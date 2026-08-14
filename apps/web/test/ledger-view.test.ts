import { describe, expect, test } from "bun:test";
import { computeBalances, computeRelationshipBalances, simplifyBalances } from "../src/lib/ledger-view";
import type { LocalExpense, LocalGroup, LocalMember, LocalOperation } from "../src/lib/db";

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

  test("does not remove a server payment when its optimistic reversal is rejected", () => {
    const rejectedReversal = {
      ...payment,
      id: "rejected-payment-reversal",
      type: "PaymentReversed",
      baseVersion: 1,
      syncStatus: "rejected",
    } satisfies LocalOperation;

    expect(computeBalances([], [payment, rejectedReversal], "group-1", "USD"))
      .toEqual({ a: -1000, b: 1000 });
  });

  test("does not count a rejected optimistic expense toward balances", () => {
    expect(computeBalances([{ ...expense, syncStatus: "rejected" }], [], "group-1", "USD"))
      .toEqual({});
  });

  test("applies balance-only imports without treating them as expenses", () => {
    const imported = {
      ...payment,
      id: "imported-effect-operation",
      type: "ImportedTransactionRecorded",
      targetId: "imported-effect-1",
      payload: {
        currency: "USD",
        effects: [
          { participantId: "a", amountMinor: 750 },
          { participantId: "import:mira", amountMinor: -750 },
        ],
        import: { readOnly: true },
      },
    } satisfies LocalOperation;
    expect(computeBalances([], [imported], "group-1", "USD")).toEqual({ a: 750, "import:mira": -750 });
  });

  test("does not remove an imported balance when its optimistic undo is rejected", () => {
    const imported = {
      ...payment,
      id: "imported-effect-operation",
      type: "ImportedTransactionRecorded",
      targetId: "imported-effect-1",
      payload: {
        currency: "USD",
        effects: [
          { participantId: "a", amountMinor: 750 },
          { participantId: "import:mira", amountMinor: -750 },
        ],
        import: { readOnly: true },
      },
    } satisfies LocalOperation;
    const rejectedUndo = {
      ...imported,
      id: "rejected-import-undo",
      type: "ImportedTransactionVoided",
      baseVersion: 1,
      syncStatus: "conflicted",
    } satisfies LocalOperation;

    expect(computeBalances([], [imported, rejectedUndo], "group-1", "USD"))
      .toEqual({ a: 750, "import:mira": -750 });
  });

  test("reprojects immutable imported effects after a person securely claims them", () => {
    const imported = {
      ...payment,
      id: "claimed-effect-operation",
      type: "ImportedTransactionRecorded",
      targetId: "claimed-effect-1",
      payload: {
        currency: "USD",
        effects: [
          { participantId: "a", amountMinor: 750 },
          { participantId: "import:mira", amountMinor: -750 },
        ],
      },
      participantAliases: { "import:mira": "mira-account" },
    } satisfies LocalOperation;
    expect(computeBalances([], [imported], "group-1", "USD")).toEqual({ a: 750, "mira-account": -750 });
  });

  test("reduces balances to a deterministic settlement plan", () => {
    expect(simplifyBalances({ a: 3000, b: -1000, c: -2000 })).toEqual([
      { payerId: "c", recipientId: "a", amountMinor: 2000 },
      { payerId: "b", recipientId: "a", amountMinor: 1000 },
    ]);
  });

  test("aggregates a person's balance across groups without merging currencies", () => {
    const groups: LocalGroup[] = [
      { id: "group-1", name: "Home", settlementCurrency: "USD", createdAt: "2026-07-01T00:00:00Z" },
      { id: "group-2", name: "Trip", settlementCurrency: "USD", createdAt: "2026-07-02T00:00:00Z" },
    ];
    const members: LocalMember[] = groups.flatMap((group) => [
      { id: `${group.id}-a`, groupId: group.id, userId: "a", displayName: "You", status: "active" },
      { id: `${group.id}-b`, groupId: group.id, userId: "b", displayName: "Mira", status: "active" },
    ]);
    const secondExpense: LocalExpense = {
      ...expense,
      id: "expense-2",
      groupId: "group-2",
      amountMinor: 2000,
      payers: [{ participantId: "a", amountMinor: 2000 }],
      allocations: [
        { participantId: "a", amountMinor: 1000 },
        { participantId: "b", amountMinor: 1000 },
      ],
      yourNetMinor: 1000,
    };
    const euroExpense: LocalExpense = {
      ...secondExpense,
      id: "expense-3",
      currency: "EUR",
      amountMinor: 600,
      payers: [{ participantId: "b", amountMinor: 600 }],
      allocations: [
        { participantId: "a", amountMinor: 300 },
        { participantId: "b", amountMinor: 300 },
      ],
      yourNetMinor: -300,
    };

    expect(computeRelationshipBalances([expense, secondExpense, euroExpense], [], groups, members, "a")).toEqual([
      { userId: "b", currency: "USD", amountMinor: 3000, groupIds: ["group-1", "group-2"] },
      { userId: "b", currency: "EUR", amountMinor: -300, groupIds: ["group-2"] },
    ]);
  });
});
