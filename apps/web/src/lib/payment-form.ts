import { parseDecimalToMinor } from "@expenses/protocol";

export type PaymentFormField = "amount" | "participants";

export interface PaymentFormIssue {
  field: PaymentFormField;
  message: string;
}

export function validatePaymentForm(input: {
  amount: string;
  payerId: string;
  recipientId: string;
}): PaymentFormIssue | undefined {
  try {
    parseDecimalToMinor(input.amount);
  } catch {
    return { field: "amount", message: "Enter a payment amount greater than zero." };
  }
  if (!input.payerId || !input.recipientId || input.payerId === input.recipientId) {
    return { field: "participants", message: "Choose two different people." };
  }
  return undefined;
}
