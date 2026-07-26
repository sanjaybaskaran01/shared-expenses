import { describe, expect, test } from "bun:test";
import { computeBalances, simplifyBalances } from "../src/lib/ledger-view";
import type { LocalExpense, LocalOperation } from "../src/lib/db";

const expense: LocalExpense = {
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
};

const payment = {
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
} satisfies LocalOperation;

describe("ledger presentation", () => {
  test("includes recorded payments in member balances", () => {
    const result = computeBalances([expense], [payment], "group-1", "USD");
    expect(result).toEqual({ a: 3000, b: -1000, c: -2000 });
  });

  test("reduces balances to a deterministic settlement plan", () => {
    expect(simplifyBalances({ a: 3000, b: -1000, c: -2000 })).toEqual([
      { payerId: "c", recipientId: "a", amountMinor: 2000 },
      { payerId: "b", recipientId: "a", amountMinor: 1000 },
    ]);
  });
});
