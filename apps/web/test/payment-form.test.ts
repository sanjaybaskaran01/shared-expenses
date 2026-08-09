import { describe, expect, test } from "bun:test";
import { validatePaymentForm } from "../src/lib/payment-form";

describe("payment form validation", () => {
  test("rejects a cleared, zero, or malformed amount before recording", () => {
    expect(validatePaymentForm({ amount: "", payerId: "a", recipientId: "b" })).toEqual({
      field: "amount",
      message: "Enter a payment amount greater than zero.",
    });
    expect(validatePaymentForm({ amount: "0", payerId: "a", recipientId: "b" })?.field).toBe("amount");
    expect(validatePaymentForm({ amount: "not money", payerId: "a", recipientId: "b" })?.field).toBe("amount");
  });

  test("requires two different participants", () => {
    expect(validatePaymentForm({ amount: "12.50", payerId: "", recipientId: "b" })?.field).toBe("participants");
    expect(validatePaymentForm({ amount: "12.50", payerId: "a", recipientId: "a" })).toEqual({
      field: "participants",
      message: "Choose two different people.",
    });
  });

  test("accepts a positive payment between different people", () => {
    expect(validatePaymentForm({ amount: "12.50", payerId: "a", recipientId: "b" })).toBeUndefined();
  });
});
