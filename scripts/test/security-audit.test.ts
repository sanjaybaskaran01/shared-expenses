import { describe, expect, test } from "bun:test";
import { repositoryPolicyFindings, textBlobPolicyFindings } from "../security-audit";

describe("repository security policy", () => {
  test("rejects private artifact roots even for binary content", () => {
    expect(repositoryPolicyFindings("artifacts/private-ledger.png", "")).toContain("tracked private artifact path");
    expect(repositoryPolicyFindings("work/session.bin", "")).toContain("tracked private artifact path");
    expect(repositoryPolicyFindings("xaa", "")).toContain("tracked private artifact path");
  });

  test("rejects runtime data and non-example identities in current or historical text", () => {
    expect(repositoryPolicyFindings("data/tallied.sqlite", "")).toContain("tracked runtime data file");
    const privateAddress = ["owner", "personal-domain", "test"].join("@").replace("@test", ".test");
    expect(repositoryPolicyFindings("", privateAddress)).toContain("non-example email address");
    expect(repositoryPolicyFindings("fixtures/example.ts", "owner@example.com")).toEqual([]);
  });

  test("decodes clean indexed Git blobs before applying content policy", () => {
    const privateAddress = ["owner", "private-host", "invalid"].join("@").replace("@invalid", ".invalid");
    const indexedBytes = new TextEncoder().encode(`export const owner = "${privateAddress}";`);
    expect(textBlobPolicyFindings("fixtures/owner.ts", indexedBytes, true)).toContain("non-example email address");
  });
});
