import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import type { ApiContext } from "./api-context";
import { createApiHttp } from "./api-http";
import { createApiRouter } from "./api-router";
import { createAuth } from "./auth";
import { loadConfig } from "./config";
import { ContactInviteError, ContactInviteStore } from "./contact-invites";
import { ConfidentialLedgerStore } from "./confidential-ledger";
import { openDatabase, runDomainMigrations } from "./database";
import { startEmailWorker } from "./email";
import { GroupInvitationError } from "./group-invitations";
import { LedgerStore } from "./ledger";
import { ensureVapidKeys, startPushWorker } from "./push-notifications";
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
const vapid = ensureVapidKeys(db, config.authSecret);
const splitwiseConnector = config.splitwiseOAuth
  ? new SplitwiseImportConnector(db, config.splitwiseOAuth, config.authSecret)
  : undefined;
const stopEmailWorker = startEmailWorker(db, config);
const stopPushWorker = startPushWorker(db, {
  authSecret: config.authSecret,
  vapid: {
    ...vapid,
    subject: `mailto:${config.ownerEmail ?? "notifications@localhost.invalid"}`,
  },
});

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

function createEventStream(actorId: string): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
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
}

const context: ApiContext = {
  config,
  releaseMetadata,
  db,
  auth,
  contactInvites,
  ledger,
  confidentialLedger,
  splitwiseConnector,
  vapid,
  http: createApiHttp(config, auth),
  publish,
  createEventStream,
};
const apiRoute = createApiRouter(context);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 16_000_000,
  idleTimeout: 60,
  async fetch(request, bunServer) {
    try {
      return await apiRoute(request, new URL(request.url), bunServer.requestIP(request)?.address);
    } catch (cause) {
      if (cause instanceof ContactInviteError || cause instanceof GroupInvitationError) {
        return context.http.error(request, cause.status, cause.code, cause.message);
      }
      if (cause instanceof RangeError) {
        return context.http.error(request, 400, "INVALID_REQUEST", cause.message);
      }
      const requestId = randomUUID();
      console.error("API request failed", {
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        error: cause instanceof Error ? cause.name : "UnknownError",
      });
      return context.http.error(
        request,
        500,
        "REQUEST_FAILED",
        `Tallied could not complete that request. Try again. If it keeps happening, contact support with reference ${requestId}.`,
      );
    }
  },
});

console.info(`Tallied API listening on ${server.url}`);

function shutdown(): void {
  clearInterval(importCleanupTimer);
  stopEmailWorker();
  stopPushWorker();
  server.stop(true);
  db.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
