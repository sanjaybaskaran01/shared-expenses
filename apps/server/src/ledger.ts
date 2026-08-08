import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  canonicalJson,
  importPreparationMaterial,
  isOperationType,
  operationContentHash,
  sha256Hex,
  type ImportActivationResult,
  type ImportBatchCommitRequest,
  type ImportBatchSummary,
  type ImportClaimLink,
  type ImportClaimPreview,
  type ImportClaimResult,
  type ImportClaimStatus,
  type ImportIdentitySummary,
  type ImportIdentityResolutionRequest,
  type ImportIdentityResolutionResult,
  type ImportStageChunkRequest,
  type ImportStageStartRequest,
  type ImportStageStatus,
  type ImportUndoRequest,
  type ImportUndoResult,
  type ImportUndoStageChunkRequest,
  type ImportUndoStageStartRequest,
  type ImportUndoStageStatus,
  type JsonValue,
  type OperationEnvelope,
  type ParticipantAmount,
  type SyncPushResult,
  validateExactAllocation,
} from "@expenses/protocol";
import { decryptServerValue, encryptServerValue, keyedDigest } from "./security-keys";

interface DeviceRow {
  id: string;
  user_id: string;
  public_key_jwk: string;
  status: "active" | "revoked";
}

interface OperationRow {
  server_sequence: number;
  id: string;
  group_id: string;
  actor_id: string;
  device_id: string;
  type: string;
  target_id: string;
  base_version: number;
  client_timestamp: string;
  payload_json: string;
  content_hash: string;
  signature: string;
  received_at: string;
}

interface ExpensePayload {
  description: string;
  category: string;
  amountMinor: number;
  currency: string;
  expenseDate: string;
  notes: string;
  payers: Array<{ participantId: string; amountMinor: number }>;
  allocations: Array<{ participantId: string; amountMinor: number }>;
}

interface ParsedImportMetadata {
  importBatchId: string;
  sourceProvider: "splitwise";
  sourceRecordId: string;
  importedAt: string;
  importedByDisplayName: string;
  sourceDeleted: boolean;
}

interface ImportEffect {
  participantId: string;
  amountMinor: number;
}

const versionedTypes = new Set([
  "ExpenseCreated",
  "ExpenseAmended",
  "ExpenseVoided",
  "ExpenseRestored",
  "PaymentRecorded",
  "PaymentReversed",
  "ImportedTransactionRecorded",
  "ImportedTransactionVoided",
  "OpeningBalanceCreated",
  "OpeningBalanceVoided",
  "GroupCurrencyChanged",
  "ConflictResolved",
]);

const stagedUploadLimitBytes = 192 * 1024 * 1024;
const globalStagedUploadLimitBytes = 768 * 1024 * 1024;

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Operation payload must be a JSON object");
  }
  return value;
}

function requiredString(payload: Record<string, JsonValue>, key: string, max = 500): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${key} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function optionalString(payload: Record<string, JsonValue>, key: string, max = 5_000): string {
  const value = payload[key] ?? "";
  if (typeof value !== "string" || value.length > max) {
    throw new TypeError(`${key} must be a string of at most ${max} characters`);
  }
  return value;
}

function requiredMinor(payload: Record<string, JsonValue>, key: string, allowZero = false): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    throw new TypeError(`${key} must be ${allowZero ? "a non-negative" : "a positive"} minor-unit integer`);
  }
  return Number(value);
}

