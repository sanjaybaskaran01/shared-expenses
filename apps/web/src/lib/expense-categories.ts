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
  "Shopping",
  "Clothing",
  "Subscriptions",
  "Fees",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type ExpenseCategoryTone = "general" | "food" | "travel" | "home" | "leisure" | "care" | "payment";

export interface CategorizedExpense {
  description: string;
  category: string;
  updatedAt?: string;
}

export interface ExpenseCategorySuggestion {
  category: ExpenseCategory;
  confidence: number;
  action: "apply" | "suggest";
  source: "personal-exact" | "personal-merchant" | "curated";
  reason: string;
  score: number;
}

interface CuratedCategoryRule {
  category: ExpenseCategory;
  phrases: readonly string[];
  confidence: number;
  action: ExpenseCategorySuggestion["action"];
}

const categorySet = new Set<string>(EXPENSE_CATEGORIES);

const curatedRules: readonly CuratedCategoryRule[] = [
  { category: "Dining out", phrases: ["uber eats", "door dash", "doordash", "grubhub", "ramen", "restaurant", "dinner", "lunch", "breakfast", "brunch", "coffee shop", "coffee", "cafe", "bakery", "takeout", "pizza"], confidence: 0.96, action: "apply" },
  { category: "Groceries", phrases: ["whole foods", "trader joes", "trader joe", "grocery", "groceries", "supermarket", "instacart", "aldi", "kroger"], confidence: 0.96, action: "apply" },
  { category: "Liquor", phrases: ["liquor store", "liquor", "wine shop", "wine", "brewery", "beer", "cocktail", "bar tab"], confidence: 0.95, action: "apply" },
  { category: "Rent", phrases: ["apartment rent", "house rent", "rent payment", "rent", "house lease", "lease payment"], confidence: 0.97, action: "apply" },
  { category: "Household supplies", phrases: ["home depot", "cleaning supplies", "household supplies", "ikea furniture", "ikea", "furniture", "hardware store", "hardware"], confidence: 0.95, action: "apply" },
  { category: "Utilities", phrases: ["gas bill", "electricity bill", "electric bill", "electricity", "home internet", "internet bill", "water utility", "water bill", "utility bill", "broadband", "phone bill", "mobile bill"], confidence: 0.97, action: "apply" },
  { category: "Transportation", phrases: ["amtrak", "train ticket", "train", "metro card", "metro", "subway", "bus fare", "airport parking", "parking", "toll road", "toll", "public transit"], confidence: 0.86, action: "suggest" },
  { category: "Gas/fuel", phrases: ["gas station", "fuel station", "petrol station", "shell gas", "chevron fuel", "exxon fuel", "vehicle fuel", "petrol", "fuel"], confidence: 0.97, action: "apply" },
  { category: "Taxi", phrases: ["lyft ride", "lyft", "uber ride", "uber to", "uber from", "taxi", "cab ride", "cab home", "ola ride", "grab ride"], confidence: 0.95, action: "apply" },
  { category: "Plane", phrases: ["plane ticket", "flight ticket", "delta flight", "united airlines", "jetblue flight", "southwest flight", "airline ticket", "airways flight", "flight"], confidence: 0.97, action: "apply" },
  { category: "Hotel", phrases: ["airbnb stay", "hotel room", "hotel", "hostel booking", "hostel", "motel", "resort stay", "lodging"], confidence: 0.96, action: "apply" },
  { category: "Entertainment", phrases: ["concert ticket", "cinema ticket", "cinema tickets", "movie ticket", "museum admission", "theater ticket", "theatre ticket", "concert", "cinema", "museum"], confidence: 0.95, action: "apply" },
  { category: "Games", phrases: ["steam game", "steam", "playstation store", "playstation", "xbox game", "xbox", "nintendo game", "nintendo", "video game"], confidence: 0.96, action: "apply" },
  { category: "Medical expenses", phrases: ["doctor appointment", "doctor visit", "hospital bill", "cvs pharmacy", "walgreens pharmacy", "pharmacy", "dental visit", "dentist", "medicine", "medical bill"], confidence: 0.96, action: "apply" },
  { category: "Gifts", phrases: ["birthday gift", "wedding present", "anniversary gift", "gift", "present"], confidence: 0.94, action: "apply" },
  { category: "Education", phrases: ["course tuition", "school tuition", "tuition", "school textbook", "textbook", "class fee", "course fee", "education"], confidence: 0.96, action: "apply" },
  { category: "Pets", phrases: ["veterinary visit", "veterinarian", "vet visit", "chewy dog food", "dog food", "cat food", "cat litter", "pet food", "pet supplies"], confidence: 0.96, action: "apply" },
  { category: "Shopping", phrases: ["electronics purchase", "electronics store", "shopping mall", "online shopping", "shopping"], confidence: 0.88, action: "suggest" },
  { category: "Clothing", phrases: ["running shoes", "winter jacket", "clothing store", "clothes", "apparel", "shoe store"], confidence: 0.94, action: "apply" },
  { category: "Subscriptions", phrases: ["netflix subscription", "netflix", "spotify monthly", "spotify subscription", "apple music", "youtube premium", "monthly subscription", "annual subscription", "subscription renewal"], confidence: 0.97, action: "apply" },
  { category: "Fees", phrases: ["bank fee", "late fee", "service charge", "transaction fee", "overdraft fee", "booking fee", "processing fee"], confidence: 0.96, action: "apply" },
] as const;

