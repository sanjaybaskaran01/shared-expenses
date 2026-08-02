import { describe, expect, test } from "bun:test";
import type { LocalOperation } from "../src/lib/db";
import { latestExpenseChange } from "../src/lib/expense-history";

function operation(
  id: string,
  type: LocalOperation["type"],
  actorId: string,
  clientTimestamp: string,
): LocalOperation {
  return {
    id,
    groupId: "group-1",
    actorId,
    deviceId: `device-${actorId}`,
    type,
    targetId: "expense-1",
    baseVersion: 1,
    clientTimestamp,
    payload: {},
    contentHash: "0".repeat(64),
    signature: "signature",
    syncStatus: "accepted",
  };
}

describe("expense history", () => {
  test("attributes the latest cross-user amendment to its actual actor", () => {
    const result = latestExpenseChange([
      operation("created", "ExpenseCreated", "a", "2026-07-25T10:00:00Z"),
      operation("comment", "CommentAdded", "a", "2026-07-25T11:00:00Z"),
      operation("amended", "ExpenseAmended", "b", "2026-07-25T12:00:00Z"),
    ], "expense-1");

    expect(result?.id).toBe("amended");
    expect(result?.actorId).toBe("b");
  });
});
