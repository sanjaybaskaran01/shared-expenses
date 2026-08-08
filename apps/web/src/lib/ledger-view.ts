import type { JsonValue } from "@expenses/protocol";
import type { LocalExpense, LocalGroup, LocalMember, LocalOperation } from "./db";

export interface Settlement {
  payerId: string;
  recipientId: string;
  amountMinor: number;
}

export interface RelationshipBalance {
  userId: string;
  currency: string;
  amountMinor: number;
  groupIds: string[];
}

export function operationPayload(operation: LocalOperation): Record<string, JsonValue> {
  const data = operation.payload as Record<string, JsonValue>;
  const aliases = operation.participantAliases;
  if (!aliases) return data;
  const resolve = (value: JsonValue | undefined): JsonValue | undefined =>
    typeof value === "string" ? aliases[value] ?? value : value;
  return {
    ...data,
    ...(data.payerId !== undefined ? { payerId: resolve(data.payerId)! } : {}),
    ...(data.recipientId !== undefined ? { recipientId: resolve(data.recipientId)! } : {}),
    ...(Array.isArray(data.effects) ? {
      effects: data.effects.map((effect) => {
        if (!effect || typeof effect !== "object" || Array.isArray(effect)) return effect;
        const participantId = resolve(effect.participantId);
        return { ...effect, ...(participantId !== undefined ? { participantId } : {}) };
      }),
    } : {}),
  };
}

export function activePayments(operations: readonly LocalOperation[], groupId?: string, currency?: string): LocalOperation[] {
  const reversed = new Set(operations.filter((operation) => operation.type === "PaymentReversed").map((operation) => operation.targetId));
  return operations.filter((operation) => {
    if (operation.type !== "PaymentRecorded" || reversed.has(operation.targetId) || operation.syncStatus === "rejected" || operation.syncStatus === "conflicted") return false;
    const data = operationPayload(operation);
    return (!groupId || operation.groupId === groupId) && (!currency || String(data.currency) === currency);
  });
}

export function activeImportedTransactions(
  operations: readonly LocalOperation[],
  groupId?: string,
  currency?: string,
): LocalOperation[] {
  const voided = new Set(
    operations
      .filter((operation) => operation.type === "ImportedTransactionVoided" || operation.type === "OpeningBalanceVoided")
      .map((operation) => operation.targetId),
  );
  return operations.filter((operation) => {
    if (
      (operation.type !== "ImportedTransactionRecorded" && operation.type !== "OpeningBalanceCreated") ||
      voided.has(operation.targetId) ||
      operation.syncStatus === "rejected" ||
      operation.syncStatus === "conflicted"
    ) return false;
    const data = operationPayload(operation);
    const metadata = data.import;
    const sourceDeleted = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, JsonValue>).sourceDeleted === true
      : false;
    return !sourceDeleted && (!groupId || operation.groupId === groupId) && (!currency || String(data.currency) === currency);
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
    const data = operationPayload(operation);
    const amountMinor = Number(data.amountMinor);
    add(String(data.payerId), amountMinor);
    add(String(data.recipientId), -amountMinor);
  }
  for (const operation of activeImportedTransactions(operations, groupId, currency)) {
    const effects = operationPayload(operation).effects;
    if (!Array.isArray(effects)) continue;
    for (const value of effects) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const effect = value as Record<string, JsonValue>;
      if (typeof effect.participantId === "string" && Number.isSafeInteger(effect.amountMinor)) {
        add(effect.participantId, Number(effect.amountMinor));
      }
    }
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

/**
 * Projects the immutable, group-scoped ledger into the current user's
 * cross-group relationships. Positive means the other person owes the actor;
 * negative means the actor owes them. Currencies intentionally remain separate.
 */
export function computeRelationshipBalances(
  expenses: readonly LocalExpense[],
  operations: readonly LocalOperation[],
  groups: readonly LocalGroup[],
  members: readonly LocalMember[],
  actorId: string,
): RelationshipBalance[] {
  const totals = new Map<string, RelationshipBalance>();

  for (const group of groups) {
    const groupUserIds = new Set(
      members
        .filter((member) => member.groupId === group.id && (member.status === "active" || member.status === "placeholder"))
        .map((member) => member.userId),
    );
    if (!groupUserIds.has(actorId)) continue;

    const currencies = new Set<string>([group.settlementCurrency]);
    for (const expense of expenses) {
      if (expense.groupId === group.id && expense.status === "active") currencies.add(expense.currency);
    }
    for (const operation of activePayments(operations, group.id)) {
      currencies.add(String(operationPayload(operation).currency));
    }
    for (const operation of activeImportedTransactions(operations, group.id)) {
      currencies.add(String(operationPayload(operation).currency));
    }

    for (const currency of currencies) {
      const settlements = simplifyBalances(computeBalances(expenses, operations, group.id, currency));
      for (const settlement of settlements) {
        let userId: string | undefined;
        let amountMinor = 0;
        if (settlement.recipientId === actorId) {
          userId = settlement.payerId;
          amountMinor = settlement.amountMinor;
        } else if (settlement.payerId === actorId) {
          userId = settlement.recipientId;
          amountMinor = -settlement.amountMinor;
        }
        if (!userId || !groupUserIds.has(userId)) continue;

        const key = `${userId}\u0000${currency}`;
        const current = totals.get(key);
        if (current) {
          current.amountMinor += amountMinor;
          if (!current.groupIds.includes(group.id)) current.groupIds.push(group.id);
        } else {
          totals.set(key, { userId, currency, amountMinor, groupIds: [group.id] });
        }
      }
    }
  }

  return [...totals.values()]
    .filter((item) => item.amountMinor !== 0)
    .sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor) || a.userId.localeCompare(b.userId) || a.currency.localeCompare(b.currency));
}

export function expenseComments(operations: readonly LocalOperation[], expenseId: string): LocalOperation[] {
  return operations.filter((operation) => operation.type === "CommentAdded" && operation.targetId === expenseId && operation.syncStatus !== "rejected")
    .sort((a, b) => a.clientTimestamp.localeCompare(b.clientTimestamp));
}
