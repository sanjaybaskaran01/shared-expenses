import { describe, expect, test } from "bun:test";
import {
  rankExpenseCategories,
  suggestExpenseCategory,
  type CategorizedExpense,
  type ExpenseCategory,
} from "../src/lib/expense-categories";

describe("expense category ranking", () => {
  test("ranks specific phrases ahead of overlapping generic merchants", () => {
    expect(suggestExpenseCategory("Uber Eats dinner")?.category).toBe("Dining out");
    expect(suggestExpenseCategory("Uber to the airport")?.category).toBe("Taxi");
    expect(suggestExpenseCategory("Monthly gas bill")?.category).toBe("Utilities");
    expect(suggestExpenseCategory("Shell gas station")?.category).toBe("Gas/fuel");
    expect(suggestExpenseCategory("Plane ticket")?.category).toBe("Plane");
    expect(suggestExpenseCategory("Concert ticket")?.category).toBe("Entertainment");
  });

  test("does not guess from ambiguous marketplace or platform names", () => {
    expect(suggestExpenseCategory("Amazon order")).toBeUndefined();
    expect(suggestExpenseCategory("Amazon shoes")).toBeUndefined();
    expect(suggestExpenseCategory("Apple purchase")).toBeUndefined();
    expect(suggestExpenseCategory("Target run")).toBeUndefined();
  });

  test("uses the latest exact personal correction before curated rules", () => {
    const history: CategorizedExpense[] = [
      { description: "Amazon order", category: "Household supplies", updatedAt: "2026-01-01T10:00:00Z" },
      { description: "Amazon order", category: "Gifts", updatedAt: "2026-02-01T10:00:00Z" },
    ];
    expect(suggestExpenseCategory("Amazon order", history)).toMatchObject({
      category: "Gifts",
      action: "apply",
      source: "personal-exact",
      confidence: 0.99,
    });
  });

  test("learns an ambiguous merchant only after two consistent choices", () => {
    const consistent: CategorizedExpense[] = [
      { description: "Amazon running shoes", category: "Clothing" },
      { description: "Amazon winter jacket", category: "Clothing" },
    ];
    expect(suggestExpenseCategory("Amazon backpack", consistent)).toMatchObject({
      category: "Clothing",
      action: "apply",
      source: "personal-merchant",
    });

    const conflicted: CategorizedExpense[] = [
      ...consistent,
      { description: "Amazon birthday present", category: "Gifts" },
    ];
    expect(suggestExpenseCategory("Amazon backpack", conflicted)).toBeUndefined();
  });

  test("distinguishes automatic choices from lower-confidence suggestions", () => {
    expect(suggestExpenseCategory("Netflix subscription")).toMatchObject({ category: "Subscriptions", action: "apply" });
    expect(suggestExpenseCategory("parking")).toMatchObject({ category: "Transportation", action: "suggest" });
    expect(suggestExpenseCategory("Bryant st")).toBeUndefined();
  });

  test("downgrades close cross-category matches instead of pretending certainty", () => {
    expect(suggestExpenseCategory("Shell gas bill")).toMatchObject({
      action: "suggest",
      confidence: 0.72,
      source: "curated",
    });
  });
});

const evaluationSeeds: Record<Exclude<ExpenseCategory, "General">, readonly string[]> = {
  "Dining out": ["ramen dinner", "coffee shop", "uber eats"],
  Groceries: ["whole foods groceries", "trader joes", "aldi supermarket"],
  Liquor: ["wine shop", "brewery tab", "liquor store"],
  Rent: ["monthly apartment rent", "house lease", "rent payment"],
  "Household supplies": ["ikea furniture", "home depot hardware", "cleaning supplies"],
  Utilities: ["electricity bill", "home internet", "water utility"],
  Transportation: ["amtrak train", "metro card", "airport parking"],
  "Gas/fuel": ["shell gas station", "chevron fuel", "petrol station"],
  Taxi: ["lyft ride", "uber to airport", "taxi home"],
  Plane: ["delta flight", "plane ticket", "united airlines"],
  Hotel: ["airbnb stay", "hotel room", "hostel booking"],
  Entertainment: ["concert ticket", "cinema tickets", "museum admission"],
  Games: ["steam game", "playstation store", "nintendo game"],
  "Medical expenses": ["doctor appointment", "cvs pharmacy", "dental visit"],
  Gifts: ["birthday gift", "wedding present", "anniversary gift"],
  Education: ["course tuition", "school textbook", "class fee"],
  Pets: ["veterinary visit", "chewy dog food", "cat litter"],
  Shopping: ["electronics purchase", "shopping mall", "online shopping"],
  Clothing: ["running shoes", "winter jacket", "clothing store"],
  Subscriptions: ["netflix subscription", "spotify monthly", "apple music plan"],
  Fees: ["bank fee", "late fee", "service charge"],
};

const evaluationModifiers = ["", " today", " 24.50", " on 08/06"] as const;

describe("controlled English category evaluation", () => {
  test("meets the preview precision and top-three targets", () => {
    const corpus = Object.entries(evaluationSeeds).flatMap(([category, seeds]) =>
      seeds.flatMap((description) => evaluationModifiers.map((modifier) => ({
        category: category as ExpenseCategory,
        description: `${description}${modifier}`,
      }))),
    );
    expect(corpus.length).toBeGreaterThanOrEqual(250);

    let applied = 0;
    let correctApplied = 0;
    let topThreeCorrect = 0;
    for (const item of corpus) {
      const ranked = rankExpenseCategories(item.description);
      if (ranked[0]?.action === "apply") {
        applied += 1;
        if (ranked[0].category === item.category) correctApplied += 1;
      }
      if (ranked.slice(0, 3).some((candidate) => candidate.category === item.category)) topThreeCorrect += 1;
    }

    expect(applied).toBeGreaterThan(0);
    expect(correctApplied / applied).toBeGreaterThanOrEqual(0.95);
    expect(topThreeCorrect / corpus.length).toBeGreaterThanOrEqual(0.85);
  });
});
