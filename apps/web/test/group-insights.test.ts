import { describe, expect, test } from "bun:test";
import type { LocalExpense, LocalOperation } from "../src/lib/db";
import { buildGroupInsights, buildGroupReconciliation, describeExpenseOutcome, settlementBlockerCount, summarizeOperationHealth } from "../src/lib/group-insights";

function expense(overrides: Partial<LocalExpense> = {}): LocalExpense {
  return {
    id: "expense-1",
    groupId: "group-1",
    description: "Dinner",
    category: "Dining out",
    amountMinor: 6000,
    currency: "USD",
    expenseDate: "2026-07-25",
    notes: "",
    recurrence: "none",
    payers: [{ participantId: "a", amountMinor: 6000 }],
    allocations: [
      { participantId: "a", amountMinor: 2000 },
      { participantId: "b", amountMinor: 2000 },
      { participantId: "c", amountMinor: 2000 },
    ],
    yourNetMinor: 4000,
    status: "active",
    version: 1,
    createdBy: "a",
    updatedAt: "2026-07-25T12:00:00Z",
    syncStatus: "accepted",
    ...overrides,
  };
}

describe("group insights", () => {
  test("summarizes the actor's share, payments, and categories", () => {
    const groceries = expense({
      id: "expense-2",
      description: "Groceries",
      category: "Groceries",
      amountMinor: 9000,
      expenseDate: "2026-08-01",
      payers: [{ participantId: "b", amountMinor: 9000 }],
      allocations: [
        { participantId: "a", amountMinor: 4500 },
        { participantId: "b", amountMinor: 4500 },
      ],
    });

    const result = buildGroupInsights([expense(), groceries], "USD", "a");

    expect(result.totalMinor).toBe(15_000);
    expect(result.yourShareMinor).toBe(6_500);
    expect(result.paidByYouMinor).toBe(6_000);
    expect(result.expenseCount).toBe(2);
    expect(result.averageMinor).toBe(7_500);
    expect(result.topCategory).toEqual({ name: "Groceries", amountMinor: 9_000, percentage: 60 });
  });

  test("compares the latest active month with its previous calendar month", () => {
    const result = buildGroupInsights([
      expense({ id: "july", amountMinor: 5_000, expenseDate: "2026-07-20" }),
      expense({ id: "august-a", amountMinor: 4_000, expenseDate: "2026-08-02" }),
      expense({ id: "august-b", amountMinor: 6_000, expenseDate: "2026-08-12" }),
      expense({ id: "voided", amountMinor: 99_000, expenseDate: "2026-08-20", status: "voided" }),
      expense({ id: "euros", amountMinor: 99_000, expenseDate: "2026-08-20", currency: "EUR" }),
    ], "USD", "a");

    expect(result.monthTrend).toEqual({
      currentMonth: "2026-08",
      currentMinor: 10_000,
      previousMonth: "2026-07",
      previousMinor: 5_000,
      differenceMinor: 5_000,
      percentageChange: 100,
    });
  });

  test("does not invent a comparison when the previous calendar month has no data", () => {
    const result = buildGroupInsights([
      expense({ id: "june", amountMinor: 5_000, expenseDate: "2026-06-20" }),
      expense({ id: "august", amountMinor: 10_000, expenseDate: "2026-08-02" }),
    ], "USD", "a");

    expect(result.monthTrend).toBeUndefined();
  });

  test("does not include failed optimistic expenses in totals", () => {
    const result = buildGroupInsights([
      expense({ id: "accepted", amountMinor: 5_000 }),
      expense({ id: "rejected", amountMinor: 99_000, syncStatus: "rejected" }),
      expense({ id: "conflicted", amountMinor: 88_000, syncStatus: "conflicted" }),
    ], "USD", "a");

    expect(result.totalMinor).toBe(5_000);
    expect(result.expenseCount).toBe(1);
  });
});

describe("expense outcome preview", () => {
  test("explains money coming back when the actor paid more than their share", () => {
    expect(describeExpenseOutcome(6_000, 2_000)).toEqual({
      actorPaidMinor: 6_000,
      actorShareMinor: 2_000,
      direction: "back",
      differenceMinor: 4_000,
    });
  });

  test("explains money owed when the actor paid less than their share", () => {
    expect(describeExpenseOutcome(0, 2_000)).toEqual({
      actorPaidMinor: 0,
      actorShareMinor: 2_000,
      direction: "owe",
      differenceMinor: 2_000,
    });
  });

  test("describes an even position without a signed zero", () => {
    expect(describeExpenseOutcome(2_000, 2_000)).toEqual({
      actorPaidMinor: 2_000,
      actorShareMinor: 2_000,
      direction: "even",
      differenceMinor: 0,
    });
  });
});

