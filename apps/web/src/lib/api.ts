import type { OperationEnvelope, SyncPushResult } from "@expenses/protocol";

export const apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (import.meta.env.DEV) headers.set("X-Dev-User", "dev-user");
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
  groups: Array<{ id: string; name: string; settlementCurrency: string; createdAt: string }>;
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
  if (!import.meta.env.DEV) return;
  await apiFetch("/api/v1/dev/bootstrap", { method: "POST", body: "{}" });
}

export async function registerDevice(input: {
  id: string;
  publicKeyJwk: JsonWebKey;
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

export function pullOperations(after: number): Promise<{
  operations: OperationEnvelope[];
  generation: string;
  latestServerSequence: number;
}> {
  return apiFetch(`/api/v1/sync/pull?after=${after}`);
}
