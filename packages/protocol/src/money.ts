export interface WeightedParticipant {
  participantId: string;
  weight: number;
}

export interface ParticipantAmount {
  participantId: string;
  amountMinor: number;
}

export function parseDecimalToMinor(value: string, fractionDigits = 2): number {
  if (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 6) {
    throw new RangeError("fractionDigits must be an integer from 0 through 6");
  }
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(normalized);
  if (!match) throw new RangeError("Enter a positive decimal amount");
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  if (fraction.length > fractionDigits) throw new RangeError(`Use at most ${fractionDigits} decimal places`);
  const amount = Number(whole) * 10 ** fractionDigits + Number(fraction.padEnd(fractionDigits, "0") || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError("Amount is outside the supported range");
  return amount;
}

function assertMinorUnits(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError("Money amounts must be non-negative safe integers in minor units");
  }
}

function assertUnique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new RangeError("Participant identifiers must be unique");
  }
}

export function allocateEqually(
  amountMinor: number,
  participantIds: readonly string[],
): ParticipantAmount[] {
  assertMinorUnits(amountMinor);
  if (participantIds.length === 0) throw new RangeError("At least one participant is required");
  assertUnique(participantIds);

  const base = Math.floor(amountMinor / participantIds.length);
  let remainder = amountMinor % participantIds.length;
  return participantIds.map((participantId) => ({
    participantId,
    amountMinor: base + (remainder-- > 0 ? 1 : 0),
  }));
}

export function allocateByWeights(
  amountMinor: number,
  participants: readonly WeightedParticipant[],
  expectedWeightTotal?: number,
): ParticipantAmount[] {
  assertMinorUnits(amountMinor);
  if (participants.length === 0) throw new RangeError("At least one participant is required");
  assertUnique(participants.map(({ participantId }) => participantId));

  const totalWeight = participants.reduce((sum, item) => {
    if (!Number.isSafeInteger(item.weight) || item.weight < 0) {
      throw new RangeError("Weights must be non-negative safe integers");
    }
    return sum + item.weight;
  }, 0);

  if (totalWeight <= 0) throw new RangeError("The total weight must be positive");
  if (expectedWeightTotal !== undefined && totalWeight !== expectedWeightTotal) {
    throw new RangeError(`Weights must total ${expectedWeightTotal}`);
  }

  const allocations = participants.map(({ participantId, weight }) => ({
    participantId,
    amountMinor: Math.floor((amountMinor * weight) / totalWeight),
  }));
  let remainder = amountMinor - allocations.reduce((sum, item) => sum + item.amountMinor, 0);
  for (const allocation of allocations) {
    if (remainder === 0) break;
    allocation.amountMinor += 1;
    remainder -= 1;
  }
  return allocations;
}

export function validateExactAllocation(
  amountMinor: number,
  allocations: readonly ParticipantAmount[],
): ParticipantAmount[] {
  assertMinorUnits(amountMinor);
  assertUnique(allocations.map(({ participantId }) => participantId));
  for (const allocation of allocations) assertMinorUnits(allocation.amountMinor);
  const allocated = allocations.reduce((sum, item) => sum + item.amountMinor, 0);
  if (allocated !== amountMinor) {
    throw new RangeError(`Allocations total ${allocated}, expected ${amountMinor}`);
  }
  return [...allocations];
}

export function calculateNetBalances(
  payers: readonly ParticipantAmount[],
  allocations: readonly ParticipantAmount[],
): ParticipantAmount[] {
  const balances = new Map<string, number>();
  for (const { participantId, amountMinor } of payers) {
    assertMinorUnits(amountMinor);
    balances.set(participantId, (balances.get(participantId) ?? 0) + amountMinor);
  }
  for (const { participantId, amountMinor } of allocations) {
    assertMinorUnits(amountMinor);
    balances.set(participantId, (balances.get(participantId) ?? 0) - amountMinor);
  }
  return [...balances.entries()].map(([participantId, amountMinor]) => ({
    participantId,
    amountMinor,
  }));
}

/**
 * Balances are only meaningful within a single group and a single currency.
 * Summing across either produces a number that looks authoritative and is not.
 */
export interface BalanceScope {
  groupId: string;
  currency: string;
}

export interface BalanceExpense extends BalanceScope {
  payers: readonly ParticipantAmount[];
  allocations: readonly ParticipantAmount[];
}

/** An out-of-app transfer: `payerId` handed `amountMinor` to `recipientId`. */
export interface BalanceSettlement extends BalanceScope {
  payerId: string;
  recipientId: string;
  amountMinor: number;
}

export interface PairwiseDebt {
  debtorId: string;
  creditorId: string;
  amountMinor: number;
}

export interface ScopedBalance extends BalanceScope {
  /** Positive means the participant should receive money. */
  net: ParticipantAmount[];
  /** Netted, positive-only edges. Never simplified across third parties. */
  pairwise: PairwiseDebt[];
}

