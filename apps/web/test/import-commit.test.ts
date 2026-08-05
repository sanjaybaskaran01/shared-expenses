import { describe, expect, test } from "bun:test";
import type { NormalizedImportDraft, OperationEnvelope, UnsignedOperation } from "@expenses/protocol";
import { buildImportCommit, deterministicImportId, preparedImportReview } from "../src/lib/import-commit";
import { createOpeningBalanceDraft } from "../src/lib/splitwise-import";

const draft: NormalizedImportDraft = {
  schemaVersion: 1,
  provider: "splitwise",
  mode: "history",
  sourceAccountId: "person:self",
  sourceHashes: ["a".repeat(64)],
  people: [
    { externalId: "person:self", displayName: "Sam", email: "sam@example.com", emailTrust: "exported" },
    { externalId: "person:mira", displayName: "Mira", emailTrust: "none" },
  ],
  groups: [
    { externalId: "trip:USD", name: "Goa", currency: "USD", status: "current", memberExternalIds: ["person:self", "person:mira"] },
    { externalId: "trip:INR", name: "Goa", currency: "INR", status: "settled", memberExternalIds: ["person:self", "person:mira"] },
  ],
  records: [
    {
      externalId: "expense:1",
      externalGroupId: "trip:USD",
      kind: "expense",
      description: "Ramen",
      category: "Dining out",
      amountMinor: 1200,
      currency: "USD",
      transactionDate: "2026-07-01",
      notes: "Dinner",
      recurrence: "none",
      deleted: false,
      payers: [{ externalPersonId: "person:self", amountMinor: 1200 }],
      allocations: [
        { externalPersonId: "person:self", amountMinor: 600 },
        { externalPersonId: "person:mira", amountMinor: 600 },
      ],
      source: { providerRecordId: "1", providerGroupId: "9", row: 2 },
    },
    {
      externalId: "effect:2",
      externalGroupId: "trip:INR",
      kind: "balance_effect",
      description: "Legacy adjustment",
      category: "Imported",
      amountMinor: 900,
      currency: "INR",
      transactionDate: "2025-12-01",
      notes: "",
      recurrence: "none",
      deleted: false,
      effects: [
        { externalPersonId: "person:self", amountMinor: 900 },
        { externalPersonId: "person:mira", amountMinor: -900 },
      ],
      source: { fileHash: "a".repeat(64), row: 3 },
    },
  ],
  sourceBalances: [
    { externalGroupId: "trip:USD", externalPersonId: "person:self", currency: "USD", amountMinor: 600 },
    { externalGroupId: "trip:USD", externalPersonId: "person:mira", currency: "USD", amountMinor: -600 },
    { externalGroupId: "trip:INR", externalPersonId: "person:self", currency: "INR", amountMinor: 900 },
    { externalGroupId: "trip:INR", externalPersonId: "person:mira", currency: "INR", amountMinor: -900 },
  ],
  warnings: [],
};

const signer = async (operation: UnsignedOperation): Promise<OperationEnvelope> => ({
  ...operation,
  contentHash: "b".repeat(64),
  signature: "signed",
});

