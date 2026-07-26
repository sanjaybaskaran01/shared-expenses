import type { JsonValue } from "@expenses/protocol";
import type { LocalExpense, LocalOperation } from "./db";

export interface Settlement {
  payerId: string;
  recipientId: string;
  amountMinor: number;
}

function payload(operation: LocalOperation): Record<string, JsonValue> {
  return operation.payload as Record<string, JsonValue>;
}

export function activePayments(operations: readonly LocalOperation[], groupId?: string, currency?: string): LocalOperation[] {
  const reversed = new Set(operations.filter((operation) => operation.type === "PaymentReversed").map((operation) => operation.targetId));
  return operations.filter((operation) => {
    if (operation.type !== "PaymentRecorded" || reversed.has(operation.targetId) || operation.syncStatus === "rejected" || operation.syncStatus === "conflicted") return false;
    const data = payload(operation);
    return (!groupId || operation.groupId === groupId) && (!currency || String(data.currency) === currency);
  });
}

export function computeBalances(
  expenses: readonly LocalExpense[],
  operations: readonly LocalOperation[],
  groupId: string,
  currency: string,
): Record<string, number> {
  const balances: Record<string, number> = {};
  const add = (participantId: string, amountMinor: number) => { balances[participantId] = (balances[participantId] ?? 0) + amountMinor; };
  for (const expense of expenses) {
    if (expense.groupId !== groupId || expense.currency !== currency || expense.status !== "active") continue;
    for (const payer of expense.payers) add(payer.participantId, payer.amountMinor);
    for (const allocation of expense.allocations) add(allocation.participantId, -allocation.amountMinor);
  }
  for (const operation of activePayments(operations, groupId, currency)) {
    const data = payload(operation);
    const amountMinor = Number(data.amountMinor);
    add(String(data.payerId), amountMinor);
    add(String(data.recipientId), -amountMinor);
  }
  return balances;
}

export function simplifyBalances(balances: Record<string, number>): Settlement[] {
  const creditors = Object.entries(balances).filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, amount]) => ({ id, amount }));
  const debtors = Object.entries(balances).filter(([, amount]) => amount < 0).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id, amount]) => ({ id, amount: -amount }));
  const settlements: Settlement[] = [];
  let creditorIndex = 0;
  let debtorIndex = 0;
  while (creditors[creditorIndex] && debtors[debtorIndex]) {
    const creditor = creditors[creditorIndex]!;
    const debtor = debtors[debtorIndex]!;
    const amountMinor = Math.min(creditor.amount, debtor.amount);
    if (amountMinor > 0) settlements.push({ payerId: debtor.id, recipientId: creditor.id, amountMinor });
    creditor.amount -= amountMinor;
    debtor.amount -= amountMinor;
    if (creditor.amount === 0) creditorIndex++;
    if (debtor.amount === 0) debtorIndex++;
  }
  return settlements;
}

export function expenseComments(operations: readonly LocalOperation[], expenseId: string): LocalOperation[] {
  return operations.filter((operation) => operation.type === "CommentAdded" && operation.targetId === expenseId && operation.syncStatus !== "rejected")
    .sort((a, b) => a.clientTimestamp.localeCompare(b.clientTimestamp));
}
