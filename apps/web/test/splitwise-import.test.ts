import { describe, expect, test } from "bun:test";
import {
  IMPORT_MOBILE_ROW_LIMIT,
  IMPORT_ROW_LIMIT,
  combineImportDrafts,
  createOpeningBalanceDraft,
  openingBalanceReviewRows,
  migrationRowLimit,
  parseSplitwiseCsv,
  parseSplitwiseJson,
  reconcileImportDraft,
  supportedImportFileKind,
} from "../src/lib/splitwise-import";

test("uses a conservative migration cap on coarse-pointer phones", () => {
  expect(migrationRowLimit(true)).toBe(IMPORT_MOBILE_ROW_LIMIT);
  expect(migrationRowLimit(false)).toBe(IMPORT_ROW_LIMIT);
});

test("accepts only CSV or JSON export names with compatible browser MIME types", () => {
  expect(supportedImportFileKind("group.CSV", "text/csv; charset=utf-8")).toBe("csv");
  expect(supportedImportFileKind("backup.json", "application/octet-stream")).toBe("json");
  expect(supportedImportFileKind("notes.txt", "text/plain")).toBeUndefined();
  expect(supportedImportFileKind("backup.json", "image/png")).toBeUndefined();
});

describe("Splitwise CSV import", () => {
  test("honors a device-specific row limit without truncating the export", () => {
    const draft = parseSplitwiseCsv(
      [
        "Date,Description,Category,Cost,Currency,A,B",
        "2026-08-01,Lunch,Food,10,USD,5,-5",
        "2026-08-02,Dinner,Food,10,USD,5,-5",
      ].join("\n"),
      { sourceName: "phone.csv", sourceHash: "0".repeat(64), maxRows: 1 },
    );
    expect(draft.records).toEqual([]);
    expect(draft.warnings).toContainEqual(expect.objectContaining({
      code: "TOO_MANY_ROWS",
      message: "This phone supports up to 1 entry in one migration. Use Tallied on a desktop for exports up to 100,000.",
      blocking: true,
    }));
  });

  test("parses BOM, reordered columns, quoted commas and newlines, and non-ASCII people", () => {
    const csv = "\uFEFFCurrency,Description,Date,Cost,Category,José,Mira\n" +
      "USD,\"Dinner, then coffee\nby the pier\",2026-08-01,60.00,Dining out,30.00,-30.00\n";
    const draft = parseSplitwiseCsv(csv, { sourceName: "Goa trip.csv", sourceHash: "a".repeat(64) });
    expect(draft.records).toHaveLength(1);
    expect(draft.records[0]).toMatchObject({
      description: "Dinner, then coffee\nby the pier",
      amountMinor: 6000,
      currency: "USD",
      transactionDate: "2026-08-01",
      kind: "balance_effect",
      effects: [
        { externalPersonId: "name:josé", amountMinor: 3000 },
        { externalPersonId: "name:mira", amountMinor: -3000 },
      ],
    });
    expect(draft.people.map((person) => person.displayName)).toEqual(["José", "Mira"]);
    expect(draft.warnings).toEqual([]);
  });

  test("keeps valid rows and reports actionable malformed-row warnings", () => {
    const csv = [
      "Date,Description,Category,Cost,Currency,Maya,Dev",
      "2026-08-01,Train,Travel,40,USD,20,-20",
      "2026-08-02,Broken,Travel,not-money,USD,10,-10",
      "2026-08-03,Not zero sum,Travel,20,USD,20,-10",
    ].join("\n");
    const draft = parseSplitwiseCsv(csv, { sourceName: "Trip.csv", sourceHash: "b".repeat(64) });
    expect(draft.records).toHaveLength(1);
    expect(draft.warnings.map((warning) => ({ row: warning.row, code: warning.code, blocking: warning.blocking }))).toEqual([
      { row: 3, code: "INVALID_AMOUNT", blocking: true },
      { row: 4, code: "NOT_ZERO_SUM", blocking: true },
    ]);
  });

  test("treats an empty file as one invalid source without affecting another", () => {
    const valid = parseSplitwiseCsv(
      "Date,Description,Category,Cost,Currency,A,B\n2026-08-01,Lunch,Food,10,USD,5,-5",
      { sourceName: "valid.csv", sourceHash: "c".repeat(64) },
    );
    const empty = parseSplitwiseCsv("", { sourceName: "empty.csv", sourceHash: "d".repeat(64) });
    const combined = combineImportDrafts([valid, empty, valid]);
    expect(combined.records).toHaveLength(1);
    expect(combined.sourceHashes).toEqual(["c".repeat(64), "d".repeat(64)]);
    expect(combined.warnings.some((warning) => warning.code === "EMPTY_FILE")).toBe(true);
    expect(combined.warnings.some((warning) => warning.code === "DUPLICATE_SOURCE")).toBe(true);
  });

  test("blocks currencies whose minor-unit precision cannot be represented safely", () => {
    for (const currency of ["JPY", "KWD"]) {
      const draft = parseSplitwiseCsv(
        `Date,Description,Category,Cost,Currency,A,B\n2026-08-01,Lunch,Food,10,${currency},5,-5`,
        { sourceName: `${currency}.csv`, sourceHash: currency === "JPY" ? "1".repeat(64) : "2".repeat(64) },
      );
      expect(draft.records).toHaveLength(0);
      expect(draft.warnings).toEqual([expect.objectContaining({ blocking: true })]);
    }
  });

  test("blocks overlapping CSV rows even when the files have different hashes", () => {
    const csv = "Date,Description,Category,Cost,Currency,A,B\n2026-08-01,Lunch,Food,10,USD,5,-5";
    const first = parseSplitwiseCsv(csv, { sourceName: "trip.csv", sourceHash: "4".repeat(64) });
    const second = parseSplitwiseCsv(csv, { sourceName: "trip-copy.csv", sourceHash: "5".repeat(64) });
    const combined = combineImportDrafts([first, second]);
    expect(combined.warnings).toContainEqual(expect.objectContaining({
      code: "POSSIBLE_OVERLAPPING_CSV",
      sourceName: "trip-copy.csv",
      sourceHash: "5".repeat(64),
      blocking: true,
    }));
    expect(reconcileImportDraft(combined).blockingWarnings).toHaveLength(1);
  });

  test("does not treat identical rows from clearly different groups as the same CSV candidate", () => {
    const csv = "Date,Description,Category,Cost,Currency,A,B\n2026-08-01,Lunch,Food,10,USD,5,-5";
    const trip = parseSplitwiseCsv(csv, { sourceName: "trip.csv", sourceHash: "6".repeat(64) });
    const home = parseSplitwiseCsv(csv, { sourceName: "home.csv", sourceHash: "7".repeat(64) });
    const combined = combineImportDrafts([trip, home]);
    expect(combined.warnings.some(({ code }) => code === "POSSIBLE_OVERLAPPING_CSV")).toBe(false);
    expect(combined.records).toHaveLength(2);
  });

  test("caps warning details while preserving a blocking summary for malformed bulk exports", () => {
    const rows = Array.from(
      { length: 500 },
      (_, index) => `2026-08-01,Broken ${index},Food,10,USD,10,-5`,
    );
    const draft = parseSplitwiseCsv(
      ["Date,Description,Category,Cost,Currency,A,B", ...rows].join("\n"),
      { sourceName: "broken.csv", sourceHash: "6".repeat(64) },
    );
    expect(draft.warnings.length).toBeLessThanOrEqual(201);
    expect(draft.warnings.at(-1)).toEqual(expect.objectContaining({
      code: "ADDITIONAL_WARNINGS_HIDDEN",
      blocking: true,
    }));
  });
});

