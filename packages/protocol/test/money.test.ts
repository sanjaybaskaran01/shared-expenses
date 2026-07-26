import { describe, expect, test } from "bun:test";
import {
  allocateByWeights,
  allocateEqually,
  calculateNetBalances,
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
