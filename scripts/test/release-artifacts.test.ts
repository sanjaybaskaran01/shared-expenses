import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReleaseArtifacts } from "../build-release-artifacts";
import { verifyChecksums, type ReleaseManifest } from "../release-lib";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), "tally-artifact-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "apps/web/dist/assets"), { recursive: true });
  await mkdir(join(root, "apps/server/dist"), { recursive: true });
  await mkdir(join(root, "apps/server/migrations"), { recursive: true });
  await writeFile(join(root, "apps/web/dist/index.html"), "<title>Tallied</title><script src='/assets/app.js'></script>");
  await writeFile(join(root, "apps/web/dist/assets/app.js"), "console.log('tally')");
  await writeFile(join(root, "apps/web/dist/assets/app.js.map"), "{}");
  await writeFile(join(root, "apps/web/dist/brand-concept.png"), "unused");
  await writeFile(join(root, "apps/web/dist/tally-sw.js"), "self.skipWaiting()");
  await writeFile(join(root, "apps/web/dist/manifest.webmanifest"), JSON.stringify({ name: "Tallied" }));
  await writeFile(join(root, "apps/server/dist/index.js"), "Bun.serve({fetch(){return new Response('ok')}})");
  await writeFile(join(root, "apps/server/migrations/001.sql"), "CREATE TABLE IF NOT EXISTS test (id TEXT);");
  return { root, output: join(root, "release-artifact") };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CI release artifacts", () => {
  test("packages exact web, API, migration, metadata, and checksum inputs", async () => {
    const { root, output } = await fixture();
    const commit = "b".repeat(40);
    await buildReleaseArtifacts({
      repositoryRoot: root,
      outputDirectory: output,
      commit,
      version: "0.1.0",
      builtAt: "2026-07-28T20:00:00.000Z",
    });

    expect(await Bun.file(join(output, "web/assets/app.js")).exists()).toBe(true);
    expect(await Bun.file(join(output, "web/assets/app.js.map")).exists()).toBe(false);
    expect(await Bun.file(join(output, "web/brand-concept.png")).exists()).toBe(false);
    expect(await Bun.file(join(output, "api/server/index.js")).exists()).toBe(true);
    expect(await Bun.file(join(output, "api/migrations/001.sql")).exists()).toBe(true);

    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as ReleaseManifest;
    expect(manifest.commit).toBe(commit);
    expect(manifest.targets.api.migrations).toEqual(["api/migrations/001.sql"]);
    expect(Object.keys(manifest.files)).toContain("web/release.json");
    expect(Object.keys(manifest.files)).toContain("api/checksums.json");
    await expect(verifyChecksums(output, manifest.files)).resolves.toBeUndefined();
  });

  test("refuses destructive migrations", async () => {
    const { root, output } = await fixture();
    await writeFile(join(root, "apps/server/migrations/002.sql"), "DROP TABLE test;");
    await expect(
      buildReleaseArtifacts({
        repositoryRoot: root,
        outputDirectory: output,
        commit: "c".repeat(40),
        version: "0.1.0",
        builtAt: "2026-07-28T20:00:00.000Z",
      }),
    ).rejects.toThrow("rollback-safe");
  });
});
