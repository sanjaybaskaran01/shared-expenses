import type { LocalExpense, LocalOperation } from "./db";
import { activePayments, operationPayload } from "./ledger-view";

export interface PaymentActivityDetails {
  payerId: string;
  recipientId: string;
  amountMinor: number;
  currency: string;
  paymentDate?: string;
  note?: string;
}

export function restoreExpenseFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Unable to restore this expense. Try again.";
}

export function paymentActivityDetails(
  operation: LocalOperation,
): PaymentActivityDetails | undefined {
  if (operation.type !== "PaymentRecorded") return undefined;
  const payload = operationPayload(operation);
  const payerId = typeof payload.payerId === "string" ? payload.payerId : "";
  const recipientId = typeof payload.recipientId === "string" ? payload.recipientId : "";
  const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : Number.NaN;
  const currency = typeof payload.currency === "string" ? payload.currency : "";
  if (!payerId || !recipientId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return {
    payerId,
    recipientId,
    amountMinor,
    currency,
    ...(typeof payload.paymentDate === "string" ? { paymentDate: payload.paymentDate } : {}),
    ...(typeof payload.note === "string" && payload.note.trim() ? { note: payload.note.trim() } : {}),
  };
}

export type GroupTimelineItem =
  | { kind: "expense"; date: string; sortAt: string; expense: LocalExpense }
  | { kind: "payment"; date: string; sortAt: string; operation: LocalOperation; payment: PaymentActivityDetails };

/** Keeps payments in the same chronological group feed as expenses. */
export function groupTimelineItems(
  expenses: readonly LocalExpense[],
  operations: readonly LocalOperation[],
  groupId: string,
): GroupTimelineItem[] {
  const items: GroupTimelineItem[] = expenses
    .filter((expense) => expense.groupId === groupId)
    .map((expense) => ({
      kind: "expense" as const,
      date: expense.expenseDate,
      sortAt: expense.updatedAt,
      expense,
    }));

  for (const operation of activePayments(operations, groupId)) {
    const payment = paymentActivityDetails(operation);
    if (!payment) continue;
    items.push({
      kind: "payment",
      date: payment.paymentDate ?? operation.clientTimestamp.slice(0, 10),
      sortAt: operation.clientTimestamp,
      operation,
      payment,
    });
  }

  return items.sort((left, right) =>
    right.date.localeCompare(left.date) ||
    right.sortAt.localeCompare(left.sortAt) ||
    (left.kind === "expense" ? left.expense.id : left.operation.targetId)
      .localeCompare(right.kind === "expense" ? right.expense.id : right.operation.targetId),
  );
}
