import { describe, expect, test } from "bun:test";
import { normalizeExpenseAmountInput, validateExpenseForm } from "../src/lib/expense-form";

const valid = {
  amount: "42.50",
  description: "Dinner",
  payersValid: true,
  allocationsValid: true,
};

describe("expense form validation", () => {
  test("accepts a complete expense", () => {
    expect(validateExpenseForm(valid)).toBeUndefined();
  });

  test("reports issues in the order users encounter the form", () => {
    expect(validateExpenseForm({ ...valid, amount: "0", description: "", payersValid: false, allocationsValid: false })).toEqual({
      field: "amount",
      message: "Enter an amount greater than 0.",
    });
    expect(validateExpenseForm({ ...valid, description: "   ", payersValid: false, allocationsValid: false })).toEqual({
      field: "description",
      message: "Add what this was for.",
    });
    expect(validateExpenseForm({ ...valid, payersValid: false, allocationsValid: false })).toEqual({
      field: "payer",
      message: "Choose who paid and make sure the amounts equal the total.",
    });
    expect(validateExpenseForm({ ...valid, allocationsValid: false })).toEqual({
      field: "split",
      message: "Finish the split so the full amount is assigned.",
    });
  });

  test("rejects non-numeric and negative totals", () => {
    expect(validateExpenseForm({ ...valid, amount: "ramen" })?.field).toBe("amount");
    expect(validateExpenseForm({ ...valid, amount: "-2" })?.field).toBe("amount");
  });
});

describe("formatted expense amount input", () => {
  test("keeps grouped whole amounts when pasting", () => {
    expect(normalizeExpenseAmountInput("1,000")).toBe("1000");
    expect(normalizeExpenseAmountInput("1.000")).toBe("1000");
  });

  test("accepts either common decimal separator convention", () => {
    expect(normalizeExpenseAmountInput("1,234.56")).toBe("1234.56");
    expect(normalizeExpenseAmountInput("1.234,56")).toBe("1234.56");
    expect(normalizeExpenseAmountInput("$ 1 234,50")).toBe("1234.50");
  });

  test("does not turn an over-precise formatted decimal into a larger amount", () => {
    expect(normalizeExpenseAmountInput("1,234.567")).toBe("1234.56");
    expect(normalizeExpenseAmountInput("1234,567")).toBe("1234.56");
  });

  test("does not silently truncate a large typed amount", () => {
    expect(normalizeExpenseAmountInput("999999999")).toBe("999999999");
    expect(validateExpenseForm({ ...valid, amount: "999999999" })).toEqual({
      field: "amount",
      message: "Enter an amount up to 9,999,999.99.",
    });
  });
});
