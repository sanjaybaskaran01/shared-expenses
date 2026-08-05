import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ConfidentialOperationEnvelope,
  GroupKeyEnvelope,
  ImportBatchCommitRequest,
  ImportIdentityResolutionRequest,
  ImportStageChunkRequest,
  ImportStageStartRequest,
  ImportUndoStageChunkRequest,
  ImportUndoStageStartRequest,
  ImportUndoRequest,
  JsonValue,
  OperationEnvelope,
  SyncPushRequest,
} from "@expenses/protocol";
import { getMigrations } from "better-auth/db/migration";
import { createAuth, deriveDisplayNameFromEmail } from "./auth";
import { loadConfig, resolvePublicRateKey } from "./config";
import { ContactInviteError, ContactInviteStore } from "./contact-invites";
import { ConfidentialLedgerStore } from "./confidential-ledger";
import { openDatabase, runDomainMigrations } from "./database";
import { enqueueEmail, startEmailWorker } from "./email";
import { LedgerStore } from "./ledger";
import { loadReleaseMetadata } from "./release";
import { SplitwiseImportConnector } from "./splitwise-import";

const config = loadConfig();
const releaseMetadata = loadReleaseMetadata(resolve(import.meta.dir, "../release.json"));
mkdirSync(config.attachmentsPath, { recursive: true });
const db = openDatabase(config.databasePath);
runDomainMigrations(db, resolve(import.meta.dir, "../migrations"));
const contactInvites = new ContactInviteStore(db, { emailHashSecret: config.authSecret });
const auth = createAuth(db, config, contactInvites);
const authMigrations = await getMigrations(auth.options);
await authMigrations.runMigrations();
const ledger = new LedgerStore(db, { emailHashSecret: config.authSecret });
const confidentialLedger = new ConfidentialLedgerStore(db);
const splitwiseConnector = config.splitwiseOAuth
  ? new SplitwiseImportConnector(db, config.splitwiseOAuth, config.authSecret)
  : undefined;
const stopEmailWorker = startEmailWorker(db, config);
ledger.recoverInterruptedImportActivations();
ledger.pruneExpiredImportUploads();
splitwiseConnector?.pruneExpired();
const importCleanupTimer = setInterval(() => {
  ledger.pruneExpiredImportUploads();
  splitwiseConnector?.pruneExpired();
}, 15 * 60_000);
importCleanupTimer.unref();

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

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Resource-Policy": "same-site",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

function json(request: Request, value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      ...corsHeaders(request),
      ...securityHeaders(),
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

function errorResponse(request: Request, status: number, code: string, message: string): Response {
  return json(request, { error: { code, message } }, status);
}

function safeSubjectLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "a Tallied user";
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

function validContactInviteToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

const importMutationWindows = new Map<string, number[]>();

function consumeImportMutation(actorId: string, limit = 30, windowMs = 60 * 60_000): boolean {
  const cutoff = Date.now() - windowMs;
  if (importMutationWindows.size >= 5_000) {
    for (const [key, timestamps] of importMutationWindows) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) importMutationWindows.delete(key);
      else importMutationWindows.set(key, active);
    }
    if (importMutationWindows.size >= 5_000 && !importMutationWindows.has(actorId)) return false;
  }
  const recent = (importMutationWindows.get(actorId) ?? []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= limit) {
    importMutationWindows.set(actorId, recent);
    return false;
  }
  recent.push(Date.now());
  importMutationWindows.set(actorId, recent);
  return true;
}

function publicRateKey(request: Request): string {
  const cloudflareIp = request.headers.get("cf-connecting-ip");
  return resolvePublicRateKey({
    ...(cloudflareIp ? { cloudflareIp } : {}),
    trustCloudflareProxy: config.trustCloudflareProxy,
    production: config.nodeEnv === "production",
  });
}

