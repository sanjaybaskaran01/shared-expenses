import { describe, expect, test } from "bun:test";
import type { LocalGroup, LocalMember } from "../src/lib/db";
import {
  decideExpenseLaunch,
  decideGroupCreationDestination,
  dialogHandoffDelay,
  groupComposerOriginAfterOpenChange,
  mobileExpenseActionVariant,
} from "../src/lib/expense-launch";

const groups: LocalGroup[] = [
  { id: "trip", name: "Goa trip", settlementCurrency: "USD", createdAt: "2026-07-29" },
];
const members: LocalMember[] = [
  { id: "m1", groupId: "trip", userId: "me", displayName: "Me", status: "active" },
  { id: "m2", groupId: "trip", userId: "ana", displayName: "Maya", status: "active" },
];

describe("expense launch routing", () => {
  test("keeps the global action target-agnostic", () => {
    expect(decideExpenseLaunch({ groups, members })).toEqual({ kind: "pick-target" });
  });

  test("opens the composer directly from a group", () => {
    expect(decideExpenseLaunch({ groups, members, groupId: "trip" })).toEqual({
      kind: "compose",
      target: {
        key: "group:trip",
        kind: "group",
        groupId: "trip",
        label: "Goa trip",
        detail: "2 people",
      },
    });
  });

  test("falls back to the picker if the requested group is unavailable", () => {
    expect(decideExpenseLaunch({ groups, members, groupId: "missing" })).toEqual({ kind: "pick-target" });
  });

  test("resumes an expense after a group is created from the picker", () => {
    expect(decideGroupCreationDestination("expense", groups, members, "trip")).toEqual({
      kind: "compose",
      target: {
        key: "group:trip",
        kind: "group",
        groupId: "trip",
        label: "Goa trip",
        detail: "2 people",
      },
    });
  });

  test("resumes even before the newly created group reaches the live query", () => {
    expect(decideGroupCreationDestination("expense", groups, members, "new-group", "New home")).toEqual({
      kind: "compose",
      target: {
        key: "group:new-group",
        kind: "group",
        groupId: "new-group",
        label: "New home",
        detail: "1 person",
      },
    });
  });

  test("opens the group after standalone group creation", () => {
    expect(decideGroupCreationDestination("groups", groups, members, "trip")).toEqual({
      kind: "open-group",
      groupId: "trip",
    });
  });

  test("clears a pending resume intent when the group form is dismissed", () => {
    expect(groupComposerOriginAfterOpenChange(false, "expense")).toBe("groups");
    expect(groupComposerOriginAfterOpenChange(true, "expense")).toBe("expense");
  });

  test("waits for an iPhone sheet to finish closing before opening the next sheet", () => {
    expect(dialogHandoffDelay(true)).toBeGreaterThanOrEqual(150);
    expect(dialogHandoffDelay(false)).toBe(0);
  });

  test("uses a compact floating action only inside a group", () => {
    expect(mobileExpenseActionVariant("groups", "detail")).toBe("compact");
    expect(mobileExpenseActionVariant("groups", "overview")).toBe("expanded");
    expect(mobileExpenseActionVariant("activity", "detail")).toBe("expanded");
  });
});
