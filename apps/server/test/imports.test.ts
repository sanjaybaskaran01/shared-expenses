import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalJson,
  importPreparationMaterial,
  operationContentHash,
  sha256Hex,
  type ImportBatchCommitRequest,
  type OperationEnvelope,
  type UnsignedOperation,
} from "@expenses/protocol";
import { openDatabase } from "../src/database";
import { LedgerStore } from "../src/ledger";

function encodeBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(privateKey: CryptoKey, operation: UnsignedOperation): Promise<OperationEnvelope> {
  const contentHash = await operationContentHash(operation);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(contentHash),
  );
  return { ...operation, contentHash, signature: encodeBase64Url(signature) };
}

async function stageStart(body: ImportBatchCommitRequest) {
  const { operations, operationLinks: _operationLinks, ...batch } = body;
  return {
    batch,
    expectedOperationCount: operations.length,
    preparationHash: await sha256Hex(canonicalJson(importPreparationMaterial(body))),
  };
}

describe("Splitwise migration ledger", () => {
  let db: Database;
  let store: LedgerStore;
  let privateKey: CryptoKey;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/001_domain.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/002_invitations.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/004_confidential_sync.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/005_imports.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/006_import_hardening.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/007_import_preparation_binding.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/009_import_participant_aliases.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/010_invitation_participant_aliases.sql"), "utf8"));
    db.exec(`
      CREATE TABLE "user" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO "user"(id, name, email) VALUES ('user-1', 'Sam', 'sam@example.com');
      INSERT INTO app_meta(key, value) VALUES ('generation', 'import-test');
    `);
    store = new LedgerStore(db, { emailHashSecret: "unit-test-secret" });
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

  async function request(overrides: Partial<ImportBatchCommitRequest> = {}): Promise<ImportBatchCommitRequest> {
    const batchId = "11111111-1111-4111-8111-111111111111";
    const timestamp = "2026-08-04T12:00:00.000Z";
    const group = await sign(privateKey, {
      id: "import-group-operation",
      groupId: "import-group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: "GroupCreated",
      targetId: "import-group-1",
      baseVersion: 0,
      clientTimestamp: timestamp,
      payload: { name: "Goa · USD", settlementCurrency: "USD" },
    });
    const record = await sign(privateKey, {
      id: "import-record-operation",
      groupId: "import-group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: "ImportedTransactionRecorded",
      targetId: "import-record-1",
      baseVersion: 0,
      clientTimestamp: timestamp,
      payload: {
        description: "Legacy balance effect",
        category: "Imported from Splitwise",
        amountMinor: 500,
        currency: "USD",
        transactionDate: "2026-07-01",
        notes: "",
        effects: [
          { participantId: "user-1", amountMinor: 500 },
          { participantId: "import:identity-friend", amountMinor: -500 },
        ],
        import: {
          importBatchId: batchId,
          sourceProvider: "splitwise",
          sourceRecordId: "import-record-1",
          importedAt: timestamp,
          importedByDisplayName: "Sam",
          readOnly: true,
        },
      },
    });
    return {
      id: batchId,
      provider: "splitwise",
      mode: "history",
      fingerprint: "a".repeat(64),
      sourceHashes: ["b".repeat(64)],
      selectedSourceGroups: ["goa:USD"],
      identities: [
        {
          id: "identity-self",
          externalId: "split-self",
          displayName: "Sam",
          email: "sam@example.com",
          emailTrust: "exported",
          groupIds: ["import-group-1"],
          isImporter: true,
          localUserId: "user-1",
        },
        {
          id: "identity-friend",
          externalId: "split-friend",
          displayName: "Mira",
          emailTrust: "none",
          groupIds: ["import-group-1"],
          localUserId: "import:identity-friend",
        },
      ],
      operations: [group, record],
      operationLinks: [
        { operationId: group.id, externalType: "group", externalId: "goa:USD" },
        { operationId: record.id, externalType: "record", externalId: "csv:goa:2", dedupeStrategy: "csv_candidate", semanticId: "d".repeat(64), sourceMetadata: { row: 2 } },
      ],
      sourceBalances: [
        { externalGroupId: "goa:USD", externalPersonId: "split-self", currency: "USD", amountMinor: 500 },
        { externalGroupId: "goa:USD", externalPersonId: "split-friend", currency: "USD", amountMinor: -500 },
      ],
      reconciliation: {
        groupCount: 1,
        personCount: 2,
        recordCount: 1,
        duplicateCount: 0,
        unresolvedPeople: 0,
        malformedRecords: 0,
        zeroSum: true,
        lines: [],
        participantTotals: [
          { externalPersonId: "split-friend", currency: "USD", paidMinor: 0, owedMinor: 0, paymentsSentMinor: 0, paymentsReceivedMinor: 0, netMinor: -500 },
          { externalPersonId: "split-self", currency: "USD", paidMinor: 0, owedMinor: 0, paymentsSentMinor: 0, paymentsReceivedMinor: 0, netMinor: 500 },
        ],
        groupTotals: [
          { externalGroupId: "goa:USD", currency: "USD", paidMinor: 0, owedMinor: 0, paymentsMinor: 0, netMinor: 0 },
        ],
        blockingWarnings: [],
      },
      warnings: [],
      ...overrides,
    };
  }

  test("activates an import atomically and creates a non-authorized placeholder", async () => {
    const result = await store.activateImport("user-1", await request());
    expect(result.duplicate).toBe(false);
    expect(result.accepted).toHaveLength(2);
    expect(db.query<{ status: string }, [string, string]>(
      "SELECT status FROM group_members WHERE group_id = ? AND user_id = ?",
    ).get("import-group-1", "import:identity-friend")).toEqual({ status: "placeholder" });
    expect(store.pull("import:identity-friend", 0)).toEqual([]);
    expect(db.query<{ status: string; kind: string }, [string]>(
      "SELECT status, kind FROM imported_transactions WHERE id = ?",
    ).get("import-record-1")).toEqual({ status: "active", kind: "balance_effect" });
    expect(JSON.stringify(db.query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM operations WHERE id = ?",
    ).get("import-record-operation"))).not.toContain("csv:goa:2");
  });

  test("shows claim controls only to the migration owner in a shared group snapshot", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    db.exec(`
      INSERT INTO "user"(id, name, email) VALUES ('user-3', 'Observer', 'observer@example.com');
      INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
      VALUES ('import-group-1', 'user-3', 'Observer', 'observer@example.com', 'active', '2026-08-04T12:00:00.000Z');
    `);

    const ownerMembers = store.snapshot("user-1").members as Array<Record<string, unknown>>;
    expect(ownerMembers.find(({ userId }) => userId === "import:identity-friend")).toEqual(expect.objectContaining({
      importClaim: {
        batchId: body.id,
        identityId: "identity-friend",
        status: "unclaimed",
      },
    }));

    const observerMembers = store.snapshot("user-3").members as Array<Record<string, unknown>>;
    expect(observerMembers.find(({ userId }) => userId === "import:identity-friend")).not.toHaveProperty("importClaim");
  });

  test("does not enumerate or auto-bind a trusted exported email", async () => {
    db.query('INSERT INTO "user"(id, name, email) VALUES (?, ?, ?)').run("user-2", "Mira", "mira@example.com");
    const body = await request();
    body.identities[1] = {
      ...body.identities[1]!,
      email: "mira@example.com",
      emailTrust: "exported",
      localUserId: "import:identity-friend",
    };
    expect(store.resolveImportIdentityTargets("user-1", {
      provider: "splitwise",
      identities: body.identities,
    }).resolved["split-friend"]).toBe("import:identity-friend");
    await store.activateImport("user-1", body);
    expect(db.query<{ status: string }, [string, string]>(
      "SELECT status FROM group_members WHERE group_id = ? AND user_id = ?",
    ).get("import-group-1", "import:identity-friend")).toEqual({ status: "placeholder" });
    expect(db.query<{ status: string }, [string, string]>(
      "SELECT status FROM group_members WHERE group_id = ? AND user_id = ?",
    ).get("import-group-1", "user-2")).toBeNull();
  });

  test("sums reconciliation totals for multiple imported aliases selected as the importer", async () => {
    const body = await request();
    body.identities.splice(1, 0, {
      id: "identity-self-alias",
      externalId: "split-self-alias",
      displayName: "S. Example",
      emailTrust: "none",
      groupIds: ["import-group-1"],
      isImporter: true,
      localUserId: "user-1",
    });
    body.sourceBalances = [
      { externalGroupId: "goa:USD", externalPersonId: "split-self", currency: "USD", amountMinor: 300 },
      { externalGroupId: "goa:USD", externalPersonId: "split-self-alias", currency: "USD", amountMinor: 200 },
      { externalGroupId: "goa:USD", externalPersonId: "split-friend", currency: "USD", amountMinor: -500 },
    ];
    body.reconciliation.participantTotals = [
      { externalPersonId: "split-self", currency: "USD", paidMinor: 0, owedMinor: 0, paymentsSentMinor: 0, paymentsReceivedMinor: 0, netMinor: 300 },
      { externalPersonId: "split-self-alias", currency: "USD", paidMinor: 0, owedMinor: 0, paymentsSentMinor: 0, paymentsReceivedMinor: 0, netMinor: 200 },
      { externalPersonId: "split-friend", currency: "USD", paidMinor: 0, owedMinor: 0, paymentsSentMinor: 0, paymentsReceivedMinor: 0, netMinor: -500 },
    ];
    const result = await store.activateImport("user-1", body);
    expect(result.duplicate).toBe(false);
    expect(db.query<{ count: number }, [string, string]>(
      "SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND user_id = ?",
    ).get("import-group-1", "user-1")?.count).toBe(1);
  });

  test("rejects a mapping whose provider type does not match its signed operation", async () => {
    const body = await request();
    body.operationLinks[0] = { ...body.operationLinks[0]!, externalType: "record" };
    expect(store.activateImport("user-1", body)).rejects.toThrow("mapping type");
  });

  test("returns the completed batch after a lost response retry", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    const retried = await store.activateImport("user-1", body);
    expect(retried.duplicate).toBe(true);
    expect(retried.accepted).toEqual([]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM operations").get()?.count).toBe(2);
  });

  test("blocks overlapping records even when a second file set has a different fingerprint", async () => {
    const first = await request();
    await store.activateImport("user-1", first);
    const second = await request();
    const secondBatchId = "22222222-2222-4222-8222-222222222222";
    const timestamp = "2026-08-04T12:01:00.000Z";
    const group = await sign(privateKey, {
      id: "second-group-operation",
      groupId: "import-group-2",
      actorId: "user-1",
      deviceId: "device-1",
      type: "GroupCreated",
      targetId: "import-group-2",
      baseVersion: 0,
      clientTimestamp: timestamp,
      payload: { name: "Goa · USD", settlementCurrency: "USD" },
    });
    const record = await sign(privateKey, {
      id: "second-record-operation",
      groupId: "import-group-2",
      actorId: "user-1",
      deviceId: "device-1",
      type: "ImportedTransactionRecorded",
      targetId: "import-record-2",
      baseVersion: 0,
      clientTimestamp: timestamp,
      payload: {
        description: "Legacy balance effect",
        category: "Imported from Splitwise",
        amountMinor: 500,
        currency: "USD",
        transactionDate: "2026-07-01",
        notes: "",
        effects: [
          { participantId: "user-1", amountMinor: 500 },
          { participantId: "import:identity-friend", amountMinor: -500 },
        ],
        import: {
          importBatchId: secondBatchId,
          sourceProvider: "splitwise",
          sourceRecordId: "import-record-2",
          importedAt: timestamp,
          importedByDisplayName: "Sam",
          readOnly: true,
        },
      },
    });
    second.id = secondBatchId;
    second.fingerprint = "c".repeat(64);
    second.operations = [group, record];
    second.operationLinks = [
      { operationId: group.id, externalType: "group", externalId: "goa:USD" },
      { operationId: record.id, externalType: "record", externalId: "csv:goa:2", dedupeStrategy: "csv_candidate", semanticId: "d".repeat(64), sourceMetadata: { row: 2 } },
    ];
    second.identities = second.identities.map((identity) => ({ ...identity, groupIds: ["import-group-2"] }));

    expect(store.activateImport("user-1", second)).rejects.toThrow("already imported");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_batches").get()?.count).toBe(1);
  });

  test("blocks an edited provider record with the same stable Splitwise id", async () => {
    const first = await request();
    first.operationLinks[1] = {
      ...first.operationLinks[1]!,
      externalId: "splitwise-expense:123",
      dedupeStrategy: "provider_id",
    };
    await store.activateImport("user-1", first);

    const second = await request();
    const secondBatchId = "33333333-3333-4333-8333-333333333333";
    const timestamp = "2026-08-04T12:02:00.000Z";
    const group = await sign(privateKey, {
      id: "edited-group-operation",
      groupId: "edited-group",
      actorId: "user-1",
      deviceId: "device-1",
      type: "GroupCreated",
      targetId: "edited-group",
      baseVersion: 0,
      clientTimestamp: timestamp,
      payload: { name: "Goa · USD", settlementCurrency: "USD" },
    });
    const record = await sign(privateKey, {
      id: "edited-record-operation",
      groupId: "edited-group",
      actorId: "user-1",
      deviceId: "device-1",
      type: "ImportedTransactionRecorded",
      targetId: "edited-record",
      baseVersion: 0,
      clientTimestamp: timestamp,
      payload: {
        description: "Edited legacy balance",
        category: "Imported from Splitwise",
        amountMinor: 700,
        currency: "USD",
        transactionDate: "2026-07-01",
        notes: "changed after the first export",
        effects: [
          { participantId: "user-1", amountMinor: 700 },
          { participantId: "import:identity-friend", amountMinor: -700 },
        ],
        import: {
          importBatchId: secondBatchId,
          sourceProvider: "splitwise",
          sourceRecordId: "edited-record",
          importedAt: timestamp,
          importedByDisplayName: "Sam",
          readOnly: true,
        },
      },
    });
    second.id = secondBatchId;
    second.fingerprint = "f".repeat(64);
    second.operations = [group, record];
    second.operationLinks = [
      { operationId: group.id, externalType: "group", externalId: "goa:USD" },
      {
        operationId: record.id,
        externalType: "record",
        externalId: "splitwise-expense:123",
        dedupeStrategy: "provider_id",
        semanticId: "e".repeat(64),
      },
    ];
    second.identities = second.identities.map((identity) => ({ ...identity, groupIds: ["edited-group"] }));
    second.sourceBalances = second.sourceBalances.map((balance) => ({ ...balance, externalGroupId: "goa:USD", amountMinor: balance.amountMinor > 0 ? 700 : -700 }));
    second.reconciliation.participantTotals = second.reconciliation.participantTotals.map((total) => ({ ...total, netMinor: total.netMinor > 0 ? 700 : -700 }));
    second.reconciliation.groupTotals = second.reconciliation.groupTotals.map((total) => ({ ...total, netMinor: 0 }));

    expect(store.activateImport("user-1", second)).rejects.toThrow("already imported");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_batches").get()?.count).toBe(1);
  });

  test("coalesces simultaneous activation attempts into one completed import", async () => {
    const body = await request();
    const results = await Promise.all([
      store.activateImport("user-1", body),
      store.activateImport("user-1", body),
    ]);
    expect(results.map(({ duplicate }) => duplicate).sort()).toEqual([false, true]);
    expect(results.flatMap(({ accepted }) => accepted)).toHaveLength(2);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_batches").get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM operations").get()?.count).toBe(2);
  });

  test("rejects a reconciliation mismatch without leaving partial groups or operations", async () => {
    const body = await request({
      sourceBalances: [
        { externalGroupId: "goa:USD", externalPersonId: "split-self", currency: "USD", amountMinor: 501 },
      ],
    });
    expect(store.activateImport("user-1", body)).rejects.toThrow("does not match the source");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_batches").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM groups").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM operations").get()?.count).toBe(0);
  });

  test("rolls back the entire activation when SQLite fails during a projection", async () => {
    db.exec(`
      CREATE TRIGGER fail_import_projection
      BEFORE INSERT ON imported_transactions
      BEGIN
        SELECT RAISE(ABORT, 'injected import storage failure');
      END;
    `);
    expect(store.activateImport("user-1", await request())).rejects.toThrow("injected import storage failure");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_batches").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM groups").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM operations").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM imported_identities").get()?.count).toBe(0);
  });

  test("rolls back every projection when a later imported record conflicts", async () => {
    const body = await request();
    const original = body.operations[1]!;
    const { contentHash: _contentHash, signature: _signature, ...unsigned } = original;
    const conflicting = await sign(privateKey, {
      ...unsigned,
      id: "import-record-operation-conflict",
    });
    body.operations.push(conflicting);
    body.operationLinks.push({
      operationId: conflicting.id,
      externalType: "record",
      externalId: "csv:goa:3",
      dedupeStrategy: "csv_candidate",
      semanticId: "e".repeat(64),
    });
    body.sourceBalances = body.sourceBalances.map((balance) => ({
      ...balance,
      amountMinor: balance.amountMinor * 2,
    }));
    body.reconciliation.participantTotals = body.reconciliation.participantTotals.map((total) => ({
      ...total,
      netMinor: total.netMinor * 2,
    }));
    body.reconciliation.recordCount = 2;

    expect(store.activateImport("user-1", body)).rejects.toThrow("conflicted with existing data");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_batches").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM groups").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM operations").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM imported_identities").get()?.count).toBe(0);
  });

  test("does not permit an imported transaction to be edited outside batch undo", async () => {
    await store.activateImport("user-1", await request());
    const operation = await sign(privateKey, {
      id: "independent-void",
      groupId: "import-group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: "ImportedTransactionVoided",
      targetId: "import-record-1",
      baseVersion: 1,
      clientTimestamp: new Date().toISOString(),
      payload: { reason: "Changed my mind" },
    });
    expect((await store.push("user-1", [operation])).rejected).toEqual([
      expect.objectContaining({ message: "undoImportBatchId must be a non-empty string of at most 100 characters" }),
    ]);
  });

  test("undoes exactly the active records in one transaction and is retry-safe", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    const undo = await sign(privateKey, {
      id: "undo-import-record",
      groupId: "import-group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: "ImportedTransactionVoided",
      targetId: "import-record-1",
      baseVersion: 1,
      clientTimestamp: new Date().toISOString(),
      payload: { undoImportBatchId: body.id, reason: "Undo migration" },
    });
    const result = await store.undoImport("user-1", body.id, { operations: [undo] });
    expect(result.duplicate).toBe(false);
    expect(result.batch.status).toBe("undone");
    expect(db.query<{ status: string }, [string]>(
      "SELECT status FROM imported_transactions WHERE id = ?",
    ).get("import-record-1")).toEqual({ status: "voided" });
    const retried = await store.undoImport("user-1", body.id, { operations: [undo] });
    expect(retried.duplicate).toBe(true);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM operations WHERE id = ?",
    ).get(undo.id)?.count).toBe(1);
  });

  test("rejects an incomplete undo without changing any imported record", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    expect(store.undoImport("user-1", body.id, { operations: [] })).rejects.toThrow("every active imported record");
    expect(db.query<{ status: string }, [string]>(
      "SELECT status FROM imported_transactions WHERE id = ?",
    ).get("import-record-1")).toEqual({ status: "active" });
    expect(store.listImports("user-1")[0]?.status).toBe("completed");
  });

  test("stages a large undo, resumes chunks, and makes activation retry-safe", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    const undo = await sign(privateKey, {
      id: "staged-undo-import-record",
      groupId: "import-group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: "ImportedTransactionVoided",
      targetId: "import-record-1",
      baseVersion: 1,
      clientTimestamp: new Date().toISOString(),
      payload: { undoImportBatchId: body.id, reason: "Undo migration" },
    });
    expect(store.startImportUndoStage("user-1", body.id, { expectedOperationCount: 1 })).toEqual(
      expect.objectContaining({ status: "staging", receivedOperationCount: 0, missingRanges: [{ start: 0, endExclusive: 1 }] }),
    );
    const chunk = { start: 0, operations: [undo] };
    const undoChunkStatus = store.stageImportUndoOperations("user-1", body.id, chunk);
    expect(undoChunkStatus).toEqual(
      expect.objectContaining({ status: "ready", receivedOperationCount: 1 }),
    );
    expect(undoChunkStatus.missingRanges).toBeUndefined();
    const stagedUndo = db.query<{ operation_json: string }, [string]>(
      "SELECT operation_json FROM import_staged_undo_operations WHERE batch_id = ?",
    ).get(body.id)?.operation_json ?? "";
    expect(stagedUndo.startsWith("v1.")).toBe(true);
    expect(stagedUndo).not.toContain("Undo migration");
    expect(store.stageImportUndoOperations("user-1", body.id, chunk)).toEqual(
      expect.objectContaining({ status: "ready", receivedOperationCount: 1 }),
    );
    expect(store.cancelImportUndoStage("attacker", body.id)).toBe(false);
    const result = await store.activateImportUndoStage("user-1", body.id);
    expect(result).toEqual(expect.objectContaining({ duplicate: false, batch: expect.objectContaining({ status: "undone" }) }));
    expect(await store.activateImportUndoStage("user-1", body.id)).toEqual(
      expect.objectContaining({ duplicate: true, batch: expect.objectContaining({ status: "undone" }) }),
    );
  });

  test("claim links expose no financial context and untrusted identities require owner approval", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    const expenseBeforeClaim = await sign(privateKey, {
      id: "expense-before-claim-operation",
      groupId: "import-group-1",
      actorId: "user-1",
      deviceId: "device-1",
      type: "ExpenseCreated",
      targetId: "expense-before-claim",
      baseVersion: 0,
      clientTimestamp: "2026-08-05T12:00:00.000Z",
      payload: {
        description: "Dinner before account setup",
        category: "Dining out",
        amountMinor: 2400,
        currency: "USD",
        expenseDate: "2026-08-05",
        notes: "",
        payers: [{ participantId: "user-1", amountMinor: 2400 }],
        allocations: [
          { participantId: "user-1", amountMinor: 1200 },
          { participantId: "import:identity-friend", amountMinor: 1200 },
        ],
      },
    });
    expect((await store.push("user-1", [expenseBeforeClaim])).accepted).toHaveLength(1);
    db.query('INSERT INTO "user"(id, name, email) VALUES (?, ?, ?)').run("user-2", "Mira", "mira@example.com");
    const link = store.createImportClaimLink("user-1", body.id, "identity-friend");
    const preview = store.previewImportClaim(link.token);
    expect(preview).toEqual({ provider: "splitwise", expiresAt: link.expiresAt });
    expect(Object.keys(preview).sort()).toEqual(["expiresAt", "provider"]);
    expect(store.reserveImportClaimEmail(link.token, "mira@example.com")).toEqual(expect.objectContaining({ status: "reserved" }));
    const pending = store.claimImportedIdentity("user-2", link.token);
    expect(pending).toEqual(expect.objectContaining({ status: "awaiting_owner", displayName: "Mira", requestId: expect.any(String) }));
    expect(store.importClaimStatus("user-2", pending.requestId!)).toEqual(expect.objectContaining({ status: "awaiting_owner", displayName: "Mira" }));
    expect(store.listImportIdentities("user-1", body.id).find(({ id }) => id === "identity-friend")?.claimant).toEqual(
      expect.objectContaining({ displayName: "Mira", email: "mira@example.com" }),
    );
    expect(() => store.approveImportIdentityClaim("user-2", "identity-friend")).toThrow("migration owner");
    expect(store.approveImportIdentityClaim("user-1", "identity-friend")).toEqual({
      status: "claimed",
      displayName: "Mira",
    });
    expect(store.importClaimStatus("user-2", pending.requestId!).status).toBe("claimed");
    expect(db.query<{ status: string }, [string, string]>(
      "SELECT status FROM group_members WHERE group_id = ? AND user_id = ?",
    ).get("import-group-1", "user-2")).toEqual({ status: "active" });
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM group_members WHERE user_id = ?",
    ).get("import:identity-friend")?.count).toBe(0);
    expect(db.query<{ participant_id: string }, [string]>(
      "SELECT participant_id FROM imported_transaction_effects WHERE amount_minor < 0 AND transaction_id = ?",
    ).get("import-record-1")?.participant_id).toBe("user-2");
    expect(db.query<{ amount_minor: number }, [string, string]>(
      "SELECT amount_minor FROM expense_allocations WHERE expense_id = ? AND participant_id = ?",
    ).get("expense-before-claim", "user-2")?.amount_minor).toBe(1200);
    expect(db.query<{ count: number }, [string, string]>(
      `SELECT
         (SELECT COUNT(*) FROM expense_payers WHERE participant_id = ?) +
         (SELECT COUNT(*) FROM expense_allocations WHERE participant_id = ?) AS count`,
    ).get("import:identity-friend", "import:identity-friend")?.count).toBe(0);
    expect((store.snapshot("user-2") as { participantAliases?: unknown }).participantAliases).toEqual([
      { groupId: "import-group-1", fromUserId: "import:identity-friend", toUserId: "user-2" },
    ]);
    db.query("DELETE FROM import_participant_aliases WHERE identity_id = ?").run("identity-friend");
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/009_import_participant_aliases.sql"), "utf8"));
    expect((store.snapshot("user-2") as { participantAliases?: unknown }).participantAliases).toEqual([
      { groupId: "import-group-1", fromUserId: "import:identity-friend", toUserId: "user-2" },
    ]);
    db.exec(`
      INSERT INTO "user"(id, name, email) VALUES ('user-3', 'Unrelated member', 'unrelated@example.com');
      INSERT INTO groups(id, name, settlement_currency, created_by, created_at)
      VALUES ('unrelated-group', 'Unrelated group', 'USD', 'user-1', '2026-08-04T12:00:00.000Z');
      INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at) VALUES
        ('unrelated-group', 'user-1', 'Sam', 'sam@example.com', 'active', '2026-08-04T12:00:00.000Z'),
        ('unrelated-group', 'user-2', 'Mira', 'mira@example.com', 'active', '2026-08-04T12:00:00.000Z'),
        ('unrelated-group', 'user-3', 'Unrelated member', 'unrelated@example.com', 'active', '2026-08-04T12:00:00.000Z');
      INSERT INTO import_external_mappings(
        batch_id, imported_by, provider, external_type, external_id,
        external_id_hash, local_id
      ) VALUES (
        '${body.id}', 'user-1', 'splitwise', 'group', 'unrelated:USD',
        '${"e".repeat(64)}', 'unrelated-group'
      );
    `);
    expect((store.snapshot("user-3") as { participantAliases?: unknown }).participantAliases).toEqual([]);
  });

  test("rejects a forwarded untrusted claim with an auditable claimant and permits a fresh link", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    db.query('INSERT INTO "user"(id, name, email) VALUES (?, ?, ?)').run("user-3", "Wrong Person", "wrong@example.com");
    const link = store.createImportClaimLink("user-1", body.id, "identity-friend");
    store.reserveImportClaimEmail(link.token, "wrong@example.com");
    const pending = store.claimImportedIdentity("user-3", link.token);
    expect(() => store.createImportClaimLink("user-1", body.id, "identity-friend")).toThrow("Review or reject");
    expect(store.rejectImportIdentityClaim("user-1", "identity-friend")).toEqual({ status: "rejected" });
    expect(store.importClaimStatus("user-3", pending.requestId!).status).toBe("rejected");
    expect(store.createImportClaimLink("user-1", body.id, "identity-friend").token).toHaveLength(43);
  });

  test("a trusted exported email can claim immediately but an expired token cannot", async () => {
    const body = await request();
    body.identities[1] = {
      ...body.identities[1]!,
      email: "mira@example.com",
      emailTrust: "exported",
    };
    await store.activateImport("user-1", body);
    db.query('INSERT INTO "user"(id, name, email) VALUES (?, ?, ?)').run("user-2", "Mira", "mira@example.com");
    const expired = store.createImportClaimLink("user-1", body.id, "identity-friend");
    db.query("UPDATE imported_identities SET claim_expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", "identity-friend");
    expect(() => store.claimImportedIdentity("user-2", expired.token)).toThrow("expired");
    const current = store.createImportClaimLink("user-1", body.id, "identity-friend");
    expect(() => store.reserveImportClaimEmail(current.token, "wrong@example.com")).toThrow("verified email");
    store.reserveImportClaimEmail(current.token, "mira@example.com");
    expect(store.claimImportedIdentity("user-2", current.token)).toEqual({ status: "claimed", displayName: "Mira" });
  });

  test("deletes retained source metadata without deleting migrated balances", async () => {
    const body = await request();
    await store.activateImport("user-1", body);
    const originalFingerprint = body.fingerprint;
    store.deleteImportSourceData("user-1", body.id);
    const summary = store.listImports("user-1")[0]!;
    expect(summary.sourceDataDeletedAt).toBeString();
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_sources").get()?.count).toBe(0);
    expect(db.query<{ source_metadata_json: string }, [string]>(
      "SELECT source_metadata_json FROM imported_transactions WHERE id = ?",
    ).get("import-record-1")?.source_metadata_json).toBe('{"deleted":true}');
    const retainedMapping = db.query<{ external_id: string; external_id_hash: string; source_metadata_json: string | null }, [string]>(
      "SELECT external_id, external_id_hash, source_metadata_json FROM import_external_mappings WHERE operation_id = ?",
    ).get("import-record-operation")!;
    expect(retainedMapping.external_id.startsWith("deleted:")).toBe(true);
    expect(retainedMapping.external_id_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(retainedMapping.source_metadata_json).toBeNull();
    expect(db.query<{ status: string }, [string]>(
      "SELECT status FROM imported_transactions WHERE id = ?",
    ).get("import-record-1")?.status).toBe("active");
    expect(db.query<{ fingerprint: string }, [string]>(
      "SELECT fingerprint FROM import_batches WHERE id = ?",
    ).get(body.id)?.fingerprint).not.toBe(originalFingerprint);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_batch_events WHERE batch_id = ? AND type = 'source_data_deleted'",
    ).get(body.id)?.count).toBe(1);
    store.deleteImportSourceData("user-1", body.id);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_batch_events WHERE batch_id = ? AND type = 'source_data_deleted'",
    ).get(body.id)?.count).toBe(1);
  });

  test("resumes verified chunks and activates them only after the upload is complete", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    expect(store.startImportStage("user-1", await stageStart(body))).toEqual(
      expect.objectContaining({ status: "staging", receivedOperationCount: 0, missingRanges: [{ start: 0, endExclusive: 2 }] }),
    );
    const encryptedEnvelope = db.query<{ envelope_json: string }, [string]>(
      "SELECT envelope_json FROM import_uploads WHERE batch_id = ?",
    ).get(body.id)?.envelope_json ?? "";
    expect(encryptedEnvelope).not.toContain("Mira");
    expect(encryptedEnvelope).not.toContain("mira@example.com");
    expect(encryptedEnvelope.startsWith("v1.")).toBe(true);
    const first = { start: 0, operations: [operations[0]!], operationLinks: [operationLinks[0]!] };
    const firstChunkStatus = await store.stageImportOperations("user-1", body.id, first);
    expect(firstChunkStatus).toEqual(
      expect.objectContaining({ status: "staging", receivedOperationCount: 1 }),
    );
    expect(firstChunkStatus.missingRanges).toBeUndefined();
    expect(await store.stageImportOperations("user-1", body.id, first)).toEqual(
      expect.objectContaining({ receivedOperationCount: 1 }),
    );
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM groups").get()?.count).toBe(0);
    await store.stageImportOperations("user-1", body.id, {
      start: 1,
      operations: [operations[1]!],
      operationLinks: [operationLinks[1]!],
    });
    const encryptedSource = db.query<{ operation_json: string; external_id: string; semantic_id: string | null; source_metadata_json: string | null }, [string, number]>(
      "SELECT operation_json, external_id, semantic_id, source_metadata_json FROM import_staged_operations WHERE batch_id = ? AND ordinal = ?",
    ).get(body.id, 1)!;
    expect(encryptedSource.operation_json.startsWith("v1.")).toBe(true);
    expect(encryptedSource.operation_json).not.toContain("Legacy balance effect");
    expect(encryptedSource.external_id).not.toContain("csv:goa:2");
    expect(encryptedSource.semantic_id ?? "").not.toContain("d".repeat(64));
    expect(encryptedSource.source_metadata_json ?? "").not.toContain("row");
    expect(encryptedSource.external_id.startsWith("v1.")).toBe(true);
    const activated = await store.activateImportStage("user-1", body.id);
    expect(activated.batch.status).toBe("completed");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM import_uploads").get()?.count).toBe(0);
    expect(store.startImportStage("user-1", await stageStart(body))).toEqual(
      expect.objectContaining({ status: "activated", completedBatch: expect.objectContaining({ id: body.id }) }),
    );
    expect(await store.activateImportStage("user-1", body.id)).toEqual(
      expect.objectContaining({ duplicate: true, batch: expect.objectContaining({ id: body.id }) }),
    );
  });

  test("does not resume chunks for a newly prepared version of the same import", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    store.startImportStage("user-1", await stageStart(body));
    await store.stageImportOperations("user-1", body.id, {
      start: 0,
      operations: [operations[0]!],
      operationLinks: [operationLinks[0]!],
    });
    const { contentHash: _contentHash, signature: _signature, ...unsigned } = operations[1]!;
    const changedRecord = await sign(privateKey, {
      ...unsigned,
      clientTimestamp: "2026-08-04T12:00:01.000Z",
    });
    const changedBody = { ...body, operations: [operations[0]!, changedRecord] };
    const changedStart = await stageStart(changedBody);

    expect(() => store.startImportStage("user-1", changedStart)).toThrow(
      "Prepared migration details changed",
    );
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(body.id)?.count).toBe(1);
  });

  test("independently verifies the prepared review before activation", async () => {
    const body = await request();
    store.startImportStage("user-1", await stageStart(body));
    await store.stageImportOperations("user-1", body.id, {
      start: 0,
      operations: body.operations,
      operationLinks: body.operationLinks,
    });
    db.query("UPDATE import_uploads SET preparation_hash = ? WHERE batch_id = ?")
      .run("0".repeat(64), body.id);

    await expect(store.activateImportStage("user-1", body.id)).rejects.toThrow(
      "do not match the staged upload",
    );
    expect(db.query<{ status: string }, [string]>(
      "SELECT status FROM import_uploads WHERE batch_id = ?",
    ).get(body.id)?.status).toBe("ready");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM operations").get()?.count).toBe(0);
  });

  test("atomically enforces the staged byte quota across concurrent chunks", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    store.startImportStage("user-1", { ...(await stageStart(body)), expectedOperationCount: 3 });
    await store.stageImportOperations("user-1", body.id, {
      start: 0,
      operations: [operations[0]!],
      operationLinks: [operationLinks[0]!],
    });
    db.query("UPDATE import_uploads SET payload_bytes = ? WHERE batch_id = ?")
      .run(192 * 1024 * 1024 - 2_000, body.id);
    const original = operations[1]!;
    const { contentHash: _hash, signature: _signature, ...unsigned } = original;
    const first = await sign(privateKey, { ...unsigned, id: "quota-record-1", targetId: "quota-target-1" });
    const second = await sign(privateKey, { ...unsigned, id: "quota-record-2", targetId: "quota-target-2" });
    const results = await Promise.allSettled([
      store.stageImportOperations("user-1", body.id, {
        start: 1,
        operations: [first],
        operationLinks: [{ operationId: first.id, externalType: "record", externalId: "quota:1", dedupeStrategy: "csv_candidate", semanticId: "1".repeat(64) }],
      }),
      store.stageImportOperations("user-1", body.id, {
        start: 2,
        operations: [second],
        operationLinks: [{ operationId: second.id, externalType: "record", externalId: "quota:2", dedupeStrategy: "csv_candidate", semanticId: "2".repeat(64) }],
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(db.query<{ payload_bytes: number }, [string]>(
      "SELECT payload_bytes FROM import_uploads WHERE batch_id = ?",
    ).get(body.id)!.payload_bytes).toBeLessThanOrEqual(192 * 1024 * 1024);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(body.id)?.count).toBe(2);
  });

  test("rejects activation of an incomplete staged import without projections", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    store.startImportStage("user-1", await stageStart(body));
    await store.stageImportOperations("user-1", body.id, {
      start: 0,
      operations: [operations[0]!],
      operationLinks: [operationLinks[0]!],
    });
    expect(store.activateImportStage("user-1", body.id)).rejects.toThrow("incomplete");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM groups").get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM operations").get()?.count).toBe(0);
  });

  test("does not let another account cancel an owned staged import", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    store.startImportStage("user-1", await stageStart(body));
    await store.stageImportOperations("user-1", body.id, {
      start: 0,
      operations: [operations[0]!],
      operationLinks: [operationLinks[0]!],
    });
    expect(store.cancelImportStage("attacker", body.id)).toBe(false);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(body.id)?.count).toBe(1);
    expect(store.cancelImportStage("user-1", body.id)).toBe(true);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(body.id)?.count).toBe(0);
  });

  test("does not cancel chunks after activation has claimed them and prunes expired drafts", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    store.startImportStage("user-1", await stageStart(body));
    await store.stageImportOperations("user-1", body.id, { start: 0, operations, operationLinks });
    db.query("UPDATE import_uploads SET status = 'activating' WHERE batch_id = ?").run(body.id);
    expect(store.cancelImportStage("user-1", body.id)).toBe(false);
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(body.id)?.count).toBe(2);
    db.query("UPDATE import_uploads SET status = 'ready', expires_at = ? WHERE batch_id = ?")
      .run("2020-01-01T00:00:00.000Z", body.id);
    expect(store.pruneExpiredImportUploads()).toEqual(expect.objectContaining({ imports: 1 }));
    expect(db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(body.id)?.count).toBe(0);
  });

  test("recovers an activation claimed by a server process that restarted", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    store.startImportStage("user-1", await stageStart(body));
    await store.stageImportOperations("user-1", body.id, { start: 0, operations, operationLinks });
    db.query("UPDATE import_uploads SET status = 'activating' WHERE batch_id = ?").run(body.id);

    expect(store.recoverInterruptedImportActivations()).toEqual({ imports: 1, undos: 0 });
    await expect(store.activateImportStage("user-1", body.id)).resolves.toEqual(
      expect.objectContaining({ duplicate: false }),
    );
    expect(store.listImports("user-1")[0]?.status).toBe("completed");
  });

  test("rechecks device trust when a previously verified stage activates", async () => {
    const body = await request();
    const { operations, operationLinks } = body;
    store.startImportStage("user-1", await stageStart(body));
    await store.stageImportOperations("user-1", body.id, { start: 0, operations, operationLinks });
    db.query("UPDATE devices SET status = 'revoked' WHERE id = 'device-1'").run();

    await expect(store.activateImportStage("user-1", body.id)).rejects.toThrow("no longer trusted");
    expect(db.query<{ status: string }, [string]>(
      "SELECT status FROM import_uploads WHERE batch_id = ?",
    ).get(body.id)?.status).toBe("ready");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM groups").get()?.count).toBe(0);
  });
});
