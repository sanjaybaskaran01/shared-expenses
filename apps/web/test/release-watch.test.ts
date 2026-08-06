import { describe, expect, test } from "bun:test";
import { hasNewerRelease, parseReleaseInfo } from "../src/lib/release-watch";

describe("hasNewerRelease", () => {
  test("flags a different commit as a newer release", () => {
    const baseline = { version: "0.1.0", commit: "aaa111", builtAt: "2026-01-01T00:00:00Z" };
    const latest = { version: "0.1.0", commit: "bbb222", builtAt: "2026-01-02T00:00:00Z" };
    expect(hasNewerRelease(baseline, latest)).toBe(true);
  });

  test("does not flag the same commit as newer", () => {
    const baseline = { version: "0.1.0", commit: "aaa111", builtAt: "2026-01-01T00:00:00Z" };
    const latest = { version: "0.1.0", commit: "aaa111", builtAt: "2026-01-01T00:00:00Z" };
    expect(hasNewerRelease(baseline, latest)).toBe(false);
  });

  test("does not flag when either release is missing", () => {
    const info = { version: "0.1.0", commit: "aaa111", builtAt: "2026-01-01T00:00:00Z" };
    expect(hasNewerRelease(undefined, info)).toBe(false);
    expect(hasNewerRelease(info, undefined)).toBe(false);
    expect(hasNewerRelease(undefined, undefined)).toBe(false);
  });
});

describe("parseReleaseInfo", () => {
  test("accepts a well-formed release payload", () => {
    const value = { version: "0.1.0", commit: "aaa111", builtAt: "2026-01-01T00:00:00Z" };
    expect(parseReleaseInfo(value)).toEqual(value);
  });

  test("rejects payloads missing required fields", () => {
    expect(parseReleaseInfo({ version: "0.1.0" })).toBeUndefined();
    expect(parseReleaseInfo({ commit: "aaa111", builtAt: "2026-01-01T00:00:00Z" })).toBeUndefined();
  });

  test("rejects non-object payloads", () => {
    expect(parseReleaseInfo(null)).toBeUndefined();
    expect(parseReleaseInfo("aaa111")).toBeUndefined();
    expect(parseReleaseInfo(undefined)).toBeUndefined();
  });
});
