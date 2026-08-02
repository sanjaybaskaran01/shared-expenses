import { describe, expect, test } from "bun:test";
import type { LocalExpense, LocalGroup, LocalMember, LocalOperation } from "../src/lib/db";
import { buildExpenseTargets, mostRecentExpenseGroupId } from "../src/lib/expense-targets";

const groups: LocalGroup[] = [
  { id: "trip", name: "Tokyo", settlementCurrency: "USD", createdAt: "2026-01-01" },
  { id: "home", name: "Home", settlementCurrency: "USD", createdAt: "2026-01-02" },
];
const members: LocalMember[] = [
  { id: "1", groupId: "trip", userId: "me", displayName: "Me", status: "active" },
  { id: "2", groupId: "trip", userId: "ana", displayName: "Ananya", status: "active" },
  { id: "3", groupId: "home", userId: "me", displayName: "Me", status: "active" },
  { id: "4", groupId: "home", userId: "sam", displayName: "Sam", status: "invited" },
  { id: "5", groupId: "home", userId: "ana", displayName: "Ananya", status: "active" },
];

describe("expense targets", () => {
  test("offers every group and only active people", () => {
    const targets = buildExpenseTargets(groups, members, "me");
    expect(targets.map((target) => target.key)).toEqual(["group:home", "group:trip", "person:ana"]);
    expect(targets[2]?.participantIds).toEqual(["me", "ana"]);
    expect(targets[2]?.groupId).toBe("home");
    expect(targets[2]?.detail).toBe("Home · 2 shared groups");
  });

  test("puts the current group first without preselecting it", () => {
    const targets = buildExpenseTargets(groups, members, "me", "trip");
    expect(targets[0]?.key).toBe("group:trip");
    expect(targets[1]?.key).toBe("group:home");
    expect(targets[2]?.groupId).toBe("trip");
  });

  test("finds the most recently touched active expense group", () => {
    const base = {
      description: "Dinner",
      category: "Dining out",
      amountMinor: 2000,
      currency: "USD",
      expenseDate: "2026-07-25",
      notes: "",
      recurrence: "none" as const,
      payers: [],
      allocations: [],
      yourNetMinor: 0,
      version: 1,
      createdBy: "me",
      syncStatus: "accepted" as const,
    };
    const expenses: LocalExpense[] = [
      { ...base, id: "older", groupId: "trip", status: "active", updatedAt: "2026-07-25T10:00:00Z" },
      { ...base, id: "deleted", groupId: "trip", status: "voided", updatedAt: "2026-07-30T10:00:00Z" },
      { ...base, id: "newer", groupId: "home", status: "active", updatedAt: "2026-07-29T10:00:00Z" },
    ];

    expect(mostRecentExpenseGroupId(expenses)).toBe("home");
    expect(mostRecentExpenseGroupId(expenses.filter((expense) => expense.status === "voided"))).toBeUndefined();
  });

  test("prefers the actor's own recent use over another member's later edit", () => {
    const expenses: LocalExpense[] = [
      {
        id: "mine",
        groupId: "trip",
        description: "Dinner",
        category: "Dining out",
        amountMinor: 2000,
        currency: "USD",
        expenseDate: "2026-07-25",
        notes: "",
        recurrence: "none",
        payers: [],
        allocations: [],
        yourNetMinor: 0,
        status: "active",
        version: 1,
        createdBy: "me",
        updatedAt: "2026-07-25T10:00:00Z",
        syncStatus: "accepted",
      },
      {
        id: "theirs",
        groupId: "home",
        description: "Rent",
        category: "Rent",
        amountMinor: 8000,
        currency: "USD",
        expenseDate: "2026-07-26",
        notes: "",
        recurrence: "none",
        payers: [],
        allocations: [],
        yourNetMinor: 0,
        status: "active",
        version: 2,
        createdBy: "friend",
        updatedAt: "2026-07-30T10:00:00Z",
        syncStatus: "accepted",
      },
    ];
    const operation = (id: string, targetId: string, actorId: string, clientTimestamp: string): LocalOperation => ({
      id,
      groupId: targetId === "mine" ? "trip" : "home",
      actorId,
      deviceId: `device-${actorId}`,
      type: "ExpenseAmended",
      targetId,
      baseVersion: 1,
      clientTimestamp,
      payload: {},
      contentHash: "0".repeat(64),
      signature: "signature",
      syncStatus: "accepted",
    });

    expect(mostRecentExpenseGroupId(expenses, [
      operation("my-use", "mine", "me", "2026-07-25T10:00:00Z"),
      operation("remote-edit", "theirs", "friend", "2026-07-30T10:00:00Z"),
    ], "me")).toBe("trip");
  });
});
