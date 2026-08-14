import type { LocalExpense, LocalOperation } from "./db";
import { activeImportedTransactions, activePayments, operationPayload } from "./ledger-view";

export interface CategoryInsight {
  name: string;
  amountMinor: number;
  percentage: number;
}

export interface MonthlyInsight {
  month: string;
  amountMinor: number;
}

export interface MonthTrend {
  currentMonth: string;
  currentMinor: number;
  previousMonth: string;
  previousMinor: number;
  differenceMinor: number;
  percentageChange: number;
}

export interface GroupInsights {
  totalMinor: number;
  yourShareMinor: number;
  paidByYouMinor: number;
  expenseCount: number;
  averageMinor: number;
  topCategory: CategoryInsight | undefined;
  monthTrend: MonthTrend | undefined;
  categoryBreakdown: CategoryInsight[];
  monthlyTotals: MonthlyInsight[];
}

export interface ExpenseOutcome {
  actorPaidMinor: number;
  actorShareMinor: number;
  direction: "back" | "owe" | "even";
  differenceMinor: number;
}

export interface GroupReconciliation {
  paidByYouMinor: number;
  yourShareMinor: number;
  paymentsSentMinor: number;
  paymentsReceivedMinor: number;
  balanceMinor: number;
  expenseCount: number;
  paymentCount: number;
}

export interface OperationHealth {
  pending: number;
  attention: number;
}

const expenseOperationTypes = new Set(["ExpenseCreated", "ExpenseAmended", "ExpenseVoided", "ExpenseRestored"]);

function operationHealthKey(operation: LocalOperation): string {
  if (expenseOperationTypes.has(operation.type)) return `expense:${operation.targetId}`;
  if (operation.type === "GroupCurrencyChanged") return `group-currency:${operation.groupId}`;
  if (operation.type === "PaymentRecorded" || operation.type === "PaymentReversed") return `payment:${operation.targetId}`;
  return `operation:${operation.id}`;
}

export function summarizeOperationHealth(
  operations: readonly LocalOperation[],
  groupId: string,
): OperationHealth {
  const latestBySubject = new Map<string, LocalOperation>();
  for (const operation of operations) {
    if (operation.groupId !== groupId) continue;
    const key = operationHealthKey(operation);
    const current = latestBySubject.get(key);
    if (!current || current.clientTimestamp < operation.clientTimestamp || (current.clientTimestamp === operation.clientTimestamp && current.id < operation.id)) {
      latestBySubject.set(key, operation);
    }
  }
  const current = [...latestBySubject.values()];
  return {
    pending: current.filter((operation) => operation.syncStatus === "pending").length,
    attention: current.filter((operation) => operation.syncStatus === "conflicted" || operation.syncStatus === "rejected").length,
  };
}

export function settlementBlockerCount(
  expenses: readonly LocalExpense[],
  operations: readonly LocalOperation[],
  groupId: string,
  currency: string,
): number {
  const expensesById = new Map(
    expenses
      .filter((expense) => expense.groupId === groupId && expense.currency === currency)
      .map((expense) => [expense.id, expense]),
  );
  return new Set(
    operations
      .filter((operation) =>
        operation.groupId === groupId &&
        expenseOperationTypes.has(operation.type) &&
        (operation.syncStatus === "conflicted" || operation.syncStatus === "rejected") &&
        expensesById.has(operation.targetId),
      )
      .map((operation) => operation.targetId),
  ).size;
}

function previousCalendarMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function describeExpenseOutcome(actorPaidMinor: number, actorShareMinor: number): ExpenseOutcome {
  const difference = actorPaidMinor - actorShareMinor;
  return {
    actorPaidMinor,
    actorShareMinor,
    direction: difference > 0 ? "back" : difference < 0 ? "owe" : "even",
    differenceMinor: Math.abs(difference),
  };
}

