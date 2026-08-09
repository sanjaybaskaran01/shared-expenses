import type { Database } from "bun:sqlite";
import type { createAuth } from "./auth";
import type { loadConfig } from "./config";
import type { ContactInviteStore } from "./contact-invites";
import type { ConfidentialLedgerStore } from "./confidential-ledger";
import type { LedgerStore } from "./ledger";
import type { loadReleaseMetadata } from "./release";
import type { SplitwiseImportConnector } from "./splitwise-import";

export type ServerConfig = ReturnType<typeof loadConfig>;
export type TalliedAuth = ReturnType<typeof createAuth>;
export type ReleaseMetadata = ReturnType<typeof loadReleaseMetadata>;

export interface ApiHttp {
  corsHeaders(request: Request): HeadersInit;
  securityHeaders(): Record<string, string>;
  json(request: Request, value: unknown, status?: number): Response;
  error(request: Request, status: number, code: string, message: string): Response;
  bodyJson<T>(request: Request, maxBytes?: number): Promise<T>;
  validEmail(value: string): boolean;
  validInviteToken(value: string): boolean;
  consumeMutation(key: string, limit?: number, windowMs?: number): boolean;
  publicRateKey(request: Request, peerAddress: string | undefined): string;
  requireActor(request: Request): Promise<string | Response>;
}

export interface ApiContext {
  config: ServerConfig;
  releaseMetadata: ReleaseMetadata;
  db: Database;
  auth: TalliedAuth;
  contactInvites: ContactInviteStore;
  ledger: LedgerStore;
  confidentialLedger: ConfidentialLedgerStore;
  splitwiseConnector: SplitwiseImportConnector | undefined;
  vapid: { publicKey: string };
  http: ApiHttp;
  publish(actorId: string, sequence: number): void;
  createEventStream(actorId: string): ReadableStream<Uint8Array>;
}

export interface RouteRequest {
  request: Request;
  url: URL;
  peerAddress: string | undefined;
}

export interface AuthenticatedRouteRequest extends RouteRequest {
  actorId: string;
}

export type RouteResult = Response | null;
