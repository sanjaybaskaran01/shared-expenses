import type { Database } from "bun:sqlite";
import {
  isOperationType,
  operationContentHash,
  type ImportBatchSummary,
  type JsonValue,
  type OperationEnvelope,
  type ParticipantAmount,
  type SyncPushResult,
  validateExactAllocation,
} from "@expenses/protocol";
import { decryptServerValue, encryptServerValue, keyedDigest } from "./security-keys";

export interface DeviceRow {
  id: string;
  user_id: string;
  public_key_jwk: string;
  status: "active" | "revoked";
}

export interface OperationRow {
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

export interface ExpensePayload {
  description: string;
  category: string;
  amountMinor: number;
  currency: string;
  expenseDate: string;
  notes: string;
  payers: Array<{ participantId: string; amountMinor: number }>;
  allocations: Array<{ participantId: string; amountMinor: number }>;
}

export interface ParsedImportMetadata {
  importBatchId: string;
  sourceProvider: "splitwise";
  sourceRecordId: string;
  importedAt: string;
  importedByDisplayName: string;
  sourceDeleted: boolean;
}

export interface ImportEffect {
  participantId: string;
  amountMinor: number;
}

export const versionedTypes = new Set([
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
]);

// These are the only operation types that currently materialize a server
// projection. Keep the protocol's reserved future types from being accepted as
// successful no-ops, which would otherwise advance entity versions without
// changing the ledger.
const projectedOperationTypes = new Set([
  "ExpenseCreated",
  "ExpenseAmended",
  "ExpenseVoided",
  "ExpenseRestored",
  "CommentAdded",
  "PaymentRecorded",
  "PaymentReversed",
  "ImportedTransactionRecorded",
  "ImportedTransactionVoided",
  "OpeningBalanceCreated",
  "OpeningBalanceVoided",
  "GroupCreated",
  "GroupCurrencyChanged",
]);

export const stagedUploadLimitBytes = 192 * 1024 * 1024;
export const globalStagedUploadLimitBytes = 768 * 1024 * 1024;

export function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

export function jsonObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Operation payload must be a JSON object");
  }
  return value;
}

export function requiredString(payload: Record<string, JsonValue>, key: string, max = 500): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${key} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

export function optionalString(payload: Record<string, JsonValue>, key: string, max = 5_000): string {
  const value = payload[key] ?? "";
  if (typeof value !== "string" || value.length > max) {
    throw new TypeError(`${key} must be a string of at most ${max} characters`);
  }
  return value;
}

export function requiredMinor(payload: Record<string, JsonValue>, key: string, allowZero = false): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    throw new TypeError(`${key} must be ${allowZero ? "a non-negative" : "a positive"} minor-unit integer`);
  }
  return Number(value);
}

