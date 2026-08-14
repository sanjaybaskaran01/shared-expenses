export type ExpenseFormField = "amount" | "description" | "payer" | "split";

export interface ExpenseFormIssue {
  field: ExpenseFormField;
  message: string;
}

export const maximumExpenseWholeDigits = 7;
const maximumFractionDigits = 2;

function isValidGroupedInteger(value: string, separator: string): boolean {
  const groups = value.split(separator);
  return groups.length > 1
    && /^\d{1,3}$/.test(groups[0] ?? "")
    && groups.slice(1).every((group) => /^\d{3}$/.test(group));
}

/**
 * Converts a pasted, human-formatted monetary value into the decimal format
 * accepted by the expense form. A trailing three-digit group is treated as a
 * thousands separator, while the right-most separator in a mixed format is
 * treated as the decimal separator.
 */
export function normalizeExpenseAmountInput(value: string): string {
  const input = value.replace(/[^\d.,]/g, "");
  if (!input) return "";

  const lastComma = input.lastIndexOf(",");
  const lastPeriod = input.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastPeriod);
  if (decimalIndex === -1) return input;

  const fraction = input.slice(decimalIndex + 1).replace(/[.,]/g, "");
  const hasBothSeparators = lastComma !== -1 && lastPeriod !== -1;

  const decimalSeparator = input[decimalIndex] ?? "";

  // Treat a long fraction as grouping only when its groups are valid. This
  // preserves a value such as "1,000" without silently magnifying malformed
  // input such as "1234,567". With both separator types present, the
  // right-most one unambiguously denotes the decimal portion.
  if (
    !hasBothSeparators
    && fraction.length > maximumFractionDigits
    && isValidGroupedInteger(input, decimalSeparator)
  ) {
    return input.replace(/[.,]/g, "");
  }

  const whole = input.slice(0, decimalIndex).replace(/[.,]/g, "") || "0";
  return `${whole}.${fraction.slice(0, maximumFractionDigits)}`;
}

interface ExpenseFormValidationInput {
  amount: string;
  description: string;
  payersValid: boolean;
  allocationsValid: boolean;
}

export function validateExpenseForm(input: ExpenseFormValidationInput): ExpenseFormIssue | undefined {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { field: "amount", message: "Enter an amount greater than 0." };
  }
  const wholeDigits = (input.amount.split(".", 1)[0] ?? "").replace(/^0+/, "").length;
  if (wholeDigits > maximumExpenseWholeDigits) {
    return {
      field: "amount",
      message: "Enter an amount up to 9,999,999.99.",
    };
  }
  if (!input.description.trim()) {
    return { field: "description", message: "Add what this was for." };
  }
  if (!input.payersValid) {
    return { field: "payer", message: "Choose who paid and make sure the amounts equal the total." };
  }
  if (!input.allocationsValid) {
    return { field: "split", message: "Finish the split so the full amount is assigned." };
  }
  return undefined;
}
