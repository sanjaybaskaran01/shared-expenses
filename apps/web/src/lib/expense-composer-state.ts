export type ExpenseEntryMode = "natural" | "form";
export type ExpensePickerPanel = "payer" | "split" | "date" | "details";
export type ExpenseInitialFocusTarget = "amount" | "dialog";

export function initialExpenseEntryMode(_editing: boolean): ExpenseEntryMode {
  return "form";
}

export function initialExpenseFocusTarget(editing: boolean): ExpenseInitialFocusTarget {
  return editing ? "dialog" : "amount";
}

export function shouldDismissKeyboardForPanel(panel: ExpensePickerPanel, activeTagName?: string): boolean {
  if (panel === "details") return false;
  return activeTagName === "INPUT" || activeTagName === "TEXTAREA" || activeTagName === "SELECT";
}
