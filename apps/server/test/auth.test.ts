import { describe, expect, test } from "bun:test";
import { deriveDisplayNameFromEmail } from "../src/auth";

describe("invitation display names", () => {
  test("derives a readable name from the only required field", () => {
    expect(deriveDisplayNameFromEmail("sam.jones+trip@example.com")).toBe("Sam Jones Trip");
    expect(deriveDisplayNameFromEmail("alex-doe@example.com")).toBe("Alex Doe");
  });

  test("uses a safe fallback", () => {
    expect(deriveDisplayNameFromEmail("@example.com")).toBe("Friend");
  });
});
