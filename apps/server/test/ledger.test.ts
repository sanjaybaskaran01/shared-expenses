import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { operationContentHash, type JsonValue, type OperationEnvelope, type UnsignedOperation } from "@expenses/protocol";
import { openDatabase } from "../src/database";
import { LedgerStore } from "../src/ledger";

function encodeBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signedOperation(
  privateKey: CryptoKey,
  overrides: Partial<UnsignedOperation> = {},
): Promise<OperationEnvelope> {
  const operation: UnsignedOperation = {
    id: crypto.randomUUID(),
    groupId: "group-1",
    actorId: "user-1",
    deviceId: "device-1",
    type: "ExpenseCreated",
    targetId: "expense-1",
    baseVersion: 0,
    clientTimestamp: new Date().toISOString(),
    payload: {
      description: "Dinner",
      category: "Dining out",
      amountMinor: 1001,
      currency: "USD",
      expenseDate: "2026-07-25",
      notes: "",
      payers: [{ participantId: "user-1", amountMinor: 1001 }],
      allocations: [
        { participantId: "user-1", amountMinor: 501 },
        { participantId: "user-2", amountMinor: 500 },
      ],
    },
    ...overrides,
  };
  const contentHash = await operationContentHash(operation);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(contentHash),
  );
  return { ...operation, contentHash, signature: encodeBase64Url(signature) };
}

describe("ledger ingestion", () => {
  let db: Database;
  let store: LedgerStore;
  let privateKey: CryptoKey;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/001_domain.sql"), "utf8"));
    db.query("INSERT INTO app_meta(key, value) VALUES ('generation', 'test-generation')").run();
    store = new LedgerStore(db);
    store.bootstrapGroup({
      id: "group-1",
      name: "Trip",
      settlementCurrency: "USD",
      userId: "user-1",
      displayName: "Alex",
    });
    db.query(
      "INSERT INTO group_members(group_id, user_id, display_name, status, joined_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("group-1", "user-2", "Friend", new Date().toISOString());
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    privateKey = keys.privateKey;
    store.registerDevice({
      id: "device-1",
      userId: "user-1",
      publicKeyJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
      name: "Test phone",
    });
  });

  afterEach(() => db.close());

  test("accepts a signed expense and materializes its projection", async () => {
    const operation = await signedOperation(privateKey);
    const result = await store.push("user-1", [operation]);
    expect(result.accepted).toHaveLength(1);
    expect(store.snapshot("user-1").expenses).toEqual([
      expect.objectContaining({ description: "Dinner", amountMinor: 1001, version: 1 }),
    ]);
  });

  test("is idempotent by operation UUID", async () => {
    const operation = await signedOperation(privateKey);
    await store.push("user-1", [operation]);
    const second = await store.push("user-1", [operation]);
    expect(second.duplicates).toHaveLength(1);
    expect(store.pull("user-1", 0)).toHaveLength(1);
  });

  test("creates an explicit conflict for a stale financial edit", async () => {
    await store.push("user-1", [await signedOperation(privateKey)]);
    const staleEdit = await signedOperation(privateKey, {
      id: crypto.randomUUID(),
      type: "ExpenseAmended",
      baseVersion: 0,
      payload: {
        description: "Changed dinner",
        category: "Dining out",
        amountMinor: 1001,
        currency: "USD",
        expenseDate: "2026-07-25",
        notes: "",
        payers: [{ participantId: "user-1", amountMinor: 1001 }],
        allocations: [{ participantId: "user-1", amountMinor: 1001 }],
      } as JsonValue,
    });
    const result = await store.push("user-1", [staleEdit]);
    expect(result.conflicts).toEqual([expect.objectContaining({ currentVersion: 1 })]);
    expect(store.snapshot("user-1").expenses).toEqual([
      expect.objectContaining({ description: "Dinner", version: 1 }),
    ]);
  });

  test("lets an active group member correct an expense created by another member", async () => {
    const otherKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    store.registerDevice({
      id: "device-2",
      userId: "user-2",
      publicKeyJwk: await crypto.subtle.exportKey("jwk", otherKeys.publicKey),
      name: "Friend phone",
    });
    const original = await signedOperation(otherKeys.privateKey, {
      actorId: "user-2",
      deviceId: "device-2",
    });
    expect((await store.push("user-2", [original])).accepted).toHaveLength(1);

    const correction = await signedOperation(privateKey, {
      id: crypto.randomUUID(),
      type: "ExpenseAmended",
      baseVersion: 1,
      payload: {
        description: "Corrected dinner",
        category: "Dining out",
        amountMinor: 1200,
        currency: "USD",
        expenseDate: "2026-07-25",
        notes: "Corrected by another group member",
        payers: [{ participantId: "user-2", amountMinor: 1200 }],
        allocations: [
          { participantId: "user-1", amountMinor: 600 },
          { participantId: "user-2", amountMinor: 600 },
        ],
      },
    });
    expect((await store.push("user-1", [correction])).accepted).toHaveLength(1);
    expect(store.snapshot("user-1").expenses).toEqual([
      expect.objectContaining({ description: "Corrected dinner", version: 2, createdBy: "user-2" }),
    ]);
  });

  test("allows a trusted user to create an additional group", async () => {
    const groupId = "group-2";
    const operation = await signedOperation(privateKey, {
      id: crypto.randomUUID(),
      groupId,
      type: "GroupCreated",
      targetId: groupId,
      baseVersion: 0,
      payload: { name: "Apartment", settlementCurrency: "USD" },
    });
    expect((await store.push("user-1", [operation])).accepted).toHaveLength(1);
    expect(store.snapshot("user-1").groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: groupId, name: "Apartment", settlementCurrency: "USD" }),
    ]));
  });

  test("rejects a modified payload with the original signature", async () => {
    const operation = await signedOperation(privateKey);
    operation.payload = { ...(operation.payload as Record<string, JsonValue>), description: "Tampered" };
    const result = await store.push("user-1", [operation]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ code: "CONTENT_HASH_MISMATCH" }),
    ]);
  });

  test("rejects allocations to users who are not active group members", async () => {
    const operation = await signedOperation(privateKey, {
      payload: {
        description: "Dinner",
        category: "Dining out",
        amountMinor: 1001,
        currency: "USD",
        expenseDate: "2026-07-25",
        notes: "",
        payers: [{ participantId: "user-1", amountMinor: 1001 }],
        allocations: [{ participantId: "not-a-member", amountMinor: 1001 }],
      },
    });
    const result = await store.push("user-1", [operation]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ code: "INVALID_OPERATION", message: "allocations contains a non-member" }),
    ]);
  });

  test("does not let another account take over an existing device id", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    expect(() =>
      store.registerDevice({
        id: "device-1",
        userId: "user-2",
        publicKeyJwk,
        name: "Imposter phone",
      }),
    ).toThrow("Device id is already owned by another account");
  });

  test("does not let a session replace an existing device public key", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    expect(() =>
      store.registerDevice({ id: "device-1", userId: "user-1", publicKeyJwk, name: "Replacement" }),
    ).toThrow("Device public key cannot be replaced");
  });
});
