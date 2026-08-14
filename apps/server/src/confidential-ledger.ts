import type { Database } from "bun:sqlite";
import {
  confidentialOperationContentHash,
  groupKeyEnvelopeContentHash,
  type ConfidentialOperationEnvelope,
  type GroupKeyEnvelope,
} from "@expenses/protocol";

interface DeviceRow {
  id: string;
  user_id: string;
  public_key_jwk: string;
  encryption_public_key_jwk: string | null;
  status: "active" | "revoked";
}

interface ConfidentialOperationRow {
  server_sequence: number;
  id: string;
  group_id: string;
  actor_id: string;
  device_id: string;
  key_epoch: number;
  client_timestamp: string;
  iv: string;
  ciphertext: string;
  content_hash: string;
  signature: string;
  received_at: string;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

function compactBase64Url(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

async function verifyDeviceSignature(
  publicKeyJwk: JsonWebKey,
  contentHash: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(contentHash),
    );
  } catch {
    return false;
  }
}

export class ConfidentialLedgerStore {
  constructor(private readonly db: Database) {}

  private activeMember(groupId: string, userId: string): boolean {
    return Boolean(this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM group_members gm
       JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
       WHERE gm.group_id = ? AND gm.user_id = ? AND gm.status = 'active'`,
    ).get(groupId, userId));
  }

  private device(deviceId: string): DeviceRow | null {
    return this.db.query<DeviceRow, [string]>(
      `SELECT id, user_id, public_key_jwk, encryption_public_key_jwk, status
       FROM devices WHERE id = ?`,
    ).get(deviceId) ?? null;
  }

  private async validateOperation(
    actorId: string,
    operation: unknown,
  ): Promise<string | null> {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return "INVALID_ENVELOPE";
    const envelope = operation as Partial<ConfidentialOperationEnvelope>;
    if (
      envelope.version !== 1 ||
      typeof envelope.id !== "string" || envelope.id.length < 1 || envelope.id.length > 100 ||
      typeof envelope.groupId !== "string" || envelope.groupId.length < 1 || envelope.groupId.length > 100 ||
      typeof envelope.actorId !== "string" || envelope.actorId !== actorId ||
      typeof envelope.deviceId !== "string" || envelope.deviceId.length < 1 || envelope.deviceId.length > 100 ||
      typeof envelope.keyEpoch !== "number" || !Number.isSafeInteger(envelope.keyEpoch) || envelope.keyEpoch < 1 ||
      typeof envelope.clientTimestamp !== "string" || !Number.isFinite(Date.parse(envelope.clientTimestamp)) ||
      !compactBase64Url(envelope.iv, 64) ||
      !compactBase64Url(envelope.ciphertext, 1_000_000) ||
      typeof envelope.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(envelope.contentHash) ||
      !compactBase64Url(envelope.signature, 512)
    ) return "INVALID_ENVELOPE";
    if (!this.activeMember(envelope.groupId, actorId)) return "NOT_A_GROUP_MEMBER";
    const device = this.device(envelope.deviceId);
    if (!device || device.status !== "active" || device.user_id !== actorId) return "UNTRUSTED_DEVICE";
    try {
      const expectedHash = await confidentialOperationContentHash(envelope as ConfidentialOperationEnvelope);
      if (expectedHash !== envelope.contentHash) return "CONTENT_HASH_MISMATCH";
      return await verifyDeviceSignature(JSON.parse(device.public_key_jwk), expectedHash, envelope.signature)
        ? null
        : "INVALID_SIGNATURE";
    } catch {
      return "INVALID_ENVELOPE";
    }
  }

  async push(actorId: string, operations: readonly unknown[]): Promise<{
    accepted: Array<{ id: string; serverSequence: number }>;
    duplicates: Array<{ id: string; serverSequence: number }>;
    rejected: Array<{ id: string; code: string }>;
    latestServerSequence: number;
  }> {
    const accepted: Array<{ id: string; serverSequence: number }> = [];
    const duplicates: Array<{ id: string; serverSequence: number }> = [];
    const rejected: Array<{ id: string; code: string }> = [];
    for (const candidate of operations.slice(0, 100)) {
      const rejectedId = candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
        typeof (candidate as { id?: unknown }).id === "string"
        ? (candidate as { id: string }).id
        : "unknown";
      const code = await this.validateOperation(actorId, candidate);
      if (code) {
        rejected.push({ id: rejectedId, code });
        continue;
      }
      const operation = candidate as ConfidentialOperationEnvelope;
      const existing = this.db.query<{ server_sequence: number; content_hash: string }, [string]>(
        "SELECT server_sequence, content_hash FROM confidential_operations WHERE id = ?",
      ).get(operation.id);
      if (existing) {
        if (existing.content_hash === operation.contentHash) {
          duplicates.push({ id: operation.id, serverSequence: existing.server_sequence });
        } else {
          rejected.push({ id: operation.id, code: "OPERATION_ID_REUSED" });
        }
        continue;
      }
      const receivedAt = new Date().toISOString();
      const result = this.db.query(
        `INSERT INTO confidential_operations(
           id, group_id, actor_id, device_id, key_epoch, client_timestamp,
           iv, ciphertext, content_hash, signature, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        operation.id,
        operation.groupId,
        actorId,
        operation.deviceId,
        operation.keyEpoch,
        operation.clientTimestamp,
        operation.iv,
        operation.ciphertext,
        operation.contentHash,
        operation.signature,
        receivedAt,
      );
      accepted.push({ id: operation.id, serverSequence: Number(result.lastInsertRowid) });
    }
    return {
      accepted,
      duplicates,
      rejected,
      latestServerSequence: this.latestSequenceFor(actorId),
    };
  }

