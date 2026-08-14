import type { LocalExpense, LocalOperation } from "./db";

export const expenseMutationTypes = new Set<LocalOperation["type"]>([
  "ExpenseCreated",
  "ExpenseAmended",
  "ExpenseVoided",
  "ExpenseRestored",
]);

export type ExpenseRecoveryState =
  | {
    kind: "none";
    failedOperations: LocalOperation[];
  }
  | {
    kind: "local-only";
    failedOperations: LocalOperation[];
    failure: LocalOperation;
    canRetryAsNew: boolean;
  }
  | {
    kind: "canonical";
    failedOperations: LocalOperation[];
    failure: LocalOperation;
  };

const retryableCreateErrorCodes = new Set([
  "OPERATION_ID_REUSED",
]);

function latestOperation(operations: readonly LocalOperation[]): LocalOperation {
  return operations.reduce((latest, operation) =>
    operation.clientTimestamp.localeCompare(latest.clientTimestamp) > 0 ||
    (operation.clientTimestamp === latest.clientTimestamp && operation.id.localeCompare(latest.id) > 0)
      ? operation
      : latest,
  );
}

export function isExpenseMutation(operation: LocalOperation): boolean {
  return expenseMutationTypes.has(operation.type);
}

export function expenseRecoveryState(
  expense: Pick<LocalExpense, "id" | "status">,
  operations: readonly LocalOperation[],
): ExpenseRecoveryState {
  const targetOperations = operations.filter((operation) => operation.targetId === expense.id);
  const failedOperations = targetOperations.filter(
    (operation) => isExpenseMutation(operation) && (operation.syncStatus === "rejected" || operation.syncStatus === "conflicted"),
  );
  if (failedOperations.length === 0) return { kind: "none", failedOperations };

  const failedCreate = failedOperations.find((operation) => operation.type === "ExpenseCreated");
  const hasAcceptedTargetOperation = targetOperations.some((operation) => operation.syncStatus === "accepted");
  if (failedCreate && !hasAcceptedTargetOperation) {
    return {
      kind: "local-only",
      failedOperations,
      failure: failedCreate,
      canRetryAsNew:
        expense.status === "active" &&
        failedCreate.syncStatus === "rejected" &&
        retryableCreateErrorCodes.has(failedCreate.errorCode ?? ""),
    };
  }

  return { kind: "canonical", failedOperations, failure: latestOperation(failedOperations) };
}

export function failedExpenseContext(operation: Pick<LocalOperation, "errorCode" | "errorMessage" | "type">): string {
  const serverMessage = operation.errorMessage?.trim();
  if (serverMessage) return serverMessage;

  switch (operation.errorCode) {
    case "CONFLICT":
      return "The expense changed in the group before this change could be saved.";
    case "NOT_A_GROUP_MEMBER":
      return "The server says you are no longer a current member of this group.";
    case "OPERATION_ID_REUSED":
      return "The server could not use this change’s identifier. Retrying creates a new change.";
    case "DEVICE_NOT_TRUSTED":
    case "UNTRUSTED_DEVICE":
      return "The server no longer trusts this device to save changes.";
    case "INVALID_SIGNATURE":
    case "CONTENT_HASH_MISMATCH":
    case "INVALID_ENVELOPE":
    case "INVALID_OPERATION":
    case "UNSUPPORTED_OPERATION":
    case "UNKNOWN_OPERATION_TYPE":
      return "The server could not verify this saved change.";
    default:
      return operation.errorCode
        ? `The server rejected this ${operation.type === "ExpenseCreated" ? "expense" : "change"} (${operation.errorCode}).`
        : "This saved change needs review.";
  }
}

export function recoveryTitle(state: Exclude<ExpenseRecoveryState, { kind: "none" }>): string {
  return state.kind === "local-only" ? "This expense was not added" : "A saved change was not applied";
}

export function recoveryDescription(state: Exclude<ExpenseRecoveryState, { kind: "none" }>): string {
  if (state.kind === "local-only") {
    return state.canRetryAsNew
      ? "It is not included in anyone’s balances. Retry it as a fresh expense, or discard this local copy."
      : "It is not included in anyone’s balances. Discard this local copy, then add it again if it is still needed.";
  }
  return "Tallied kept the last synced version. Discard the failed local change, then make any needed edit again.";
}
