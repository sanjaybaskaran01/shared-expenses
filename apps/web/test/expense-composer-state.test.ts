import { describe, expect, test } from "bun:test";
import {
  initialExpenseEntryMode,
  shouldDismissKeyboardForPanel,
} from "../src/lib/expense-composer-state";

describe("expense composer interaction state", () => {
  test("opens new and existing expenses in the structured form", () => {
    expect(initialExpenseEntryMode(false)).toBe("form");
    expect(initialExpenseEntryMode(true)).toBe("form");
  });

  test("dismisses the software keyboard before showing a picker", () => {
    expect(shouldDismissKeyboardForPanel("payer", "INPUT")).toBe(true);
    expect(shouldDismissKeyboardForPanel("split", "TEXTAREA")).toBe(true);
    expect(shouldDismissKeyboardForPanel("date", "SELECT")).toBe(true);
    expect(shouldDismissKeyboardForPanel("details", "INPUT")).toBe(false);
    expect(shouldDismissKeyboardForPanel("payer", "BUTTON")).toBe(false);
  });
});
