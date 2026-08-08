import type {
  ConfidentialOperationEnvelope,
  GroupKeyEnvelope,
  ImportActivationResult,
  ImportBatchCommitRequest,
  ImportBatchSummary,
  ImportClaimPreview,
  ImportClaimResult,
  ImportClaimStatus,
  ImportIdentitySummary,
  ImportIdentityResolutionRequest,
  ImportIdentityResolutionResult,
  ImportStageChunkRequest,
  ImportStageStartRequest,
  ImportStageStatus,
  ImportUndoRequest,
  ImportUndoResult,
  ImportUndoStageChunkRequest,
  ImportUndoStageStartRequest,
  ImportUndoStageStatus,
  OperationEnvelope,
  SyncPushResult,
} from "@expenses/protocol";
import { canonicalJson, importPreparationMaterial, sha256Hex } from "@expenses/protocol";
import { developmentIdentity } from "./development-actor";
import { resumableUploadRanges, uploadChunkOffsets } from "./import-upload";

const development = developmentIdentity(globalThis.location?.search ?? "", import.meta.env.DEV);
export const developmentActorId = development.actorId;

class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const apiBaseUrl = import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://localhost:3000" : (globalThis.location?.origin ?? "http://localhost:3000"));

const activationTimeoutMs = 5 * 60_000;
const activationRecoveryTimeoutMs = 2 * 60_000;

async function apiFetch<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (import.meta.env.DEV) headers.set("X-Dev-User", development.actorId);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiRequestError(response.status, payload?.error?.message ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function uploadChunkWithRetry<T>(path: string, body: unknown): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof ApiRequestError) || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 3) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250 * 2 ** attempt + Math.floor(Math.random() * 125)));
    }
  }
  throw lastError;
}

function mayHaveCompletedAfterError(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || [408, 409, 425, 429].includes(error.status) || error.status >= 500;
}

async function waitForImportStatus(
  batchId: string,
  status: ImportBatchSummary["status"],
  timeoutMs = activationRecoveryTimeoutMs,
): Promise<ImportBatchSummary | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const batch = await getImports()
      .then(({ imports }) => imports.find((candidate) => candidate.id === batchId && candidate.status === status))
      .catch(() => undefined);
    if (batch) return batch;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
  }
  return undefined;
}

export interface RemoteSnapshot {
  groups: Array<{ id: string; name: string; settlementCurrency: string; createdAt: string; version: number }>;
  members: Array<{
    groupId: string;
    userId: string;
    displayName: string;
    email: string | null;
    status: string;
    importClaim?: {
      batchId: string;
      identityId: string;
      status: "unclaimed" | "reserved" | "awaiting_owner";
    };
  }>;
  manifest: { generation: string; latestServerSequence: number };
  participantAliases?: Array<{ groupId: string; fromUserId: string; toUserId: string }>;
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

export interface PushConfig {
  publicKey: string;
  subscribed: boolean;
}

export interface BrowserPushSubscriptionJson {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export function getPushConfig(deviceId: string): Promise<PushConfig> {
  return apiFetch(`/api/v1/push/config?deviceId=${encodeURIComponent(deviceId)}`);
}

export function registerPushSubscription(
  deviceId: string,
  subscription: BrowserPushSubscriptionJson,
): Promise<{ subscribed: true }> {
  return apiFetch("/api/v1/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ deviceId, subscription }),
  });
}

export function revokePushSubscription(deviceId: string): Promise<{ subscribed: false }> {
  return apiFetch("/api/v1/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ deviceId }),
  });
}

export function markNotificationsRead(): Promise<{ read: number }> {
  return apiFetch("/api/v1/notifications/read", { method: "POST", body: "{}" });
}

export interface ImportCapabilities {
  localFiles: boolean;
  balanceOnly: boolean;
  splitwiseOAuth: { available: boolean; reason: string | null };
  limits: { files: number; fileBytes: number; totalBytes: number; rows: number };
}

export function getImportCapabilities(): Promise<ImportCapabilities> {
  return apiFetch("/api/v1/imports/capabilities");
}

export function getImports(): Promise<{ imports: ImportBatchSummary[] }> {
  return apiFetch("/api/v1/imports");
}

export function resolveImportIdentities(
  body: ImportIdentityResolutionRequest,
): Promise<ImportIdentityResolutionResult> {
  return apiFetch("/api/v1/imports/resolve-identities", { method: "POST", body: JSON.stringify(body) });
}

export async function stageImport(
  body: ImportBatchCommitRequest,
  onProgress?: (completed: number, total: number) => void,
): Promise<ImportStageStatus> {
  return stageImportInternal(body, onProgress, true);
}