const merchantAliases = [
  "uber eats", "whole foods", "trader joes", "home depot", "apple music",
  "amazon", "apple", "target", "walmart", "costco", "uber", "lyft", "netflix",
  "spotify", "doordash", "grubhub", "instacart", "airbnb", "amtrak", "ikea",
] as const;

export function normalizeCategoryText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function includesPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function knownCategory(value: string): value is ExpenseCategory {
  return categorySet.has(value);
}

function merchantSignature(text: string): string | undefined {
  return merchantAliases.find((merchant) => includesPhrase(text, merchant));
}

function historyByRecency(history: readonly CategorizedExpense[]): CategorizedExpense[] {
  return history
    .map((expense, index) => ({ expense, index }))
    .sort((left, right) => {
      const leftTime = left.expense.updatedAt ? Date.parse(left.expense.updatedAt) : Number.NaN;
      const rightTime = right.expense.updatedAt ? Date.parse(right.expense.updatedAt) : Number.NaN;
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
      return right.index - left.index;
    })
    .map(({ expense }) => expense);
}

function personalCandidates(normalized: string, history: readonly CategorizedExpense[]): ExpenseCategorySuggestion[] {
  const eligible = historyByRecency(history).filter((expense) => knownCategory(expense.category) && expense.category !== "General");
  const exact = eligible.find((expense) => normalizeCategoryText(expense.description) === normalized);
  if (exact && knownCategory(exact.category)) {
    return [{ category: exact.category, confidence: 0.99, action: "apply", source: "personal-exact", reason: "Used for this exact description before", score: 10_000 }];
  }

  const merchant = merchantSignature(normalized);
  if (!merchant) return [];
  const matching = eligible.filter((expense) => merchantSignature(normalizeCategoryText(expense.description)) === merchant);
  const counts = new Map<ExpenseCategory, number>();
  for (const expense of matching) {
    if (knownCategory(expense.category)) counts.set(expense.category, (counts.get(expense.category) ?? 0) + 1);
  }
  if (counts.size !== 1) return [];
  const onlyCategory = [...counts.entries()][0];
  if (!onlyCategory) return [];
  const [category, count] = onlyCategory;
  if (count < 2) return [];
  return [{ category, confidence: 0.98, action: "apply", source: "personal-merchant", reason: `Learned from ${count} choices for ${merchant}`, score: 9_000 + count }];
}

function curatedCandidates(normalized: string): ExpenseCategorySuggestion[] {
  const byCategory = new Map<ExpenseCategory, ExpenseCategorySuggestion>();
  for (const rule of curatedRules) {
    for (const phrase of rule.phrases) {
      if (!includesPhrase(normalized, phrase)) continue;
      const words = phrase.split(" ").length;
      const exactBonus = normalized === phrase ? 120 : 0;
      const score = (words > 1 ? 700 : 480) + words * 30 + exactBonus;
      const candidate: ExpenseCategorySuggestion = {
        category: rule.category,
        confidence: rule.confidence,
        action: rule.action,
        source: "curated",
        reason: `Matches “${phrase}”`,
        score,
      };
      if ((byCategory.get(rule.category)?.score ?? -1) < score) byCategory.set(rule.category, candidate);
    }
  }
  return [...byCategory.values()];
}

export function rankExpenseCategories(
  description: string,
  history: readonly CategorizedExpense[] = [],
): ExpenseCategorySuggestion[] {
  const normalized = normalizeCategoryText(description);
  if (!normalized) return [];
  const ranked = [...personalCandidates(normalized, history), ...curatedCandidates(normalized)]
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence || left.category.localeCompare(right.category));
  const seen = new Set<ExpenseCategory>();
  const unique = ranked.filter((candidate) => {
    if (seen.has(candidate.category)) return false;
    seen.add(candidate.category);
    return true;
  });
  const top = unique[0];
  const runnerUp = unique[1];
  if (top?.source === "curated" && runnerUp?.source === "curated" && top.score - runnerUp.score <= 60) {
    unique[0] = {
      ...top,
      confidence: 0.72,
      action: "suggest",
      reason: `Could be ${top.category} or ${runnerUp.category}`,
    };
  }
  return unique;
}

export function suggestExpenseCategory(
  description: string,
  history: readonly CategorizedExpense[] = [],
): ExpenseCategorySuggestion | undefined {
  return rankExpenseCategories(description, history)[0];
}

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
    case "Shopping":
    case "Clothing":
    case "Subscriptions":
      return "leisure";
    case "Medical expenses":
    case "Education":
    case "Pets":
      return "care";
    case "Fees":
      return "general";
    case "Payment":
      return "payment";
    default:
      return "general";
  }
}
