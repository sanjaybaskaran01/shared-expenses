import { describe, expect, test } from "bun:test";
import type { LocalExpense, LocalOperation } from "../src/lib/db";
import {
  expenseRecoveryState,
  failedExpenseContext,
  recoveryDescription,
} from "../src/lib/expense-recovery";

const expense: LocalExpense = {
  id: "expense-1",
  groupId: "group-1",
  description: "Dinner",
  category: "Dining out",
  amountMinor: 4_200,
  currency: "USD",
  expenseDate: "2026-08-14",
  notes: "",
  recurrence: "none",
  payers: [{ participantId: "me", amountMinor: 4_200 }],
  allocations: [{ participantId: "me", amountMinor: 2_100 }, { participantId: "friend", amountMinor: 2_100 }],
  yourNetMinor: 2_100,
  status: "active",
  version: 1,
  createdBy: "me",
  updatedAt: "2026-08-14T12:00:00.000Z",
  syncStatus: "rejected",
};

function operation(overrides: Partial<LocalOperation> = {}): LocalOperation {
  return {
    id: "operation-1",
    groupId: "group-1",
    actorId: "me",
    deviceId: "device-1",
    type: "ExpenseCreated",
    targetId: expense.id,
    baseVersion: 0,
    clientTimestamp: "2026-08-14T12:00:00.000Z",
    payload: {},
    contentHash: "0".repeat(64),
    signature: "signature",
    syncStatus: "rejected",
    ...overrides,
  };
}

describe("expense recovery", () => {
  test("classifies a rejected create with no accepted target history as local-only and retryable", () => {
    const state = expenseRecoveryState(expense, [
      operation({ errorCode: "OPERATION_ID_REUSED", errorMessage: "Operation id is already in use" }),
      operation({ id: "pending-comment", type: "CommentAdded", syncStatus: "pending", clientTimestamp: "2026-08-14T12:01:00.000Z" }),
    ]);

    expect(state.kind).toBe("local-only");
    if (state.kind !== "local-only") throw new Error("Expected a local-only recovery state");
    expect(state.canRetryAsNew).toBe(true);
    expect(state.failedOperations.map(({ id }) => id)).toEqual(["operation-1"]);
    expect(recoveryDescription(state)).toContain("not included in anyone’s balances");
    expect(failedExpenseContext(state.failure)).toBe("Operation id is already in use");
  });

  test("does not offer a fresh retry when the server says the actor is no longer a group member", () => {
    const state = expenseRecoveryState(expense, [
      operation({ errorCode: "NOT_A_GROUP_MEMBER" }),
    ]);

    expect(state.kind).toBe("local-only");
    if (state.kind !== "local-only") throw new Error("Expected a local-only recovery state");
    expect(state.canRetryAsNew).toBe(false);
    expect(failedExpenseContext(state.failure)).toBe("The server says you are no longer a current member of this group.");
  });

  test("does not offer a fresh retry for an unclassified server failure", () => {
    const state = expenseRecoveryState(expense, [
      operation({ errorMessage: "The server could not apply this expense." }),
    ]);

    expect(state.kind).toBe("local-only");
    if (state.kind !== "local-only") throw new Error("Expected a local-only recovery state");
    expect(state.canRetryAsNew).toBe(false);
  });

  test("does not offer a fresh retry for a locally deleted rejected create", () => {
    const state = expenseRecoveryState({ ...expense, status: "voided" }, [
      operation({ errorCode: "OPERATION_ID_REUSED" }),
    ]);

    expect(state.kind).toBe("local-only");
    if (state.kind !== "local-only") throw new Error("Expected a local-only recovery state");
    expect(state.canRetryAsNew).toBe(false);
  });

  test("keeps the accepted canonical expense when a later amend or void fails", () => {
    const acceptedCreate = operation({ id: "accepted-create", syncStatus: "accepted", serverSequence: 5 });
    const rejectedAmend = operation({
      id: "rejected-amend",
      type: "ExpenseAmended",
      baseVersion: 1,
      clientTimestamp: "2026-08-14T12:03:00.000Z",
      errorCode: "CONFLICT",
      errorMessage: "The expense was changed by someone else.",
    });
    const rejectedVoid = operation({
      id: "rejected-void",
      type: "ExpenseVoided",
      baseVersion: 1,
      clientTimestamp: "2026-08-14T12:04:00.000Z",
      errorCode: "CONFLICT",
    });
    const state = expenseRecoveryState({ ...expense, syncStatus: "accepted" }, [acceptedCreate, rejectedAmend, rejectedVoid]);

    expect(state.kind).toBe("canonical");
    if (state.kind !== "canonical") throw new Error("Expected a canonical recovery state");
    expect(state.failure.id).toBe("rejected-void");
    expect(state.failedOperations.map(({ id }) => id)).toEqual(["rejected-amend", "rejected-void"]);
    expect(recoveryDescription(state)).toContain("last synced version");
    expect(failedExpenseContext(rejectedAmend)).toBe("The expense was changed by someone else.");
  });

  test("does not discard as local-only if any accepted target history exists", () => {
    const state = expenseRecoveryState(expense, [
      operation({ id: "failed-create", errorCode: "OPERATION_ID_REUSED" }),
      operation({ id: "accepted-comment", type: "CommentAdded", syncStatus: "accepted", serverSequence: 7 }),
    ]);

    expect(state.kind).toBe("canonical");
  });
});
