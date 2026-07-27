import { describe, expect, test } from "bun:test";
import { calculateExpenseAllocations, calculateExpensePayers } from "../src/lib/store";

describe("expense split allocations", () => {
  test("distributes an equal split deterministically", () => {
    expect(calculateExpenseAllocations({
      amount: "10.00",
      participantIds: ["a", "b", "c"],
      splitMethod: "equal",
      splitValues: {},
    })).toEqual([
      { participantId: "a", amountMinor: 334 },
      { participantId: "b", amountMinor: 333 },
      { participantId: "c", amountMinor: 333 },
    ]);
  });

  test("accepts exact amounts that total the expense", () => {
    expect(calculateExpenseAllocations({
      amount: "42.75",
      participantIds: ["a", "b"],
      splitMethod: "exact",
      splitValues: { a: "40.00", b: "2.75" },
    })).toEqual([
      { participantId: "a", amountMinor: 4000 },
      { participantId: "b", amountMinor: 275 },
    ]);
  });

  test("requires percentages to total one hundred", () => {
    expect(() => calculateExpenseAllocations({
      amount: "20.00",
      participantIds: ["a", "b"],
      splitMethod: "percentage",
      splitValues: { a: "60", b: "30" },
    })).toThrow();
  });

  test("allocates by whole-number shares", () => {
    expect(calculateExpenseAllocations({
      amount: "12.00",
      participantIds: ["a", "b"],
      splitMethod: "shares",
      splitValues: { a: "1", b: "3" },
    })).toEqual([
      { participantId: "a", amountMinor: 300 },
      { participantId: "b", amountMinor: 900 },
    ]);
  });

  test("applies adjustments before sharing the remainder", () => {
    expect(calculateExpenseAllocations({
      amount: "30.00",
      participantIds: ["a", "b", "c"],
      splitMethod: "adjustment",
      splitValues: { a: "3.00", b: "0", c: "-3.00" },
    })).toEqual([
      { participantId: "a", amountMinor: 1300 },
      { participantId: "b", amountMinor: 1000 },
      { participantId: "c", amountMinor: 700 },
    ]);
  });

  test("requires multiple payer amounts to equal the expense", () => {
    expect(calculateExpensePayers({
      amount: "42.75",
      payerIds: ["a", "b"],
      payerValues: { a: "20.00", b: "22.75" },
    })).toEqual([
      { participantId: "a", amountMinor: 2000 },
      { participantId: "b", amountMinor: 2275 },
    ]);
    expect(() => calculateExpensePayers({
      amount: "42.75",
      payerIds: ["a", "b"],
      payerValues: { a: "20.00", b: "20.00" },
    })).toThrow();
  });
});
