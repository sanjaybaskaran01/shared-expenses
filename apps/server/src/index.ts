import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { JsonValue, OperationEnvelope, SyncPushRequest } from "@expenses/protocol";
import { getMigrations } from "better-auth/db/migration";
import { createAuth, deriveDisplayNameFromEmail } from "./auth";
import { loadConfig } from "./config";
import { openDatabase, runDomainMigrations } from "./database";
import { enqueueEmail, startEmailWorker } from "./email";
import { LedgerStore } from "./ledger";
import { loadReleaseMetadata } from "./release";

const config = loadConfig();
const releaseMetadata = loadReleaseMetadata(resolve(import.meta.dir, "../release.json"));
mkdirSync(config.attachmentsPath, { recursive: true });
const db = openDatabase(config.databasePath);
runDomainMigrations(db, resolve(import.meta.dir, "../migrations"));
const auth = createAuth(db, config);
const authMigrations = await getMigrations(auth.options);
await authMigrations.runMigrations();
const ledger = new LedgerStore(db);
const stopEmailWorker = startEmailWorker(db, config);

const subscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  if (!origin || origin !== config.webOrigin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function json(request: Request, value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}

function errorResponse(request: Request, status: number, code: string, message: string): Response {
  return json(request, { error: { code, message } }, status);
}

function safeSubjectLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "an Expenses user";
}

async function currentActor(request: Request): Promise<string | null> {
  if (config.devAuthBypass) {
    return request.headers.get("x-dev-user") ?? "dev-user";
  }
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.emailVerified ? session.user.id : null;
}

async function requireActor(request: Request): Promise<string | Response> {
  const actor = await currentActor(request);
  return actor ?? errorResponse(request, 401, "UNAUTHENTICATED", "Sign in is required");
}

async function bodyJson<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 1_000_000) throw new RangeError("Request body is too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 1_000_000) throw new RangeError("Request body is too large");
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new RangeError("Request body must be valid JSON");
  }
}

function publish(actorId: string, sequence: number): void {
  const message = encoder.encode(`event: sequence\ndata: ${JSON.stringify({ sequence })}\n\n`);
  for (const controller of subscribers.get(actorId) ?? []) {
    try {
      controller.enqueue(message);
    } catch {
      subscribers.get(actorId)?.delete(controller);
    }
  }
}