describe("group reconciliation", () => {
  test("shows how expenses and recorded payments produce the actor balance", () => {
    const payment: LocalOperation = {
      id: "payment-operation",
      groupId: "group-1",
      actorId: "b",
      deviceId: "device-b",
      type: "PaymentRecorded",
      targetId: "payment-1",
      baseVersion: 0,
      clientTimestamp: "2026-07-26T12:00:00Z",
      payload: { payerId: "b", recipientId: "a", amountMinor: 1000, currency: "USD", paymentDate: "2026-07-26", note: "" },
      contentHash: "0".repeat(64),
      signature: "signature",
      syncStatus: "accepted",
    };

    expect(buildGroupReconciliation([expense()], [payment], "group-1", "USD", "a")).toEqual({
      paidByYouMinor: 6000,
      yourShareMinor: 2000,
      paymentsSentMinor: 0,
      paymentsReceivedMinor: 1000,
      balanceMinor: 3000,
      expenseCount: 1,
      paymentCount: 1,
    });
  });

  test("counts only payments involving the actor", () => {
    const operation = (id: string, payerId: string, recipientId: string): LocalOperation => ({
      id,
      groupId: "group-1",
      actorId: payerId,
      deviceId: `device-${payerId}`,
      type: "PaymentRecorded",
      targetId: id,
      baseVersion: 0,
      clientTimestamp: "2026-07-26T12:00:00Z",
      payload: { payerId, recipientId, amountMinor: 1000, currency: "USD", paymentDate: "2026-07-26", note: "" },
      contentHash: "0".repeat(64),
      signature: "signature",
      syncStatus: "accepted",
    });

    const result = buildGroupReconciliation(
      [expense()],
      [operation("to-actor", "b", "a"), operation("unrelated", "b", "c")],
      "group-1",
      "USD",
      "a",
    );

    expect(result.paymentCount).toBe(1);
    expect(result.paymentsReceivedMinor).toBe(1000);
  });

  test("includes opening balances without inflating spending insights", () => {
    const opening: LocalOperation = {
      id: "opening-operation",
      groupId: "group-1",
      actorId: "a",
      deviceId: "device-a",
      type: "OpeningBalanceCreated",
      targetId: "opening-1",
      baseVersion: 0,
      clientTimestamp: "2026-07-26T12:00:00Z",
      payload: {
        currency: "USD",
        effects: [
          { participantId: "a", amountMinor: 800 },
          { participantId: "b", amountMinor: -800 },
        ],
        import: { readOnly: true },
      },
      contentHash: "0".repeat(64),
      signature: "signature",
      syncStatus: "accepted",
    };
    const result = buildGroupReconciliation([], [opening], "group-1", "USD", "a");
    expect(result.balanceMinor).toBe(800);
    expect(result.expenseCount).toBe(0);
  });
});

describe("settlement safety", () => {
  test("blocks settlement for failed expense changes in scope, including a rejected void", () => {
    const failedExpenseOperation = (
      id: string,
      targetId: string,
      type: LocalOperation["type"],
      syncStatus: LocalOperation["syncStatus"],
      groupId = "group-1",
    ): LocalOperation => ({
      id,
      groupId,
      actorId: "a",
      deviceId: "device-a",
      type,
      targetId,
      baseVersion: 1,
      clientTimestamp: "2026-07-26T12:00:00Z",
      payload: {},
      contentHash: "0".repeat(64),
      signature: "signature",
      syncStatus,
    });

    expect(settlementBlockerCount(
      [
        expense({ id: "accepted" }),
        expense({ id: "failed-amend" }),
        // The client restores this canonical active expense after its void fails.
        expense({ id: "failed-void" }),
        expense({ id: "other-currency", currency: "EUR" }),
        expense({ id: "other-group", groupId: "group-2" }),
      ],
      [
        failedExpenseOperation("accepted-change", "accepted", "ExpenseAmended", "accepted"),
        failedExpenseOperation("failed-amend-operation", "failed-amend", "ExpenseAmended", "rejected"),
        failedExpenseOperation("failed-void-operation", "failed-void", "ExpenseVoided", "conflicted"),
        failedExpenseOperation("other-currency-operation", "other-currency", "ExpenseAmended", "rejected"),
        failedExpenseOperation("other-group-operation", "other-group", "ExpenseAmended", "rejected", "group-2"),
      ],
      "group-1",
      "USD",
    )).toBe(2);
  });

  test("uses the latest expense operation when reporting sync health", () => {
    const operation = (id: string, targetId: string, clientTimestamp: string, syncStatus: LocalOperation["syncStatus"]): LocalOperation => ({
      id,
      groupId: "group-1",
      actorId: "a",
      deviceId: "device-a",
      type: "ExpenseAmended",
      targetId,
      baseVersion: 1,
      clientTimestamp,
      payload: {},
      contentHash: "0".repeat(64),
      signature: "signature",
      syncStatus,
    });

    expect(summarizeOperationHealth([
      operation("old", "expense-1", "2026-07-26T10:00:00Z", "rejected"),
      operation("fixed", "expense-1", "2026-07-26T11:00:00Z", "accepted"),
      operation("waiting", "expense-2", "2026-07-26T12:00:00Z", "pending"),
    ], "group-1")).toEqual({ pending: 1, attention: 0 });
  });
});