async function stageImportInternal(
  body: ImportBatchCommitRequest,
  onProgress: ((completed: number, total: number) => void) | undefined,
  allowRestart: boolean,
): Promise<ImportStageStatus> {
  const { operations, operationLinks, ...batch } = body;
  const preparationHash = await sha256Hex(canonicalJson(importPreparationMaterial(body)));
  const startBody: ImportStageStartRequest = {
    batch,
    expectedOperationCount: operations.length,
    preparationHash,
  };
  let started: ImportStageStatus;
  try {
    started = await apiFetch<ImportStageStatus>("/api/v1/imports/stage", {
      method: "POST",
      body: JSON.stringify(startBody),
    });
  } catch (error) {
    if (allowRestart && error instanceof Error && /prepared migration details changed/i.test(error.message)) {
      await cancelImportUpload(body.id);
      return stageImportInternal(body, onProgress, false);
    }
    throw error;
  }
  if (started.status === "activated" && started.completedBatch) {
    return started;
  }
  let uploadedCount = Math.min(started.receivedOperationCount, operations.length);
  onProgress?.(uploadedCount, operations.length);
  const links = new Map(operationLinks.map((link) => [link.operationId, link]));
  const uploadImportChunk = async (offset: number): Promise<void> => {
    const chunkOperations = operations.slice(offset, offset + 250);
    const chunk: ImportStageChunkRequest = {
      start: offset,
      operations: chunkOperations,
      operationLinks: chunkOperations.map((operation) => {
        const link = links.get(operation.id);
        if (!link) throw new Error("A migration operation is missing its source mapping");
        return link;
      }),
    };
    await uploadChunkWithRetry<ImportStageStatus>(`/api/v1/imports/${encodeURIComponent(body.id)}/chunks`, chunk);
    uploadedCount = Math.min(operations.length, uploadedCount + chunkOperations.length);
    onProgress?.(uploadedCount, operations.length);
  };
  if (started.receivedOperationCount < operations.length) {
    const groupOperationCount = operations.findIndex(({ type }) => type !== "GroupCreated");
    const sequentialOperationCount = groupOperationCount < 0 ? operations.length : groupOperationCount;
    const parallelOffsets: number[] = [];
    for (const offset of uploadChunkOffsets(
      resumableUploadRanges(started.missingRanges, started.receivedOperationCount, operations.length),
      operations.length,
    )) {
      if (offset < sequentialOperationCount) await uploadImportChunk(offset);
      else parallelOffsets.push(offset);
    }
    let nextOffset = 0;
    const worker = async (): Promise<void> => {
      while (nextOffset < parallelOffsets.length) {
        const offset = parallelOffsets[nextOffset++]!;
        await uploadImportChunk(offset);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, parallelOffsets.length) }, () => worker()));
  }
  return {
    ...started,
    status: "ready",
    receivedOperationCount: operations.length,
    missingRanges: [],
  };
}

export async function activateStagedImport(batchId: string): Promise<ImportActivationResult> {
  try {
    return await apiFetch<ImportActivationResult>(
      `/api/v1/imports/${encodeURIComponent(batchId)}/activate`,
      { method: "POST" },
      activationTimeoutMs,
    );
  } catch (error) {
    const recovered = mayHaveCompletedAfterError(error)
      ? await waitForImportStatus(batchId, "completed")
      : undefined;
    if (recovered) return { batch: recovered, duplicate: true, accepted: [] };
    throw error;
  }
}

export async function activateImport(body: ImportBatchCommitRequest): Promise<ImportActivationResult> {
  const staged = await stageImport(body);
  if (staged.status === "activated" && staged.completedBatch) {
    return { batch: staged.completedBatch, duplicate: true, accepted: [] };
  }
  return activateStagedImport(body.id);
}

export async function undoImport(
  batchId: string,
  body: ImportUndoRequest,
  onProgress?: (completed: number, total: number) => void,
): Promise<ImportUndoResult> {
  const serialized = JSON.stringify(body);
  if (body.operations.length <= 250 && new TextEncoder().encode(serialized).byteLength <= 3_500_000) {
    onProgress?.(0, body.operations.length);
    const result = await apiFetch<ImportUndoResult>(`/api/v1/imports/${encodeURIComponent(batchId)}/undo`, {
      method: "POST",
      body: serialized,
    });
    onProgress?.(body.operations.length, body.operations.length);
    return result;
  }
  return stageUndoImport(batchId, body, true, onProgress);
}