describe("Splitwise JSON backup import", () => {
  test("deduplicates identical provider records across backups but blocks changed versions", () => {
    const backup = (description: string) => ({
      user: { id: 1, first_name: "Sam" },
      groups: [{ id: 10, name: "Trip", members: [{ id: 1, first_name: "Sam" }, { id: 2, first_name: "Mira" }] }],
      expenses: [{
        id: 90,
        group_id: 10,
        cost: "10.00",
        currency_code: "USD",
        description,
        date: "2026-08-01",
        users: [
          { user: { id: 1, first_name: "Sam" }, paid_share: "10.00", owed_share: "5.00" },
          { user: { id: 2, first_name: "Mira" }, paid_share: "0.00", owed_share: "5.00" },
        ],
      }],
    });
    const first = parseSplitwiseJson(JSON.stringify(backup("Dinner")), { sourceName: "first.json", sourceHash: "7".repeat(64) });
    const identical = parseSplitwiseJson(JSON.stringify(backup("Dinner")), { sourceName: "second.json", sourceHash: "8".repeat(64) });
    const changed = parseSplitwiseJson(JSON.stringify(backup("Late dinner")), { sourceName: "third.json", sourceHash: "9".repeat(64) });
    expect(combineImportDrafts([first, identical]).warnings).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_RECORD",
      blocking: false,
    }));
    expect(combineImportDrafts([first, changed]).warnings).toContainEqual(expect.objectContaining({
      code: "CONFLICTING_RECORD",
      blocking: true,
    }));
  });

  test("preserves explicit payers, allocations, payments, recurrence, deletion, and group-less history", () => {
    const backup = {
      user: { id: 1, first_name: "Alex", email: "alex@example.com" },
      groups: [{
        id: 10,
        name: "Goa",
        members: [
          { id: 1, first_name: "Alex", balance: [{ currency_code: "USD", amount: "0.00" }] },
          { id: 2, first_name: "Mira", balance: [{ currency_code: "USD", amount: "0.00" }] },
        ],
      }],
      friends: [{ id: 2, first_name: "Mira", email: "mira@example.com" }],
      expenses: [
        {
          id: 100,
          group_id: 10,
          cost: "60.00",
          currency_code: "USD",
          description: "Dinner",
          details: "Patio",
          date: "2026-08-01T19:00:00Z",
          created_at: "2026-08-01T19:01:00Z",
          updated_at: "2026-08-02T08:00:00Z",
          repeat_interval: "monthly",
          deleted_at: "2026-08-03T08:00:00Z",
          payment: false,
          users: [
            { user: { id: 1, first_name: "Alex" }, paid_share: "60.00", owed_share: "30.00" },
            { user: { id: 2, first_name: "Mira" }, paid_share: "0.00", owed_share: "30.00" },
          ],
        },
        {
          id: 101,
          group_id: 0,
          friendship_id: 77,
          cost: "15.00",
          currency_code: "EUR",
          description: "Payment",
          date: "2026-08-04T10:00:00Z",
          payment: true,
          users: [
            { user: { id: 1, first_name: "Alex" }, paid_share: "15.00", owed_share: "0.00" },
            { user: { id: 2, first_name: "Mira" }, paid_share: "0.00", owed_share: "15.00" },
          ],
        },
      ],
    };
    const draft = parseSplitwiseJson(JSON.stringify(backup), { sourceName: "backup.json", sourceHash: "e".repeat(64) });
    expect(draft.records[0]).toMatchObject({
      externalId: "splitwise-expense:100",
      kind: "expense",
      deleted: true,
      recurrence: "monthly",
      payers: [{ externalPersonId: "splitwise-user:1", amountMinor: 6000 }],
      allocations: [
        { externalPersonId: "splitwise-user:1", amountMinor: 3000 },
        { externalPersonId: "splitwise-user:2", amountMinor: 3000 },
      ],
    });
    expect(draft.records[1]).toMatchObject({
      kind: "payment",
      externalGroupId: "splitwise-friendship:77:EUR",
      payerExternalId: "splitwise-user:1",
      recipientExternalId: "splitwise-user:2",
    });
    expect(draft.sourceBalances).toEqual([
      { externalGroupId: "splitwise-group:10:USD", externalPersonId: "splitwise-user:1", currency: "USD", amountMinor: 0, sourceHash: "e".repeat(64) },
      { externalGroupId: "splitwise-group:10:USD", externalPersonId: "splitwise-user:2", currency: "USD", amountMinor: 0, sourceHash: "e".repeat(64) },
    ]);
    const reconciliation = reconcileImportDraft(draft);
    expect(reconciliation.blockingWarnings).toEqual([]);
    expect(reconciliation.participantTotals).toContainEqual({
      externalPersonId: "splitwise-user:1",
      currency: "EUR",
      paidMinor: 0,
      owedMinor: 0,
      paymentsSentMinor: 1500,
      paymentsReceivedMinor: 0,
      netMinor: 1500,
    });
    expect(reconciliation.groupTotals).toContainEqual(expect.objectContaining({
      externalGroupId: "splitwise-friendship:77:EUR",
      currency: "EUR",
      paymentsMinor: 1500,
      netMinor: 0,
    }));
  });

  test("derives current status from the full group balance instead of the last expense", () => {
    const backup = {
      user: { id: 1, first_name: "Sam" },
      groups: [{ id: 10, name: "Trip", members: [{ id: 1, first_name: "Sam" }, { id: 2, first_name: "Mira" }] }],
      expenses: [
        {
          id: 1, group_id: 10, cost: "20.00", currency_code: "USD", description: "Dinner", date: "2026-08-01",
          users: [
            { user: { id: 1, first_name: "Sam" }, paid_share: "20.00", owed_share: "10.00" },
            { user: { id: 2, first_name: "Mira" }, paid_share: "0.00", owed_share: "10.00" },
          ],
        },
        {
          id: 2, group_id: 10, cost: "5.00", currency_code: "USD", description: "Solo", date: "2026-08-02",
          users: [{ user: { id: 1, first_name: "Sam" }, paid_share: "5.00", owed_share: "5.00" }],
        },
      ],
    };
    const draft = parseSplitwiseJson(JSON.stringify(backup), { sourceName: "backup.json", sourceHash: "3".repeat(64) });
    expect(draft.groups[0]?.status).toBe("current");
  });
});

