export type ExpenseEntryMode = "natural" | "form";
export type ExpensePickerPanel = "payer" | "split" | "date" | "details";

export function initialExpenseEntryMode(_editing: boolean): ExpenseEntryMode {
  return "form";
}

export function shouldDismissKeyboardForPanel(panel: ExpensePickerPanel, activeTagName?: string): boolean {
  if (panel === "details") return false;
  return activeTagName === "INPUT" || activeTagName === "TEXTAREA" || activeTagName === "SELECT";
}
