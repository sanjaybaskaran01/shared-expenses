import type {
  ConfidentialOperationEnvelope,
  GroupKeyEnvelope,
  OperationEnvelope,
  SyncPushResult,
} from "@expenses/protocol";
import { developmentIdentity } from "./development-actor";

const development = developmentIdentity(globalThis.location?.search ?? "", import.meta.env.DEV);
export const developmentActorId = development.actorId;

export const apiBaseUrl = import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://localhost:3000" : (globalThis.location?.origin ?? "http://localhost:3000"));

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (import.meta.env.DEV) headers.set("X-Dev-User", development.actorId);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export interface RemoteSnapshot {
  groups: Array<{ id: string; name: string; settlementCurrency: string; createdAt: string; version: number }>;
  members: Array<{
    groupId: string;
    userId: string;
    displayName: string;
    email: string | null;
    status: string;
  }>;
  manifest: { generation: string; latestServerSequence: number };
}

export async function bootstrapDevelopment(): Promise<void> {
  if (!import.meta.env.DEV || development.scenario) return;
  await apiFetch("/api/v1/dev/bootstrap", { method: "POST", body: "{}" });
}

export interface AuthCapabilities {
  google: boolean;
  magicLink: boolean;
}

export function getAuthCapabilities(): Promise<AuthCapabilities> {
  return apiFetch("/api/v1/auth/capabilities");
}

export interface ContactInviteState {
  creditsTotal: number;
  creditsRemaining: number;
  invitations: Array<{
    id: string;
    status: "pending" | "reserved" | "accepted" | "revoked" | "expired";
    createdAt: string;
    expiresAt: string;
    acceptedAt?: string;
  }>;
  contacts: Array<{ userId: string; displayName: string; joinedAt: string }>;
}

export interface CreatedContactInvitation extends ContactInviteState {
  id: string;
  url: string;
  expiresAt: string;
}

export function getContacts(): Promise<ContactInviteState> {
  return apiFetch("/api/v1/contacts");
}

export function createContactInvitation(): Promise<CreatedContactInvitation> {
  return apiFetch("/api/v1/contact-invitations", { method: "POST" });
}

export function revokeContactInvitation(id: string): Promise<ContactInviteState> {
  return apiFetch(`/api/v1/contact-invitations/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}

export function claimContactInvitation(token: string, email: string): Promise<void> {
  return apiFetch("/api/v1/contact-invitations/claim", {
    method: "POST",
    body: JSON.stringify({ token, email }),
  });
}

export function acceptCurrentContactInvitation(token: string): Promise<ContactInviteState> {
  return apiFetch("/api/v1/contact-invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function registerDevice(input: {
  id: string;
  publicKeyJwk: JsonWebKey;
  encryptionPublicKeyJwk?: JsonWebKey;
  name: string;
}): Promise<void> {
  await apiFetch("/api/v1/devices/register", { method: "POST", body: JSON.stringify(input) });
}

export async function inviteGroupMember(groupId: string, input: { email: string }): Promise<void> {
  await apiFetch(`/api/v1/groups/${encodeURIComponent(groupId)}/invitations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getSnapshot(): Promise<RemoteSnapshot> {
  return apiFetch("/api/v1/snapshot");
}

export function pushOperations(operations: OperationEnvelope[]): Promise<SyncPushResult> {
  return apiFetch("/api/v1/sync/push", {
    method: "POST",
    body: JSON.stringify({ operations }),
  });
}

export function sendFeedback(input: { category: "bug" | "idea"; message: string; pageUrl?: string }): Promise<void> {
  return apiFetch("/api/v1/feedback", { method: "POST", body: JSON.stringify(input) });
}

export function pullOperations(after: number): Promise<{
  operations: OperationEnvelope[];
  generation: string;
  latestServerSequence: number;
}> {
  return apiFetch(`/api/v1/sync/pull?after=${after}`);
}

export function getConfidentialGroupDevices(groupId: string): Promise<{
  devices: Array<{ id: string; userId: string; encryptionPublicKeyJwk: JsonWebKey }>;
}> {
  return apiFetch(`/api/v2/groups/${encodeURIComponent(groupId)}/devices`);
}

export function putGroupKeyEnvelope(groupId: string, envelope: GroupKeyEnvelope): Promise<{
  status: "created" | "duplicate";
}> {
  return apiFetch(`/api/v2/groups/${encodeURIComponent(groupId)}/key-envelopes`, {
    method: "POST",
    body: JSON.stringify({ envelope }),
  });
}

export function getGroupKeyEnvelopes(groupId: string): Promise<{ envelopes: GroupKeyEnvelope[] }> {
  return apiFetch(`/api/v2/groups/${encodeURIComponent(groupId)}/key-envelopes`);
}

export function pushConfidentialOperations(operations: ConfidentialOperationEnvelope[]): Promise<{
  accepted: Array<{ id: string; serverSequence: number }>;
  duplicates: Array<{ id: string; serverSequence: number }>;
  rejected: Array<{ id: string; code: string }>;
  latestServerSequence: number;
}> {
  return apiFetch("/api/v2/sync/push", {
    method: "POST",
    body: JSON.stringify({ operations }),
  });
}

export function pullConfidentialOperations(after: number): Promise<{
  operations: ConfidentialOperationEnvelope[];
  latestServerSequence: number;
}> {
  return apiFetch(`/api/v2/sync/pull?after=${after}`);
}
