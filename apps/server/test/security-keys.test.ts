import { describe, expect, test } from "bun:test";
import { decryptServerValue, encryptServerValue, keyedDigest } from "../src/security-keys";

describe("purpose-separated server keys", () => {
  const root = "unit-test-root-secret-with-enough-entropy";

  test("does not reuse digests across email, claim, and provider-id domains", () => {
    const value = "same-input@example.com";
    const values = new Set([
      keyedDigest(root, "identity-email", value),
      keyedDigest(root, "import-claim-token", value),
      keyedDigest(root, "import-external-id", value),
    ]);
    expect(values.size).toBe(3);
  });

  test("encrypts with randomized authenticated envelopes bound to their purpose", () => {
    const first = encryptServerValue(root, "import-stage-envelope", "private migration review");
    const second = encryptServerValue(root, "import-stage-envelope", "private migration review");
    expect(first).not.toBe(second);
    expect(first).not.toContain("private migration review");
    expect(decryptServerValue(root, "import-stage-envelope", first)).toBe("private migration review");
    expect(() => decryptServerValue(root, "splitwise-access-token", first)).toThrow();
    const tampered = `${first.slice(0, -1)}${first.endsWith("a") ? "b" : "a"}`;
    expect(() => decryptServerValue(root, "import-stage-envelope", tampered)).toThrow();
  });
});
