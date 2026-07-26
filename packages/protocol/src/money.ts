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