export function buildGroupReconciliation(
  expenses: readonly LocalExpense[],
  operations: readonly LocalOperation[],
  groupId: string,
  currency: string,
  actorId: string,
): GroupReconciliation {
  const insight = buildGroupInsights(expenses.filter((expense) => expense.groupId === groupId), currency, actorId);
  const payments = activePayments(operations, groupId, currency).filter((payment) => {
    const data = operationPayload(payment);
    return data.payerId === actorId || data.recipientId === actorId;
  });
  let paymentsSentMinor = 0;
  let paymentsReceivedMinor = 0;
  for (const payment of payments) {
    const data = operationPayload(payment);
    const amountMinor = Number(data.amountMinor);
    if (!Number.isFinite(amountMinor)) continue;
    if (data.payerId === actorId) paymentsSentMinor += amountMinor;
    if (data.recipientId === actorId) paymentsReceivedMinor += amountMinor;
  }
  let importedBalanceMinor = 0;
  for (const operation of activeImportedTransactions(operations, groupId, currency)) {
    const data = operationPayload(operation);
    if (!Array.isArray(data.effects)) continue;
    for (const value of data.effects) {
      const effect = value as { participantId?: unknown; amountMinor?: unknown };
      if (effect.participantId === actorId && Number.isSafeInteger(effect.amountMinor)) {
        importedBalanceMinor += Number(effect.amountMinor);
      }
    }
  }
  return {
    paidByYouMinor: insight.paidByYouMinor,
    yourShareMinor: insight.yourShareMinor,
    paymentsSentMinor,
    paymentsReceivedMinor,
    balanceMinor: insight.paidByYouMinor - insight.yourShareMinor + paymentsSentMinor - paymentsReceivedMinor + importedBalanceMinor,
    expenseCount: insight.expenseCount,
    paymentCount: payments.length,
  };
}

export function buildGroupInsights(
  expenses: readonly LocalExpense[],
  currency: string,
  actorId: string,
): GroupInsights {
  const included = expenses.filter(
    (expense) =>
      expense.status === "active" &&
      expense.currency === currency &&
      expense.syncStatus !== "rejected" &&
      expense.syncStatus !== "conflicted",
  );
  const totalMinor = included.reduce((sum, expense) => sum + expense.amountMinor, 0);
  const yourShareMinor = included.reduce(
    (sum, expense) => sum + (expense.allocations.find((allocation) => allocation.participantId === actorId)?.amountMinor ?? 0),
    0,
  );
  const paidByYouMinor = included.reduce(
    (sum, expense) => sum + (expense.payers.find((payer) => payer.participantId === actorId)?.amountMinor ?? 0),
    0,
  );

  const categories = new Map<string, number>();
  const months = new Map<string, number>();
  for (const expense of included) {
    categories.set(expense.category, (categories.get(expense.category) ?? 0) + expense.amountMinor);
    const month = expense.expenseDate.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + expense.amountMinor);
  }

  const categoryBreakdown = [...categories]
    .map(([name, amountMinor]) => ({
      name,
      amountMinor,
      percentage: totalMinor === 0 ? 0 : Math.round((amountMinor / totalMinor) * 100),
    }))
    .sort((left, right) => right.amountMinor - left.amountMinor || left.name.localeCompare(right.name));
  const monthlyTotals = [...months]
    .map(([month, amountMinor]) => ({ month, amountMinor }))
    .sort((left, right) => left.month.localeCompare(right.month));

  const current = monthlyTotals.at(-1);
  const previousMonth = current ? previousCalendarMonth(current.month) : undefined;
  const previous = previousMonth ? monthlyTotals.find((entry) => entry.month === previousMonth) : undefined;
  const monthTrend = current && previous
    ? {
        currentMonth: current.month,
        currentMinor: current.amountMinor,
        previousMonth: previous.month,
        previousMinor: previous.amountMinor,
        differenceMinor: current.amountMinor - previous.amountMinor,
        percentageChange: previous.amountMinor === 0 ? 0 : Math.round(((current.amountMinor - previous.amountMinor) / previous.amountMinor) * 100),
      }
    : undefined;

  return {
    totalMinor,
    yourShareMinor,
    paidByYouMinor,
    expenseCount: included.length,
    averageMinor: included.length === 0 ? 0 : Math.round(totalMinor / included.length),
    topCategory: categoryBreakdown[0],
    monthTrend,
    categoryBreakdown,
    monthlyTotals,
  };
}