// NUL cannot occur in a group id, ISO currency code, or participant id.
const SCOPE_SEPARATOR = "\u0000";

function joinKey(left: string, right: string): string {
  return `${left}${SCOPE_SEPARATOR}${right}`;
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(SCOPE_SEPARATOR);
  return [key.slice(0, index), key.slice(index + 1)];
}

/**
 * Who owes whom for a single expense. Each ower's share is attributed to the
 * people who actually paid, split by how much each of them put in. With one
 * payer this is exact; with several, `allocateByWeights` keeps the minor units
 * summing to the ower's full share.
 */
export function expensePairwiseDebts(expense: BalanceExpense): PairwiseDebt[] {
  const payers = expense.payers.filter(({ amountMinor }) => amountMinor > 0);
  if (payers.length === 0) return [];
  const debts: PairwiseDebt[] = [];
  for (const { participantId: debtorId, amountMinor } of expense.allocations) {
    assertMinorUnits(amountMinor);
    if (amountMinor === 0) continue;
    const shares =
      payers.length === 1
        ? [{ participantId: payers[0]!.participantId, amountMinor }]
        : allocateByWeights(
            amountMinor,
            payers.map(({ participantId, amountMinor: paid }) => ({ participantId, weight: paid })),
          );
    for (const share of shares) {
      if (share.amountMinor === 0 || share.participantId === debtorId) continue;
      debts.push({ debtorId, creditorId: share.participantId, amountMinor: share.amountMinor });
    }
  }
  return debts;
}

/**
 * Net positions and pairwise debts, partitioned by group and currency.
 * Settlements reduce the debt they repay; they never move value between scopes.
 */
export function computeBalances(
  expenses: readonly BalanceExpense[],
  settlements: readonly BalanceSettlement[] = [],
): ScopedBalance[] {
  const nets = new Map<string, Map<string, number>>();
  const directed = new Map<string, Map<string, number>>();

  const scopeOf = (map: Map<string, Map<string, number>>, scope: BalanceScope): Map<string, number> => {
    const key = joinKey(scope.groupId, scope.currency);
    let existing = map.get(key);
    if (!existing) {
      existing = new Map<string, number>();
      map.set(key, existing);
    }
    return existing;
  };

  for (const expense of expenses) {
    const net = scopeOf(nets, expense);
    for (const entry of calculateNetBalances(expense.payers, expense.allocations)) {
      net.set(entry.participantId, (net.get(entry.participantId) ?? 0) + entry.amountMinor);
    }
    const edges = scopeOf(directed, expense);
    for (const debt of expensePairwiseDebts(expense)) {
      const key = joinKey(debt.debtorId, debt.creditorId);
      edges.set(key, (edges.get(key) ?? 0) + debt.amountMinor);
    }
  }

  for (const settlement of settlements) {
    assertMinorUnits(settlement.amountMinor);
    if (settlement.payerId === settlement.recipientId) {
      throw new RangeError("A settlement cannot have the same payer and recipient");
    }
    const net = scopeOf(nets, settlement);
    net.set(settlement.payerId, (net.get(settlement.payerId) ?? 0) + settlement.amountMinor);
    net.set(settlement.recipientId, (net.get(settlement.recipientId) ?? 0) - settlement.amountMinor);
    const edges = scopeOf(directed, settlement);
    const key = joinKey(settlement.payerId, settlement.recipientId);
    edges.set(key, (edges.get(key) ?? 0) - settlement.amountMinor);
  }

  const scopeKeys = [...new Set([...nets.keys(), ...directed.keys()])].sort();
  return scopeKeys.map((scopeKey) => {
    const [groupId, currency] = splitKey(scopeKey);
    const net = [...(nets.get(scopeKey) ?? new Map<string, number>()).entries()]
      .map(([participantId, amountMinor]) => ({ participantId, amountMinor }))
      .sort((left, right) => left.participantId.localeCompare(right.participantId));

    const edges = directed.get(scopeKey) ?? new Map<string, number>();
    const seen = new Set<string>();
    const pairwise: PairwiseDebt[] = [];
    for (const key of [...edges.keys()].sort()) {
      const [debtorId, creditorId] = splitKey(key);
      const unordered = debtorId < creditorId ? joinKey(debtorId, creditorId) : joinKey(creditorId, debtorId);
      if (seen.has(unordered)) continue;
      seen.add(unordered);
      const balance = (edges.get(joinKey(debtorId, creditorId)) ?? 0) - (edges.get(joinKey(creditorId, debtorId)) ?? 0);
      if (balance > 0) pairwise.push({ debtorId, creditorId, amountMinor: balance });
      else if (balance < 0) pairwise.push({ debtorId: creditorId, creditorId: debtorId, amountMinor: -balance });
    }
    return { groupId, currency, net, pairwise };
  });
}