export function requiredCurrency(payload: Record<string, JsonValue>, key: string): string {
  const currency = requiredString(payload, key, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError(`${key} must be a three-letter ISO code`);
  return currency;
}

export function participantAmounts(payload: Record<string, JsonValue>, key: string): ParticipantAmount[] {
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

export function parseExpensePayload(value: JsonValue): ExpensePayload {
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

export function parseImportMetadata(payload: Record<string, JsonValue>): ParsedImportMetadata | null {
  const value = payload.import;
  if (value === undefined) return null;
  const metadata = jsonObject(value);
  const sourceProvider = requiredString(metadata, "sourceProvider", 30);
  if (sourceProvider !== "splitwise") throw new TypeError("sourceProvider must be splitwise");
  if (metadata.sourceMetadata !== undefined) {
    throw new TypeError("This import contains unsupported provider data. Create a new import.");
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

export function importEffects(payload: Record<string, JsonValue>): ImportEffect[] {
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

export abstract class LedgerCore {
  protected readonly verificationKeys = new Map<string, Promise<CryptoKey>>();

  constructor(
    protected readonly db: Database,
    protected readonly options: { emailHashSecret?: string } = {},
  ) {}

  protected get rootSecret(): string {
    return this.options.emailHashSecret ?? "test-only-import-email-hash-secret";
  }

  protected secretHash(purpose: string, value: string): string {
    return keyedDigest(this.rootSecret, purpose, value);
  }

  protected emailHash(value: string): string {
    return this.secretHash("identity-email", value.trim().toLowerCase());
  }

  protected importExternalIdHash(provider: string, externalType: string, externalId: string): string {
    return this.secretHash("import-external-id", `${provider}:${externalType}:${externalId}`);
  }

  protected importSemanticIdHash(provider: string, semanticId: string): string {
    return this.secretHash("import-semantic-id", `${provider}:${semanticId}`);
  }

  protected encryptImportEnvelope(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-envelope", value);
  }

  protected decryptImportEnvelope(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-envelope", value);
  }

  protected encryptImportStagedSource(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-source", value);
  }

  protected decryptImportStagedSource(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-source", value);
  }

  protected encryptImportStagedOperation(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-operation", value);
  }

  protected decryptImportStagedOperation(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-operation", value);
  }

  protected encryptImportStagedSemantic(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-semantic", value);
  }

  protected decryptImportStagedSemantic(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-semantic", value);
  }

  protected encryptImportStagedUndo(value: string): string {
    return encryptServerValue(this.rootSecret, "import-stage-undo", value);
  }

  protected decryptImportStagedUndo(value: string): string {
    return decryptServerValue(this.rootSecret, "import-stage-undo", value);
  }

  protected missingStageRanges(batchId: string, expected: number, undo = false): Array<{ start: number; endExclusive: number }> {
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

  protected assertGlobalStagingCapacity(addedBytes: number): void {
    if (addedBytes <= 0) return;
    const importBytes = this.db.query<{ total: number }, []>(
      "SELECT COALESCE(SUM(payload_bytes), 0) AS total FROM import_uploads WHERE status IN ('staging', 'ready', 'activating')",
    ).get()?.total ?? 0;
    const undoBytes = this.db.query<{ total: number }, []>(
      "SELECT COALESCE(SUM(payload_bytes), 0) AS total FROM import_undo_uploads WHERE status IN ('staging', 'ready', 'activating')",
    ).get()?.total ?? 0;
    if (importBytes + undoBytes + addedBytes > globalStagedUploadLimitBytes) {
      throw new TypeError("Temporary import storage is full. Finish or cancel another import, or try again later.");
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
           JOIN groups g ON g.id = o.group_id AND g.deleted_at IS NULL
           WHERE gm.user_id = ? AND gm.status = 'active' AND o.status = 'accepted'`,
        )
        .get(actorId)?.sequence ?? 0
    );
  }

  activeMemberIdsForGroups(groupIds: readonly string[]): string[] {
    const actorIds = new Set<string>();
    for (const groupId of new Set(groupIds)) {
      const rows = this.db.query<{ user_id: string }, [string]>(
        `SELECT gm.user_id FROM group_members gm
         JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
         WHERE gm.group_id = ? AND gm.status = 'active'`,
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

  protected isActiveMember(groupId: string, userId: string): boolean {
    return Boolean(
      this.db
        .query<{ one: number }, [string, string]>(
          `SELECT 1 AS one FROM group_members gm
           JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
           WHERE gm.group_id = ? AND gm.user_id = ? AND gm.status = 'active'`,
        )
        .get(groupId, userId),
    );
  }

  protected assertActiveParticipants(groupId: string, label: string, participants: readonly ParticipantAmount[]): void {
    for (const participant of participants) {
      if (!this.isActiveMember(groupId, participant.participantId)) {
        throw new TypeError(`${label} contains a non-member`);
      }
    }
  }

  protected assertFinancialParticipants(
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

  protected async verifyOperation(
    actorId: string,
    operation: unknown,
    plannedGroupIds: ReadonlySet<string> = new Set(),
  ): Promise<string | null> {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return "INVALID_ENVELOPE";
    const envelope = operation as Partial<OperationEnvelope>;
    if (
      typeof envelope.id !== "string" ||
      envelope.id.length === 0 ||
      envelope.id.length > 100 ||
      typeof envelope.groupId !== "string" ||
      envelope.groupId.length === 0 ||
      envelope.groupId.length > 100 ||
      typeof envelope.actorId !== "string" ||
      typeof envelope.deviceId !== "string" ||
      envelope.deviceId.length === 0 ||
      envelope.deviceId.length > 100 ||
      typeof envelope.targetId !== "string" ||
      envelope.targetId.length === 0 ||
      envelope.targetId.length > 100 ||
      typeof envelope.baseVersion !== "number" ||
      !Number.isSafeInteger(envelope.baseVersion) ||
      envelope.baseVersion < 0 ||
      typeof envelope.clientTimestamp !== "string" ||
      !Number.isFinite(Date.parse(envelope.clientTimestamp)) ||
      typeof envelope.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.contentHash) ||
      typeof envelope.signature !== "string" ||
      envelope.signature.length > 512 ||
      !Object.hasOwn(envelope, "payload")
    ) {
      return "INVALID_ENVELOPE";
    }
    if (envelope.actorId !== actorId) return "ACTOR_MISMATCH";
    if (typeof envelope.type !== "string" || !isOperationType(envelope.type)) return "UNKNOWN_OPERATION_TYPE";
    if (!projectedOperationTypes.has(envelope.type)) return "UNSUPPORTED_OPERATION";
    if (envelope.type !== "GroupCreated" && !this.isActiveMember(envelope.groupId, actorId) && !plannedGroupIds.has(envelope.groupId)) {
      return "NOT_A_GROUP_MEMBER";
    }
    const device = this.db
      .query<DeviceRow, [string]>("SELECT id, user_id, public_key_jwk, status FROM devices WHERE id = ?")
      .get(envelope.deviceId);
    if (!device || device.user_id !== actorId || device.status !== "active") return "DEVICE_NOT_TRUSTED";

    let expectedHash: string;
    try {
      expectedHash = await operationContentHash({
        id: envelope.id,
        groupId: envelope.groupId,
        actorId: envelope.actorId,
        deviceId: envelope.deviceId,
        type: envelope.type,
        targetId: envelope.targetId,
        baseVersion: envelope.baseVersion,
        clientTimestamp: envelope.clientTimestamp,
        payload: envelope.payload as JsonValue,
      });
    } catch {
      return "INVALID_ENVELOPE";
    }
    if (expectedHash !== envelope.contentHash) return "CONTENT_HASH_MISMATCH";

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
        decodeBase64Url(envelope.signature),
        new TextEncoder().encode(envelope.contentHash),
      );
      return valid ? null : "INVALID_SIGNATURE";
    } catch {
      return "INVALID_SIGNATURE";
    }
  }

  protected async verifyImportOperationBatch(
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

  protected assertImportActivationAuthorization(
    actorId: string,
    operations: readonly OperationEnvelope[],
    plannedGroupIds: ReadonlySet<string>,
  ): void {
    const deviceIds = new Set<string>();
    for (const operation of operations) {
      if (operation.actorId !== actorId) throw new TypeError("Import operation actor does not match the signed-in account");
      if (!plannedGroupIds.has(operation.groupId)) {
        throw new TypeError("Every imported entry must belong to a group created by this import.");
      }
      deviceIds.add(operation.deviceId);
    }
    if (deviceIds.size !== 1) throw new TypeError("An import must be signed by one trusted device");
    const deviceId = [...deviceIds][0]!;
    const device = this.db.query<Pick<DeviceRow, "user_id" | "status">, [string]>(
      "SELECT user_id, status FROM devices WHERE id = ? LIMIT 1",
    ).get(deviceId);
    if (!device || device.user_id !== actorId || device.status !== "active") {
      throw new TypeError("This device is no longer trusted to finish the import. Sign in again and retry.");
    }
  }

  async push(actorId: string, operations: readonly unknown[]): Promise<SyncPushResult> {
    const result: SyncPushResult = {
      accepted: [],
      duplicates: [],
      conflicts: [],
      rejected: [],
      latestServerSequence: this.latestSequenceFor(actorId),
      generation: this.generation,
    };

    if (operations.length > 100) {
      result.rejected.push({ id: "batch", code: "BATCH_TOO_LARGE", message: "Sync no more than 100 changes at a time." });
      return result;
    }

    for (const candidate of operations) {
      const operationId = candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
        typeof (candidate as { id?: unknown }).id === "string"
        ? (candidate as { id: string }).id
        : "unknown";
      const verificationError = await this.verifyOperation(actorId, candidate);
      if (verificationError) {
        result.rejected.push({ id: operationId, code: verificationError, message: "Operation verification failed" });
        continue;
      }
      const operation = candidate as OperationEnvelope;
      const existing = this.db
        .query<{
          server_sequence: number;
          content_hash: string;
          status: "accepted" | "conflicted" | "rejected";
          conflict_id: string | null;
          current_version: number | null;
        }, [string]>(
          `SELECT o.server_sequence, o.content_hash, o.status,
                  c.id AS conflict_id, c.current_version
           FROM operations o LEFT JOIN conflicts c ON c.operation_id = o.id
           WHERE o.id = ?`,
        )
        .get(operation.id);
      if (existing) {
        if (existing.content_hash !== operation.contentHash) {
          result.rejected.push({ id: operation.id, code: "OPERATION_ID_REUSED", message: "Operation id is already in use" });
        } else if (existing.status === "accepted") {
          result.duplicates.push({ id: operation.id, serverSequence: existing.server_sequence });
        } else if (existing.status === "conflicted" && existing.conflict_id && existing.current_version !== null) {
          result.conflicts.push({
            id: operation.id,
            conflictId: existing.conflict_id,
            currentVersion: existing.current_version,
          });
        } else {
          result.rejected.push({ id: operation.id, code: "OPERATION_ID_REUSED", message: "Operation id is already in use" });
        }
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

  protected importBatchSummary(batchId: string, actorId: string): ImportBatchSummary {
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
    if (!row || !["completed", "undone", "cancelled"].includes(row.status)) throw new Error("This import is no longer available. Start again.");
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


  protected abstract ingestVerified(operation: OperationEnvelope):
    | { kind: "accepted"; serverSequence: number }
    | { kind: "conflict"; conflictId: string; currentVersion: number };
}
