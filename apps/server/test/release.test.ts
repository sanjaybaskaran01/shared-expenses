import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseMetadata } from "../src/release";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("API release metadata", () => {
  test("loads the CI-generated release identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tally-api-release-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "release.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0",
      commit: "a".repeat(40),
      builtAt: "2026-07-28T20:00:00.000Z",
    }));

    expect(loadReleaseMetadata(path, {})).toEqual({
      version: "0.1.0",
      commit: "a".repeat(40),
      builtAt: "2026-07-28T20:00:00.000Z",
    });
  });

  test("falls back to explicit development environment values", () => {
    expect(loadReleaseMetadata("/missing/release.json", {
      APP_VERSION: "dev-version",
      APP_COMMIT: "dev-commit",
      APP_BUILT_AT: "dev-time",
    })).toEqual({ version: "dev-version", commit: "dev-commit", builtAt: "dev-time" });
  });

  test("rejects malformed release metadata instead of masquerading as a development build", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tally-api-release-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "release.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, version: "0.1.0", commit: "short" }));
    expect(() => loadReleaseMetadata(path, {})).toThrow("invalid");
  });
});
