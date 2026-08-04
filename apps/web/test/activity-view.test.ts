import { describe, expect, test } from "bun:test";
import { paymentActivityDetails } from "../src/lib/activity-view";

describe("activity payment details", () => {
  test("exposes the people, amount, currency, date, and note for an auditable payment", () => {
    expect(paymentActivityDetails({
      type: "PaymentRecorded",
      payload: { payerId: "alex", recipientId: "ananya", amountMinor: 3050, currency: "USD", paymentDate: "2026-07-30", note: "Paid by bank" },
    })).toEqual({ payerId: "alex", recipientId: "ananya", amountMinor: 3050, currency: "USD", paymentDate: "2026-07-30", note: "Paid by bank" });
  });

  test("ignores unrelated or malformed operations", () => {
    expect(paymentActivityDetails({ type: "ExpenseCreated", payload: {} })).toBeUndefined();
    expect(paymentActivityDetails({ type: "PaymentRecorded", payload: { amountMinor: 0 } })).toBeUndefined();
  });
});
