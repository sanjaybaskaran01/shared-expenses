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

  test("voids and restores an expense with versioned audit operations", async () => {
    await store.push("user-1", [await signedOperation(privateKey)]);
    const voided = await signedOperation(privateKey, {
      id: crypto.randomUUID(),
      type: "ExpenseVoided",
      baseVersion: 1,
      payload: { reason: "Entered twice" },
    });
    expect((await store.push("user-1", [voided])).accepted).toHaveLength(1);
    expect(store.snapshot("user-1").expenses).toEqual([
      expect.objectContaining({ status: "voided", version: 2 }),
    ]);

    const restored = await signedOperation(privateKey, {
      id: crypto.randomUUID(),
      type: "ExpenseRestored",
      baseVersion: 2,
      payload: { reason: "Deletion was a mistake" },
    });
    expect((await store.push("user-1", [restored])).accepted).toHaveLength(1);
    expect(store.snapshot("user-1").expenses).toEqual([
      expect.objectContaining({ status: "active", version: 3 }),
    ]);
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

  test("rejects an expense whose currency differs from the group settlement currency", async () => {
    const operation = await signedOperation(privateKey, {
      payload: {
        description: "Dinner",
        category: "Dining out",
        amountMinor: 1000,
        currency: "EUR",
        expenseDate: "2026-07-25",
        notes: "",
        payers: [{ participantId: "user-1", amountMinor: 1000 }],
        allocations: [{ participantId: "user-1", amountMinor: 1000 }],
      },
    });
    const result = await store.push("user-1", [operation]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ message: expect.stringContaining("must match the group settlement currency") }),
    ]);
  });

  test("does not let a create operation overwrite an existing expense", async () => {
    await store.push("user-1", [await signedOperation(privateKey)]);
    const duplicateCreate = await signedOperation(privateKey, {
      id: crypto.randomUUID(),
      baseVersion: 1,
      payload: {
        description: "Replacement",
        category: "Other",
        amountMinor: 1001,
        currency: "USD",
        expenseDate: "2026-07-25",
        notes: "",
        payers: [{ participantId: "user-1", amountMinor: 1001 }],
        allocations: [{ participantId: "user-1", amountMinor: 1001 }],
      },
    });
    const result = await store.push("user-1", [duplicateCreate]);
    expect(result.rejected).toEqual([expect.objectContaining({ message: "Expense already exists" })]);
    expect(store.snapshot("user-1").expenses).toEqual([
      expect.objectContaining({ description: "Dinner", version: 1 }),
    ]);
  });

  test("does not let an amended expense resurrect a voided one", async () => {
    await store.push("user-1", [await signedOperation(privateKey)]);
    await store.push("user-1", [
      await signedOperation(privateKey, { id: crypto.randomUUID(), type: "ExpenseVoided", baseVersion: 1, payload: {} }),
    ]);
    const revive = await signedOperation(privateKey, {
      id: crypto.randomUUID(),
      type: "ExpenseAmended",
      baseVersion: 2,
      payload: {
        description: "Back from the dead",
        category: "Dining out",
        amountMinor: 1001,
        currency: "USD",
        expenseDate: "2026-07-25",
        notes: "",
        payers: [{ participantId: "user-1", amountMinor: 1001 }],
        allocations: [{ participantId: "user-1", amountMinor: 1001 }],
      } as JsonValue,
    });
    const result = await store.push("user-1", [revive]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ message: "A voided expense cannot be amended" }),
    ]);
    expect(store.snapshot("user-1").expenses).toEqual([expect.objectContaining({ status: "voided" })]);
  });

  describe("cross-group isolation", () => {
    beforeEach(async () => {
      store.bootstrapGroup({
        id: "group-2",
        name: "Other trip",
        settlementCurrency: "USD",
        userId: "user-1",
        displayName: "Alex",
      });
      await store.push("user-1", [await signedOperation(privateKey)]);
    });

    test("does not let a member of another group void an expense they cannot see", async () => {
      const attack = await signedOperation(privateKey, {
        id: crypto.randomUUID(),
        groupId: "group-2",
        type: "ExpenseVoided",
        targetId: "expense-1",
        baseVersion: 0,
        payload: {},
      });
      const result = await store.push("user-1", [attack]);
      expect(result.rejected).toEqual([
        expect.objectContaining({ message: "Target belongs to another group" }),
      ]);
      expect(store.snapshot("user-1").expenses).toEqual([
        expect.objectContaining({ id: "expense-1", status: "active" }),
      ]);
    });

    test("does not let a member of another group rewrite an expense they cannot see", async () => {
      const attack = await signedOperation(privateKey, {
        id: crypto.randomUUID(),
        groupId: "group-2",
        type: "ExpenseAmended",
        targetId: "expense-1",
        baseVersion: 0,
        payload: {
          description: "Hijacked",
          category: "Dining out",
          amountMinor: 5000,
          currency: "USD",
          expenseDate: "2026-07-25",
          notes: "",
          payers: [{ participantId: "user-1", amountMinor: 5000 }],
          allocations: [{ participantId: "user-1", amountMinor: 5000 }],
        } as JsonValue,
      });
      const result = await store.push("user-1", [attack]);
      expect(result.rejected).toEqual([
        expect.objectContaining({ message: "Target belongs to another group" }),
      ]);
      expect(store.snapshot("user-1").expenses).toEqual([
        expect.objectContaining({ description: "Dinner", amountMinor: 1001 }),
      ]);
    });

    test("does not let a member of another group restore an expense they cannot see", async () => {
      const attack = await signedOperation(privateKey, {
        id: crypto.randomUUID(),
        groupId: "group-2",
        type: "ExpenseRestored",
        targetId: "expense-1",
        baseVersion: 0,
        payload: {},
      });
      const result = await store.push("user-1", [attack]);
      expect(result.rejected).toEqual([
        expect.objectContaining({ message: "Target belongs to another group" }),
      ]);
    });
  });

  describe("settlements", () => {
    const paymentPayload = (overrides: Record<string, JsonValue> = {}): JsonValue => ({
      payerId: "user-2",
      recipientId: "user-1",
      amountMinor: 500,
      currency: "USD",
      paymentDate: "2026-07-26",
      note: "Bank transfer",
      ...overrides,
    });

    test("records a payment between two active members", async () => {
      const operation = await signedOperation(privateKey, {
        type: "PaymentRecorded",
        targetId: "payment-1",
        payload: paymentPayload(),
      });
      const result = await store.push("user-1", [operation]);
      expect(result.accepted).toHaveLength(1);
      expect(db.query("SELECT payer_id, amount_minor, status FROM payments WHERE id = 'payment-1'").get()).toEqual({
        payer_id: "user-2",
        amount_minor: 500,
        status: "active",
      });
    });

    test("rejects a payment to yourself", async () => {
      const operation = await signedOperation(privateKey, {
        type: "PaymentRecorded",
        targetId: "payment-2",
        payload: paymentPayload({ recipientId: "user-2" }),
      });
      const result = await store.push("user-1", [operation]);
      expect(result.rejected).toEqual([
        expect.objectContaining({ message: "A payment cannot have the same payer and recipient" }),
      ]);
    });

    test("rejects a payment whose currency is not an ISO code", async () => {
      const operation = await signedOperation(privateKey, {
        type: "PaymentRecorded",
        targetId: "payment-3",
        payload: paymentPayload({ currency: "$$" }),
      });
      const result = await store.push("user-1", [operation]);
      expect(result.rejected).toEqual([
        expect.objectContaining({ message: "currency must be a three-letter ISO code" }),
      ]);
    });

    test("rejects a payment in a different currency than the group", async () => {
      const operation = await signedOperation(privateKey, {
        type: "PaymentRecorded",
        targetId: "payment-4",
        payload: paymentPayload({ currency: "EUR" }),
      });
      const result = await store.push("user-1", [operation]);
      expect(result.rejected).toEqual([
        expect.objectContaining({ message: "Payment currency must match the group settlement currency (USD)" }),
      ]);
    });
  });

  test("scopes the reported sequence to groups the caller belongs to", async () => {
    await store.push("user-1", [await signedOperation(privateKey)]);
    db.query(
      "INSERT INTO groups(id, name, settlement_currency, created_by, created_at) VALUES ('group-x', 'Not mine', 'USD', 'user-9', ?)",
    ).run(new Date().toISOString());
    db.query(
      `INSERT INTO operations(
        id, group_id, actor_id, device_id, type, target_id, base_version,
        client_timestamp, payload_json, content_hash, signature, received_at, status
      ) VALUES ('op-x', 'group-x', 'user-9', 'device-9', 'ExpenseCreated', 'expense-x', 0, ?, '{}', 'hash', 'sig', ?, 'accepted')`,
    ).run(new Date().toISOString(), new Date().toISOString());

    expect(store.latestSequence).toBeGreaterThan(store.latestSequenceFor("user-1"));
    expect(store.latestSequenceFor("user-1")).toBe(1);
  });
});
