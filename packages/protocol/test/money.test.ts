import { describe, expect, test } from "bun:test";
import {
  allocateByWeights,
  allocateEqually,
  calculateNetBalances,
  computeBalances,
  parseDecimalToMinor,
  validateExactAllocation,
} from "../src/money";

describe("money allocation", () => {
  test("splits $10.01 equally without losing a cent", () => {
    expect(allocateEqually(1001, ["a", "b"])).toEqual([
      { participantId: "a", amountMinor: 501 },
      { participantId: "b", amountMinor: 500 },
    ]);
  });

  test("parses decimal money without floating-point rounding", () => {
    expect(parseDecimalToMinor("10.01")).toBe(1001);
    expect(() => parseDecimalToMinor("10.001")).toThrow("at most 2 decimal places");
  });

  test("uses stable participant order for weighted rounding", () => {
    expect(
      allocateByWeights(100, [
        { participantId: "a", weight: 1 },
        { participantId: "b", weight: 1 },
        { participantId: "c", weight: 1 },
      ]),
    ).toEqual([
      { participantId: "a", amountMinor: 34 },
      { participantId: "b", amountMinor: 33 },
      { participantId: "c", amountMinor: 33 },
    ]);
  });

  test("validates basis-point percentages", () => {
    expect(() =>
      allocateByWeights(
        1000,
        [
          { participantId: "a", weight: 5000 },
          { participantId: "b", weight: 4999 },
        ],
        10_000,
      ),
    ).toThrow("Weights must total 10000");
  });

  test("rejects invalid exact totals", () => {
    expect(() =>
      validateExactAllocation(1000, [
        { participantId: "a", amountMinor: 400 },
        { participantId: "b", amountMinor: 500 },
      ]),
    ).toThrow("expected 1000");
  });

  test("calculates paid minus allocated net", () => {
    expect(
      calculateNetBalances(
        [{ participantId: "a", amountMinor: 1001 }],
        allocateEqually(1001, ["a", "b"]),
      ),
    ).toEqual([
      { participantId: "a", amountMinor: 500 },
      { participantId: "b", amountMinor: -500 },
    ]);
  });
});

describe("scoped balances", () => {
  const dinner = {
    groupId: "trip",
    currency: "USD",
    payers: [{ participantId: "a", amountMinor: 1001 }],
    allocations: allocateEqually(1001, ["a", "b"]),
  };

  test("never combines different currencies in the same group", () => {
    const scopes = computeBalances([
      dinner,
      { ...dinner, currency: "EUR", payers: [{ participantId: "b", amountMinor: 800 }], allocations: allocateEqually(800, ["a", "b"]) },
    ]);
    expect(scopes.map(({ groupId, currency }) => ({ groupId, currency }))).toEqual([
      { groupId: "trip", currency: "EUR" },
      { groupId: "trip", currency: "USD" },
    ]);
  });

  test("never combines different groups in the same currency", () => {
    const scopes = computeBalances([dinner, { ...dinner, groupId: "flat" }]);
    expect(scopes).toHaveLength(2);
    expect(scopes.every((scope) => scope.pairwise.length === 1)).toBe(true);
  });

  test("attributes a single-payer expense entirely to that payer", () => {
    const [scope] = computeBalances([dinner]);
    expect(scope?.pairwise).toEqual([{ debtorId: "b", creditorId: "a", amountMinor: 500 }]);
    expect(scope?.net).toEqual([
      { participantId: "a", amountMinor: 500 },
      { participantId: "b", amountMinor: -500 },
    ]);
  });

  test("splits an ower's share across multiple payers without losing a minor unit", () => {
    const [scope] = computeBalances([
      {
        groupId: "trip",
        currency: "USD",
        payers: [
          { participantId: "a", amountMinor: 50 },
          { participantId: "b", amountMinor: 51 },
        ],
        allocations: [{ participantId: "c", amountMinor: 101 }],
      },
    ]);
    const owedByC = scope?.pairwise.filter(({ debtorId }) => debtorId === "c") ?? [];
    expect(owedByC.reduce((sum, debt) => sum + debt.amountMinor, 0)).toBe(101);
  });

  test("nets opposing debts between the same two people", () => {
    const [scope] = computeBalances([
      dinner,
      {
        groupId: "trip",
        currency: "USD",
        payers: [{ participantId: "b", amountMinor: 300 }],
        allocations: [{ participantId: "a", amountMinor: 300 }],
      },
    ]);
    expect(scope?.pairwise).toEqual([{ debtorId: "b", creditorId: "a", amountMinor: 200 }]);
  });

  test("a settlement reduces the debt it repays and clears the balance exactly", () => {
    const [scope] = computeBalances(
      [dinner],
      [{ groupId: "trip", currency: "USD", payerId: "b", recipientId: "a", amountMinor: 500 }],
    );
    expect(scope?.pairwise).toEqual([]);
    expect(scope?.net).toEqual([
      { participantId: "a", amountMinor: 0 },
      { participantId: "b", amountMinor: 0 },
    ]);
  });

  test("an overpayment flips who owes whom", () => {
    const [scope] = computeBalances(
      [dinner],
      [{ groupId: "trip", currency: "USD", payerId: "b", recipientId: "a", amountMinor: 700 }],
    );
    expect(scope?.pairwise).toEqual([{ debtorId: "a", creditorId: "b", amountMinor: 200 }]);
  });

  test("a settlement in one scope leaves other scopes untouched", () => {
    const scopes = computeBalances(
      [dinner, { ...dinner, groupId: "flat" }],
      [{ groupId: "trip", currency: "USD", payerId: "b", recipientId: "a", amountMinor: 500 }],
    );
    expect(scopes.find((scope) => scope.groupId === "trip")?.pairwise).toEqual([]);
    expect(scopes.find((scope) => scope.groupId === "flat")?.pairwise).toEqual([
      { debtorId: "b", creditorId: "a", amountMinor: 500 },
    ]);
  });

  test("rejects a settlement that pays the person who made it", () => {
    expect(() =>
      computeBalances([], [{ groupId: "trip", currency: "USD", payerId: "a", recipientId: "a", amountMinor: 100 }]),
    ).toThrow("same payer and recipient");
  });
});
