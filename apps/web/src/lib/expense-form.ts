export type ExpenseFormField = "amount" | "description" | "payer" | "split";

export interface ExpenseFormIssue {
  field: ExpenseFormField;
  message: string;
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
