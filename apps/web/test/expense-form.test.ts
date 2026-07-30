import { describe, expect, test } from "bun:test";
import { validateExpenseForm } from "../src/lib/expense-form";

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
