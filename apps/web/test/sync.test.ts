import { describe, expect, test } from "bun:test";
import type { OperationEnvelope } from "@expenses/protocol";
import { expenseFromOperation } from "../src/lib/sync";

describe("remote expense projection", () => {
  test("calculates the balance for the current user, not the operation author", () => {
    const operation: OperationEnvelope = {
      id: "operation-1",
      groupId: "group-1",
      actorId: "friend",
      deviceId: "device-1",
      type: "ExpenseCreated",
      targetId: "expense-1",
      baseVersion: 0,
      clientTimestamp: "2026-07-25T00:00:00.000Z",
      payload: {
        description: "Dinner",
        category: "Dining out",
        amountMinor: 1000,
        currency: "USD",
        expenseDate: "2026-07-25",
        notes: "",
        payers: [{ participantId: "friend", amountMinor: 1000 }],
        allocations: [
          { participantId: "friend", amountMinor: 500 },
          { participantId: "current-user", amountMinor: 500 },
        ],
      },
      contentHash: "0".repeat(64),
      signature: "test-signature",
    };

    expect(expenseFromOperation(operation, "accepted", "current-user")?.yourNetMinor).toBe(-500);
  });
});
