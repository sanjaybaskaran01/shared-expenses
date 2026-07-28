import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChecksums } from "../release-lib";
import {
  bootstrapLegacyRuntime,
  ensureProductionServerEntry,
  stageApiRelease,
  updateProductionServerEntry,
} from "../release-runtime";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tally-runtime-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("versioned API runtime", () => {
  test("stages a complete immutable API release", async () => {
    const root = await temporaryDirectory();
    const api = join(root, "artifact/api");
    const runtime = join(root, "runtime");
    const commit = "d".repeat(40);
    await mkdir(join(api, "server"), { recursive: true });
    await mkdir(join(api, "migrations"), { recursive: true });
    await writeFile(join(api, "server/index.js"), "console.log('release')\n");
    await writeFile(join(api, "migrations/001.sql"), "CREATE TABLE test (id TEXT);\n");
    await writeFile(join(api, "release.json"), JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0",
      commit,
      builtAt: "2026-07-28T20:00:00.000Z",
    }));
    const checksums = await buildChecksums(api, ["server/index.js", "migrations/001.sql", "release.json"]);
    await writeFile(join(api, "checksums.json"), JSON.stringify(checksums));

    const staged = await stageApiRelease(api, runtime);
    expect(staged.commit).toBe(commit);
    expect(staged.releasePath).toBe(join(runtime, "releases", commit));
    expect(await readFile(join(staged.releasePath, "migrations/001.sql"), "utf8")).toContain("CREATE TABLE");

    await writeFile(join(staged.releasePath, "server/index.js"), "tampered\n");
    await expect(stageApiRelease(api, runtime)).rejects.toThrow("Checksum mismatch");
  });

  test("preserves the legacy runtime as the first rollback target", async () => {
    const root = await temporaryDirectory();
    const runtime = join(root, "runtime");
    await mkdir(join(runtime, "server"), { recursive: true });
    await mkdir(join(runtime, "migrations"), { recursive: true });
    await writeFile(join(runtime, "server/index.js"), "console.log('legacy')\n");
    await writeFile(join(runtime, "migrations/001.sql"), "CREATE TABLE legacy (id TEXT);\n");

    const legacy = await bootstrapLegacyRuntime(runtime, "0.1.0", "2026-07-28T20:00:00.000Z");
    if (!legacy) throw new Error("Expected a legacy release");
    expect(legacy?.target).toMatch(/^releases\/legacy-/);
    expect(await readlink(join(runtime, "current"))).toBe(legacy.target);
    expect(await Bun.file(join(runtime, legacy.target, "server/index.js")).exists()).toBe(true);
  });

  test("updates the server entry with a permissions-preserving backup", async () => {
    const root = await temporaryDirectory();
    const envPath = join(root, "production.env");
    await writeFile(envPath, "DATABASE_PATH='/data/tally.sqlite'\nEXPENSES_SERVER_ENTRY='/old/index.js'\n", { mode: 0o600 });
    const newEntry = join(root, "runtime/current/server/index.js");

    const backup = await updateProductionServerEntry(envPath, newEntry, "20260728T200000Z");
    expect(await readFile(envPath, "utf8")).toContain(`EXPENSES_SERVER_ENTRY='${newEntry}'`);
    expect(await readFile(backup, "utf8")).toContain("/old/index.js");
    expect((await import("node:fs/promises").then(({ stat }) => stat(envPath))).mode & 0o777).toBe(0o600);
    expect(await ensureProductionServerEntry(envPath, newEntry)).toBeNull();
  });
});
