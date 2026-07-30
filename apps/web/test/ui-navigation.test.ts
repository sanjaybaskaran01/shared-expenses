import { describe, expect, test } from "bun:test";
import { nextTabIndex } from "../src/lib/ui-navigation";

describe("horizontal tab keyboard navigation", () => {
  test("moves and wraps with arrow keys", () => {
    expect(nextTabIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextTabIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextTabIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(nextTabIndex(2, 3, "ArrowLeft")).toBe(1);
  });

  test("jumps to the first and last tab", () => {
    expect(nextTabIndex(1, 3, "Home")).toBe(0);
    expect(nextTabIndex(1, 3, "End")).toBe(2);
  });

  test("ignores unrelated keys and empty lists", () => {
    expect(nextTabIndex(1, 3, "Enter")).toBeUndefined();
    expect(nextTabIndex(0, 0, "ArrowRight")).toBeUndefined();
  });
});