  latestSequenceFor(actorId: string): number {
    return this.db.query<{ sequence: number }, [string]>(
      `SELECT COALESCE(MAX(co.server_sequence), 0) AS sequence
       FROM confidential_operations co
       JOIN group_members gm ON gm.group_id = co.group_id
       JOIN groups g ON g.id = co.group_id AND g.deleted_at IS NULL
       WHERE gm.user_id = ? AND gm.status = 'active'`,
    ).get(actorId)?.sequence ?? 0;
  }

  pull(actorId: string, after: number): ConfidentialOperationEnvelope[] {
    return this.db.query<ConfidentialOperationRow, [string, number]>(
      `SELECT co.* FROM confidential_operations co
       JOIN group_members gm ON gm.group_id = co.group_id
       JOIN groups g ON g.id = co.group_id AND g.deleted_at IS NULL
       WHERE gm.user_id = ? AND gm.status = 'active' AND co.server_sequence > ?
       ORDER BY co.server_sequence LIMIT 500`,
    ).all(actorId, after).map((row) => ({
      version: 1,
      id: row.id,
      groupId: row.group_id,
      actorId: row.actor_id,
      deviceId: row.device_id,
      keyEpoch: row.key_epoch,
      clientTimestamp: row.client_timestamp,
      iv: row.iv,
      ciphertext: row.ciphertext,
      contentHash: row.content_hash,
      signature: row.signature,
      serverSequence: row.server_sequence,
      receivedAt: row.received_at,
    }));
  }

  groupDevices(actorId: string, groupId: string): Array<{
    id: string;
    userId: string;
    encryptionPublicKeyJwk: JsonWebKey;
  }> {
    if (!this.activeMember(groupId, actorId)) throw new Error("Active group membership is required");
    return this.db.query<{ id: string; user_id: string; encryption_public_key_jwk: string }, [string]>(
      `SELECT d.id, d.user_id, d.encryption_public_key_jwk
       FROM devices d
       JOIN group_members gm ON gm.user_id = d.user_id
       WHERE gm.group_id = ? AND gm.status = 'active' AND d.status = 'active'
         AND d.encryption_public_key_jwk IS NOT NULL`,
    ).all(groupId).map((row) => ({
      id: row.id,
      userId: row.user_id,
      encryptionPublicKeyJwk: JSON.parse(row.encryption_public_key_jwk),
    }));
  }

  async putKeyEnvelope(actorId: string, envelope: GroupKeyEnvelope): Promise<"created" | "duplicate"> {
    if (
      envelope.version !== 1 ||
      !Number.isSafeInteger(envelope.keyEpoch) || envelope.keyEpoch < 1 ||
      !compactBase64Url(envelope.salt, 128) ||
      !compactBase64Url(envelope.iv, 64) ||
      !compactBase64Url(envelope.ciphertext, 2_048) ||
      !/^[a-f0-9]{64}$/.test(envelope.contentHash) ||
      !compactBase64Url(envelope.signature, 512)
    ) throw new TypeError("Invalid group key envelope");
    if (!this.activeMember(envelope.groupId, actorId)) throw new Error("Active group membership is required");
    const sender = this.device(envelope.senderDeviceId);
    const recipient = this.device(envelope.recipientDeviceId);
    if (!sender || sender.status !== "active" || sender.user_id !== actorId) throw new Error("Untrusted sender device");
    if (!recipient || recipient.status !== "active" || !recipient.encryption_public_key_jwk ||
      !this.activeMember(envelope.groupId, recipient.user_id)) throw new Error("Invalid recipient device");
    const expectedHash = await groupKeyEnvelopeContentHash(envelope);
    if (expectedHash !== envelope.contentHash ||
      !await verifyDeviceSignature(JSON.parse(sender.public_key_jwk), expectedHash, envelope.signature)) {
      throw new Error("Invalid group key envelope signature");
    }
    const existing = this.db.query<{ content_hash: string }, [string, number, string]>(
      `SELECT content_hash FROM group_key_envelopes
       WHERE group_id = ? AND key_epoch = ? AND recipient_device_id = ?`,
    ).get(envelope.groupId, envelope.keyEpoch, envelope.recipientDeviceId);
    if (existing) {
      if (existing.content_hash !== envelope.contentHash) throw new Error("A different key envelope already exists");
      return "duplicate";
    }
    this.db.query(
      `INSERT INTO group_key_envelopes(
         group_id, key_epoch, recipient_device_id, sender_device_id,
         envelope_json, content_hash, signature, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      envelope.groupId,
      envelope.keyEpoch,
      envelope.recipientDeviceId,
      envelope.senderDeviceId,
      JSON.stringify(envelope),
      envelope.contentHash,
      envelope.signature,
      new Date().toISOString(),
    );
    return "created";
  }

  keyEnvelopes(actorId: string, groupId: string): GroupKeyEnvelope[] {
    if (!this.activeMember(groupId, actorId)) throw new Error("Active group membership is required");
    return this.db.query<{ envelope_json: string }, [string, string]>(
      `SELECT gke.envelope_json FROM group_key_envelopes gke
       JOIN devices d ON d.id = gke.recipient_device_id
       WHERE gke.group_id = ? AND d.user_id = ? AND d.status = 'active'
       ORDER BY gke.key_epoch DESC`,
    ).all(groupId, actorId).map((row) => JSON.parse(row.envelope_json) as GroupKeyEnvelope);
  }
}
