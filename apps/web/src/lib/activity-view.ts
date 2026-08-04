import type { JsonValue } from "@expenses/protocol";
import type { LocalOperation } from "./db";

export interface PaymentActivityDetails {
  payerId: string;
  recipientId: string;
  amountMinor: number;
  currency: string;
  paymentDate?: string;
  note?: string;
}

export function paymentActivityDetails(
  operation: Pick<LocalOperation, "type" | "payload">,
): PaymentActivityDetails | undefined {
  if (operation.type !== "PaymentRecorded") return undefined;
  const payload = operation.payload as Record<string, JsonValue>;
  const payerId = typeof payload.payerId === "string" ? payload.payerId : "";
  const recipientId = typeof payload.recipientId === "string" ? payload.recipientId : "";
  const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : Number.NaN;
  const currency = typeof payload.currency === "string" ? payload.currency : "";
  if (!payerId || !recipientId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return {
    payerId,
    recipientId,
    amountMinor,
    currency,
    ...(typeof payload.paymentDate === "string" ? { paymentDate: payload.paymentDate } : {}),
    ...(typeof payload.note === "string" && payload.note.trim() ? { note: payload.note.trim() } : {}),
  };
}
