export const EXPENSE_CATEGORIES = [
  "General",
  "Dining out",
  "Groceries",
  "Liquor",
  "Rent",
  "Household supplies",
  "Utilities",
  "Transportation",
  "Gas/fuel",
  "Taxi",
  "Plane",
  "Hotel",
  "Entertainment",
  "Games",
  "Medical expenses",
  "Gifts",
  "Education",
  "Pets",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type ExpenseCategoryTone = "general" | "food" | "travel" | "home" | "leisure" | "care" | "payment";

export function expenseCategoryTone(category: string): ExpenseCategoryTone {
  switch (category) {
    case "Dining out":
    case "Groceries":
    case "Liquor":
      return "food";
    case "Transportation":
    case "Gas/fuel":
    case "Taxi":
    case "Plane":
    case "Hotel":
      return "travel";
    case "Rent":
    case "Household supplies":
    case "Utilities":
      return "home";
    case "Entertainment":
    case "Games":
    case "Gifts":
      return "leisure";
    case "Medical expenses":
    case "Education":
    case "Pets":
      return "care";
    case "Payment":
      return "payment";
    default:
      return "general";
  }
}