describe("migration commit planner", () => {
  test("uses deterministic UUIDs for retry-safe batches and records", async () => {
    expect(await deterministicImportId("group", "same-input")).toBe(await deterministicImportId("group", "same-input"));
    expect(await deterministicImportId("group", "same-input")).not.toBe(await deterministicImportId("record", "same-input"));
    expect(await deterministicImportId("group", "same-input")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("splits a multi-currency source group and maps non-users to placeholders", async () => {
    const progress: Array<[number, number]> = [];
    const commit = await buildImportCommit(draft, {
      selectedGroupIds: ["trip:USD", "trip:INR"],
      importerExternalId: "person:self",
      importedByDisplayName: "Sam",
      actorId: "user-1",
      deviceId: "device-1",
      importedAt: "2026-08-04T12:00:00.000Z",
      sign: signer,
      onProgress: (completed, total) => progress.push([completed, total]),
    });
    const groups = commit.operations.filter((operation) => operation.type === "GroupCreated");
    expect(groups.map((operation) => operation.payload)).toEqual([
      { name: "Goa · USD", settlementCurrency: "USD" },
      { name: "Goa · INR", settlementCurrency: "INR" },
    ]);
    const mira = commit.identities.find((identity) => identity.externalId === "person:mira")!;
    expect(mira.isImporter).toBeUndefined();
    expect(mira.groupIds).toHaveLength(2);
    const expense = commit.operations.find((operation) => operation.type === "ExpenseCreated")!;
    const payload = expense.payload as { allocations: Array<{ participantId: string }> };
    expect(payload.allocations.map(({ participantId }) => participantId)).toContain(`import:${mira.id}`);
    expect(commit.reconciliation.blockingWarnings).toEqual([]);
    const sharedLedger = JSON.stringify(commit.operations);
    expect(sharedLedger).not.toContain('"providerRecordId":"1"');
    expect(sharedLedger).not.toContain('"providerGroupId":"9"');
    expect(sharedLedger).not.toContain('"sourceMetadata"');
    expect(sharedLedger).not.toContain("a".repeat(64));
    expect(commit.operationLinks.find(({ externalType }) => externalType === "record")?.sourceMetadata).toEqual({
      providerRecordId: "1",
      providerGroupId: "9",
      row: 2,
      recurrence: "none",
    });
    expect(progress).toEqual([[1, 2], [2, 2]]);
    const review = preparedImportReview(commit, draft, ["trip:USD", "trip:INR"]);
    expect(review.operationCount).toBe(commit.operations.length);
    expect(review.people.map(({ displayName }) => displayName)).toEqual(["Sam", "Mira"]);
    expect(review.groups.map(({ name }) => name)).toEqual(["Goa", "Goa"]);
    expect("operations" in review).toBe(false);
  });

  test("preserves balance-only effects as a non-spending ledger operation", async () => {
    const commit = await buildImportCommit(draft, {
      selectedGroupIds: ["trip:INR"],
      importerExternalId: "person:self",
      importedByDisplayName: "Sam",
      actorId: "user-1",
      deviceId: "device-1",
      importedAt: "2026-08-04T12:00:00.000Z",
      sign: signer,
    });
    expect(commit.operations.map(({ type }) => type)).toEqual(["GroupCreated", "ImportedTransactionRecorded"]);
    expect(commit.mode).toBe("history");
  });

  test("plans multiple balance-only rows in one shared context with every member", async () => {
    const opening = createOpeningBalanceDraft({
      ownerExternalId: "opening:self",
      ownerName: "Sam",
      rows: [
        { personName: "Mira", direction: "owes_me", amount: "24.00", currency: "USD", groupName: "Opening balances", effectiveDate: "2026-08-04" },
        { personName: "Dev", direction: "i_owe", amount: "7.80", currency: "USD", groupName: "Opening balances", effectiveDate: "2026-08-04" },
      ],
    });
    const commit = await buildImportCommit(opening, {
      selectedGroupIds: opening.groups.map(({ externalId }) => externalId),
      importerExternalId: "opening:self",
      importedByDisplayName: "Sam",
      actorId: "user-1",
      deviceId: "device-1",
      importedAt: "2026-08-04T12:00:00.000Z",
      sign: signer,
    });
    expect(commit.operations.map(({ type }) => type)).toEqual([
      "GroupCreated",
      "OpeningBalanceCreated",
      "OpeningBalanceCreated",
    ]);
    expect(commit.identities.filter(({ isImporter }) => !isImporter).map(({ displayName }) => displayName).sort()).toEqual(["Dev", "Mira"]);
  });

  test("combines multiple imported self aliases into one Tallied participant", async () => {
    const aliased = structuredClone(draft);
    aliased.people.push({ externalId: "person:sam-alt", displayName: "Alex", emailTrust: "none" });
    aliased.groups[0]!.memberExternalIds.push("person:sam-alt");
    aliased.records[0]!.payers = [
      { externalPersonId: "person:self", amountMinor: 600 },
      { externalPersonId: "person:sam-alt", amountMinor: 600 },
    ];
    aliased.records[0]!.allocations = [
      { externalPersonId: "person:self", amountMinor: 300 },
      { externalPersonId: "person:sam-alt", amountMinor: 300 },
      { externalPersonId: "person:mira", amountMinor: 600 },
    ];
    aliased.sourceBalances = [
      { externalGroupId: "trip:USD", externalPersonId: "person:self", currency: "USD", amountMinor: 300 },
      { externalGroupId: "trip:USD", externalPersonId: "person:sam-alt", currency: "USD", amountMinor: 300 },
      { externalGroupId: "trip:USD", externalPersonId: "person:mira", currency: "USD", amountMinor: -600 },
    ];
    const commit = await buildImportCommit(aliased, {
      selectedGroupIds: ["trip:USD"],
      importerExternalIds: ["person:self", "person:sam-alt"],
      importedByDisplayName: "Sam",
      actorId: "user-1",
      deviceId: "device-1",
      importedAt: "2026-08-04T12:00:00.000Z",
      sign: signer,
    });
    const payload = commit.operations.find(({ type }) => type === "ExpenseCreated")!.payload as {
      payers: Array<{ participantId: string; amountMinor: number }>;
      allocations: Array<{ participantId: string; amountMinor: number }>;
    };
    expect(payload.payers).toEqual([{ participantId: "user-1", amountMinor: 1200 }]);
    expect(payload.allocations).toContainEqual({ participantId: "user-1", amountMinor: 600 });
  });

  test("blocks warnings only when their source is part of the chosen groups", async () => {
    const scoped = structuredClone(draft);
    scoped.sourceHashes = ["1".repeat(64), "2".repeat(64)];
    scoped.groups[0]!.sourceHashes = ["1".repeat(64)];
    scoped.groups[1]!.sourceHashes = ["2".repeat(64)];
    scoped.warnings = [{
      code: "MALFORMED_RECORD",
      message: "A row is malformed",
      sourceHash: "2".repeat(64),
      blocking: true,
    }];
    const options = {
      importerExternalId: "person:self",
      importedByDisplayName: "Sam",
      actorId: "user-1",
      deviceId: "device-1",
      importedAt: "2026-08-04T12:00:00.000Z",
      sign: signer,
    };
    await expect(buildImportCommit(scoped, { ...options, selectedGroupIds: ["trip:USD"] })).resolves.toBeDefined();
    await expect(buildImportCommit(scoped, { ...options, selectedGroupIds: ["trip:INR"] })).rejects.toThrow("Resolve every migration check");
    scoped.warnings = [{ ...scoped.warnings[0]!, sourceHash: "3".repeat(64) }];
    await expect(buildImportCommit(scoped, { ...options, selectedGroupIds: ["trip:USD"] })).rejects.toThrow("Resolve every migration check");
  });

  test("blocks planning when the chosen source does not reconcile", async () => {
    const mismatched = structuredClone(draft);
    mismatched.sourceBalances[0]!.amountMinor = 601;
    expect(buildImportCommit(mismatched, {
      selectedGroupIds: ["trip:USD"],
      importerExternalId: "person:self",
      importedByDisplayName: "Sam",
      actorId: "user-1",
      deviceId: "device-1",
      importedAt: "2026-08-04T12:00:00.000Z",
      sign: signer,
    })).rejects.toThrow("Resolve every migration check");
  });
});
