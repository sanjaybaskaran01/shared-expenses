import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  confidentialOperationContentHash,
  type ConfidentialOperationEnvelope,
  type UnsignedConfidentialOperation,
} from "@expenses/protocol";
import { ConfidentialLedgerStore } from "../src/confidential-ledger";

function base64Url(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64url");
}

describe("server-blind confidential ledger storage", () => {
  let db: Database;
  let store: ConfidentialLedgerStore;
  let privateKey: CryptoKey;

  beforeEach(async () => {
    db = new Database(":memory:", { strict: true });
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/001_domain.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/004_confidential_sync.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/005_imports.sql"), "utf8"));
    db.exec(`
      INSERT INTO groups(id, name, settlement_currency, created_by, created_at)
      VALUES ('group-1', 'Private group', 'USD', 'alice', '2026-07-28T12:00:00.000Z');
      INSERT INTO group_members(group_id, user_id, display_name, status, joined_at)
      VALUES ('group-1', 'alice', 'Alice', 'active', '2026-07-28T12:00:00.000Z');
    `);
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    privateKey = signing.privateKey;
    const publicKey = await crypto.subtle.exportKey("jwk", signing.publicKey);
    db.query(
      `INSERT INTO devices(id, user_id, public_key_jwk, name, status, created_at)
       VALUES ('alice-phone', 'alice', ?, 'Phone', 'active', '2026-07-28T12:00:00.000Z')`,
    ).run(JSON.stringify(publicKey));
    store = new ConfidentialLedgerStore(db);
  });

  async function signed(overrides: Partial<UnsignedConfidentialOperation> = {}): Promise<ConfidentialOperationEnvelope> {
    const operation: UnsignedConfidentialOperation = {
      version: 1,
      id: crypto.randomUUID(),
      groupId: "group-1",
      actorId: "alice",
      deviceId: "alice-phone",
      keyEpoch: 1,
      clientTimestamp: "2026-07-28T12:00:00.000Z",
      iv: base64Url(crypto.getRandomValues(new Uint8Array(12)).buffer),
      ciphertext: base64Url(new TextEncoder().encode("opaque encrypted bytes").buffer),
      ...overrides,
    };
    const contentHash = await confidentialOperationContentHash(operation);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(contentHash),
    );
    return { ...operation, contentHash, signature: base64Url(signature) };
  }

  test("stores and returns only signed ciphertext for an authorized member", async () => {
    const operation = await signed();
    const result = await store.push("alice", [operation]);
    expect(result.accepted).toHaveLength(1);
    expect(store.pull("alice", 0)[0]).toEqual(expect.objectContaining({ ciphertext: operation.ciphertext }));
    const persisted = db.query<{ value: string }, []>(
      "SELECT group_concat(ciphertext, '') AS value FROM confidential_operations",
    ).get()?.value;
    expect(persisted).not.toContain("Ramen");
  });

  test("retries a valid operation whose id is the malformed-envelope fallback", async () => {
    const operation = await signed({ id: "unknown" });
    const first = await store.push("alice", [operation]);
    const retried = await store.push("alice", [operation]);

    expect(first.accepted).toHaveLength(1);
    expect(retried.duplicates).toEqual([{ id: "unknown", serverSequence: first.accepted[0]!.serverSequence }]);
  });

  test("rejects tampering and callers outside the group", async () => {
    const operation = await signed();
    expect((await store.push("mallory", [operation])).rejected[0]?.code).toBe("INVALID_ENVELOPE");
    expect((await store.push("alice", [{ ...operation, ciphertext: `${operation.ciphertext}a` }])).rejected[0]?.code)
      .toBe("CONTENT_HASH_MISMATCH");
  });

  test("does not disclose a duplicate confidential operation to a non-member", async () => {
    const operation = await signed();
    await store.push("alice", [operation]);

    expect((await store.push("mallory", [operation])).duplicates).toEqual([]);
    expect((await store.push("mallory", [operation])).rejected[0]?.code).toBe("INVALID_ENVELOPE");
  });

  test("rejects malformed envelopes without dereferencing them", async () => {
    const result = await store.push("alice", [null, false, 42, "operation", [], {}, { id: "incomplete" }]);

    expect(result.accepted).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.rejected).toHaveLength(7);
    expect(result.rejected.every(({ code }) => code === "INVALID_ENVELOPE")).toBe(true);
    expect(result.rejected.at(-1)).toEqual({ id: "incomplete", code: "INVALID_ENVELOPE" });
  });

  test("does not accept confidential writes after the group is undone", async () => {
    db.query("UPDATE groups SET deleted_at = ? WHERE id = ?").run("2026-08-14T12:00:00.000Z", "group-1");

    expect((await store.push("alice", [await signed()])).rejected).toEqual([
      expect.objectContaining({ code: "NOT_A_GROUP_MEMBER" }),
    ]);
    expect(store.pull("alice", 0)).toEqual([]);
  });
});