async function currentActor(request: Request): Promise<string | null> {
  if (config.devAuthBypass) {
    const candidate = request.headers.get("x-dev-user") ?? new URL(request.url).searchParams.get("devUser") ?? "dev-user";
    return /^[a-z][a-z0-9-]{0,47}$/.test(candidate) ? candidate : "dev-user";
  }
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.emailVerified ? session.user.id : null;
}

async function requireActor(request: Request): Promise<string | Response> {
  const actor = await currentActor(request);
  return actor ?? errorResponse(request, 401, "UNAUTHENTICATED", "Sign in is required");
}

async function bodyJson<T>(request: Request, maxBytes = 1_000_000): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new RangeError("Request body is too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) throw new RangeError("Request body is too large");
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
      magicLink: config.smtp.enabled,
    });
  }

  if (url.pathname === "/api/v1/imports/capabilities" && request.method === "GET") {
    return json(request, {
      localFiles: true,
      balanceOnly: true,
      splitwiseOAuth: {
        available: Boolean(config.splitwiseOAuth),
        reason: config.splitwiseOAuth
          ? null
          : "Direct connection requires written Splitwise API approval. CSV, JSON, and balance-only migration remain available.",
      },
      limits: { files: 20, fileBytes: 10_485_760, totalBytes: 52_428_800, rows: 100_000 },
    });
  }

  if (url.pathname === "/api/v1/import-claims/preview" && request.method === "POST") {
    if (!consumeImportMutation(`claim-preview:${publicRateKey(request)}`, 30, 60 * 60_000)) {
      return errorResponse(request, 429, "CLAIM_RATE_LIMITED", "Too many claim checks. Try again later.");
    }
    const body = await bodyJson<{ token?: string }>(request, 2_000);
    const token = body.token?.trim() ?? "";
    if (!validContactInviteToken(token)) {
      return errorResponse(request, 400, "INVALID_CLAIM", "This migration claim link is invalid or expired");
    }
    try {
      return json(request, ledger.previewImportClaim(token));
    } catch {
      return errorResponse(request, 404, "INVALID_CLAIM", "This migration claim link is invalid or expired");
    }
  }

  if (
    (url.pathname === "/api/v1/import-claims/reserve" || url.pathname === "/api/v1/import-claims/email") &&
    request.method === "POST"
  ) {
    const rateKey = publicRateKey(request);
    if (!consumeImportMutation(`claim-auth:${rateKey}`, 15, 60 * 60_000)) {
      return errorResponse(request, 429, "CLAIM_RATE_LIMITED", "Too many claim attempts. Try again later.");
    }
    const body = await bodyJson<{ token?: string; email?: string }>(request, 4_000);
    const token = body.token?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!validContactInviteToken(token) || !validEmail(email)) {
      return errorResponse(request, 400, "INVALID_CLAIM", "Enter a valid email and claim link");
    }
    if (url.pathname.endsWith("/email") && !config.smtp.enabled) {
      return errorResponse(request, 503, "EMAIL_NOT_CONFIGURED", "Email verification is unavailable");
    }
    try {
      const reservation = ledger.reserveImportClaimEmail(token, email);
      if (url.pathname.endsWith("/email")) {
        const callback = new URL(config.webOrigin);
        callback.hash = new URLSearchParams({ migrationClaim: token }).toString();
        const failure = new URL(config.webOrigin);
        failure.searchParams.set("auth", "failed");
        failure.hash = callback.hash;
        await auth.api.signInMagicLink({
          headers: request.headers,
          body: {
            email,
            name: deriveDisplayNameFromEmail(email),
            callbackURL: callback.toString(),
            newUserCallbackURL: callback.toString(),
            errorCallbackURL: failure.toString(),
            metadata: { migrationClaim: true },
          },
        });
        return json(request, { status: "verification-sent", expiresAt: reservation.expiresAt }, 202);
      }
      return json(request, reservation, 201);
    } catch (error) {
      return errorResponse(request, 400, "CLAIM_RESERVATION_REJECTED", error instanceof Error ? error.message : "Claim unavailable");
    }
  }

  if (url.pathname === "/api/v1/contact-invitations/claim" && request.method === "POST") {
    if (!config.smtp.enabled) {
      return errorResponse(request, 503, "EMAIL_NOT_CONFIGURED", "Email verification is unavailable");
    }
    const body = await bodyJson<{ token?: string; email?: string }>(request);
    const token = body.token?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!validContactInviteToken(token)) {
      return errorResponse(request, 400, "INVALID_INVITATION", "This invitation link is invalid");
    }
    if (!validEmail(email)) {
      return errorResponse(request, 400, "INVALID_EMAIL", "Enter a valid email address");
    }
    const reservation = contactInvites.reserve(token, email);
    await auth.api.signInMagicLink({
      headers: request.headers,
      body: {
        email,
        name: deriveDisplayNameFromEmail(email),
        callbackURL: config.webOrigin,
        newUserCallbackURL: config.webOrigin,
        errorCallbackURL: `${config.webOrigin}/?auth=failed`,
        metadata: { contactInvitationId: reservation.invitationId },
      },
    });
    return json(request, { status: "verification-sent" }, 202);
  }

  if (url.pathname.startsWith("/api/auth/")) {
    const response = await auth.handler(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
    for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }

  if (url.pathname === "/api/v1/imports/splitwise/callback" && request.method === "GET") {
    if (!splitwiseConnector) return errorResponse(request, 404, "NOT_FOUND", "Not found");
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const destination = new URL(config.webOrigin);
    if (!consumeImportMutation(`splitwise-callback:${publicRateKey(request)}`, 60, 60 * 60_000)) {
      destination.hash = new URLSearchParams({ migration: "splitwise-auth-rate-limited" }).toString();
      return new Response(null, { status: 303, headers: { ...securityHeaders(), Location: destination.toString(), "Cache-Control": "no-store" } });
    }
    try {
      if (url.searchParams.has("error")) {
        splitwiseConnector.deny(state);
        destination.hash = new URLSearchParams({ migration: "splitwise-auth-cancelled" }).toString();
      } else {
        const completed = await splitwiseConnector.complete(state, code);
        destination.hash = new URLSearchParams({ splitwiseSession: completed.sessionId }).toString();
      }
    } catch {
      destination.hash = new URLSearchParams({ migration: "splitwise-auth-failed" }).toString();
    }
    return new Response(null, {
      status: 303,
      headers: {
        ...securityHeaders(),
        Location: destination.toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  const actorOrResponse = await requireActor(request);
  if (actorOrResponse instanceof Response) return actorOrResponse;
  const actorId = actorOrResponse;

  if (url.pathname === "/api/v1/imports" && request.method === "GET") {
    return json(request, { imports: ledger.listImports(actorId) });
  }

  if (url.pathname === "/api/v1/imports/resolve-identities" && request.method === "POST") {
    if (!consumeImportMutation(`import-identity:${actorId}`, 30, 60 * 60_000)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many identity checks. Try again later.");
    }
    const body = await bodyJson<ImportIdentityResolutionRequest>(request, 200_000);
    try {
      return json(request, ledger.resolveImportIdentityTargets(actorId, body));
    } catch (error) {
      return errorResponse(request, 400, "IMPORT_IDENTITIES_INVALID", error instanceof Error ? error.message : "Identity check failed");
    }
  }

  if (url.pathname === "/api/v1/imports/splitwise/start" && request.method === "POST") {
    if (!splitwiseConnector) {
      return errorResponse(
        request,
        403,
        "SPLITWISE_APPROVAL_REQUIRED",
        "Direct connection is unavailable until Splitwise grants written API approval.",
      );
    }
    if (!consumeImportMutation(actorId, 10)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration attempts. Try again later.");
    }
    return json(request, splitwiseConnector.start(actorId), 201);
  }

  if (url.pathname === "/api/v1/imports/splitwise/snapshot" && request.method === "POST") {
    if (!splitwiseConnector) return errorResponse(request, 404, "NOT_FOUND", "Not found");
    const body = await bodyJson<{ sessionId?: string }>(request, 2_000);
    const sessionId = body.sessionId?.trim() ?? "";
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) {
      return errorResponse(request, 400, "INVALID_SESSION", "Splitwise migration session is invalid");
    }
    try {
      return json(request, { snapshot: await splitwiseConnector.snapshot(actorId, sessionId) });
    } catch (error) {
      return errorResponse(
        request,
        400,
        "SPLITWISE_READ_FAILED",
        error instanceof Error ? error.message : "Splitwise data could not be read",
      );
    }
  }

  if (url.pathname === "/api/v1/imports/splitwise/cancel" && request.method === "POST") {
    if (!splitwiseConnector) return errorResponse(request, 404, "NOT_FOUND", "Not found");
    const body = await bodyJson<{ sessionId?: string }>(request, 2_000);
    const sessionId = body.sessionId?.trim() ?? "";
    if (/^[0-9a-f-]{36}$/.test(sessionId)) splitwiseConnector.cancel(actorId, sessionId);
    return json(request, { status: "cancelled" });
  }

  if (url.pathname === "/api/v1/imports/activate" && request.method === "POST") {
    if (!consumeImportMutation(actorId, 10)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration attempts. Try again later.");
    }
    const body = await bodyJson<ImportBatchCommitRequest>(request, 12_000_000);
    try {
      const result = await ledger.activateImport(actorId, body);
      if (!result.duplicate) {
        for (const memberId of ledger.activeMemberIdsForGroups(body.operations.map(({ groupId }) => groupId))) {
          publish(memberId, ledger.latestSequenceFor(memberId));
        }
      }
      return json(request, result, result.duplicate ? 200 : 201);
    } catch (error) {
      return errorResponse(
        request,
        400,
        "IMPORT_REJECTED",
        error instanceof Error ? error.message : "The migration could not be verified",
      );
    }
  }

  if (url.pathname === "/api/v1/imports/stage" && request.method === "POST") {
    if (!consumeImportMutation(actorId, 30)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration attempts. Try again later.");
    }
    const body = await bodyJson<ImportStageStartRequest>(request, 12_000_000);
    try {
      return json(request, ledger.startImportStage(actorId, body), 201);
    } catch (error) {
      return errorResponse(request, 400, "IMPORT_STAGE_REJECTED", error instanceof Error ? error.message : "Upload unavailable");
    }
  }

  const importChunkMatch = /^\/api\/v1\/imports\/([^/]+)\/chunks$/.exec(url.pathname);
  if (importChunkMatch && request.method === "POST") {
    if (!consumeImportMutation(`import-chunk:${actorId}`, 1_000, 60 * 60_000)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration chunks. Try again later.");
    }
    const body = await bodyJson<ImportStageChunkRequest>(request, 4_000_000);
    try {
      return json(request, await ledger.stageImportOperations(actorId, decodeURIComponent(importChunkMatch[1]!), body));
    } catch (error) {
      return errorResponse(request, 400, "IMPORT_CHUNK_REJECTED", error instanceof Error ? error.message : "Upload unavailable");
    }
  }

  const importStageActivateMatch = /^\/api\/v1\/imports\/([^/]+)\/activate$/.exec(url.pathname);
  if (importStageActivateMatch && request.method === "POST") {
    const batchId = decodeURIComponent(importStageActivateMatch[1]!);
    try {
      const result = await ledger.activateImportStage(actorId, batchId);
      if (!result.duplicate) {
        for (const memberId of ledger.activeMemberIdsForGroups(ledger.groupIdsForImportBatch(actorId, batchId))) {
          publish(memberId, ledger.latestSequenceFor(memberId));
        }
      }
      return json(request, result, result.duplicate ? 200 : 201);
    } catch (error) {
      return errorResponse(request, 400, "IMPORT_REJECTED", error instanceof Error ? error.message : "Migration unavailable");
    }
  }

  const importStageCancelMatch = /^\/api\/v1\/imports\/([^/]+)\/cancel$/.exec(url.pathname);
  if (importStageCancelMatch && request.method === "POST") {
    const cancelled = ledger.cancelImportStage(actorId, decodeURIComponent(importStageCancelMatch[1]!));
    if (!cancelled) {
      return errorResponse(request, 409, "IMPORT_CANCEL_TOO_LATE", "This upload is unavailable or already activating");
    }
    return json(request, { status: "cancelled" });
  }

  const importUndoStageStartMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-stage$/.exec(url.pathname);
  if (importUndoStageStartMatch && request.method === "POST") {
    if (!consumeImportMutation(actorId, 10)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration attempts. Try again later.");
    }
    const batchId = decodeURIComponent(importUndoStageStartMatch[1]!);
    const body = await bodyJson<ImportUndoStageStartRequest>(request, 10_000);
    try {
      return json(request, ledger.startImportUndoStage(actorId, batchId, body), 201);
    } catch (error) {
      return errorResponse(request, 400, "IMPORT_UNDO_STAGE_REJECTED", error instanceof Error ? error.message : "Undo upload unavailable");
    }
  }

  const importUndoChunkMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-chunks$/.exec(url.pathname);
  if (importUndoChunkMatch && request.method === "POST") {
    if (!consumeImportMutation(`import-undo-chunk:${actorId}`, 1_000, 60 * 60_000)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many undo chunks. Try again later.");
    }
    const batchId = decodeURIComponent(importUndoChunkMatch[1]!);
    const body = await bodyJson<ImportUndoStageChunkRequest>(request, 4_000_000);
    try {
      return json(request, ledger.stageImportUndoOperations(actorId, batchId, body));
    } catch (error) {
      return errorResponse(request, 400, "IMPORT_UNDO_CHUNK_REJECTED", error instanceof Error ? error.message : "Undo upload unavailable");
    }
  }

  const importUndoActivateMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-activate$/.exec(url.pathname);
  if (importUndoActivateMatch && request.method === "POST") {
    const batchId = decodeURIComponent(importUndoActivateMatch[1]!);
    try {
      const result = await ledger.activateImportUndoStage(actorId, batchId);
      if (!result.duplicate) {
        for (const memberId of ledger.activeMemberIdsForGroups(ledger.groupIdsForImportBatch(actorId, batchId))) {
          publish(memberId, ledger.latestSequenceFor(memberId));
        }
      }
      return json(request, result);
    } catch (error) {
      return errorResponse(request, 400, "IMPORT_UNDO_REJECTED", error instanceof Error ? error.message : "Undo unavailable");
    }
  }

  const importUndoCancelMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-cancel$/.exec(url.pathname);
  if (importUndoCancelMatch && request.method === "POST") {
    const cancelled = ledger.cancelImportUndoStage(actorId, decodeURIComponent(importUndoCancelMatch[1]!));
    if (!cancelled) return errorResponse(request, 409, "IMPORT_CANCEL_TOO_LATE", "This undo is unavailable or already activating");
    return json(request, { status: "cancelled" });
  }

  const importUndoMatch = /^\/api\/v1\/imports\/([^/]+)\/undo$/.exec(url.pathname);
  if (importUndoMatch && request.method === "POST") {
    if (!consumeImportMutation(actorId, 10)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration attempts. Try again later.");
    }
    const batchId = decodeURIComponent(importUndoMatch[1]!);
    const body = await bodyJson<ImportUndoRequest>(request, 12_000_000);
    try {
      const result = await ledger.undoImport(actorId, batchId, body);
      if (!result.duplicate) {
        for (const memberId of ledger.activeMemberIdsForGroups(body.operations.map(({ groupId }) => groupId))) {
          publish(memberId, ledger.latestSequenceFor(memberId));
        }
      }
      return json(request, result);
    } catch (error) {
      return errorResponse(
        request,
        400,
        "IMPORT_UNDO_REJECTED",
        error instanceof Error ? error.message : "The migration could not be undone",
      );
    }
  }

  const importIdentitiesMatch = /^\/api\/v1\/imports\/([^/]+)\/identities$/.exec(url.pathname);
  if (importIdentitiesMatch && request.method === "GET") {
    const batchId = decodeURIComponent(importIdentitiesMatch[1]!);
    return json(request, { identities: ledger.listImportIdentities(actorId, batchId) });
  }

  const importClaimLinkMatch = /^\/api\/v1\/imports\/([^/]+)\/identities\/([^/]+)\/claim-link$/.exec(url.pathname);
  if (importClaimLinkMatch && request.method === "POST") {
    if (!consumeImportMutation(actorId)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration actions. Try again later.");
    }
    try {
      const batchId = decodeURIComponent(importClaimLinkMatch[1]!);
      const identityId = decodeURIComponent(importClaimLinkMatch[2]!);
      const claim = ledger.createImportClaimLink(actorId, batchId, identityId);
      const shareUrl = new URL(config.webOrigin);
      shareUrl.hash = new URLSearchParams({ migrationClaim: claim.token }).toString();
      return json(request, { identityId: claim.identityId, url: shareUrl.toString(), expiresAt: claim.expiresAt }, 201);
    } catch (error) {
      return errorResponse(request, 403, "CLAIM_LINK_REJECTED", error instanceof Error ? error.message : "Claim link unavailable");
    }
  }

  if (url.pathname === "/api/v1/import-claims/claim" && request.method === "POST") {
    if (!consumeImportMutation(actorId)) {
      return errorResponse(request, 429, "IMPORT_RATE_LIMITED", "Too many migration actions. Try again later.");
    }
    const body = await bodyJson<{ token?: string }>(request, 2_000);
    const token = body.token?.trim() ?? "";
    if (!validContactInviteToken(token)) {
      return errorResponse(request, 400, "INVALID_CLAIM", "This migration claim link is invalid or expired");
    }
    try {
      return json(request, ledger.claimImportedIdentity(actorId, token));
    } catch (error) {
      return errorResponse(request, 400, "CLAIM_REJECTED", error instanceof Error ? error.message : "Claim unavailable");
    }
  }

  if (url.pathname === "/api/v1/import-claims/status" && request.method === "POST") {
    const body = await bodyJson<{ requestId?: string }>(request, 2_000);
    const requestId = body.requestId?.trim() ?? "";
    if (!validContactInviteToken(requestId)) {
      return errorResponse(request, 400, "INVALID_CLAIM_REQUEST", "Claim request is unavailable");
    }
    try {
      return json(request, ledger.importClaimStatus(actorId, requestId));
    } catch (error) {
      return errorResponse(request, 404, "CLAIM_REQUEST_UNAVAILABLE", error instanceof Error ? error.message : "Claim request is unavailable");
    }
  }

  const approveImportClaimMatch = /^\/api\/v1\/import-identities\/([^/]+)\/approve$/.exec(url.pathname);
  if (approveImportClaimMatch && request.method === "POST") {
    try {
      return json(request, ledger.approveImportIdentityClaim(actorId, decodeURIComponent(approveImportClaimMatch[1]!)));
    } catch (error) {
      return errorResponse(request, 403, "CLAIM_APPROVAL_REJECTED", error instanceof Error ? error.message : "Claim unavailable");
    }
  }

  const rejectImportClaimMatch = /^\/api\/v1\/import-identities\/([^/]+)\/reject$/.exec(url.pathname);
  if (rejectImportClaimMatch && request.method === "POST") {
    try {
      return json(request, ledger.rejectImportIdentityClaim(actorId, decodeURIComponent(rejectImportClaimMatch[1]!)));
    } catch (error) {
      return errorResponse(request, 403, "CLAIM_REJECTION_REJECTED", error instanceof Error ? error.message : "Claim unavailable");
    }
  }

  const sourceDataDeleteMatch = /^\/api\/v1\/imports\/([^/]+)\/source-data\/delete$/.exec(url.pathname);
  if (sourceDataDeleteMatch && request.method === "POST") {
    try {
      return json(request, ledger.deleteImportSourceData(actorId, decodeURIComponent(sourceDataDeleteMatch[1]!)));
    } catch (error) {
      return errorResponse(request, 403, "SOURCE_DELETE_REJECTED", error instanceof Error ? error.message : "Source data unavailable");
    }
  }

  if (url.pathname === "/api/v1/contact-invitations" && request.method === "POST") {
    const invitation = contactInvites.create(actorId);
    const shareUrl = new URL(config.webOrigin);
    shareUrl.hash = new URLSearchParams({ invite: invitation.token }).toString();
    return json(request, {
      id: invitation.id,
      url: shareUrl.toString(),
      expiresAt: invitation.expiresAt,
      ...contactInvites.list(actorId),
    }, 201);
  }

  if (url.pathname === "/api/v1/contacts" && request.method === "GET") {
    return json(request, contactInvites.list(actorId));
  }

  if (url.pathname === "/api/v1/contact-invitations/accept" && request.method === "POST") {
    const body = await bodyJson<{ token?: string }>(request);
    const token = body.token?.trim() ?? "";
    if (!validContactInviteToken(token)) {
      return errorResponse(request, 400, "INVALID_INVITATION", "This invitation link is invalid");
    }
    const user = db.query<{ email: string }, [string]>(
      `SELECT email FROM "user" WHERE id = ? LIMIT 1`,
    ).get(actorId);
    if (!user) return errorResponse(request, 401, "UNAUTHENTICATED", "Sign in is required");
    contactInvites.acceptForSignedInUser(token, actorId, user.email);
    return json(request, { status: "accepted", ...contactInvites.list(actorId) });
  }

  const contactInvitationMatch = /^\/api\/v1\/contact-invitations\/([^/]+)\/revoke$/.exec(url.pathname);
  if (contactInvitationMatch && request.method === "POST") {
    contactInvites.revoke(actorId, decodeURIComponent(contactInvitationMatch[1]!));
    return json(request, { status: "revoked", ...contactInvites.list(actorId) });
  }

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
    const body = await bodyJson<{
      id: string;
      publicKeyJwk: JsonWebKey;
      encryptionPublicKeyJwk?: JsonWebKey;
      name: string;
    }>(request);
    if (
      !body.id || body.id.length > 100 ||
      !body.name || body.name.length > 100 ||
      !body.publicKeyJwk || body.publicKeyJwk.kty !== "EC" || body.publicKeyJwk.crv !== "P-256" ||
      (body.encryptionPublicKeyJwk &&
        (body.encryptionPublicKeyJwk.kty !== "EC" || body.encryptionPublicKeyJwk.crv !== "P-256"))
    ) {
      return errorResponse(request, 400, "INVALID_DEVICE", "id, publicKeyJwk, and name are required");
    }
    ledger.registerDevice({
      id: body.id,
      userId: actorId,
      publicKeyJwk: body.publicKeyJwk,
      ...(body.encryptionPublicKeyJwk ? { encryptionPublicKeyJwk: body.encryptionPublicKeyJwk } : {}),
      name: body.name,
    });
    return json(request, { id: body.id, status: "active" }, 201);
  }

  const invitationMatch = /^\/api\/v1\/groups\/([^/]+)\/invitations$/.exec(url.pathname);
  if (invitationMatch && request.method === "POST") {
    if (!config.smtp.enabled) {
      return errorResponse(request, 503, "EMAIL_NOT_CONFIGURED", "Email invitations are unavailable");
    }
    const groupId = decodeURIComponent(invitationMatch[1]!);
    const membership = db.query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'active'",
    ).get(groupId, actorId);
    if (!membership) return errorResponse(request, 403, "NOT_A_GROUP_MEMBER", "Active group membership is required");
    const body = await bodyJson<{ email?: string }>(request);
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!validEmail(email)) {
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
    if (result.accepted.length > 0) {
      const acceptedIds = new Set(result.accepted.map(({ id }) => id));
      const groupIds = body.operations
        .filter(({ id }) => acceptedIds.has(id))
        .map(({ groupId }) => groupId);
      for (const memberId of ledger.activeMemberIdsForGroups(groupIds)) {
        publish(memberId, ledger.latestSequenceFor(memberId));
      }
    }
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

  if (url.pathname === "/api/v2/sync/push" && request.method === "POST") {
    const body = await bodyJson<{ operations?: ConfidentialOperationEnvelope[] }>(request);
    if (!Array.isArray(body.operations) || body.operations.length > 100) {
      return errorResponse(request, 400, "INVALID_BATCH", "operations must contain at most 100 entries");
    }
    return json(request, await confidentialLedger.push(actorId, body.operations));
  }

  if (url.pathname === "/api/v2/sync/pull" && request.method === "GET") {
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    return json(request, {
      operations: confidentialLedger.pull(actorId, after),
      latestServerSequence: confidentialLedger.latestSequenceFor(actorId),
    });
  }

  const confidentialDevicesMatch = /^\/api\/v2\/groups\/([^/]+)\/devices$/.exec(url.pathname);
  if (confidentialDevicesMatch && request.method === "GET") {
    const groupId = decodeURIComponent(confidentialDevicesMatch[1]!);
    try {
      return json(request, { devices: confidentialLedger.groupDevices(actorId, groupId) });
    } catch {
      return errorResponse(request, 403, "NOT_A_GROUP_MEMBER", "Active group membership is required");
    }
  }

  const keyEnvelopesMatch = /^\/api\/v2\/groups\/([^/]+)\/key-envelopes$/.exec(url.pathname);
  if (keyEnvelopesMatch && request.method === "GET") {
    const groupId = decodeURIComponent(keyEnvelopesMatch[1]!);
    try {
      return json(request, { envelopes: confidentialLedger.keyEnvelopes(actorId, groupId) });
    } catch {
      return errorResponse(request, 403, "NOT_A_GROUP_MEMBER", "Active group membership is required");
    }
  }

  if (keyEnvelopesMatch && request.method === "POST") {
    const groupId = decodeURIComponent(keyEnvelopesMatch[1]!);
    const body = await bodyJson<{ envelope?: GroupKeyEnvelope }>(request);
    if (!body.envelope || body.envelope.groupId !== groupId) {
      return errorResponse(request, 400, "INVALID_KEY_ENVELOPE", "A matching group key envelope is required");
    }
    try {
      const status = await confidentialLedger.putKeyEnvelope(actorId, body.envelope);
      return json(request, { status }, status === "created" ? 201 : 200);
    } catch {
      return errorResponse(request, 400, "INVALID_KEY_ENVELOPE", "The key envelope was rejected");
    }
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
  maxRequestBodySize: 16_000_000,
  idleTimeout: 60,
  async fetch(request) {
    try {
      return await apiRoute(request, new URL(request.url));
    } catch (error) {
      if (error instanceof ContactInviteError) {
        return errorResponse(request, error.status, error.code, error.message);
      }
      if (error instanceof RangeError) {
        return errorResponse(request, 400, "INVALID_REQUEST", error.message);
      }
      const requestId = randomUUID();
      console.error("API request failed", {
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return errorResponse(
        request,
        500,
        "REQUEST_FAILED",
        `The request could not be completed (reference ${requestId})`,
      );
    }
  },
});

console.info(`Tallied API listening on ${server.url}`);

function shutdown(): void {
  clearInterval(importCleanupTimer);
  stopEmailWorker();
  server.stop(true);
  db.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