async function stageUndoImport(
  batchId: string,
  body: ImportUndoRequest,
  allowRestart: boolean,
  onProgress?: (completed: number, total: number) => void,
): Promise<ImportUndoResult> {
  const start: ImportUndoStageStartRequest = { expectedOperationCount: body.operations.length };
  const staged = await apiFetch<ImportUndoStageStatus>(
    `/api/v1/imports/${encodeURIComponent(batchId)}/undo-stage`,
    { method: "POST", body: JSON.stringify(start) },
  );
  if (staged.status === "undone" && staged.completedBatch) {
    return { batch: staged.completedBatch, duplicate: true, accepted: [] };
  }
  let uploadedCount = Math.min(staged.receivedOperationCount, body.operations.length);
  onProgress?.(uploadedCount, body.operations.length);
  if (staged.receivedOperationCount < body.operations.length) {
    const offsets = uploadChunkOffsets(
      resumableUploadRanges(staged.missingRanges, staged.receivedOperationCount, body.operations.length),
      body.operations.length,
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < offsets.length) {
        const offset = offsets[next++]!;
        const chunk: ImportUndoStageChunkRequest = {
          start: offset,
          operations: body.operations.slice(offset, offset + 250),
        };
        await uploadChunkWithRetry<ImportUndoStageStatus>(`/api/v1/imports/${encodeURIComponent(batchId)}/undo-chunks`, chunk);
        uploadedCount = Math.min(body.operations.length, uploadedCount + chunk.operations.length);
        onProgress?.(uploadedCount, body.operations.length);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, offsets.length) }, () => worker()));
    } catch (error) {
      if (allowRestart && error instanceof Error && /does not match the staged data/i.test(error.message)) {
        await cancelImportUndoUpload(batchId);
        return stageUndoImport(batchId, body, false, onProgress);
      }
      throw error;
    }
  }
  try {
    return await apiFetch<ImportUndoResult>(
      `/api/v1/imports/${encodeURIComponent(batchId)}/undo-activate`,
      { method: "POST" },
      activationTimeoutMs,
    );
  } catch (error) {
    const recovered = mayHaveCompletedAfterError(error)
      ? await waitForImportStatus(batchId, "undone")
      : undefined;
    if (recovered) return { batch: recovered, duplicate: true, accepted: [] };
    throw error;
  }
}

export function cancelImportUndoUpload(batchId: string): Promise<{ status: "cancelled" }> {
  return apiFetch(`/api/v1/imports/${encodeURIComponent(batchId)}/undo-cancel`, { method: "POST" });
}

export function cancelImportUpload(batchId: string): Promise<{ status: "cancelled" }> {
  return apiFetch(`/api/v1/imports/${encodeURIComponent(batchId)}/cancel`, { method: "POST" });
}

export function getImportIdentities(batchId: string): Promise<{ identities: ImportIdentitySummary[] }> {
  return apiFetch(`/api/v1/imports/${encodeURIComponent(batchId)}/identities`);
}

export function createImportClaimLink(batchId: string, identityId: string): Promise<{
  identityId: string;
  url: string;
  expiresAt: string;
}> {
  return apiFetch(
    `/api/v1/imports/${encodeURIComponent(batchId)}/identities/${encodeURIComponent(identityId)}/claim-link`,
    { method: "POST" },
  );
}

export function previewImportClaim(token: string): Promise<ImportClaimPreview> {
  return apiFetch("/api/v1/import-claims/preview", { method: "POST", body: JSON.stringify({ token }) });
}

export function reserveImportClaim(token: string, email: string): Promise<{ status: "reserved"; expiresAt: string }> {
  return apiFetch("/api/v1/import-claims/reserve", {
    method: "POST",
    body: JSON.stringify({ token, email }),
  });
}

export function requestImportClaimMagicLink(token: string, email: string): Promise<{ status: "verification-sent"; expiresAt: string }> {
  return apiFetch("/api/v1/import-claims/email", {
    method: "POST",
    body: JSON.stringify({ token, email }),
  });
}

export function claimImportedIdentity(token: string): Promise<ImportClaimResult> {
  return apiFetch("/api/v1/import-claims/claim", { method: "POST", body: JSON.stringify({ token }) });
}

export function getImportClaimStatus(requestId: string): Promise<ImportClaimStatus> {
  return apiFetch("/api/v1/import-claims/status", { method: "POST", body: JSON.stringify({ requestId }) });
}

export function approveImportIdentityClaim(identityId: string): Promise<ImportClaimResult> {
  return apiFetch(`/api/v1/import-identities/${encodeURIComponent(identityId)}/approve`, { method: "POST" });
}

export function rejectImportIdentityClaim(identityId: string): Promise<{ status: "rejected" }> {
  return apiFetch(`/api/v1/import-identities/${encodeURIComponent(identityId)}/reject`, { method: "POST" });
}

export function deleteImportSourceData(batchId: string): Promise<ImportBatchSummary> {
  return apiFetch(`/api/v1/imports/${encodeURIComponent(batchId)}/source-data/delete`, { method: "POST" });
}

export function startSplitwiseImport(): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: string }> {
  return apiFetch("/api/v1/imports/splitwise/start", { method: "POST" });
}

export function getSplitwiseSnapshot(sessionId: string): Promise<{ snapshot: Record<string, unknown> }> {
  return apiFetch("/api/v1/imports/splitwise/snapshot", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export function cancelSplitwiseImport(sessionId: string): Promise<void> {
  return apiFetch("/api/v1/imports/splitwise/cancel", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
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
