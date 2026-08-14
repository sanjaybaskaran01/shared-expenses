import type { LocalOperation } from "./db";

const expenseChangeTypes = new Set([
  "ExpenseCreated",
  "ExpenseAmended",
  "ExpenseVoided",
  "ExpenseRestored",
]);

export function latestExpenseChange(
  operations: readonly LocalOperation[],
  expenseId: string,
): LocalOperation | undefined {
  return operations
    .filter((operation) =>
      operation.targetId === expenseId &&
      expenseChangeTypes.has(operation.type) &&
      operation.syncStatus !== "rejected" &&
      operation.syncStatus !== "conflicted",
    )
    .slice()
    .sort((left, right) => left.clientTimestamp.localeCompare(right.clientTimestamp) || left.id.localeCompare(right.id))
    .at(-1);
}