async function apiRoute(request: Request, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Allow-Headers": "Content-Type, X-Dev-User",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return json(request, {
      status: "ok",
      ...releaseMetadata,
      serverTime: new Date().toISOString(),
    });
  }

  if (url.pathname === "/api/v1/auth/capabilities" && request.method === "GET") {
    return json(request, {
      google: Boolean(config.googleAuth),
      magicLink: true,
    });
  }

  if (url.pathname.startsWith("/api/auth/")) {
    const response = await auth.handler(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    return new Response(response.body, { status: response.status, headers });
  }

  const actorOrResponse = await requireActor(request);
  if (actorOrResponse instanceof Response) return actorOrResponse;
  const actorId = actorOrResponse;

  if (url.pathname === "/api/v1/dev/bootstrap" && request.method === "POST") {
    if (!config.devAuthBypass) return errorResponse(request, 404, "NOT_FOUND", "Not found");
    const body = await bodyJson<{
      groupId?: string;
      groupName?: string;
      displayName?: string;
      friendId?: string;
      friendName?: string;
    }>(request);
    const groupId = body.groupId ?? "dev-group";
    ledger.bootstrapGroup({
      id: groupId,
      name: body.groupName ?? "Weekend trip",
      settlementCurrency: "USD",
      userId: actorId,
      displayName: body.displayName ?? "You",
    });
    const friendId = body.friendId ?? "dev-friend";
    db.query(
      `INSERT OR IGNORE INTO group_members(group_id, user_id, display_name, status, joined_at)
       VALUES (?, ?, ?, 'active', ?)`,
    ).run(groupId, friendId, body.friendName ?? "Alex", new Date().toISOString());
    return json(request, { groupId, actorId, friendId }, 201);
  }

  if (url.pathname === "/api/v1/devices/register" && request.method === "POST") {
    const body = await bodyJson<{ id: string; publicKeyJwk: JsonWebKey; name: string }>(request);
    if (
      !body.id || body.id.length > 100 ||
      !body.name || body.name.length > 100 ||
      !body.publicKeyJwk || body.publicKeyJwk.kty !== "EC" || body.publicKeyJwk.crv !== "P-256"
    ) {
      return errorResponse(request, 400, "INVALID_DEVICE", "id, publicKeyJwk, and name are required");
    }
    ledger.registerDevice({ id: body.id, userId: actorId, publicKeyJwk: body.publicKeyJwk, name: body.name });
    return json(request, { id: body.id, status: "active" }, 201);
  }

  const invitationMatch = /^\/api\/v1\/groups\/([^/]+)\/invitations$/.exec(url.pathname);
  if (invitationMatch && request.method === "POST") {
    const groupId = decodeURIComponent(invitationMatch[1]!);
    const membership = db.query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'active'",
    ).get(groupId, actorId);
    if (!membership) return errorResponse(request, 403, "NOT_A_GROUP_MEMBER", "Active group membership is required");
    const body = await bodyJson<{ email?: string }>(request);
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      return errorResponse(request, 400, "INVALID_EMAIL", "Enter a valid email address");
    }
    const existingUser = db.query<{ name: string }, [string]>(
      `SELECT name FROM "user" WHERE lower(email) = ? LIMIT 1`,
    ).get(email);
    const displayName = existingUser?.name.trim() || deriveDisplayNameFromEmail(email);
    const duplicate = db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM group_members
       WHERE group_id = ? AND lower(email) = ? AND status IN ('placeholder', 'active') LIMIT 1`,
    ).get(groupId, email);
    if (duplicate) return errorResponse(request, 409, "ALREADY_INVITED", "This email is already in the group");

    const invitationId = randomUUID();
    const now = new Date().toISOString();
    const placeholderUserId = `invite:${invitationId}`;
    db.transaction(() => {
      db.query(
        `INSERT INTO group_invitations(id, group_id, email, display_name, invited_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(invitationId, groupId, email, displayName, actorId, now);
      db.query(
        `INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
         VALUES (?, ?, ?, ?, 'placeholder', ?)`,
      ).run(groupId, placeholderUserId, displayName, email, now);
    })();
    try {
      await auth.api.signInMagicLink({
        headers: request.headers,
        body: {
          email,
          name: displayName,
          callbackURL: config.webOrigin,
          newUserCallbackURL: config.webOrigin,
          errorCallbackURL: `${config.webOrigin}/?auth=failed`,
          metadata: { invitationId },
        },
      });
    } catch {
      db.transaction(() => {
        db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, placeholderUserId);
        db.query("DELETE FROM group_invitations WHERE id = ?").run(invitationId);
      })();
      return errorResponse(request, 503, "INVITE_EMAIL_FAILED", "The invitation could not be sent. Try again.");
    }
    return json(request, { id: invitationId, email, status: "pending" }, 201);
  }

  if (url.pathname === "/api/v1/feedback" && request.method === "POST") {
    const body = await bodyJson<{ category?: string; message?: string; pageUrl?: string }>(request);
    const category = body.category === "bug" || body.category === "idea" ? body.category : null;
    const message = body.message?.trim() ?? "";
    if (!category) return errorResponse(request, 400, "INVALID_CATEGORY", 'category must be "bug" or "idea"');
    if (!message || message.length > 4_000) {
      return errorResponse(request, 400, "INVALID_MESSAGE", "Enter a message of at most 4000 characters");
    }
    const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 300) : "";
    if (config.ownerEmail) {
      const actorKey = createHash("sha256").update(actorId).digest("hex").slice(0, 24);
      const recentCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
      const recentCount = db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM email_outbox WHERE idempotency_key LIKE ? AND created_at >= ?",
        )
        .get(`feedback:${actorKey}:%`, recentCutoff)?.count ?? 0;
      if (recentCount >= 5) {
        return errorResponse(request, 429, "FEEDBACK_RATE_LIMITED", "Too many feedback messages. Try again shortly.");
      }
      const reporter = db
        .query<{ email: string | null; name: string | null }, [string]>('SELECT email, name FROM "user" WHERE id = ?')
        .get(actorId);
      const reporterLabel = safeSubjectLabel(reporter?.name || reporter?.email || actorId);
      const label = category === "bug" ? "Bug report" : "Feature request";
      const contentKey = createHash("sha256")
        .update(JSON.stringify({ actorId, category, message, pageUrl }))
        .digest("hex");
      enqueueEmail(db, {
        idempotencyKey: `feedback:${actorKey}:${contentKey}`,
        recipient: config.ownerEmail,
        subject: `${label} from ${reporterLabel}`,
        text: [message, "", `— ${reporterLabel}${reporter?.email ? ` (${reporter.email})` : ""}`, pageUrl ? `Page: ${pageUrl}` : ""]
          .filter(Boolean)
          .join("\n"),
      });
    }
    return json(request, { status: "received" }, 201);
  }

  if (url.pathname === "/api/v1/snapshot" && request.method === "GET") {
    return json(request, { ...ledger.snapshot(actorId), manifest: ledger.manifest(actorId) });
  }

  if (url.pathname === "/api/v1/sync/push" && request.method === "POST") {
    const body = await bodyJson<SyncPushRequest>(request);
    if (!Array.isArray(body.operations)) {
      return errorResponse(request, 400, "INVALID_BATCH", "operations must be an array");
    }
    const result = await ledger.push(actorId, body.operations as OperationEnvelope<JsonValue>[]);
    if (result.accepted.length > 0) publish(actorId, result.latestServerSequence);
    return json(request, result);
  }

  if (url.pathname === "/api/v1/sync/pull" && request.method === "GET") {
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    return json(request, {
      operations: ledger.pull(actorId, after),
      generation: ledger.generation,
      latestServerSequence: ledger.latestSequenceFor(actorId),
    });
  }

  if (url.pathname === "/api/v1/sync/manifest" && request.method === "GET") {
    return json(request, ledger.manifest(actorId));
  }

  if (url.pathname === "/api/v1/sync/events" && request.method === "GET") {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
        const actorSubscribers = subscribers.get(actorId) ?? new Set();
        actorSubscribers.add(nextController);
        subscribers.set(actorId, actorSubscribers);
        nextController.enqueue(
          encoder.encode(`event: ready\ndata: ${JSON.stringify({ sequence: ledger.latestSequenceFor(actorId) })}\n\n`),
        );
        heartbeat = setInterval(() => {
          try {
            nextController.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            if (heartbeat) clearInterval(heartbeat);
            actorSubscribers.delete(nextController);
          }
        }, 20_000);
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        if (controller) subscribers.get(actorId)?.delete(controller);
      },
    });
    return new Response(stream, {
      headers: {
        ...corsHeaders(request),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return errorResponse(request, 404, "NOT_FOUND", "Not found");
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 1_000_000,
  idleTimeout: 60,
  async fetch(request) {
    try {
      return await apiRoute(request, new URL(request.url));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      return errorResponse(request, error instanceof RangeError ? 400 : 500, "REQUEST_FAILED", message);
    }
  },
});

console.info(`Expenses API listening on ${server.url}`);

function shutdown(): void {
  stopEmailWorker();
  server.stop(true);
  db.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
