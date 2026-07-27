import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  isOperationType,
  operationContentHash,
  type JsonValue,
  type OperationEnvelope,
  type ParticipantAmount,
  type SyncPushResult,
  validateExactAllocation,
} from "@expenses/protocol";

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

const versionedTypes = new Set([
  "ExpenseCreated",
  "ExpenseAmended",
  "ExpenseVoided",
  "PaymentRecorded",
  "PaymentReversed",
  "ConflictResolved",
]);

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

export class LedgerStore {
  constructor(private readonly db: Database) {}

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

  registerDevice(input: { id: string; userId: string; publicKeyJwk: JsonWebKey; name: string }): void {
    const existing = this.db
      .query<{ user_id: string; public_key_jwk: string }, [string]>("SELECT user_id, public_key_jwk FROM devices WHERE id = ?")
      .get(input.id);
    if (existing && existing.user_id !== input.userId) {
      throw new Error("Device id is already owned by another account");
    }
    if (existing && existing.public_key_jwk !== JSON.stringify(input.publicKeyJwk)) {
      throw new Error("Device public key cannot be replaced");
    }
    this.db
      .query(
        `INSERT INTO devices(id, user_id, public_key_jwk, name, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON CONFLICT(id) DO UPDATE SET
           public_key_jwk = excluded.public_key_jwk,
           name = excluded.name,
           status = 'active',
           revoked_at = NULL`,
      )
      .run(input.id, input.userId, JSON.stringify(input.publicKeyJwk), input.name, new Date().toISOString());
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

  private async verifyOperation(actorId: string, operation: OperationEnvelope): Promise<string | null> {
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
    if (!this.isActiveMember(operation.groupId, actorId)) return "NOT_A_GROUP_MEMBER";
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
      const key = await crypto.subtle.importKey(
        "jwk",
        JSON.parse(device.public_key_jwk) as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
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
  private assertTargetGroup(table: "expenses" | "payments", targetId: string, groupId: string): { status: string } | null {
    const existing = this.db
      .query<{ group_id: string; status: string }, [string]>(`SELECT group_id, status FROM ${table} WHERE id = ?`)
      .get(targetId);
    if (!existing) return null;
    if (existing.group_id !== groupId) throw new Error("Target belongs to another group");
    return { status: existing.status };
  }

  private applyProjection(operation: OperationEnvelope, version: number, receivedAt: string): void {
    if (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended") {
      const payload = parseExpensePayload(operation.payload);
      this.assertActiveParticipants(operation.groupId, "payers", payload.payers);
      this.assertActiveParticipants(operation.groupId, "allocations", payload.allocations);

      const settlementCurrency = this.db
        .query<{ settlement_currency: string }, [string]>("SELECT settlement_currency FROM groups WHERE id = ?")
        .get(operation.groupId)?.settlement_currency;
      if (!settlementCurrency) throw new Error("Group does not exist");
      if (payload.currency !== settlementCurrency) {
        throw new Error(`Expense currency must match the group settlement currency (${settlementCurrency})`);
      }

      const existing = this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      if (operation.type === "ExpenseAmended") {
        if (!existing) throw new Error("Expense does not exist");
        if (existing.status !== "active") throw new Error("A voided expense cannot be amended");
      }

      this.db
        .query(
          `INSERT INTO expenses(
            id, group_id, description, category, amount_minor, currency, expense_date,
            notes, status, version, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
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
          version,
          operation.actorId,
          receivedAt,
          receivedAt,
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
      this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      const result = this.db
        .query("UPDATE expenses SET status = 'voided', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("Expense does not exist");
      return;
    }

    if (operation.type === "CommentAdded") {
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
      const payerId = requiredString(payload, "payerId", 100);
      const recipientId = requiredString(payload, "recipientId", 100);
      if (payerId === recipientId) throw new TypeError("A payment cannot have the same payer and recipient");
      this.assertActiveParticipants(operation.groupId, "payment", [
        { participantId: payerId, amountMinor: 0 },
        { participantId: recipientId, amountMinor: 0 },
      ]);
      this.assertTargetGroup("payments", operation.targetId, operation.groupId);
      this.db
        .query(
          `INSERT INTO payments(
            id, group_id, payer_id, recipient_id, amount_minor, currency,
            payment_date, note, status, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          operation.targetId,
          operation.groupId,
          payerId,
          recipientId,
          requiredMinor(payload, "amountMinor"),
          requiredCurrency(payload, "currency"),
          requiredString(payload, "paymentDate", 32),
          optionalString(payload, "note"),
          version,
          receivedAt,
          receivedAt,
        );
      return;
    }

    if (operation.type === "PaymentReversed") {
      this.assertTargetGroup("payments", operation.targetId, operation.groupId);
      const result = this.db
        .query("UPDATE payments SET status = 'reversed', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("Payment does not exist");
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

  snapshot(actorId: string): { groups: unknown[]; expenses: unknown[]; members: unknown[] } {
    const groups = this.db
      .query(
        `SELECT g.id, g.name, g.settlement_currency AS settlementCurrency, g.created_at AS createdAt
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
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
    const members = this.db
      .query(
        `SELECT gm.group_id AS groupId, gm.user_id AS userId, gm.display_name AS displayName,
                gm.email, gm.status
         FROM group_members gm
         WHERE gm.group_id IN (
           SELECT group_id FROM group_members WHERE user_id = ? AND status = 'active'
         ) ORDER BY gm.joined_at`,
      )
      .all(actorId);
    return { groups, expenses, members };
  }
}