describe("migration reconciliation", () => {
  test("computes zero-sum balances and blocks a source mismatch", () => {
    const draft = parseSplitwiseCsv(
      "Date,Description,Category,Cost,Currency,A,B\n2026-08-01,Lunch,Food,10,USD,5,-5",
      { sourceName: "valid.csv", sourceHash: "f".repeat(64) },
    );
    draft.sourceBalances = [{ externalPersonId: "name:b", currency: "USD", amountMinor: -600 }];
    const report = reconcileImportDraft(draft);
    expect(report.zeroSum).toBe(true);
    expect(report.lines[0]).toMatchObject({ sourceMinor: -600, computedMinor: -500, differenceMinor: 100, matches: false });
    expect(report.blockingWarnings.some((warning) => warning.code === "BALANCE_MISMATCH")).toBe(true);
  });

  test("opening balances affect reconciliation without becoming expenses", () => {
    const draft = createOpeningBalanceDraft({
      ownerExternalId: "tallied-owner",
      ownerName: "You",
      rows: [
        { personName: "Mira", direction: "owes_me", amount: "24.00", currency: "USD", groupName: "Opening balances", effectiveDate: "2026-08-04" },
        { personName: "Dev", direction: "i_owe", amount: "7.80", currency: "USD", effectiveDate: "2026-08-04" },
      ],
    });
    expect(draft.records.every((record) => record.kind === "opening_balance")).toBe(true);
    const report = reconcileImportDraft(draft);
    expect(report.zeroSum).toBe(true);
    expect(report.recordCount).toBe(2);
    expect(draft.groups[0]?.memberExternalIds).toEqual(["tallied-owner", "opening-person:1:mira", "opening-person:2:dev"]);
    expect(openingBalanceReviewRows(draft, ["tallied-owner"], draft.groups.map(({ externalId }) => externalId))).toEqual([
      expect.objectContaining({ personName: "Mira", direction: "owes_me", amountMinor: 2400, currency: "USD", groupName: "Opening balances", effectiveDate: "2026-08-04" }),
      expect.objectContaining({ personName: "Dev", direction: "i_owe", amountMinor: 780, currency: "USD", groupName: "Opening balances", effectiveDate: "2026-08-04" }),
    ]);
  });

  test("reuses an explicitly selected person across balance rows without merging same-name strangers", () => {
    const draft = createOpeningBalanceDraft({
      ownerExternalId: "owner",
      ownerName: "Sam",
      rows: [
        { personKey: "mira", personName: "Mira", direction: "owes_me", amount: "10", currency: "USD", groupName: "Trip", effectiveDate: "2026-08-01" },
        { personKey: "mira", personName: "Mira", direction: "i_owe", amount: "3", currency: "USD", groupName: "Home", effectiveDate: "2026-08-01" },
        { personKey: "another-mira", personName: "Mira", direction: "owes_me", amount: "2", currency: "USD", groupName: "Work", effectiveDate: "2026-08-01" },
      ],
    });
    expect(draft.people.map(({ externalId }) => externalId).sort()).toEqual([
      "opening-person:another-mira",
      "opening-person:mira",
      "owner",
    ]);
    expect(draft.groups.find(({ name }) => name === "Trip")?.memberExternalIds).toContain("opening-person:mira");
    expect(draft.groups.find(({ name }) => name === "Home")?.memberExternalIds).toContain("opening-person:mira");
  });

  test("parses an unambiguous comma decimal without multiplying the amount", () => {
    const draft = createOpeningBalanceDraft({
      ownerExternalId: "owner",
      ownerName: "You",
      rows: [{ personName: "Mira", direction: "owes_me", amount: "24,50", currency: "USD", effectiveDate: "2026-08-04" }],
    });
    expect(draft.records[0]?.amountMinor).toBe(2450);
    expect(draft.warnings).toEqual([]);
  });
});