function requiredCurrency(payload: Record<string, JsonValue>, key: string): string {
  const currency = requiredString(payload, key, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError(`${key} must be a three-letter ISO code`);
  return currency;
}

function participantAmounts(payload: Record<string, JsonValue>, key: string): ParticipantAmount[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${key} must be a non-empty array`);
  return value.map((entry) => {
    const object = jsonObject(entry);
    return {
      participantId: requiredString(object, "participantId", 100),
      amountMinor: requiredMinor(object, "amountMinor", true),
    };
  });
}

function parseExpensePayload(value: JsonValue): ExpensePayload {
  const payload = jsonObject(value);
  const amountMinor = requiredMinor(payload, "amountMinor");
  const payers = validateExactAllocation(amountMinor, participantAmounts(payload, "payers"));
  const allocations = validateExactAllocation(amountMinor, participantAmounts(payload, "allocations"));
  const currency = requiredCurrency(payload, "currency");
  return {
    description: requiredString(payload, "description", 200),
    category: requiredString(payload, "category", 100),
    amountMinor,
    currency,
    expenseDate: requiredString(payload, "expenseDate", 32),
    notes: optionalString(payload, "notes"),
    payers,
    allocations,
  };
}

function parseImportMetadata(payload: Record<string, JsonValue>): ParsedImportMetadata | null {
  const value = payload.import;
  if (value === undefined) return null;
  const metadata = jsonObject(value);
  const sourceProvider = requiredString(metadata, "sourceProvider", 30);
  if (sourceProvider !== "splitwise") throw new TypeError("sourceProvider must be splitwise");
  if (metadata.sourceMetadata !== undefined) {
    throw new TypeError("Provider source metadata must not be embedded in shared ledger operations");
  }
  const importedAt = requiredString(metadata, "importedAt", 40);
  if (!Number.isFinite(Date.parse(importedAt))) throw new TypeError("importedAt must be a valid timestamp");
  if (metadata.readOnly !== true) throw new TypeError("Imported records must be read-only");
  return {
    importBatchId: requiredString(metadata, "importBatchId", 100),
    sourceProvider,
    sourceRecordId: requiredString(metadata, "sourceRecordId", 300),
    importedAt,
    importedByDisplayName: requiredString(metadata, "importedByDisplayName", 100),
    sourceDeleted: metadata.sourceDeleted === true,
  };
}

function importEffects(payload: Record<string, JsonValue>): ImportEffect[] {
  const value = payload.effects;
  if (!Array.isArray(value) || value.length < 2 || value.length > 100) {
    throw new TypeError("effects must contain between 2 and 100 people");
  }
  const seen = new Set<string>();
  const effects = value.map((entry) => {
    const object = jsonObject(entry);
    const participantId = requiredString(object, "participantId", 100);
    const amountMinor = object.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) === 0) {
      throw new TypeError("effect amounts must be non-zero minor-unit integers");
    }
    if (seen.has(participantId)) throw new TypeError("effect participants must be unique");
    seen.add(participantId);
    return { participantId, amountMinor: Number(amountMinor) };
  });
  if (effects.reduce((sum, effect) => sum + effect.amountMinor, 0) !== 0) {
    throw new TypeError("effects must add to zero");
  }
  return effects;
}

export class LedgerStore {
  private readonly verificationKeys = new Map<string, Promise<CryptoKey>>();

  constructor(
    private readonly db: Database,
    private readonly options: { emailHashSecret?: string } = {},
  ) {}

  private get rootSecret(): string {
    return this.options.emailHashSecret ?? "test-only-import-email-hash-secret";
  }

  private secretHash(purpose: string, value: string): string {
    return keyedDigest(this.rootSecret, purpose, value);
  }

  private emailHash(value: string): string {
    return this.secretHash("identity-email", value.trim().toLowerCase());
  }

  private importExternalIdHash(provider: string, externalType: string, externalId: string): string {
    return this.secretHash("import-external-id", `${provider}:${externalType}:${externalId}`);
  }

  private importSemanticIdHash(provider: string, semanticId: string): string {
    return this.secretHash("import-semantic-id", `${provider}:${semanticId}`);
  }

  private encryptImportEnvelope(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-envelope", value);
  }

  private decryptImportEnvelope(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-envelope", value);
  }

  private encryptImportStagedSource(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-source", value);
  }

  private decryptImportStagedSource(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-source", value);
  }

  private encryptImportStagedOperation(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-operation", value);
  }

  private decryptImportStagedOperation(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-operation", value);
  }

  private encryptImportStagedSemantic(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-semantic", value);
  }

  private decryptImportStagedSemantic(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-semantic", value);
  }

  private encryptImportStagedUndo(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-undo", value);
  }

  private decryptImportStagedUndo(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-undo", value);
  }

  private missingStageRanges(batchId: string, expected: number, undo = false): Array<{ start: number; endExclusive: number }> {
    const ordinals = (undo
      ? this.db.query<{ ordinal: number }, [string]>(
        "SELECT ordinal FROM import_staged_undo_operations WHERE batch_id = ? ORDER BY ordinal",
      ).all(batchId)
      : this.db.query<{ ordinal: number }, [string]>(
        "SELECT ordinal FROM import_staged_operations WHERE batch_id = ? ORDER BY ordinal",
      ).all(batchId)).map(({ ordinal }) => ordinal);
    const ranges: Array<{ start: number; endExclusive: number }> = [];
    let cursor = 0;
    for (const ordinal of ordinals) {
      if (ordinal > cursor) ranges.push({ start: cursor, endExclusive: ordinal });
      if (ordinal >= cursor) cursor = ordinal + 1;
    }
    if (cursor < expected) ranges.push({ start: cursor, endExclusive: expected });
    return ranges;
  }

  private assertGlobalStagingCapacity(addedBytes: number): void {
    if (addedBytes <= 0) return;
    const importBytes = this.db.query<{ total: number }, []>(
      "SELECT COALESCE(SUM(payload_bytes), 0) AS total FROM import_uploads WHERE status IN ('staging', 'ready', 'activating')",
    ).get()?.total ?? 0;
    const undoBytes = this.db.query<{ total: number }, []>(
      "SELECT COALESCE(SUM(payload_bytes), 0) AS total FROM import_undo_uploads WHERE status IN ('staging', 'ready', 'activating')",
    ).get()?.total ?? 0;
    if (importBytes + undoBytes + addedBytes > globalStagedUploadLimitBytes) {
      throw new TypeError("Temporary migration storage is full. Finish, cancel, or wait for another upload to expire.");
    }
  }

  get generation(): string {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM app_meta WHERE key = 'generation'").get();
    if (!row) throw new Error("Missing server generation");
    return row.value;
  }

  get latestSequence(): number {
    return (
      this.db.query<{ sequence: number }, []>("SELECT COALESCE(MAX(server_sequence), 0) AS sequence FROM operations").get()
        ?.sequence ?? 0
    );
  }

  /**
   * The global sequence leaks the existence and write rate of groups the caller
   * is not in, so every actor-facing response uses this scoped maximum instead.
   */
  latestSequenceFor(actorId: string): number {
    return (
      this.db
        .query<{ sequence: number }, [string]>(
          `SELECT COALESCE(MAX(o.server_sequence), 0) AS sequence FROM operations o
           JOIN group_members gm ON gm.group_id = o.group_id
           WHERE gm.user_id = ? AND gm.status = 'active' AND o.status = 'accepted'`,
        )
        .get(actorId)?.sequence ?? 0
    );
  }

  activeMemberIdsForGroups(groupIds: readonly string[]): string[] {
    const actorIds = new Set<string>();
    for (const groupId of new Set(groupIds)) {
      const rows = this.db.query<{ user_id: string }, [string]>(
        "SELECT user_id FROM group_members WHERE group_id = ? AND status = 'active'",
      ).all(groupId);
      for (const { user_id } of rows) actorIds.add(user_id);
    }
    return [...actorIds].sort();
  }

  bootstrapGroup(input: {
    id: string;
    name: string;
    settlementCurrency: string;
    userId: string;
    displayName: string;
    email?: string;
  }): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT OR IGNORE INTO groups(id, name, settlement_currency, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(input.id, input.name, input.settlementCurrency, input.userId, now);
      this.db
        .query(
          `INSERT OR IGNORE INTO group_members(
            group_id, user_id, display_name, email, status, joined_at
          ) VALUES (?, ?, ?, ?, 'active', ?)`,
        )
        .run(input.id, input.userId, input.displayName, input.email ?? null, now);
    })();
  }

  registerDevice(input: {
    id: string;
    userId: string;
    publicKeyJwk: JsonWebKey;
    encryptionPublicKeyJwk?: JsonWebKey;
    name: string;
  }): void {
    const existing = this.db
      .query<{ user_id: string; public_key_jwk: string; encryption_public_key_jwk: string | null }, [string]>(
        "SELECT user_id, public_key_jwk, encryption_public_key_jwk FROM devices WHERE id = ?",
      )
      .get(input.id);
    if (existing && existing.user_id !== input.userId) {
      throw new Error("Device id is already owned by another account");
    }
    if (existing && existing.public_key_jwk !== JSON.stringify(input.publicKeyJwk)) {
      throw new Error("Device public key cannot be replaced");
    }
    if (
      existing?.encryption_public_key_jwk &&
      input.encryptionPublicKeyJwk &&
      existing.encryption_public_key_jwk !== JSON.stringify(input.encryptionPublicKeyJwk)
    ) {
      throw new Error("Device encryption key cannot be replaced");
    }
    this.db
      .query(
        `INSERT INTO devices(id, user_id, public_key_jwk, encryption_public_key_jwk, name, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)
         ON CONFLICT(id) DO UPDATE SET
           public_key_jwk = excluded.public_key_jwk,
           encryption_public_key_jwk = COALESCE(devices.encryption_public_key_jwk, excluded.encryption_public_key_jwk),
           name = excluded.name,
           status = 'active',
           revoked_at = NULL`,
      )
      .run(
        input.id,
        input.userId,
        JSON.stringify(input.publicKeyJwk),
        input.encryptionPublicKeyJwk ? JSON.stringify(input.encryptionPublicKeyJwk) : null,
        input.name,
        new Date().toISOString(),
      );
  }

  private isActiveMember(groupId: string, userId: string): boolean {
    return Boolean(
      this.db
        .query<{ one: number }, [string, string]>(
          "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'active'",
        )
        .get(groupId, userId),
    );
  }

  private assertActiveParticipants(groupId: string, label: string, participants: readonly ParticipantAmount[]): void {
    for (const participant of participants) {
      if (!this.isActiveMember(groupId, participant.participantId)) {
        throw new TypeError(`${label} contains a non-member`);
      }
    }
  }

  private assertFinancialParticipants(
    groupId: string,
    label: string,
    participants: readonly ParticipantAmount[],
    allowPlaceholders: boolean,
  ): void {
    for (const participant of participants) {
      const membership = this.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1",
      ).get(groupId, participant.participantId);
      if (!membership || (membership.status !== "active" && !(allowPlaceholders && membership.status === "placeholder"))) {
        throw new TypeError(`${label} contains a non-member`);
      }
    }
  }

  private async verifyOperation(
    actorId: string,
    operation: OperationEnvelope,
    plannedGroupIds: ReadonlySet<string> = new Set(),
  ): Promise<string | null> {
    if (
      !operation ||
      typeof operation.id !== "string" ||
      operation.id.length === 0 ||
      operation.id.length > 100 ||
      typeof operation.groupId !== "string" ||
      operation.groupId.length === 0 ||
      operation.groupId.length > 100 ||
      typeof operation.deviceId !== "string" ||
      operation.deviceId.length === 0 ||
      operation.deviceId.length > 100 ||
      typeof operation.targetId !== "string" ||
      operation.targetId.length === 0 ||
      operation.targetId.length > 100 ||
      !Number.isSafeInteger(operation.baseVersion) ||
      operation.baseVersion < 0 ||
      typeof operation.clientTimestamp !== "string" ||
      !Number.isFinite(Date.parse(operation.clientTimestamp)) ||
      typeof operation.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(operation.contentHash) ||
      typeof operation.signature !== "string" ||
      operation.signature.length > 512
    ) {
      return "INVALID_ENVELOPE";
    }
    if (operation.actorId !== actorId) return "ACTOR_MISMATCH";
    if (!isOperationType(operation.type)) return "UNKNOWN_OPERATION_TYPE";
    if (operation.type !== "GroupCreated" && !this.isActiveMember(operation.groupId, actorId) && !plannedGroupIds.has(operation.groupId)) {
      return "NOT_A_GROUP_MEMBER";
    }
    const device = this.db
      .query<DeviceRow, [string]>("SELECT id, user_id, public_key_jwk, status FROM devices WHERE id = ?")
      .get(operation.deviceId);
    if (!device || device.user_id !== actorId || device.status !== "active") return "DEVICE_NOT_TRUSTED";

    const expectedHash = await operationContentHash({
      id: operation.id,
      groupId: operation.groupId,
      actorId: operation.actorId,
      deviceId: operation.deviceId,
      type: operation.type,
      targetId: operation.targetId,
      baseVersion: operation.baseVersion,
      clientTimestamp: operation.clientTimestamp,
      payload: operation.payload,
    });
    if (expectedHash !== operation.contentHash) return "CONTENT_HASH_MISMATCH";

    try {
      const cacheKey = `${device.id}:${device.public_key_jwk}`;
      let keyPromise = this.verificationKeys.get(cacheKey);
      if (!keyPromise) {
        keyPromise = crypto.subtle.importKey(
          "jwk",
          JSON.parse(device.public_key_jwk) as JsonWebKey,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        if (this.verificationKeys.size >= 100) this.verificationKeys.clear();
        this.verificationKeys.set(cacheKey, keyPromise);
      }
      const key = await keyPromise;
      const valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        decodeBase64Url(operation.signature),
        new TextEncoder().encode(operation.contentHash),
      );
      return valid ? null : "INVALID_SIGNATURE";
    } catch {
      return "INVALID_SIGNATURE";
    }
  }

  private async verifyImportOperationBatch(
    actorId: string,
    operations: readonly OperationEnvelope[],
    plannedGroupIds: ReadonlySet<string> = new Set(),
    label = "Import",
  ): Promise<void> {
    const errors = new Array<string | null>(operations.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < operations.length) {
        const index = next++;
        errors[index] = await this.verifyOperation(actorId, operations[index]!, plannedGroupIds);
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, operations.length) }, () => worker()));
    const firstError = errors.find((error) => error !== null);
    if (firstError) throw new TypeError(`${label} operation verification failed: ${firstError}`);
  }

  private assertImportActivationAuthorization(
    actorId: string,
    operations: readonly OperationEnvelope[],
    plannedGroupIds: ReadonlySet<string>,
  ): void {
    const deviceIds = new Set<string>();
    for (const operation of operations) {
      if (operation.actorId !== actorId) throw new TypeError("Import operation actor does not match the signed-in account");
      if (!plannedGroupIds.has(operation.groupId)) {
        throw new TypeError("Every imported record must belong to a group created by this migration");
      }
      deviceIds.add(operation.deviceId);
    }
    if (deviceIds.size !== 1) throw new TypeError("An import must be signed by one trusted device");
    const deviceId = [...deviceIds][0]!;
    const device = this.db.query<Pick<DeviceRow, "user_id" | "status">, [string]>(
      "SELECT user_id, status FROM devices WHERE id = ? LIMIT 1",
    ).get(deviceId);
    if (!device || device.user_id !== actorId || device.status !== "active") {
      throw new TypeError("The device that signed this migration is no longer trusted");
    }
  }

  async push(actorId: string, operations: readonly OperationEnvelope[]): Promise<SyncPushResult> {
    const result: SyncPushResult = {
      accepted: [],
      duplicates: [],
      conflicts: [],
      rejected: [],
      latestServerSequence: this.latestSequenceFor(actorId),
      generation: this.generation,
    };

    if (operations.length > 100) {
      result.rejected.push({ id: "batch", code: "BATCH_TOO_LARGE", message: "A sync batch may contain at most 100 operations" });
      return result;
    }

    for (const operation of operations) {
      const existing = this.db
        .query<{ server_sequence: number }, [string]>("SELECT server_sequence FROM operations WHERE id = ?")
        .get(operation.id);
      if (existing) {
        result.duplicates.push({ id: operation.id, serverSequence: existing.server_sequence });
        continue;
      }

      const verificationError = await this.verifyOperation(actorId, operation);
      if (verificationError) {
        result.rejected.push({ id: operation.id, code: verificationError, message: "Operation verification failed" });
        continue;
      }

      try {
        const outcome = this.db.transaction(() => this.ingestVerified(operation))();
        if (outcome.kind === "accepted") {
          result.accepted.push({ id: operation.id, serverSequence: outcome.serverSequence });
        } else {
          result.conflicts.push({
            id: operation.id,
            conflictId: outcome.conflictId,
            currentVersion: outcome.currentVersion,
          });
        }
      } catch (error) {
        result.rejected.push({
          id: operation.id,
          code: "INVALID_OPERATION",
          message: error instanceof Error ? error.message : "Invalid operation",
        });
      }
    }

    result.latestServerSequence = this.latestSequenceFor(actorId);
    return result;
  }

  private importBatchSummary(batchId: string, actorId: string): ImportBatchSummary {
    const row = this.db.query<{
      id: string;
      provider: "splitwise";
      mode: ImportBatchSummary["mode"];
      status: ImportBatchSummary["status"];
      rollback_status: ImportBatchSummary["rollbackStatus"];
      started_at: string;
      completed_at: string | null;
      undone_at: string | null;
      source_data_deleted_at: string | null;
      group_count: number;
      record_count: number;
      warning_count: number;
    }, [string, string]>(
      `SELECT b.id, b.provider, b.mode, b.status, b.rollback_status, b.started_at,
              b.completed_at, b.undone_at, b.source_data_deleted_at,
              (SELECT COUNT(*) FROM import_external_mappings m WHERE m.batch_id = b.id AND m.external_type = 'group') AS group_count,
              (SELECT COUNT(*) FROM import_external_mappings m WHERE m.batch_id = b.id AND m.external_type = 'record') AS record_count,
              json_array_length(b.warnings_json) AS warning_count
       FROM import_batches b WHERE b.id = ? AND b.imported_by = ? LIMIT 1`,
    ).get(batchId, actorId);
    if (!row || !["completed", "undone", "cancelled"].includes(row.status)) throw new Error("Import batch is unavailable");
    return {
      id: row.id,
      provider: row.provider,
      mode: row.mode,
      status: row.status,
      rollbackStatus: row.rollback_status,
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.undone_at ? { undoneAt: row.undone_at } : {}),
      ...(row.source_data_deleted_at ? { sourceDataDeletedAt: row.source_data_deleted_at } : {}),
      groupCount: row.group_count,
      recordCount: row.record_count,
      warningCount: row.warning_count,
    };
  }

  listImports(actorId: string): ImportBatchSummary[] {
    const ids = this.db.query<{ id: string }, [string]>(
      `SELECT id FROM import_batches
       WHERE imported_by = ? AND status IN ('completed', 'undone', 'cancelled')
       ORDER BY started_at DESC`,
    ).all(actorId);
    return ids.map(({ id }) => this.importBatchSummary(id, actorId));
  }

  /**
   * A process restart proves that no activation from the prior process is
   * still running. Return claimed uploads to their retry-safe ready state.
   */
  recoverInterruptedImportActivations(): { imports: number; undos: number } {
    const imports = this.db.query(
      "UPDATE import_uploads SET status = 'ready' WHERE status = 'activating'",
    ).run().changes;
    const undos = this.db.query(
      "UPDATE import_undo_uploads SET status = 'ready' WHERE status = 'activating'",
    ).run().changes;
    return { imports, undos };
  }

  groupIdsForImportBatch(actorId: string, batchId: string): string[] {
    return this.db.query<{ local_id: string }, [string, string]>(
      `SELECT DISTINCT m.local_id FROM import_external_mappings m
       JOIN import_batches b ON b.id = m.batch_id
       WHERE m.batch_id = ? AND b.imported_by = ? AND m.external_type = 'group'`,
    ).all(batchId, actorId).map(({ local_id }) => local_id);
  }

  pruneExpiredImportUploads(now = new Date()): { imports: number; undos: number } {
    const timestamp = now.toISOString();
    const staleActivation = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const imports = this.db.query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count FROM import_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready', 'expired', 'cancelled'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).get(timestamp, staleActivation)?.count ?? 0;
    this.db.query(
      `DELETE FROM import_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready', 'expired', 'cancelled'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).run(timestamp, staleActivation);
    const undos = this.db.query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count FROM import_undo_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).get(timestamp, staleActivation)?.count ?? 0;
    this.db.query(
      `DELETE FROM import_undo_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).run(timestamp, staleActivation);
    return { imports, undos };
  }

  private activeImportRecordCount(batchId: string): number {
    return this.db.query<{ count: number }, [string, string, string]>(
      `SELECT (
         (SELECT COUNT(*) FROM expenses WHERE import_batch_id = ? AND status = 'active') +
         (SELECT COUNT(*) FROM payments WHERE import_batch_id = ? AND status = 'active') +
         (SELECT COUNT(*) FROM imported_transactions WHERE batch_id = ? AND status = 'active')
       ) AS count`,
    ).get(batchId, batchId, batchId)?.count ?? 0;
  }

  startImportStage(actorId: string, request: ImportStageStartRequest): ImportStageStatus {
    const { batch } = request;
    if (
      !/^[0-9a-f-]{36}$/.test(batch.id) ||
      !/^[a-f0-9]{64}$/.test(batch.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(request.preparationHash)
    ) {
      throw new TypeError("Import batch identity is invalid");
    }
    if (batch.provider !== "splitwise" || !["current", "history", "balances", "custom"].includes(batch.mode)) {
      throw new TypeError("Import provider or mode is invalid");
    }
    if (
      !Number.isSafeInteger(request.expectedOperationCount) ||
      request.expectedOperationCount <= 0 ||
      request.expectedOperationCount > 100_500 ||
      batch.sourceHashes.length > 20 ||
      batch.sourceHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
      batch.identities.length > 500
    ) {
      throw new TypeError("Import size is outside the supported limit");
    }
    if (!batch.reconciliation.zeroSum || batch.reconciliation.blockingWarnings.length > 0) {
      throw new TypeError("Resolve every migration check before uploading the import");
    }
    const completed = this.db.query<{ id: string }, [string, string, string]>(
      `SELECT id FROM import_batches WHERE imported_by = ? AND provider = ? AND fingerprint = ?
       AND status IN ('completed', 'undone', 'cancelled') LIMIT 1`,
    ).get(actorId, batch.provider, batch.fingerprint);
    if (completed) {
      return {
        batchId: completed.id,
        expectedOperationCount: request.expectedOperationCount,
        receivedOperationCount: request.expectedOperationCount,
        status: "activated",
        expiresAt: new Date().toISOString(),
        missingRanges: [],
        completedBatch: this.importBatchSummary(completed.id, actorId),
      };
    }
    const now = new Date();
    this.pruneExpiredImportUploads(now);
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const existing = this.db.query<{
      batch_id: string;
      expected_operation_count: number;
      status: "staging" | "ready" | "activating";
      expires_at: string;
      received: number;
      preparation_hash: string;
    }, [string, string]>(
      `SELECT u.batch_id, u.expected_operation_count, u.status, u.expires_at, u.preparation_hash,
              (SELECT COUNT(*) FROM import_staged_operations s WHERE s.batch_id = u.batch_id) AS received
       FROM import_uploads u WHERE u.actor_id = ? AND u.fingerprint = ? LIMIT 1`,
    ).get(actorId, batch.fingerprint);
    if (existing) {
      if (existing.batch_id !== batch.id || existing.expected_operation_count !== request.expectedOperationCount) {
        throw new TypeError("A different upload already uses this import fingerprint");
      }
      if (existing.preparation_hash !== request.preparationHash) {
        throw new TypeError("Prepared migration details changed; restart the earlier upload");
      }
      if (existing.status === "activating") throw new Error("This migration is already activating");
      return {
        batchId: existing.batch_id,
        expectedOperationCount: existing.expected_operation_count,
        receivedOperationCount: existing.received,
        status: existing.status,
        expiresAt: existing.expires_at,
        missingRanges: this.missingStageRanges(existing.batch_id, existing.expected_operation_count),
      };
    }
    const activeUploadCount = this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM import_uploads
       WHERE actor_id = ? AND status IN ('staging', 'ready', 'activating')`,
    ).get(actorId)?.count ?? 0;
    if (activeUploadCount >= 2) {
      throw new Error("Finish or cancel an existing migration upload before starting another");
    }
    const serializedEnvelope = JSON.stringify(batch);
    if (new TextEncoder().encode(serializedEnvelope).byteLength > 2_000_000) {
      throw new TypeError("Import review data is too large");
    }
    const encryptedEnvelope = this.encryptImportEnvelope(serializedEnvelope);
    const envelopeBytes = new TextEncoder().encode(encryptedEnvelope).byteLength;
    this.db.transaction(() => {
      this.assertGlobalStagingCapacity(envelopeBytes);
      this.db.query(
        `INSERT INTO import_uploads(
           batch_id, actor_id, fingerprint, envelope_json, expected_operation_count,
           status, created_at, expires_at, payload_bytes, preparation_hash
         ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?)`,
      ).run(
        batch.id,
        actorId,
        batch.fingerprint,
        encryptedEnvelope,
        request.expectedOperationCount,
        now.toISOString(),
        expiresAt,
        envelopeBytes,
        request.preparationHash,
      );
    })();
    return {
      batchId: batch.id,
      expectedOperationCount: request.expectedOperationCount,
      receivedOperationCount: 0,
      status: "staging",
      expiresAt,
      missingRanges: [{ start: 0, endExclusive: request.expectedOperationCount }],
    };
  }

  async stageImportOperations(
    actorId: string,
    batchId: string,
    request: ImportStageChunkRequest,
  ): Promise<ImportStageStatus> {
    if (
      !Number.isSafeInteger(request.start) ||
      request.start < 0 ||
      request.operations.length === 0 ||
      request.operations.length > 250 ||
      request.operationLinks.length !== request.operations.length
    ) {
      throw new TypeError("An import chunk must contain 1 to 250 mapped operations");
    }
    const upload = this.db.query<{
      expected_operation_count: number;
      status: "staging" | "ready";
      expires_at: string;
      payload_bytes: number;
    }, [string, string]>(
      `SELECT expected_operation_count, status, expires_at, payload_bytes FROM import_uploads
       WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
    ).get(batchId, actorId);
    if (!upload || Date.parse(upload.expires_at) <= Date.now()) throw new Error("Import upload is unavailable or expired");
    if (request.start + request.operations.length > upload.expected_operation_count) {
      throw new TypeError("Import chunk exceeds the declared operation count");
    }
    const links = new Map(request.operationLinks.map((link) => [link.operationId, link]));
    if (links.size !== request.operations.length) throw new TypeError("Every staged operation needs one unique source mapping");
    const plannedGroupIds = new Set([
      ...this.db.query<{ group_id: string }, [string]>(
        "SELECT DISTINCT group_id FROM import_staged_operations WHERE batch_id = ? AND operation_type = 'GroupCreated'",
      ).all(batchId).map(({ group_id }) => group_id),
      ...request.operations.filter(({ type }) => type === "GroupCreated").map(({ groupId }) => groupId),
    ]);
    for (const operation of request.operations) {
      const link = links.get(operation.id);
      if (!link || !["group", "record"].includes(link.externalType) || !link.externalId) {
        throw new TypeError("Import operation mappings are invalid");
      }
      if ((link.externalType === "group") !== (operation.type === "GroupCreated")) {
        throw new TypeError("Import mapping type does not match its operation");
      }
      if (link.externalType === "record" && (
        !["provider_id", "csv_candidate"].includes(link.dedupeStrategy ?? "") ||
        !/^[a-f0-9]{64}$/.test(link.semanticId ?? "")
      )) {
        throw new TypeError("Import semantic mapping is invalid");
      }
      const sourceMetadataJson = link.sourceMetadata === undefined ? null : JSON.stringify(link.sourceMetadata);
      if (sourceMetadataJson && new TextEncoder().encode(sourceMetadataJson).byteLength > 10_000) {
        throw new TypeError("Import source metadata is too large");
      }
      if (!["GroupCreated", "ExpenseCreated", "PaymentRecorded", "ImportedTransactionRecorded", "OpeningBalanceCreated"].includes(operation.type)) {
        throw new TypeError("An import contains an unsupported operation");
      }
      const verificationError = await this.verifyOperation(actorId, operation, plannedGroupIds);
      if (verificationError) throw new TypeError(`Import operation verification failed: ${verificationError}`);
    }
    this.db.transaction(() => {
      const currentUpload = this.db.query<{ payload_bytes: number }, [string, string]>(
        `SELECT payload_bytes FROM import_uploads
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
      ).get(batchId, actorId);
      if (!currentUpload) throw new Error("Import upload is unavailable");
      let addedBytes = 0;
      for (let index = 0; index < request.operations.length; index += 1) {
        const ordinal = request.start + index;
        const operation = request.operations[index]!;
        const link = links.get(operation.id)!;
        const existing = this.db.query<{
          operation_id: string;
          content_hash: string;
          external_type: string;
          external_id: string;
          semantic_id: string | null;
          dedupe_strategy: string | null;
          source_metadata_json: string | null;
        }, [string, number]>(
          `SELECT operation_id, content_hash, external_type, external_id, semantic_id, dedupe_strategy, source_metadata_json
           FROM import_staged_operations WHERE batch_id = ? AND ordinal = ? LIMIT 1`,
        ).get(batchId, ordinal);
        const sourceMetadataJson = link.sourceMetadata === undefined ? null : JSON.stringify(link.sourceMetadata);
        const operationJson = JSON.stringify(operation);
        const encryptedOperation = this.encryptImportStagedOperation(operationJson);
        const encryptedExternalId = this.encryptImportStagedSource(link.externalId);
        const encryptedSemanticId = link.semanticId ? this.encryptImportStagedSemantic(link.semanticId) : null;
        const encryptedSourceMetadata = sourceMetadataJson ? this.encryptImportStagedSource(sourceMetadataJson) : null;
        const rowBytes = new TextEncoder().encode(encryptedOperation).byteLength
          + (encryptedSourceMetadata ? new TextEncoder().encode(encryptedSourceMetadata).byteLength : 0)
          + new TextEncoder().encode(encryptedExternalId).byteLength
          + (encryptedSemanticId ? new TextEncoder().encode(encryptedSemanticId).byteLength : 0);
        if (rowBytes > 512_000) throw new TypeError("An import operation is too large");
        if (existing) {
          if (
            existing.operation_id !== operation.id ||
            existing.content_hash !== operation.contentHash ||
            existing.external_type !== link.externalType ||
            this.decryptImportStagedSource(existing.external_id) !== link.externalId ||
            (existing.semantic_id ? this.decryptImportStagedSemantic(existing.semantic_id) : null) !== (link.semanticId ?? null) ||
            existing.dedupe_strategy !== (link.dedupeStrategy ?? null) ||
            (existing.source_metadata_json ? this.decryptImportStagedSource(existing.source_metadata_json) : null) !== sourceMetadataJson
          ) throw new TypeError("A retried import chunk does not match the staged data");
          continue;
        }
        addedBytes += rowBytes;
        this.db.query(
          `INSERT INTO import_staged_operations(
             batch_id, ordinal, operation_id, content_hash, operation_json, operation_type,
             group_id, external_type, external_id, semantic_id, dedupe_strategy, source_metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          batchId,
          ordinal,
          operation.id,
          operation.contentHash,
          encryptedOperation,
          operation.type,
          operation.groupId,
          link.externalType,
          encryptedExternalId,
          encryptedSemanticId,
          link.dedupeStrategy ?? null,
          encryptedSourceMetadata,
        );
      }
      const received = this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
      ).get(batchId)?.count ?? 0;
      this.assertGlobalStagingCapacity(addedBytes);
      const reserved = this.db.query(
        `UPDATE import_uploads SET status = ?, payload_bytes = payload_bytes + ?
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') AND payload_bytes <= ?`,
      ).run(
        received === upload.expected_operation_count ? "ready" : "staging",
        addedBytes,
        batchId,
        actorId,
        stagedUploadLimitBytes - addedBytes,
      );
      if (reserved.changes !== 1) throw new TypeError("Import upload exceeds the 192 MiB staged-data limit");
    })();
    const receivedOperationCount = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(batchId)?.count ?? 0;
    return {
      batchId,
      expectedOperationCount: upload.expected_operation_count,
      receivedOperationCount,
      status: receivedOperationCount === upload.expected_operation_count ? "ready" : "staging",
      expiresAt: upload.expires_at,
    };
  }

  async activateImportStage(actorId: string, batchId: string): Promise<ImportActivationResult> {
    const upload = this.db.query<{
      envelope_json: string;
      expected_operation_count: number;
      preparation_hash: string;
      status: string;
    }, [string, string]>(
      "SELECT envelope_json, expected_operation_count, preparation_hash, status FROM import_uploads WHERE batch_id = ? AND actor_id = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!upload) {
      const completed = this.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
      ).get(batchId, actorId);
      if (completed && ["completed", "undone", "cancelled"].includes(completed.status)) {
        return { batch: this.importBatchSummary(batchId, actorId), duplicate: true, accepted: [] };
      }
      throw new Error("Import upload is unavailable");
    }
    if (upload.status !== "ready") throw new Error("Import upload is incomplete");
    const rows = this.db.query<{
      ordinal: number;
      operation_id: string;
      content_hash: string;
      group_id: string;
      operation_json: string;
      external_type: "group" | "record";
      external_id: string;
      semantic_id: string | null;
      dedupe_strategy: "provider_id" | "csv_candidate" | null;
      source_metadata_json: string | null;
    }, [string]>(
      `SELECT ordinal, operation_id, content_hash, group_id, operation_json, external_type, external_id, semantic_id, dedupe_strategy, source_metadata_json FROM import_staged_operations
       WHERE batch_id = ? ORDER BY ordinal`,
    ).all(batchId);
    if (rows.length !== upload.expected_operation_count || rows.some((row, index) => row.ordinal !== index)) {
      throw new Error("Import upload is incomplete");
    }
    const base = JSON.parse(this.decryptImportEnvelope(upload.envelope_json)) as Omit<ImportBatchCommitRequest, "operations" | "operationLinks">;
    const operations = rows.map(({ operation_json }) => JSON.parse(this.decryptImportStagedOperation(operation_json)) as OperationEnvelope);
    if (operations.some((operation, index) =>
      operation.id !== rows[index]!.operation_id ||
      operation.contentHash !== rows[index]!.content_hash ||
      operation.groupId !== rows[index]!.group_id
    )) throw new Error("Encrypted import staging metadata does not match its signed operations");
    const operationLinks = rows.map((row, index) => ({
      operationId: operations[index]!.id,
      externalType: row.external_type,
      externalId: this.decryptImportStagedSource(row.external_id),
      ...(row.dedupe_strategy ? { dedupeStrategy: row.dedupe_strategy } : {}),
      ...(row.semantic_id ? { semanticId: this.decryptImportStagedSemantic(row.semantic_id) } : {}),
      ...(row.source_metadata_json
        ? { sourceMetadata: JSON.parse(this.decryptImportStagedSource(row.source_metadata_json)) as JsonValue }
        : {}),
    }));
    const reconstructedRequest: ImportBatchCommitRequest = { ...base, operations, operationLinks };
    const preparationHash = await sha256Hex(canonicalJson(importPreparationMaterial(reconstructedRequest)));
    if (preparationHash !== upload.preparation_hash) {
      throw new Error("Prepared migration details do not match the staged upload");
    }
    const claimed = this.db.query(
      `UPDATE import_uploads SET status = 'activating'
       WHERE batch_id = ? AND actor_id = ? AND status = 'ready'`,
    ).run(batchId, actorId);
    if (claimed.changes !== 1) throw new Error("Import activation is already in progress");
    let result: ImportActivationResult;
    try {
      result = await this.activateImport(actorId, reconstructedRequest, { signaturesPreverified: true });
    } catch (error) {
      this.db.query(
        "UPDATE import_uploads SET status = 'ready' WHERE batch_id = ? AND actor_id = ? AND status = 'activating'",
      ).run(batchId, actorId);
      throw error;
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM import_staged_operations WHERE batch_id = ?").run(batchId);
      this.db.query("DELETE FROM import_uploads WHERE batch_id = ? AND actor_id = ?").run(batchId, actorId);
    })();
    return result;
  }

  cancelImportStage(actorId: string, batchId: string): boolean {
    // Delete the owner-scoped parent only. Foreign-key cascade removes chunks
    // without letting one authenticated actor target another actor's batch id.
    return this.db.query(
      "DELETE FROM import_uploads WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready')",
    ).run(batchId, actorId).changes > 0;
  }

  startImportUndoStage(
    actorId: string,
    batchId: string,
    request: ImportUndoStageStartRequest,
  ): ImportUndoStageStatus {
    if (!Number.isSafeInteger(request.expectedOperationCount) || request.expectedOperationCount <= 0 || request.expectedOperationCount > 100_500) {
      throw new TypeError("Undo size is outside the supported limit");
    }
    const batch = this.db.query<{ status: string }, [string, string]>(
      "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!batch) throw new Error("Import batch is unavailable");
    if (batch.status === "undone") {
      return {
        batchId,
        expectedOperationCount: request.expectedOperationCount,
        receivedOperationCount: request.expectedOperationCount,
        status: "undone",
        expiresAt: new Date().toISOString(),
        missingRanges: [],
        completedBatch: this.importBatchSummary(batchId, actorId),
      };
    }
    if (batch.status !== "completed") throw new Error("Only a completed import can be undone");
    const activeCount = this.activeImportRecordCount(batchId);
    if (activeCount !== request.expectedOperationCount) {
      throw new TypeError("Undo must include every active imported record exactly once");
    }
    const now = new Date();
    this.pruneExpiredImportUploads(now);
    const existing = this.db.query<{
      expected_operation_count: number;
      status: "staging" | "ready";
      expires_at: string;
      received: number;
    }, [string, string]>(
      `SELECT u.expected_operation_count, u.status, u.expires_at,
              (SELECT COUNT(*) FROM import_staged_undo_operations s WHERE s.batch_id = u.batch_id) AS received
       FROM import_undo_uploads u WHERE u.batch_id = ? AND u.actor_id = ? LIMIT 1`,
    ).get(batchId, actorId);
    if (existing) {
      if (existing.expected_operation_count !== request.expectedOperationCount) {
        throw new TypeError("A different undo upload already exists for this import");
      }
      return {
        batchId,
        expectedOperationCount: existing.expected_operation_count,
        receivedOperationCount: existing.received,
        status: existing.status,
        expiresAt: existing.expires_at,
        missingRanges: this.missingStageRanges(batchId, existing.expected_operation_count, true),
      };
    }
    const concurrent = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_undo_uploads WHERE actor_id = ?",
    ).get(actorId)?.count ?? 0;
    if (concurrent >= 2) throw new Error("Finish or cancel an existing undo upload before starting another");
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    this.db.query(
      `INSERT INTO import_undo_uploads(
         batch_id, actor_id, expected_operation_count, status, payload_bytes, created_at, expires_at
       ) VALUES (?, ?, ?, 'staging', 0, ?, ?)`,
    ).run(batchId, actorId, request.expectedOperationCount, now.toISOString(), expiresAt);
    return {
      batchId,
      expectedOperationCount: request.expectedOperationCount,
      receivedOperationCount: 0,
      status: "staging",
      expiresAt,
      missingRanges: [{ start: 0, endExclusive: request.expectedOperationCount }],
    };
  }

  stageImportUndoOperations(
    actorId: string,
    batchId: string,
    request: ImportUndoStageChunkRequest,
  ): ImportUndoStageStatus {
    if (!Number.isSafeInteger(request.start) || request.start < 0 || request.operations.length === 0 || request.operations.length > 250) {
      throw new TypeError("An undo chunk must contain 1 to 250 operations");
    }
    const upload = this.db.query<{
      expected_operation_count: number;
      expires_at: string;
      payload_bytes: number;
    }, [string, string]>(
      `SELECT expected_operation_count, expires_at, payload_bytes FROM import_undo_uploads
       WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
    ).get(batchId, actorId);
    if (!upload || Date.parse(upload.expires_at) <= Date.now()) throw new Error("Undo upload is unavailable or expired");
    if (request.start + request.operations.length > upload.expected_operation_count) {
      throw new TypeError("Undo chunk exceeds the declared operation count");
    }
    this.db.transaction(() => {
      const currentUpload = this.db.query<{ payload_bytes: number }, [string, string]>(
        `SELECT payload_bytes FROM import_undo_uploads
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
      ).get(batchId, actorId);
      if (!currentUpload) throw new Error("Undo upload is unavailable");
      let addedBytes = 0;
      for (let index = 0; index < request.operations.length; index += 1) {
        const ordinal = request.start + index;
        const operation = request.operations[index]!;
        const operationJson = JSON.stringify(operation);
        const encryptedOperation = this.encryptImportStagedUndo(operationJson);
        const rowBytes = new TextEncoder().encode(encryptedOperation).byteLength;
        if (rowBytes > 512_000) throw new TypeError("An undo operation is too large");
        const existing = this.db.query<{ operation_id: string; content_hash: string }, [string, number]>(
          `SELECT operation_id, content_hash FROM import_staged_undo_operations
           WHERE batch_id = ? AND ordinal = ? LIMIT 1`,
        ).get(batchId, ordinal);
        if (existing) {
          if (existing.operation_id !== operation.id || existing.content_hash !== operation.contentHash) {
            throw new TypeError("A retried undo chunk does not match the staged data");
          }
          continue;
        }
        addedBytes += rowBytes;
        this.db.query(
          `INSERT INTO import_staged_undo_operations(
             batch_id, ordinal, operation_id, content_hash, operation_json
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(batchId, ordinal, operation.id, operation.contentHash, encryptedOperation);
      }
      const received = this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM import_staged_undo_operations WHERE batch_id = ?",
      ).get(batchId)?.count ?? 0;
      this.assertGlobalStagingCapacity(addedBytes);
      const reserved = this.db.query(
        `UPDATE import_undo_uploads SET status = ?, payload_bytes = payload_bytes + ?
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') AND payload_bytes <= ?`,
      ).run(
        received === upload.expected_operation_count ? "ready" : "staging",
        addedBytes,
        batchId,
        actorId,
        stagedUploadLimitBytes - addedBytes,
      );
      if (reserved.changes !== 1) throw new TypeError("Undo upload exceeds the 192 MiB staged-data limit");
    })();
    const receivedOperationCount = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_undo_operations WHERE batch_id = ?",
    ).get(batchId)?.count ?? 0;
    return {
      batchId,
      expectedOperationCount: upload.expected_operation_count,
      receivedOperationCount,
      status: receivedOperationCount === upload.expected_operation_count ? "ready" : "staging",
      expiresAt: upload.expires_at,
    };
  }

  async activateImportUndoStage(actorId: string, batchId: string): Promise<ImportUndoResult> {
    const upload = this.db.query<{ expected_operation_count: number; status: string }, [string, string]>(
      "SELECT expected_operation_count, status FROM import_undo_uploads WHERE batch_id = ? AND actor_id = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!upload) {
      const batch = this.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
      ).get(batchId, actorId);
      if (batch?.status === "undone") {
        return { batch: this.importBatchSummary(batchId, actorId), duplicate: true, accepted: [] };
      }
      throw new Error("Undo upload is unavailable");
    }
    if (upload.status !== "ready") throw new Error("Undo upload is incomplete");
    const rows = this.db.query<{ ordinal: number; operation_json: string }, [string]>(
      `SELECT ordinal, operation_json FROM import_staged_undo_operations
       WHERE batch_id = ? ORDER BY ordinal`,
    ).all(batchId);
    if (rows.length !== upload.expected_operation_count || rows.some((row, index) => row.ordinal !== index)) {
      throw new Error("Undo upload is incomplete");
    }
    const operations = rows.map(({ operation_json }) => JSON.parse(this.decryptImportStagedUndo(operation_json)) as OperationEnvelope);
    const claimed = this.db.query(
      `UPDATE import_undo_uploads SET status = 'activating'
       WHERE batch_id = ? AND actor_id = ? AND status = 'ready'`,
    ).run(batchId, actorId);
    if (claimed.changes !== 1) throw new Error("Undo activation is already in progress");
    let result: ImportUndoResult;
    try {
      result = await this.undoImport(actorId, batchId, { operations });
    } catch (error) {
      this.db.query(
        "UPDATE import_undo_uploads SET status = 'ready' WHERE batch_id = ? AND actor_id = ? AND status = 'activating'",
      ).run(batchId, actorId);
      throw error;
    }
    this.db.query("DELETE FROM import_undo_uploads WHERE batch_id = ? AND actor_id = ?").run(batchId, actorId);
    return result;
  }

  cancelImportUndoStage(actorId: string, batchId: string): boolean {
    return this.db.query(
      "DELETE FROM import_undo_uploads WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready')",
    ).run(batchId, actorId).changes > 0;
  }

  resolveImportIdentityTargets(
    actorId: string,
    request: ImportIdentityResolutionRequest,
  ): ImportIdentityResolutionResult {
    if (request.provider !== "splitwise" || request.identities.length === 0 || request.identities.length > 500) {
      throw new TypeError("Import identities are invalid");
    }
    const resolved: Record<string, string> = {};
    for (const identity of request.identities) {
      if (
        !identity.id || identity.id.length > 100 || !identity.externalId || identity.externalId.length > 300 ||
        !identity.displayName.trim() || identity.displayName.length > 100 || resolved[identity.externalId]
      ) {
        throw new TypeError("Imported identity details are invalid");
      }
      if (identity.isImporter) {
        resolved[identity.externalId] = actorId;
        continue;
      }
      const providerMapping = this.db.query<{ local_id: string }, [string, string, string]>(
        `SELECT m.local_id FROM import_external_mappings m
         JOIN import_batches b ON b.id = m.batch_id
         WHERE m.imported_by = ? AND m.provider = ? AND m.external_type = 'person'
           AND m.external_id_hash = ? AND m.local_id NOT LIKE 'import:%'
           AND b.status IN ('completed', 'undone')
         ORDER BY b.completed_at DESC LIMIT 1`,
      ).get(actorId, request.provider, this.importExternalIdHash(request.provider, "person", identity.externalId));
      if (providerMapping) {
        resolved[identity.externalId] = providerMapping.local_id;
        continue;
      }
      // Export contents are client-controlled and therefore never authorize
      // another Tallied account or disclose whether an email is registered.
      // A placeholder becomes active only through the explicit claim flow.
      resolved[identity.externalId] = `import:${identity.id}`;
    }
    return { resolved };
  }

  private resolvedImportIdentities(actorId: string, request: ImportBatchCommitRequest): Map<string, string> {
    const importer = request.identities.filter((identity) => identity.isImporter);
    if (importer.length === 0) throw new TypeError("Choose at least one imported identity as yourself");
    const resolution = this.resolveImportIdentityTargets(actorId, {
      provider: request.provider,
      identities: request.identities.map(({ id, externalId, displayName, email, emailTrust, isImporter }) => ({
        id,
        externalId,
        displayName,
        ...(email ? { email } : {}),
        emailTrust,
        ...(isImporter ? { isImporter } : {}),
      })),
    });
    const resolved = new Map<string, string>();
    for (const identity of request.identities) {
      if (!identity.id || identity.id.length > 100 || !identity.externalId || identity.externalId.length > 300) {
        throw new TypeError("Imported identity ids are invalid");
      }
      if (!identity.displayName.trim() || identity.displayName.length > 100 || identity.groupIds.length > 100) {
        throw new TypeError("Imported identity details are invalid");
      }
      if (resolved.has(identity.externalId)) throw new TypeError("Imported identities must be unique");
      const localUserId = resolution.resolved[identity.externalId];
      if (!localUserId || identity.localUserId !== localUserId) {
        throw new TypeError("Imported identity resolution changed; review the migration again");
      }
      resolved.set(identity.externalId, localUserId);
    }
    return resolved;
  }

  private validateImportReconciliation(
    request: ImportBatchCommitRequest,
    resolvedPeople: ReadonlyMap<string, string>,
    operationById: ReadonlyMap<string, OperationEnvelope>,
  ): void {
    if (!request.reconciliation.zeroSum || request.reconciliation.blockingWarnings.length > 0) {
      throw new TypeError("Resolve every migration check before finishing the import");
    }
    const groupMapping = new Map<string, string>();
    for (const link of request.operationLinks) {
      if (link.externalType !== "group") continue;
      const operation = operationById.get(link.operationId);
      if (!operation || operation.type !== "GroupCreated") throw new TypeError("Group mappings must reference group creation operations");
      groupMapping.set(link.externalId, operation.groupId);
    }
    const detailed = new Map<string, number>();
    const aggregate = new Map<string, number>();
    const groupTotals = new Map<string, number>();
    const participantFinancials = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsSentMinor: number;
      paymentsReceivedMinor: number;
      netMinor: number;
    }>();
    const groupFinancials = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsMinor: number;
      netMinor: number;
    }>();
    const participantTotal = (participantId: string, currency: string) => {
      const key = `${participantId}\0${currency}`;
      const current = participantFinancials.get(key) ?? {
        paidMinor: 0,
        owedMinor: 0,
        paymentsSentMinor: 0,
        paymentsReceivedMinor: 0,
        netMinor: 0,
      };
      participantFinancials.set(key, current);
      return current;
    };
    const groupTotal = (groupId: string, currency: string) => {
      const key = `${groupId}\0${currency}`;
      const current = groupFinancials.get(key) ?? {
        paidMinor: 0,
        owedMinor: 0,
        paymentsMinor: 0,
        netMinor: 0,
      };
      groupFinancials.set(key, current);
      return current;
    };
    const add = (groupId: string, participantId: string, currency: string, amountMinor: number): void => {
      const detailKey = `${groupId}\0${participantId}\0${currency}`;
      detailed.set(detailKey, (detailed.get(detailKey) ?? 0) + amountMinor);
      const aggregateKey = `${participantId}\0${currency}`;
      aggregate.set(aggregateKey, (aggregate.get(aggregateKey) ?? 0) + amountMinor);
      const groupKey = `${groupId}\0${currency}`;
      groupTotals.set(groupKey, (groupTotals.get(groupKey) ?? 0) + amountMinor);
      participantTotal(participantId, currency).netMinor += amountMinor;
      groupTotal(groupId, currency).netMinor += amountMinor;
    };
    for (const operation of request.operations) {
      if (operation.type === "GroupCreated") continue;
      const payload = jsonObject(operation.payload);
      const metadata = parseImportMetadata(payload);
      if (!metadata || metadata.importBatchId !== request.id) throw new TypeError("Every imported record needs matching provenance");
      if (metadata.sourceDeleted) continue;
      if (operation.type === "ExpenseCreated") {
        const expense = parseExpensePayload(operation.payload);
        for (const payer of expense.payers) {
          participantTotal(payer.participantId, expense.currency).paidMinor += payer.amountMinor;
          groupTotal(operation.groupId, expense.currency).paidMinor += payer.amountMinor;
          add(operation.groupId, payer.participantId, expense.currency, payer.amountMinor);
        }
        for (const allocation of expense.allocations) {
          participantTotal(allocation.participantId, expense.currency).owedMinor += allocation.amountMinor;
          groupTotal(operation.groupId, expense.currency).owedMinor += allocation.amountMinor;
          add(operation.groupId, allocation.participantId, expense.currency, -allocation.amountMinor);
        }
      } else if (operation.type === "PaymentRecorded") {
        const currency = requiredCurrency(payload, "currency");
        const amountMinor = requiredMinor(payload, "amountMinor");
        const payerId = requiredString(payload, "payerId", 100);
        const recipientId = requiredString(payload, "recipientId", 100);
        participantTotal(payerId, currency).paymentsSentMinor += amountMinor;
        participantTotal(recipientId, currency).paymentsReceivedMinor += amountMinor;
        groupTotal(operation.groupId, currency).paymentsMinor += amountMinor;
        add(operation.groupId, payerId, currency, amountMinor);
        add(operation.groupId, recipientId, currency, -amountMinor);
      } else if (operation.type === "ImportedTransactionRecorded" || operation.type === "OpeningBalanceCreated") {
        const currency = requiredCurrency(payload, "currency");
        for (const effect of importEffects(payload)) add(operation.groupId, effect.participantId, currency, effect.amountMinor);
      } else {
        throw new TypeError("An import contains an unsupported operation");
      }
    }
    if ([...groupTotals.values()].some((amount) => amount !== 0)) throw new TypeError("Imported balances do not add to zero");
    const expectedParticipants = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsSentMinor: number;
      paymentsReceivedMinor: number;
      netMinor: number;
    }>();
    for (const total of request.reconciliation.participantTotals) {
      const localPersonId = resolvedPeople.get(total.externalPersonId);
      if (!localPersonId) throw new TypeError("A reconciliation total references an unknown person");
      const key = `${localPersonId}\0${total.currency}`;
      const current = expectedParticipants.get(key) ?? {
        paidMinor: 0,
        owedMinor: 0,
        paymentsSentMinor: 0,
        paymentsReceivedMinor: 0,
        netMinor: 0,
      };
      current.paidMinor += total.paidMinor;
      current.owedMinor += total.owedMinor;
      current.paymentsSentMinor += total.paymentsSentMinor;
      current.paymentsReceivedMinor += total.paymentsReceivedMinor;
      current.netMinor += total.netMinor;
      expectedParticipants.set(key, current);
    }
    const expectedGroups = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsMinor: number;
      netMinor: number;
    }>();
    for (const total of request.reconciliation.groupTotals) {
      const localGroupId = groupMapping.get(total.externalGroupId);
      if (!localGroupId) throw new TypeError("A reconciliation total references an unknown group");
      const key = `${localGroupId}\0${total.currency}`;
      if (expectedGroups.has(key)) throw new TypeError("Reconciliation group totals must be unique");
      expectedGroups.set(key, total);
    }
    if (expectedParticipants.size !== participantFinancials.size || expectedGroups.size !== groupFinancials.size) {
      throw new TypeError("Reconciliation totals are incomplete");
    }
    for (const [key, computed] of participantFinancials) {
      const expected = expectedParticipants.get(key);
      if (!expected ||
        expected.paidMinor !== computed.paidMinor || expected.owedMinor !== computed.owedMinor ||
        expected.paymentsSentMinor !== computed.paymentsSentMinor ||
        expected.paymentsReceivedMinor !== computed.paymentsReceivedMinor || expected.netMinor !== computed.netMinor
      ) throw new TypeError("A participant reconciliation total does not match the imported records");
    }
    for (const [key, computed] of groupFinancials) {
      const expected = expectedGroups.get(key);
      if (!expected || expected.paidMinor !== computed.paidMinor || expected.owedMinor !== computed.owedMinor ||
        expected.paymentsMinor !== computed.paymentsMinor || expected.netMinor !== computed.netMinor
      ) throw new TypeError("A group reconciliation total does not match the imported records");
    }
    const expectedSourceBalances = new Map<string, number>();
    for (const source of request.sourceBalances) {
      const localPersonId = resolvedPeople.get(source.externalPersonId);
      if (!localPersonId) throw new TypeError("A source balance references an unknown person");
      const localGroupId = source.externalGroupId ? groupMapping.get(source.externalGroupId) : undefined;
      if (source.externalGroupId && !localGroupId) throw new TypeError("A source balance references an unknown group");
      const key = localGroupId
        ? `${localGroupId}\0${localPersonId}\0${source.currency}`
        : `${localPersonId}\0${source.currency}`;
      expectedSourceBalances.set(key, (expectedSourceBalances.get(key) ?? 0) + source.amountMinor);
    }
    for (const [key, expectedMinor] of expectedSourceBalances) {
      const localGroupId = key.split("\0").length === 3;
      const computed = localGroupId ? detailed.get(key) ?? 0 : aggregate.get(key) ?? 0;
      if (computed !== expectedMinor) throw new TypeError("A computed balance does not match the source");
    }
  }

  async activateImport(
    actorId: string,
    request: ImportBatchCommitRequest,
    options: { signaturesPreverified?: boolean } = {},
  ): Promise<ImportActivationResult> {
    if (!/^[0-9a-f-]{36}$/.test(request.id) || !/^[a-f0-9]{64}$/.test(request.fingerprint)) {
      throw new TypeError("Import batch identity is invalid");
    }
    if (request.provider !== "splitwise" || !["current", "history", "balances", "custom"].includes(request.mode)) {
      throw new TypeError("Import provider or mode is invalid");
    }
    if (request.sourceHashes.length > 20 || request.sourceHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new TypeError("Source fingerprints are invalid");
    }
    if (request.operations.length === 0 || request.operations.length > 100_500 || request.identities.length > 500) {
      throw new TypeError("Import size is outside the supported limit");
    }
    const previous = this.db.query<{ id: string; status: string }, [string, string, string]>(
      "SELECT id, status FROM import_batches WHERE imported_by = ? AND provider = ? AND fingerprint = ? LIMIT 1",
    ).get(actorId, request.provider, request.fingerprint);
    if (previous && ["completed", "undone", "cancelled"].includes(previous.status)) {
      return { batch: this.importBatchSummary(previous.id, actorId), duplicate: true, accepted: [] };
    }
    if (previous) throw new TypeError("This import is already being processed");

    const operationIds = new Set<string>();
    const operationById = new Map<string, OperationEnvelope>();
    const plannedGroupIds = new Set(request.operations.filter((operation) => operation.type === "GroupCreated").map((operation) => operation.groupId));
    if (plannedGroupIds.size === 0) throw new TypeError("An import must create at least one group");
    for (const operation of request.operations) {
      if (operationIds.has(operation.id)) throw new TypeError("Import operations must be unique");
      operationIds.add(operation.id);
      operationById.set(operation.id, operation);
      if (!["GroupCreated", "ExpenseCreated", "PaymentRecorded", "ImportedTransactionRecorded", "OpeningBalanceCreated"].includes(operation.type)) {
        throw new TypeError("An import contains an unsupported operation");
      }
      if (this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM operations WHERE id = ?").get(operation.id)) {
        throw new TypeError("An import operation already exists outside this batch");
      }
    }
    // Chunk staging already proved immutable hash/signature integrity. Device
    // trust remains mutable and must be checked again at the commit point.
    this.assertImportActivationAuthorization(actorId, request.operations, plannedGroupIds);
    if (!options.signaturesPreverified) {
      await this.verifyImportOperationBatch(actorId, request.operations, plannedGroupIds);
    }
    const linkedOperationIds = new Set<string>();
    for (const link of request.operationLinks) {
      const operation = operationById.get(link.operationId);
      if (!operation || linkedOperationIds.has(link.operationId) || !link.externalId || link.externalId.length > 500) {
        throw new TypeError("Import operation mappings are invalid");
      }
      if ((link.externalType === "group") !== (operation.type === "GroupCreated")) {
        throw new TypeError("Import mapping type does not match its operation");
      }
      if (link.externalType === "record" && (
        !["provider_id", "csv_candidate"].includes(link.dedupeStrategy ?? "") ||
        !/^[a-f0-9]{64}$/.test(link.semanticId ?? "")
      )) {
        throw new TypeError("Import semantic mapping is invalid");
      }
      const sourceMetadataJson = link.sourceMetadata === undefined ? null : JSON.stringify(link.sourceMetadata);
      if (sourceMetadataJson && new TextEncoder().encode(sourceMetadataJson).byteLength > 10_000) {
        throw new TypeError("Import source metadata is too large");
      }
      if (link.externalType === "record") {
        const metadata = parseImportMetadata(jsonObject(operation.payload));
        if (!metadata || metadata.importBatchId !== request.id || metadata.sourceRecordId !== operation.targetId) {
          throw new TypeError("Imported provenance does not match its Tallied record");
        }
      }
      linkedOperationIds.add(link.operationId);
    }
    if (linkedOperationIds.size !== request.operations.length) throw new TypeError("Every import operation needs one source mapping");

    const resolvedPeople = this.resolvedImportIdentities(actorId, request);
    this.validateImportReconciliation(request, resolvedPeople, operationById);
    const now = new Date().toISOString();
    const accepted: Array<{ id: string; serverSequence: number }> = [];

    try {
      this.db.transaction(() => {
      for (const link of request.operationLinks) {
        if (link.externalType !== "record") continue;
        const dedupeHash = link.dedupeStrategy === "provider_id"
          ? this.importExternalIdHash(request.provider, link.externalType, link.externalId)
          : this.importSemanticIdHash(request.provider, link.semanticId!);
        const dedupeColumn = link.dedupeStrategy === "provider_id" ? "external_id_hash" : "semantic_id_hash";
        const duplicate = this.db.query<{ batch_id: string }, [string, string, string, string, string]>(
          `SELECT m.batch_id FROM import_external_mappings m
           JOIN import_batches b ON b.id = m.batch_id
           WHERE m.imported_by = ? AND m.provider = ? AND m.external_type = ?
             AND m.${dedupeColumn} = ? AND m.batch_id <> ? AND b.status = 'completed'
           LIMIT 1`,
        ).get(
          actorId,
          request.provider,
          link.externalType,
          dedupeHash,
          request.id,
        );
        if (duplicate) throw new TypeError("One or more Splitwise records were already imported in another migration");
      }
      this.db.query(
        `INSERT INTO import_batches(
           id, imported_by, provider, mode, source_account_key, fingerprint,
           selected_source_groups_json, warnings_json, reconciliation_json,
           status, rollback_status, started_at, reviewed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activating', 'available', ?, ?)`,
      ).run(
        request.id,
        actorId,
        request.provider,
        request.mode,
        request.sourceAccountId ? this.secretHash("import-source-account", request.sourceAccountId) : null,
        request.fingerprint,
        JSON.stringify(request.selectedSourceGroups),
        JSON.stringify(request.warnings),
        JSON.stringify(request.reconciliation),
        now,
        now,
      );
      const sourceInsert = this.db.query("INSERT INTO import_sources(batch_id, source_hash) VALUES (?, ?)");
      for (const sourceHash of new Set(request.sourceHashes)) sourceInsert.run(request.id, sourceHash);

      const groupOperations = request.operations.filter((operation) => operation.type === "GroupCreated");
      for (const operation of groupOperations) {
        const outcome = this.ingestVerified(operation);
        if (outcome.kind !== "accepted") throw new TypeError("An imported group conflicted with existing data");
        accepted.push({ id: operation.id, serverSequence: outcome.serverSequence });
      }

      for (const identity of request.identities) {
        const localUserId = resolvedPeople.get(identity.externalId)!;
        const normalizedEmail = identity.email?.trim().toLowerCase();
        const claimed = localUserId === actorId || !localUserId.startsWith("import:");
        if (localUserId !== actorId) {
          this.db.query(
            `INSERT INTO imported_identities(
               id, batch_id, provider, external_user_id, display_name, email_hash, email_trust,
               placeholder_user_id, claimed_by_user_id, status, created_at, claimed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            identity.id,
            request.id,
            request.provider,
            identity.externalId,
            identity.displayName.trim(),
            normalizedEmail ? this.emailHash(normalizedEmail) : null,
            identity.emailTrust,
            `import:${identity.id}`,
            claimed ? localUserId : null,
            claimed ? "claimed" : "unclaimed",
            now,
            claimed ? now : null,
          );
        }
        for (const groupId of new Set(identity.groupIds)) {
          if (!plannedGroupIds.has(groupId)) throw new TypeError("An imported person references an unknown group");
          if (localUserId === actorId) continue;
          this.db.query(
            `INSERT OR IGNORE INTO group_members(group_id, user_id, display_name, status, joined_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(groupId, localUserId, identity.displayName.trim(), claimed ? "active" : "placeholder", now);
        }
        this.db.query(
          `INSERT INTO import_external_mappings(
             batch_id, imported_by, provider, external_type, external_id,
             external_id_hash, semantic_id_hash, source_metadata_json, local_id
           ) VALUES (?, ?, ?, 'person', ?, ?, NULL, NULL, ?)`,
        ).run(
          request.id,
          actorId,
          request.provider,
          identity.externalId,
          this.importExternalIdHash(request.provider, "person", identity.externalId),
          localUserId,
        );
      }

      for (const operation of request.operations.filter((item) => item.type !== "GroupCreated")) {
        const metadata = parseImportMetadata(jsonObject(operation.payload));
        if (!metadata || metadata.importBatchId !== request.id) throw new TypeError("Imported provenance does not match its batch");
        const outcome = this.ingestVerified(operation);
        if (outcome.kind !== "accepted") throw new TypeError("An imported record conflicted with existing data");
        accepted.push({ id: operation.id, serverSequence: outcome.serverSequence });
      }

      for (const link of request.operationLinks) {
        const operation = operationById.get(link.operationId)!;
        this.db.query(
          `INSERT INTO import_external_mappings(
             batch_id, imported_by, provider, external_type, external_id,
             external_id_hash, semantic_id_hash, source_metadata_json, local_id, operation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          request.id,
          actorId,
          request.provider,
          link.externalType,
          link.externalId,
          this.importExternalIdHash(request.provider, link.externalType, link.externalId),
          link.dedupeStrategy === "csv_candidate" && link.semanticId
            ? this.importSemanticIdHash(request.provider, link.semanticId)
            : null,
          link.sourceMetadata === undefined ? null : JSON.stringify(link.sourceMetadata),
          operation.targetId,
          operation.id,
        );
      }
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'activated', ?, ?)`,
      ).run(randomUUID(), request.id, actorId, now, JSON.stringify({ operationCount: accepted.length }));
      this.db.query(
        `UPDATE import_batches SET status = 'completed', completed_at = ?
         WHERE id = ? AND imported_by = ? AND status = 'activating'`,
      ).run(now, request.id, actorId);
      })();
    } catch (error) {
      // Verification yields between operations. A concurrent retry can therefore
      // finish the same fingerprint before this transaction begins. Treat that
      // unique-key race exactly like any other lost-response retry.
      accepted.length = 0;
      const completed = this.db.query<{ id: string; status: string }, [string, string, string]>(
        "SELECT id, status FROM import_batches WHERE imported_by = ? AND provider = ? AND fingerprint = ? LIMIT 1",
      ).get(actorId, request.provider, request.fingerprint);
      if (completed && ["completed", "undone", "cancelled"].includes(completed.status)) {
        return { batch: this.importBatchSummary(completed.id, actorId), duplicate: true, accepted: [] };
      }
      throw error;
    }

    return { batch: this.importBatchSummary(request.id, actorId), duplicate: false, accepted };
  }

  async undoImport(actorId: string, batchId: string, request: ImportUndoRequest): Promise<ImportUndoResult> {
    const batch = this.db.query<{ status: string }, [string, string]>(
      "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!batch) throw new Error("Import batch is unavailable");
    if (batch.status === "undone") {
      return { batch: this.importBatchSummary(batchId, actorId), duplicate: true, accepted: [] };
    }
    if (batch.status !== "completed") throw new Error("Only a completed import can be undone");

    const active = this.db.query<{
      target_id: string;
      group_id: string;
      version: number;
      undo_type: OperationEnvelope["type"];
    }, [string, string, string]>(
      `SELECT id AS target_id, group_id, version, 'ExpenseVoided' AS undo_type
       FROM expenses WHERE import_batch_id = ? AND status = 'active'
       UNION ALL
       SELECT id AS target_id, group_id, version, 'PaymentReversed' AS undo_type
       FROM payments WHERE import_batch_id = ? AND status = 'active'
       UNION ALL
       SELECT id AS target_id, group_id, version,
              CASE kind WHEN 'opening_balance' THEN 'OpeningBalanceVoided' ELSE 'ImportedTransactionVoided' END AS undo_type
       FROM imported_transactions WHERE batch_id = ? AND status = 'active'`,
    ).all(batchId, batchId, batchId);
    if (request.operations.length !== active.length) {
      throw new TypeError("Undo must include every active imported record exactly once");
    }
    const expected = new Map(active.map((row) => [row.target_id, row]));
    const operationIds = new Set<string>();
    for (const operation of request.operations) {
      const row = expected.get(operation.targetId);
      if (
        !row ||
        row.group_id !== operation.groupId ||
        row.version !== operation.baseVersion ||
        row.undo_type !== operation.type ||
        operationIds.has(operation.id)
      ) {
        throw new TypeError("Undo operations do not exactly match the active imported records");
      }
      operationIds.add(operation.id);
      const payloadBatchId = requiredString(jsonObject(operation.payload), "undoImportBatchId", 100);
      if (payloadBatchId !== batchId) throw new TypeError("Undo provenance does not match its import batch");
      if (this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM operations WHERE id = ?").get(operation.id)) {
        throw new TypeError("An undo operation id is already in use");
      }
      expected.delete(operation.targetId);
    }
    if (expected.size > 0) throw new TypeError("Undo must include every active imported record exactly once");
    await this.verifyImportOperationBatch(actorId, request.operations, new Set(), "Undo");

    const accepted: Array<{ id: string; serverSequence: number }> = [];
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const operation of request.operations) {
        const outcome = this.ingestVerified(operation);
        if (outcome.kind !== "accepted") throw new TypeError("An imported record changed before undo could finish");
        accepted.push({ id: operation.id, serverSequence: outcome.serverSequence });
      }
      this.db.query(
        `UPDATE groups SET deleted_at = ?
         WHERE id IN (
           SELECT local_id FROM import_external_mappings
           WHERE batch_id = ? AND external_type = 'group'
         )
           AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.group_id = groups.id AND e.status = 'active')
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.group_id = groups.id AND p.status = 'active')
           AND NOT EXISTS (
             SELECT 1 FROM imported_transactions t WHERE t.group_id = groups.id AND t.status = 'active'
           )`,
      ).run(now, batchId);
      this.db.query(
        `UPDATE import_batches SET status = 'undone', rollback_status = 'completed', undone_at = ?
         WHERE id = ? AND imported_by = ? AND status = 'completed'`,
      ).run(now, batchId, actorId);
      this.db.query(
        `UPDATE import_claim_requests SET status = 'rejected', resolved_at = ?
         WHERE identity_id IN (SELECT id FROM imported_identities WHERE batch_id = ?)
           AND status = 'pending'`,
      ).run(now, batchId);
      this.db.query(
        `UPDATE imported_identities SET status = 'revoked', claim_token_hash = NULL,
           claim_expires_at = NULL, reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL,
           reserved_by_user_id = NULL, revoked_at = ?
         WHERE batch_id = ? AND status IN ('unclaimed', 'reserved', 'awaiting_owner')`,
      ).run(now, batchId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'undone', ?, ?)`,
      ).run(randomUUID(), batchId, actorId, now, JSON.stringify({ operationCount: accepted.length }));
    })();
    return { batch: this.importBatchSummary(batchId, actorId), duplicate: false, accepted };
  }

  listImportIdentities(actorId: string, batchId: string): ImportIdentitySummary[] {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE import_claim_requests SET status = 'expired', resolved_at = ?
         WHERE status = 'pending' AND expires_at <= ?`,
      ).run(now, now);
      this.db.query(
        `UPDATE imported_identities SET status = 'unclaimed', reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE status = 'awaiting_owner' AND reservation_expires_at <= ?`,
      ).run(now);
    })();
    const rows = this.db.query<{
      id: string;
      display_name: string;
      status: ImportIdentitySummary["status"];
      email_trust: ImportIdentitySummary["emailTrust"];
      claim_expires_at: string | null;
      claimant_name: string | null;
      claimant_email: string | null;
      requested_at: string | null;
      reservation_expires_at: string | null;
    }, [string, string]>(
      `SELECT i.id, i.display_name, i.status, i.email_trust, i.claim_expires_at,
              u.name AS claimant_name, u.email AS claimant_email,
              r.requested_at, r.expires_at AS reservation_expires_at
       FROM imported_identities i JOIN import_batches b ON b.id = i.batch_id
       LEFT JOIN import_claim_requests r ON r.identity_id = i.id AND r.status = 'pending'
       LEFT JOIN "user" u ON u.id = r.claimant_user_id
       WHERE i.batch_id = ? AND b.imported_by = ? ORDER BY i.display_name COLLATE NOCASE`,
    ).all(batchId, actorId);
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      emailTrust: row.email_trust,
      ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
      ...(row.claimant_name && row.claimant_email && row.requested_at && row.reservation_expires_at
        ? {
            claimant: {
              displayName: row.claimant_name,
              email: row.claimant_email,
              requestedAt: row.requested_at,
              expiresAt: row.reservation_expires_at,
            },
          }
        : {}),
    }));
  }

  createImportClaimLink(actorId: string, batchId: string, identityId: string): ImportClaimLink {
    const identity = this.db.query<{ status: string; display_name: string }, [string, string, string]>(
      `SELECT i.status, i.display_name FROM imported_identities i
       JOIN import_batches b ON b.id = i.batch_id
       WHERE i.id = ? AND i.batch_id = ? AND b.imported_by = ? AND b.status = 'completed' LIMIT 1`,
    ).get(identityId, batchId, actorId);
    if (!identity) throw new Error("Only the migration owner can create this claim link");
    if (identity.status === "claimed" || identity.status === "revoked") {
      throw new Error("This imported identity can no longer be claimed");
    }
    if (identity.status === "awaiting_owner") {
      throw new Error("Review or reject the pending claim before creating a new link");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.secretHash("import-claim-token", token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE imported_identities SET
           status = 'unclaimed', claim_token_hash = ?, claim_expires_at = ?,
           reserved_email_hash = NULL, reservation_requested_at = NULL,
           reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE id = ? AND batch_id = ?`,
      ).run(tokenHash, expiresAt, identityId, batchId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_link_created', ?, ?)`,
      ).run(randomUUID(), batchId, actorId, now.toISOString(), JSON.stringify({ identityId }));
    })();
    return { identityId, token, expiresAt };
  }

  previewImportClaim(token: string): ImportClaimPreview {
    const row = this.db.query<{
      provider: "splitwise";
      claim_expires_at: string;
      status: string;
    }, [string]>(
      `SELECT i.provider, i.claim_expires_at, i.status
       FROM imported_identities i WHERE i.claim_token_hash = ? LIMIT 1`,
    ).get(this.secretHash("import-claim-token", token));
    if (
      !row ||
      !["unclaimed", "reserved"].includes(row.status) ||
      !row.claim_expires_at ||
      Date.parse(row.claim_expires_at) <= Date.now()
    ) {
      throw new Error("Claim link is invalid or expired");
    }
    return { provider: row.provider, expiresAt: row.claim_expires_at };
  }

  reserveImportClaimEmail(token: string, email: string): { status: "reserved"; expiresAt: string } {
    const normalizedEmail = email.trim().toLowerCase();
    const emailHash = this.emailHash(normalizedEmail);
    const tokenHash = this.secretHash("import-claim-token", token);
    const identity = this.db.query<{
      id: string;
      batch_id: string;
      email_hash: string | null;
      email_trust: string;
      status: string;
      claim_expires_at: string | null;
      reserved_email_hash: string | null;
      reservation_expires_at: string | null;
    }, [string]>(
      `SELECT id, batch_id, email_hash, email_trust, status, claim_expires_at,
              reserved_email_hash, reservation_expires_at
       FROM imported_identities WHERE claim_token_hash = ? LIMIT 1`,
    ).get(tokenHash);
    const now = new Date();
    if (
      !identity || !["unclaimed", "reserved"].includes(identity.status) ||
      !identity.claim_expires_at || Date.parse(identity.claim_expires_at) <= now.getTime()
    ) {
      throw new Error("Claim link is invalid or expired");
    }
    if (
      ["provider", "exported"].includes(identity.email_trust) &&
      identity.email_hash !== emailHash
    ) {
      throw new Error("Use the verified email associated with this imported identity");
    }
    if (
      identity.status === "reserved" && identity.reserved_email_hash &&
      identity.reserved_email_hash !== emailHash && identity.reservation_expires_at &&
      Date.parse(identity.reservation_expires_at) > now.getTime()
    ) {
      throw new Error("This claim link is already being verified");
    }
    const expiresAt = new Date(Math.min(
      Date.parse(identity.claim_expires_at),
      now.getTime() + 15 * 60_000,
    )).toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE imported_identities SET status = 'reserved', reserved_email_hash = ?,
           reservation_requested_at = ?, reservation_expires_at = ?, reserved_by_user_id = NULL
         WHERE id = ? AND claim_token_hash = ? AND status IN ('unclaimed', 'reserved')`,
      ).run(emailHash, now.toISOString(), expiresAt, identity.id, tokenHash);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_auth_reserved', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, "pre-auth", now.toISOString(), JSON.stringify({ identityId: identity.id }));
    })();
    return { status: "reserved", expiresAt };
  }

  claimImportedIdentity(actorId: string, token: string): ImportClaimResult {
    const identity = this.db.query<{
      id: string;
      batch_id: string;
      display_name: string;
      email_hash: string | null;
      email_trust: string;
      claim_expires_at: string;
      status: string;
      reserved_email_hash: string | null;
      reservation_expires_at: string | null;
    }, [string]>(
      `SELECT id, batch_id, display_name, email_hash, email_trust, claim_expires_at, status,
              reserved_email_hash, reservation_expires_at
       FROM imported_identities WHERE claim_token_hash = ? LIMIT 1`,
    ).get(this.secretHash("import-claim-token", token));
    if (
      !identity ||
      !["unclaimed", "reserved"].includes(identity.status) ||
      Date.parse(identity.claim_expires_at) <= Date.now()
    ) {
      throw new Error("Claim link is invalid or expired");
    }
    const user = this.db.query<{ email: string; email_verified: number }, [string]>(
      `SELECT email, emailVerified AS email_verified FROM "user" WHERE id = ? LIMIT 1`,
    ).get(actorId);
    if (!user || !user.email_verified) throw new Error("Verify your email before claiming imported history");
    if (
      identity.status === "reserved" && (
        identity.reserved_email_hash !== this.emailHash(user.email) ||
        !identity.reservation_expires_at || Date.parse(identity.reservation_expires_at) <= Date.now()
      )
    ) {
      throw new Error("Sign in with the email reserved for this claim link");
    }
    const trustedEmail = ["provider", "exported"].includes(identity.email_trust)
      && identity.email_hash === this.emailHash(user.email);
    if (trustedEmail) return this.completeImportClaim(identity.id, actorId);

    const now = new Date();
    const reservationExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
    const requestToken = randomBytes(32).toString("base64url");
    this.db.transaction(() => {
      this.db.query(
        `UPDATE imported_identities SET status = 'awaiting_owner', claim_token_hash = NULL,
           claim_expires_at = NULL, reserved_email_hash = ?, reservation_requested_at = ?,
           reservation_expires_at = ?, reserved_by_user_id = ?
         WHERE id = ?`,
      ).run(this.emailHash(user.email), now.toISOString(), reservationExpiresAt, actorId, identity.id);
      this.db.query(
        `UPDATE import_claim_requests SET status = 'expired', resolved_at = ?
         WHERE identity_id = ? AND status = 'pending'`,
      ).run(now.toISOString(), identity.id);
      this.db.query(
        `INSERT INTO import_claim_requests(
           token_hash, identity_id, claimant_user_id, status, requested_at, expires_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(this.secretHash("import-claim-request", requestToken), identity.id, actorId, now.toISOString(), reservationExpiresAt);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_awaiting_owner', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, actorId, now.toISOString(), JSON.stringify({ identityId: identity.id }));
    })();
    return {
      status: "awaiting_owner",
      displayName: identity.display_name,
      requestId: requestToken,
      expiresAt: reservationExpiresAt,
    };
  }

  importClaimStatus(actorId: string, requestId: string): ImportClaimStatus {
    const row = this.db.query<{
      status: "pending" | "approved" | "rejected" | "expired";
      display_name: string;
      expires_at: string;
    }, [string, string]>(
      `SELECT r.status, i.display_name, r.expires_at
       FROM import_claim_requests r JOIN imported_identities i ON i.id = r.identity_id
       WHERE r.token_hash = ? AND r.claimant_user_id = ? LIMIT 1`,
    ).get(this.secretHash("import-claim-request", requestId), actorId);
    if (!row) throw new Error("Claim request is unavailable");
    let status = row.status;
    if (status === "pending" && Date.parse(row.expires_at) <= Date.now()) {
      status = "expired";
      this.db.query(
        "UPDATE import_claim_requests SET status = 'expired', resolved_at = ? WHERE token_hash = ? AND status = 'pending'",
      ).run(new Date().toISOString(), this.secretHash("import-claim-request", requestId));
    }
    return {
      status: status === "pending" ? "awaiting_owner" : status === "approved" ? "claimed" : status,
      displayName: row.display_name,
      expiresAt: row.expires_at,
    };
  }

  approveImportIdentityClaim(actorId: string, identityId: string): ImportClaimResult {
    const identity = this.db.query<{
      reserved_by_user_id: string | null;
      reservation_expires_at: string | null;
    }, [string, string]>(
      `SELECT i.reserved_by_user_id, i.reservation_expires_at
       FROM imported_identities i JOIN import_batches b ON b.id = i.batch_id
       WHERE i.id = ? AND b.imported_by = ? AND i.status = 'awaiting_owner' LIMIT 1`,
    ).get(identityId, actorId);
    if (!identity) throw new Error("Only the migration owner can approve this claim");
    if (
      !identity.reserved_by_user_id ||
      !identity.reservation_expires_at ||
      Date.parse(identity.reservation_expires_at) <= Date.now()
    ) {
      throw new Error("The claim reservation expired");
    }
    return this.completeImportClaim(identityId, identity.reserved_by_user_id);
  }

  rejectImportIdentityClaim(actorId: string, identityId: string): { status: "rejected" } {
    const identity = this.db.query<{ batch_id: string }, [string, string]>(
      `SELECT i.batch_id FROM imported_identities i JOIN import_batches b ON b.id = i.batch_id
       WHERE i.id = ? AND b.imported_by = ? AND i.status = 'awaiting_owner' LIMIT 1`,
    ).get(identityId, actorId);
    if (!identity) throw new Error("Only the migration owner can reject this claim");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE import_claim_requests SET status = 'rejected', resolved_at = ?
         WHERE identity_id = ? AND status = 'pending'`,
      ).run(now, identityId);
      this.db.query(
        `UPDATE imported_identities SET status = 'unclaimed', reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE id = ? AND status = 'awaiting_owner'`,
      ).run(identityId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_rejected', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, actorId, now, JSON.stringify({ identityId }));
    })();
    return { status: "rejected" };
  }

  private completeImportClaim(identityId: string, claimedBy: string): ImportClaimResult {
    const identity = this.db.query<{
      batch_id: string;
      display_name: string;
      placeholder_user_id: string;
      status: string;
    }, [string]>(
      "SELECT batch_id, display_name, placeholder_user_id, status FROM imported_identities WHERE id = ? LIMIT 1",
    ).get(identityId);
    if (!identity || identity.status === "claimed" || identity.status === "revoked") {
      throw new Error("This imported identity can no longer be claimed");
    }
    const user = this.db.query<{ email: string }, [string]>('SELECT email FROM "user" WHERE id = ? LIMIT 1').get(claimedBy);
    if (!user) throw new Error("Claiming account does not exist");

    const duplicatePayer = this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM expense_payers old
       JOIN expense_payers current ON current.expense_id = old.expense_id AND current.participant_id = ?
       WHERE old.participant_id = ? LIMIT 1`,
    ).get(claimedBy, identity.placeholder_user_id);
    const duplicateAllocation = this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM expense_allocations old
       JOIN expense_allocations current ON current.expense_id = old.expense_id AND current.participant_id = ?
       WHERE old.participant_id = ? LIMIT 1`,
    ).get(claimedBy, identity.placeholder_user_id);
    const duplicateEffect = this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM imported_transaction_effects old
       JOIN imported_transaction_effects current
         ON current.transaction_id = old.transaction_id AND current.participant_id = ?
       WHERE old.participant_id = ? LIMIT 1`,
    ).get(claimedBy, identity.placeholder_user_id);
    const selfPayment = this.db.query<{ one: number }, [string, string, string, string]>(
      `SELECT 1 AS one FROM payments WHERE
         (payer_id = ? AND recipient_id = ?) OR (payer_id = ? AND recipient_id = ?) LIMIT 1`,
    ).get(identity.placeholder_user_id, claimedBy, claimedBy, identity.placeholder_user_id);
    const conflict = duplicatePayer || duplicateAllocation || duplicateEffect || selfPayment;
    if (conflict) throw new Error("This account already appears in the same imported transaction; the migration owner must reconcile it");

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query("UPDATE expense_payers SET participant_id = ? WHERE participant_id = ?")
        .run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE expense_allocations SET participant_id = ? WHERE participant_id = ?")
        .run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE payments SET payer_id = ? WHERE payer_id = ?").run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE payments SET recipient_id = ? WHERE recipient_id = ?").run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE imported_transaction_effects SET participant_id = ? WHERE participant_id = ?")
        .run(claimedBy, identity.placeholder_user_id);

      const memberships = this.db.query<{ group_id: string }, [string]>(
        "SELECT group_id FROM group_members WHERE user_id = ? AND status = 'placeholder'",
      ).all(identity.placeholder_user_id);
      for (const { group_id: groupId } of memberships) {
        this.db.query(
          `INSERT INTO import_participant_aliases(
             group_id, placeholder_user_id, claimed_user_id, identity_id, created_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(group_id, placeholder_user_id) DO UPDATE SET
             claimed_user_id = excluded.claimed_user_id,
             identity_id = excluded.identity_id,
             created_at = excluded.created_at`,
        ).run(groupId, identity.placeholder_user_id, claimedBy, identityId, now);
        const existing = this.db.query<{ one: number }, [string, string]>(
          "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1",
        ).get(groupId, claimedBy);
        if (existing) {
          this.db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
            .run(groupId, identity.placeholder_user_id);
        } else {
          this.db.query(
            `UPDATE group_members SET user_id = ?, email = ?, status = 'active', removed_at = NULL
             WHERE group_id = ? AND user_id = ?`,
          ).run(claimedBy, user.email, groupId, identity.placeholder_user_id);
        }
      }
      this.db.query(
        `UPDATE imported_identities SET status = 'claimed', claimed_by_user_id = ?, claimed_at = ?,
           claim_token_hash = NULL, claim_expires_at = NULL, reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE id = ?`,
      ).run(claimedBy, now, identityId);
      this.db.query(
        `UPDATE import_claim_requests SET status = 'approved', resolved_at = ?
         WHERE identity_id = ? AND claimant_user_id = ? AND status = 'pending'`,
      ).run(now, identityId, claimedBy);
      this.db.query(
        `UPDATE import_external_mappings SET local_id = ?
         WHERE batch_id = ? AND external_type = 'person' AND local_id = ?`,
      ).run(claimedBy, identity.batch_id, identity.placeholder_user_id);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'identity_claimed', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, claimedBy, now, JSON.stringify({ identityId }));
    })();
    return { status: "claimed", displayName: identity.display_name };
  }

  deleteImportSourceData(actorId: string, batchId: string): ImportBatchSummary {
    const batch = this.db.query<{ source_data_deleted_at: string | null; fingerprint: string }, [string, string]>(
      "SELECT source_data_deleted_at, fingerprint FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!batch) throw new Error("Import batch is unavailable");
    if (batch.source_data_deleted_at) return this.importBatchSummary(batchId, actorId);
    const now = new Date().toISOString();
    const deletedFingerprint = this.secretHash("import-deleted-fingerprint", `${batchId}:${batch.fingerprint}`);
    this.db.transaction(() => {
      const claimed = this.db.query(
        `UPDATE import_batches SET source_account_key = NULL, selected_source_groups_json = '[]',
           warnings_json = '[]', reconciliation_json = '{"sourceDataDeleted":true}',
           fingerprint = ?, source_data_deleted_at = ?
         WHERE id = ? AND imported_by = ? AND source_data_deleted_at IS NULL`,
      ).run(deletedFingerprint, now, batchId, actorId);
      if (claimed.changes !== 1) return;
      this.db.query("DELETE FROM import_sources WHERE batch_id = ?").run(batchId);
      for (const table of ["expenses", "payments"] as const) {
        const rows = this.db.query<{ id: string; source_record_id: string }, [string]>(
          `SELECT id, source_record_id FROM ${table} WHERE import_batch_id = ?`,
        ).all(batchId);
        for (const row of rows) {
          this.db.query(
            `UPDATE ${table} SET source_record_id = ?, source_metadata_json = '{"deleted":true}' WHERE id = ?`,
          ).run(`deleted:${this.secretHash("import-source-tombstone", row.source_record_id)}`, row.id);
        }
      }
      const transactions = this.db.query<{ id: string; source_record_id: string }, [string]>(
        "SELECT id, source_record_id FROM imported_transactions WHERE batch_id = ?",
      ).all(batchId);
      for (const row of transactions) {
        this.db.query(
          `UPDATE imported_transactions SET source_record_id = ?, source_metadata_json = '{"deleted":true}' WHERE id = ?`,
        ).run(`deleted:${this.secretHash("import-source-tombstone", row.source_record_id)}`, row.id);
      }
      const mappings = this.db.query<{ external_type: string; external_id: string }, [string]>(
        "SELECT external_type, external_id FROM import_external_mappings WHERE batch_id = ?",
      ).all(batchId);
      for (const mapping of mappings) {
        this.db.query(
          `UPDATE import_external_mappings SET external_id = ?, source_metadata_json = NULL
           WHERE batch_id = ? AND external_type = ? AND external_id = ?`,
        ).run(`deleted:${this.secretHash("import-source-tombstone", mapping.external_id)}`, batchId, mapping.external_type, mapping.external_id);
      }
      const identities = this.db.query<{ id: string; external_user_id: string }, [string]>(
        "SELECT id, external_user_id FROM imported_identities WHERE batch_id = ?",
      ).all(batchId);
      for (const identity of identities) {
        this.db.query(
          `UPDATE imported_identities SET external_user_id = ?, email_hash = NULL,
             claim_token_hash = NULL, claim_expires_at = NULL, reserved_email_hash = NULL,
             reservation_requested_at = NULL, reservation_expires_at = NULL,
             reserved_by_user_id = NULL,
             status = CASE WHEN status IN ('unclaimed', 'reserved', 'awaiting_owner') THEN 'revoked' ELSE status END,
             revoked_at = CASE WHEN status IN ('unclaimed', 'reserved', 'awaiting_owner') THEN ? ELSE revoked_at END
           WHERE id = ?`,
        ).run(`deleted:${this.secretHash("import-source-tombstone", identity.external_user_id)}`, now, identity.id);
      }
      this.db.query(
        `UPDATE import_claim_requests SET status = 'rejected', resolved_at = ?
         WHERE identity_id IN (SELECT id FROM imported_identities WHERE batch_id = ?)
           AND status = 'pending'`,
      ).run(now, batchId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'source_data_deleted', ?, '{}')`,
      ).run(randomUUID(), batchId, actorId, now);
    })();
    return this.importBatchSummary(batchId, actorId);
  }

  private ingestVerified(operation: OperationEnvelope):
    | { kind: "accepted"; serverSequence: number }
    | { kind: "conflict"; conflictId: string; currentVersion: number } {
    const current = this.db
      .query<{ version: number }, [string, string]>(
        "SELECT version FROM entity_versions WHERE group_id = ? AND target_id = ?",
      )
      .get(operation.groupId, operation.targetId)?.version ?? 0;
    const receivedAt = new Date().toISOString();

    if (versionedTypes.has(operation.type) && operation.baseVersion !== current) {
      const inserted = this.insertOperation(operation, receivedAt, "conflicted");
      const conflictId = randomUUID();
      this.db
        .query(
          `INSERT INTO conflicts(
            id, operation_id, group_id, target_id, submitted_base_version, current_version, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          conflictId,
          operation.id,
          operation.groupId,
          operation.targetId,
          operation.baseVersion,
          current,
          receivedAt,
        );
      return { kind: "conflict", conflictId, currentVersion: current };
    }

    const serverSequence = this.insertOperation(operation, receivedAt, "accepted");
    this.applyProjection(operation, current + 1, receivedAt);
    if (versionedTypes.has(operation.type)) {
      this.db
        .query(
          `INSERT INTO entity_versions(group_id, target_id, version, operation_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(group_id, target_id) DO UPDATE SET
             version = excluded.version,
             operation_id = excluded.operation_id`,
        )
        .run(operation.groupId, operation.targetId, current + 1, operation.id);
    }
    return { kind: "accepted", serverSequence };
  }

  private insertOperation(
    operation: OperationEnvelope,
    receivedAt: string,
    status: "accepted" | "conflicted",
  ): number {
    const result = this.db
      .query(
        `INSERT INTO operations(
          id, group_id, actor_id, device_id, type, target_id, base_version,
          client_timestamp, payload_json, content_hash, signature, received_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.id,
        operation.groupId,
        operation.actorId,
        operation.deviceId,
        operation.type,
        operation.targetId,
        operation.baseVersion,
        operation.clientTimestamp,
        JSON.stringify(operation.payload),
        operation.contentHash,
        operation.signature,
        receivedAt,
        status,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Membership is checked against the group the operation *declares*, so without
   * this every active member of any group could mutate an expense in any other
   * group by targeting its id. Confines the write to the row's real owner group.
   */
  private assertTargetGroup(
    table: "expenses" | "payments",
    targetId: string,
    groupId: string,
  ): { status: string; readOnly: boolean; importBatchId: string | null } | null {
    const existing = this.db
      .query<{ group_id: string; status: string; read_only: number; import_batch_id: string | null }, [string]>(
        `SELECT group_id, status, read_only, import_batch_id FROM ${table} WHERE id = ?`,
      )
      .get(targetId);
    if (!existing) return null;
    if (existing.group_id !== groupId) throw new Error("Target belongs to another group");
    return { status: existing.status, readOnly: existing.read_only === 1, importBatchId: existing.import_batch_id };
  }

  private assertImportedUndo(
    operation: OperationEnvelope,
    existing: { readOnly: boolean; importBatchId: string | null },
  ): void {
    if (!existing.readOnly) return;
    const requestedBatchId = requiredString(jsonObject(operation.payload), "undoImportBatchId", 100);
    if (!existing.importBatchId || requestedBatchId !== existing.importBatchId) {
      throw new Error("Imported records can only be changed by undoing their import");
    }
    const owned = this.db.query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM import_batches WHERE id = ? AND imported_by = ? AND status = 'completed'",
    ).get(requestedBatchId, operation.actorId);
    if (!owned) throw new Error("Only the migration owner can undo imported records");
  }

  private applyProjection(operation: OperationEnvelope, version: number, receivedAt: string): void {
    if (operation.type === "GroupCreated") {
      if (operation.groupId !== operation.targetId) throw new TypeError("A new group must target its own group id");
      const payload = jsonObject(operation.payload);
      const name = requiredString(payload, "name", 100);
      const settlementCurrency = requiredString(payload, "settlementCurrency", 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(settlementCurrency)) throw new TypeError("settlementCurrency must be a three-letter ISO code");
      const profile = this.db.query<{ displayName: string; email: string | null }, [string]>(
        `SELECT display_name AS displayName, email
         FROM group_members WHERE user_id = ? ORDER BY joined_at LIMIT 1`,
      ).get(operation.actorId);
      this.db.query(
        "INSERT INTO groups(id, name, settlement_currency, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(operation.groupId, name, settlementCurrency, operation.actorId, receivedAt);
      this.db.query(
        `INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      ).run(operation.groupId, operation.actorId, profile?.displayName ?? operation.actorId, profile?.email ?? null, receivedAt);
      return;
    }

    if (operation.type === "GroupCurrencyChanged") {
      if (operation.groupId !== operation.targetId) throw new TypeError("A currency change must target its group id");
      const payload = jsonObject(operation.payload);
      const settlementCurrency = requiredString(payload, "settlementCurrency", 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(settlementCurrency)) throw new TypeError("settlementCurrency must be a three-letter ISO code");
      const ledgerEntries = this.db
        .query<{ count: number }, [string, string, string]>(
          `SELECT
             (SELECT COUNT(*) FROM expenses WHERE group_id = ?) +
             (SELECT COUNT(*) FROM payments WHERE group_id = ?) +
             (SELECT COUNT(*) FROM imported_transactions WHERE group_id = ?) AS count`,
        )
        .get(operation.groupId, operation.groupId, operation.groupId)?.count ?? 0;
      if (ledgerEntries > 0) throw new Error("Group currency is locked after the first expense or payment");
      const result = this.db
        .query("UPDATE groups SET settlement_currency = ? WHERE id = ? AND deleted_at IS NULL")
        .run(settlementCurrency, operation.groupId);
      if (result.changes !== 1) throw new Error("Group does not exist");
      return;
    }

    if (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended") {
      const payload = parseExpensePayload(operation.payload);
      const importMetadata = parseImportMetadata(jsonObject(operation.payload));
      this.assertFinancialParticipants(operation.groupId, "payers", payload.payers, Boolean(importMetadata));
      this.assertFinancialParticipants(operation.groupId, "allocations", payload.allocations, Boolean(importMetadata));

      const settlementCurrency = this.db
        .query<{ settlement_currency: string }, [string]>("SELECT settlement_currency FROM groups WHERE id = ?")
        .get(operation.groupId)?.settlement_currency;
      if (!settlementCurrency) throw new Error("Group does not exist");
      if (payload.currency !== settlementCurrency) {
        throw new Error(`Expense currency must match the group settlement currency (${settlementCurrency})`);
      }

      const existing = this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      if (operation.type === "ExpenseCreated") {
        if (existing) throw new Error("Expense already exists");
      } else {
        if (!existing) throw new Error("Expense does not exist");
        if (existing.status !== "active") throw new Error("A voided expense cannot be amended");
        if (existing.readOnly) throw new Error("Imported expenses are read-only; undo the migration and import again");
        if (importMetadata) throw new Error("Import provenance is only valid when an expense is created");
      }

      this.db
        .query(
          `INSERT INTO expenses(
            id, group_id, description, category, amount_minor, currency, expense_date,
            notes, status, version, created_by, created_at, updated_at,
            import_batch_id, source_provider, source_record_id, source_metadata_json,
            imported_by, imported_at, read_only
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            description = excluded.description,
            category = excluded.category,
            amount_minor = excluded.amount_minor,
            currency = excluded.currency,
            expense_date = excluded.expense_date,
            notes = excluded.notes,
            version = excluded.version,
            updated_at = excluded.updated_at`,
        )
        .run(
          operation.targetId,
          operation.groupId,
          payload.description,
          payload.category,
          payload.amountMinor,
          payload.currency,
          payload.expenseDate,
          payload.notes,
          importMetadata?.sourceDeleted ? "voided" : "active",
          version,
          operation.actorId,
          receivedAt,
          receivedAt,
          importMetadata?.importBatchId ?? null,
          importMetadata?.sourceProvider ?? null,
          importMetadata?.sourceRecordId ?? null,
          null,
          importMetadata ? operation.actorId : null,
          importMetadata?.importedAt ?? null,
          importMetadata ? 1 : 0,
        );
      this.db.query("DELETE FROM expense_payers WHERE expense_id = ?").run(operation.targetId);
      this.db.query("DELETE FROM expense_allocations WHERE expense_id = ?").run(operation.targetId);
      const payerInsert = this.db.query(
        "INSERT INTO expense_payers(expense_id, participant_id, amount_minor) VALUES (?, ?, ?)",
      );
      for (const payer of payload.payers) payerInsert.run(operation.targetId, payer.participantId, payer.amountMinor);
      const allocationInsert = this.db.query(
        "INSERT INTO expense_allocations(expense_id, participant_id, amount_minor) VALUES (?, ?, ?)",
      );
      for (const allocation of payload.allocations) {
        allocationInsert.run(operation.targetId, allocation.participantId, allocation.amountMinor);
      }
      return;
    }

    if (operation.type === "ExpenseVoided") {
      const existing = this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      if (!existing) throw new Error("Expense does not exist");
      this.assertImportedUndo(operation, existing);
      const result = this.db
        .query("UPDATE expenses SET status = 'voided', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("Expense does not exist");
      return;
    }

    if (operation.type === "ExpenseRestored") {
      const existing = this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      if (!existing) throw new Error("Expense does not exist");
      if (existing.readOnly) throw new Error("Imported expenses cannot be restored independently");
      if (existing.status !== "voided") throw new Error("Only a voided expense can be restored");
      const result = this.db
        .query("UPDATE expenses SET status = 'active', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("Expense does not exist");
      return;
    }

    if (operation.type === "CommentAdded") {
      if (!this.assertTargetGroup("expenses", operation.targetId, operation.groupId)) {
        throw new Error("Expense does not exist");
      }
      const payload = jsonObject(operation.payload);
      this.db
        .query("INSERT INTO comments(id, group_id, target_id, actor_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          operation.id,
          operation.groupId,
          operation.targetId,
          operation.actorId,
          requiredString(payload, "body", 2_000),
          receivedAt,
        );
      return;
    }

    if (operation.type === "PaymentRecorded") {
      const payload = jsonObject(operation.payload);
      const importMetadata = parseImportMetadata(payload);
      const payerId = requiredString(payload, "payerId", 100);
      const recipientId = requiredString(payload, "recipientId", 100);
      if (payerId === recipientId) throw new TypeError("A payment cannot have the same payer and recipient");
      this.assertFinancialParticipants(
        operation.groupId,
        "payment",
        [
          { participantId: payerId, amountMinor: 0 },
          { participantId: recipientId, amountMinor: 0 },
        ],
        Boolean(importMetadata),
      );
      const settlementCurrency = this.db
        .query<{ settlement_currency: string }, [string]>("SELECT settlement_currency FROM groups WHERE id = ?")
        .get(operation.groupId)?.settlement_currency;
      if (!settlementCurrency) throw new Error("Group does not exist");
      const currency = requiredCurrency(payload, "currency");
      if (currency !== settlementCurrency) {
        throw new Error(`Payment currency must match the group settlement currency (${settlementCurrency})`);
      }
      if (this.assertTargetGroup("payments", operation.targetId, operation.groupId)) {
        throw new Error("Payment already exists");
      }
      this.db
        .query(
          `INSERT INTO payments(
            id, group_id, payer_id, recipient_id, amount_minor, currency,
            payment_date, note, status, version, created_at, updated_at,
            import_batch_id, source_provider, source_record_id, source_metadata_json,
            imported_by, imported_at, read_only
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.targetId,
          operation.groupId,
          payerId,
          recipientId,
          requiredMinor(payload, "amountMinor"),
          currency,
          requiredString(payload, "paymentDate", 32),
          optionalString(payload, "note"),
          importMetadata?.sourceDeleted ? "reversed" : "active",
          version,
          receivedAt,
          receivedAt,
          importMetadata?.importBatchId ?? null,
          importMetadata?.sourceProvider ?? null,
          importMetadata?.sourceRecordId ?? null,
          null,
          importMetadata ? operation.actorId : null,
          importMetadata?.importedAt ?? null,
          importMetadata ? 1 : 0,
        );
      return;
    }

    if (operation.type === "PaymentReversed") {
      const existing = this.assertTargetGroup("payments", operation.targetId, operation.groupId);
      if (!existing) throw new Error("Payment does not exist");
      if (existing.status !== "active") throw new Error("Payment is already reversed");
      this.assertImportedUndo(operation, existing);
      const result = this.db
        .query("UPDATE payments SET status = 'reversed', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("Payment does not exist");
      return;
    }

    if (operation.type === "ImportedTransactionRecorded" || operation.type === "OpeningBalanceCreated") {
      const payload = jsonObject(operation.payload);
      const importMetadata = parseImportMetadata(payload);
      if (!importMetadata) throw new TypeError("Imported transactions require source provenance");
      const effects = importEffects(payload);
      this.assertFinancialParticipants(
        operation.groupId,
        "effects",
        effects.map((effect) => ({ participantId: effect.participantId, amountMinor: Math.abs(effect.amountMinor) })),
        true,
      );
      const settlementCurrency = this.db
        .query<{ settlement_currency: string }, [string]>("SELECT settlement_currency FROM groups WHERE id = ?")
        .get(operation.groupId)?.settlement_currency;
      if (!settlementCurrency) throw new Error("Group does not exist");
      const currency = requiredCurrency(payload, "currency");
      if (currency !== settlementCurrency) {
        throw new Error(`Imported currency must match the group settlement currency (${settlementCurrency})`);
      }
      const amountMinor = requiredMinor(payload, "amountMinor");
      const positiveTotal = effects.reduce((sum, effect) => sum + Math.max(0, effect.amountMinor), 0);
      if (positiveTotal !== amountMinor) throw new TypeError("Imported amount must equal its positive balance effects");
      const kind = operation.type === "OpeningBalanceCreated" ? "opening_balance" : "balance_effect";
      this.db.query(
        `INSERT INTO imported_transactions(
           id, batch_id, group_id, kind, description, category, amount_minor, currency,
           transaction_date, notes, source_provider, source_record_id, source_metadata_json,
           imported_by, imported_at, status, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        operation.targetId,
        importMetadata.importBatchId,
        operation.groupId,
        kind,
        requiredString(payload, "description", 200),
        requiredString(payload, "category", 100),
        amountMinor,
        currency,
        requiredString(payload, "transactionDate", 32),
        optionalString(payload, "notes"),
        importMetadata.sourceProvider,
        importMetadata.sourceRecordId,
        null,
        operation.actorId,
        importMetadata.importedAt,
        importMetadata.sourceDeleted ? "voided" : "active",
        version,
      );
      const insertEffect = this.db.query(
        "INSERT INTO imported_transaction_effects(transaction_id, participant_id, amount_minor) VALUES (?, ?, ?)",
      );
      for (const effect of effects) insertEffect.run(operation.targetId, effect.participantId, effect.amountMinor);
      return;
    }

    if (operation.type === "ImportedTransactionVoided" || operation.type === "OpeningBalanceVoided") {
      const existing = this.db.query<{ group_id: string; batch_id: string; status: string }, [string]>(
        "SELECT group_id, batch_id, status FROM imported_transactions WHERE id = ? LIMIT 1",
      ).get(operation.targetId);
      if (!existing || existing.group_id !== operation.groupId) throw new Error("Imported transaction does not exist");
      if (existing.status !== "active") throw new Error("Imported transaction is already voided");
      const requestedBatchId = requiredString(jsonObject(operation.payload), "undoImportBatchId", 100);
      if (requestedBatchId !== existing.batch_id) {
        throw new Error("Imported records can only be changed by undoing their import");
      }
      const owned = this.db.query<{ one: number }, [string, string]>(
        "SELECT 1 AS one FROM import_batches WHERE id = ? AND imported_by = ? AND status = 'completed'",
      ).get(existing.batch_id, operation.actorId);
      if (!owned) throw new Error("Only the migration owner can undo imported records");
      this.db.query("UPDATE imported_transactions SET status = 'voided', version = ? WHERE id = ?")
        .run(version, operation.targetId);
      return;
    }
  }

  pull(actorId: string, after: number, limit = 500): OperationEnvelope[] {
    const rows = this.db
      .query<OperationRow, [string, number, number]>(
        `SELECT o.* FROM operations o
         JOIN group_members gm ON gm.group_id = o.group_id
         WHERE gm.user_id = ? AND gm.status = 'active'
           AND o.status = 'accepted' AND o.server_sequence > ?
         ORDER BY o.server_sequence ASC LIMIT ?`,
      )
      .all(actorId, after, Math.min(limit, 500));
    return rows.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      actorId: row.actor_id,
      deviceId: row.device_id,
      type: row.type as OperationEnvelope["type"],
      targetId: row.target_id,
      baseVersion: row.base_version,
      clientTimestamp: row.client_timestamp,
      payload: JSON.parse(row.payload_json) as JsonValue,
      contentHash: row.content_hash,
      signature: row.signature,
      serverSequence: row.server_sequence,
      receivedAt: row.received_at,
    }));
  }

  manifest(actorId: string): { generation: string; latestServerSequence: number; groups: Array<{ groupId: string; count: number; maxSequence: number }> } {
    const groups = this.db
      .query<{ groupId: string; count: number; maxSequence: number }, [string]>(
        `SELECT o.group_id AS groupId, COUNT(*) AS count, MAX(o.server_sequence) AS maxSequence
         FROM operations o
         JOIN group_members gm ON gm.group_id = o.group_id
         WHERE gm.user_id = ? AND gm.status = 'active' AND o.status = 'accepted'
         GROUP BY o.group_id ORDER BY o.group_id`,
      )
      .all(actorId);
    return { generation: this.generation, latestServerSequence: this.latestSequenceFor(actorId), groups };
  }

  snapshot(actorId: string): { groups: unknown[]; expenses: unknown[]; members: unknown[]; participantAliases: unknown[] } {
    const groups = this.db
      .query(
        `SELECT g.id, g.name, g.settlement_currency AS settlementCurrency, g.created_at AS createdAt,
                COALESCE(ev.version, 0) AS version
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
         LEFT JOIN entity_versions ev ON ev.group_id = g.id AND ev.target_id = g.id
         WHERE gm.user_id = ? AND gm.status = 'active' AND g.deleted_at IS NULL
         ORDER BY g.created_at`,
      )
      .all(actorId);
    const expenses = this.db
      .query(
        `SELECT e.id, e.group_id AS groupId, e.description, e.category,
                e.amount_minor AS amountMinor, e.currency, e.expense_date AS expenseDate,
                e.notes, e.status, e.version, e.created_by AS createdBy
         FROM expenses e JOIN group_members gm ON gm.group_id = e.group_id
         WHERE gm.user_id = ? AND gm.status = 'active'
         ORDER BY e.expense_date DESC, e.created_at DESC`,
      )
      .all(actorId);
    const memberRows = this.db
      .query<{
        groupId: string;
        userId: string;
        displayName: string;
        email: string | null;
        status: string;
        importIdentityId: string | null;
        importBatchId: string | null;
        importClaimStatus: "unclaimed" | "reserved" | "awaiting_owner" | null;
      }, [string, string]>(
        `SELECT gm.group_id AS groupId, gm.user_id AS userId, gm.display_name AS displayName,
                gm.email, gm.status, ii.id AS importIdentityId, ib.id AS importBatchId,
                CASE WHEN ii.status IN ('unclaimed', 'reserved', 'awaiting_owner') THEN ii.status END AS importClaimStatus
         FROM group_members gm
         LEFT JOIN imported_identities ii ON ii.placeholder_user_id = gm.user_id
         LEFT JOIN import_batches ib ON ib.id = ii.batch_id AND ib.imported_by = ? AND ib.status = 'completed'
         WHERE gm.group_id IN (
           SELECT group_id FROM group_members WHERE user_id = ? AND status = 'active'
         ) ORDER BY gm.joined_at`,
      )
      .all(actorId, actorId);
    const members = memberRows.map(({ importIdentityId, importBatchId, importClaimStatus, ...member }) => ({
      ...member,
      ...(importIdentityId && importBatchId && importClaimStatus
        ? { importClaim: { identityId: importIdentityId, batchId: importBatchId, status: importClaimStatus } }
        : {}),
    }));
    const participantAliases = this.db.query<{ groupId: string; fromUserId: string; toUserId: string }, [string]>(
      `SELECT aliases.group_id AS groupId,
              aliases.placeholder_user_id AS fromUserId,
              aliases.claimed_user_id AS toUserId
       FROM import_participant_aliases aliases
       JOIN imported_identities identity
         ON identity.id = aliases.identity_id AND identity.status = 'claimed'
       JOIN group_members viewer ON viewer.group_id = aliases.group_id
       JOIN group_members claimed_member
         ON claimed_member.group_id = viewer.group_id
        AND claimed_member.user_id = aliases.claimed_user_id
        AND claimed_member.status = 'active'
       WHERE viewer.user_id = ? AND viewer.status = 'active'
       ORDER BY aliases.group_id, aliases.placeholder_user_id`,
    ).all(actorId);
    return { groups, expenses, members, participantAliases };
  }
}
