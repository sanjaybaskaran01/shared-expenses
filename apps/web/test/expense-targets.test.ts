import { describe, expect, test } from "bun:test";
import type { LocalGroup, LocalMember } from "../src/lib/db";
import { buildExpenseTargets } from "../src/lib/expense-targets";

const groups: LocalGroup[] = [
  { id: "trip", name: "Tokyo", settlementCurrency: "USD", createdAt: "2026-01-01" },
  { id: "home", name: "Home", settlementCurrency: "USD", createdAt: "2026-01-02" },
];
const members: LocalMember[] = [
  { id: "1", groupId: "trip", userId: "me", displayName: "Me", status: "active" },
  { id: "2", groupId: "trip", userId: "ana", displayName: "Maya", status: "active" },
  { id: "3", groupId: "home", userId: "me", displayName: "Me", status: "active" },
  { id: "4", groupId: "home", userId: "sam", displayName: "Sam", status: "invited" },
  { id: "5", groupId: "home", userId: "ana", displayName: "Maya", status: "active" },
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
});
