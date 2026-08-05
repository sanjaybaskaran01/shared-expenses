import { describe, expect, test } from "bun:test";
import { groupTimelineItems, paymentActivityDetails } from "../src/lib/activity-view";
import type { LocalExpense, LocalOperation } from "../src/lib/db";

describe("activity payment details", () => {
  test("exposes the people, amount, currency, date, and note for an auditable payment", () => {
    expect(paymentActivityDetails({
      type: "PaymentRecorded",
      payload: { payerId: "alex", recipientId: "ananya", amountMinor: 3050, currency: "USD", paymentDate: "2026-07-30", note: "Paid by bank" },
    })).toEqual({ payerId: "alex", recipientId: "ananya", amountMinor: 3050, currency: "USD", paymentDate: "2026-07-30", note: "Paid by bank" });
  });

  test("ignores unrelated or malformed operations", () => {
    expect(paymentActivityDetails({ type: "ExpenseCreated", payload: {} })).toBeUndefined();
    expect(paymentActivityDetails({ type: "PaymentRecorded", payload: { amountMinor: 0 } })).toBeUndefined();
  });
});

describe("group timeline", () => {
  test("keeps payments beside expenses in source-date order", () => {
    const expense = {
      id: "expense-1", groupId: "group-1", description: "Dinner", category: "Food", amountMinor: 2000,
      currency: "USD", expenseDate: "2026-07-02", notes: "", payers: [], allocations: [], yourNetMinor: 0,
      status: "active", version: 1, createdBy: "a", updatedAt: "2026-07-02T12:00:00Z", syncStatus: "accepted",
    } satisfies LocalExpense;
    const payment = {
      id: "operation-1", groupId: "group-1", actorId: "a", deviceId: "device-1", type: "PaymentRecorded",
      targetId: "payment-1", baseVersion: 0, clientTimestamp: "2026-07-01T13:00:00Z",
      payload: { payerId: "a", recipientId: "b", amountMinor: 1000, currency: "USD", paymentDate: "2026-07-01" },
      contentHash: "0".repeat(64), signature: "signature", syncStatus: "accepted",
    } satisfies LocalOperation;

    expect(groupTimelineItems([expense], [payment], "group-1").map((item) => item.kind)).toEqual(["expense", "payment"]);
  });

  test("omits reversed payments", () => {
    const payment = {
      id: "operation-1", groupId: "group-1", actorId: "a", deviceId: "device-1", type: "PaymentRecorded",
      targetId: "payment-1", baseVersion: 0, clientTimestamp: "2026-07-01T13:00:00Z",
      payload: { payerId: "a", recipientId: "b", amountMinor: 1000, currency: "USD", paymentDate: "2026-07-01" },
      contentHash: "0".repeat(64), signature: "signature", syncStatus: "accepted",
    } satisfies LocalOperation;
    const reversal = { ...payment, id: "operation-2", type: "PaymentReversed", clientTimestamp: "2026-07-02T13:00:00Z" } satisfies LocalOperation;
    expect(groupTimelineItems([], [payment, reversal], "group-1")).toEqual([]);
  });
});
