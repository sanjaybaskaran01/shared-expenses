import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBackwardCompatibleMigration,
  assertRepositoryReady,
  atomicSwitchSymlink,
  buildChecksums,
  parseReleaseArgs,
  parseWranglerVersionId,
  planReleaseOperations,
  pollHealth,
  pollWebDeployment,
  rollbackAndRethrow,
  selectSuccessfulCiRun,
  upsertEnvAssignment,
  verifyChecksums,
  type ReleaseHealth,
} from "../release-lib";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tally-release-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("release arguments", () => {
  test("defaults to an all release", () => {
    expect(parseReleaseArgs([])).toEqual({ mode: "all", dryRun: false });
  });

  test("accepts explicit targets and dry runs", () => {
    expect(parseReleaseArgs(["web", "--dry-run"])).toEqual({ mode: "web", dryRun: true });
    expect(parseReleaseArgs(["api"])).toEqual({ mode: "api", dryRun: false });
  });

  test("does not expose a force escape hatch", () => {
    expect(() => parseReleaseArgs(["all", "--force"])).toThrow("Unknown release option");
  });

  test("keeps every dry-run path non-mutating", () => {
    expect(planReleaseOperations({ mode: "web", dryRun: true })).toEqual({
      includeWeb: true, includeApi: false, mutateWeb: false, mutateApi: false,
    });
    expect(planReleaseOperations({ mode: "api", dryRun: true })).toEqual({
      includeWeb: false, includeApi: true, mutateWeb: false, mutateApi: false,
    });
    expect(planReleaseOperations({ mode: "all", dryRun: true })).toEqual({
      includeWeb: true, includeApi: true, mutateWeb: false, mutateApi: false,
    });
  });
});

describe("repository and CI gates", () => {
  const ready = { branch: "main", trackedDirty: false, ahead: 0, behind: 0 };

  test("accepts only a synchronized clean main branch", () => {
    expect(() => assertRepositoryReady(ready)).not.toThrow();
    expect(() => assertRepositoryReady({ ...ready, branch: "feature" })).toThrow("main");
    expect(() => assertRepositoryReady({ ...ready, trackedDirty: true })).toThrow("tracked changes");
    expect(() => assertRepositoryReady({ ...ready, ahead: 1 })).toThrow("origin/main");
    expect(() => assertRepositoryReady({ ...ready, behind: 1 })).toThrow("origin/main");
  });

  test("selects a successful push CI run for the exact commit", () => {
    const commit = "a".repeat(40);
    expect(
      selectSuccessfulCiRun(
        [
          { databaseId: 1, headSha: commit, event: "pull_request", status: "completed", conclusion: "success" },
          { databaseId: 2, headSha: commit, event: "push", status: "completed", conclusion: "failure" },
          { databaseId: 3, headSha: commit, event: "push", status: "completed", conclusion: "success" },
        ],
        commit,
      ).databaseId,
    ).toBe(3);
    expect(() => selectSuccessfulCiRun([], commit)).toThrow("successful CI");
  });
});

describe("Wrangler deployment output", () => {
  test("extracts the deployed version without waiting on eventually consistent status", () => {
    expect(parseWranglerVersionId(`\nUploaded shared-expenses-web\nCurrent Version ID: 9a01bc23-4567-489a-bcde-f0123456789a\n`))
      .toBe("9a01bc23-4567-489a-bcde-f0123456789a");
  });

  test("uses the last version id and rejects unrelated output", () => {
    expect(parseWranglerVersionId("Worker Version ID: 11111111-1111-4111-8111-111111111111\nCurrent Version ID: 22222222-2222-4222-8222-222222222222"))
      .toBe("22222222-2222-4222-8222-222222222222");
    expect(parseWranglerVersionId("Deployment complete")).toBeUndefined();
  });

  test("accepts Cloudflare version ids that are UUID-shaped but not RFC variants", () => {
    expect(parseWranglerVersionId("Current Version ID: fe123456-789a-9bcd-7ef0-123456789abc"))
      .toBe("fe123456-789a-9bcd-7ef0-123456789abc");
  });

  test("ignores Wrangler color control sequences around the version id", () => {
    expect(parseWranglerVersionId("\u001b[32mCurrent Version ID:\u001b[0m \u001b[1m1a515947-9c96-404c-b23f-c94ef3f9c753\u001b[0m"))
      .toBe("1a515947-9c96-404c-b23f-c94ef3f9c753");
  });
});

describe("artifact integrity", () => {
  test("builds and verifies checksums and rejects modified files", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "server"));
    await writeFile(join(root, "release.json"), "{\"commit\":\"abc\"}\n");
    await writeFile(join(root, "server", "index.js"), "console.log('ok')\n");

    const checksums = await buildChecksums(root, ["release.json", "server/index.js"]);
    await expect(verifyChecksums(root, checksums)).resolves.toBeUndefined();

    await writeFile(join(root, "server", "index.js"), "changed\n");
    await expect(verifyChecksums(root, checksums)).rejects.toThrow("Checksum mismatch");
  });

  test("rejects migrations that make rollback unsafe", () => {
    expect(() => assertBackwardCompatibleMigration("CREATE TABLE IF NOT EXISTS example (id TEXT);", "003.sql")).not.toThrow();
    expect(() => assertBackwardCompatibleMigration("ALTER TABLE example ADD COLUMN note TEXT;", "003.sql")).not.toThrow();
    expect(() => assertBackwardCompatibleMigration("DROP TABLE example;", "003.sql")).toThrow("rollback-safe");
    expect(() => assertBackwardCompatibleMigration("DELETE FROM example;", "003.sql")).toThrow("rollback-safe");
  });
});

describe("atomic runtime activation", () => {
  test("switches the current symlink and returns the previous target", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "releases", "old"), { recursive: true });
    await mkdir(join(root, "releases", "new"), { recursive: true });
    await symlink("releases/old", join(root, "current"));

    const previous = await atomicSwitchSymlink(join(root, "current"), "releases/new");
    expect(previous).toBe("releases/old");
    expect(await readlink(join(root, "current"))).toBe("releases/new");
  });

  test("updates only the selected production environment key", () => {
    const source = "# production\nDATABASE_PATH='/private/tally.sqlite'\nEXPENSES_SERVER_ENTRY='/old/index.js'\nSMTP_APP_PASSWORD='secret'\n";
    const updated = upsertEnvAssignment(source, "EXPENSES_SERVER_ENTRY", "/new/current/server/index.js");
    expect(updated).toContain("EXPENSES_SERVER_ENTRY='/new/current/server/index.js'");
    expect(updated).toContain("SMTP_APP_PASSWORD='secret'");
    expect(updated.match(/EXPENSES_SERVER_ENTRY=/g)?.length).toBe(1);
  });
});

describe("rollback reporting", () => {
  test("rethrows the deployment failure after a successful rollback", async () => {
    const deploymentError = new Error("deployment failed");
    await expect(rollbackAndRethrow(deploymentError, async () => undefined, "rollback failed"))
      .rejects.toBe(deploymentError);
  });

  test("reports both deployment and rollback failures", async () => {
    const deploymentError = new Error("deployment failed");
    const rollbackError = new Error("rollback failed");
    try {
      await rollbackAndRethrow(
        deploymentError,
        async () => { throw rollbackError; },
        "both failed",
      );
      throw new Error("Expected rollbackAndRethrow to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([deploymentError, rollbackError]);
    }
  });
});

describe("health polling", () => {
  test("retries until the expected commit is public", async () => {
    let attempts = 0;
    const health = await pollHealth(
      async (): Promise<ReleaseHealth> => {
        attempts += 1;
        return attempts < 3
          ? { status: "ok", version: "0.1.0", commit: "old", builtAt: "old", serverTime: "now" }
          : { status: "ok", version: "0.1.0", commit: "new", builtAt: "now", serverTime: "now" };
      },
      { expectedCommit: "new", timeoutMs: 100, delaysMs: [0, 0, 0] },
    );

    expect(health.commit).toBe("new");
    expect(attempts).toBe(3);
  });

  test("fails when the expected revision never appears", async () => {
    await expect(
      pollHealth(
        async () => ({ status: "ok", version: "0.1.0", commit: "old", builtAt: "old", serverTime: "now" }),
        { expectedCommit: "new", timeoutMs: 5, delaysMs: [0, 0] },
      ),
    ).rejects.toThrow("new");
  });
});

describe("web release verification", () => {
  test("requires matching metadata, assets, service-worker policy, and manifest", async () => {
    const commit = "e".repeat(40);
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === "/release.json") {
        return Response.json(
          { commit, version: "0.1.0", builtAt: "now" },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (path === "/tally-sw.js") return new Response("self.skipWaiting()", { headers: { "cache-control": "no-cache" } });
      if (path === "/manifest.webmanifest") return Response.json({ name: "Tallied" });
      return new Response("<script src='/assets/app.js'></script>");
    };

    const result = await pollWebDeployment(fetcher, {
      baseUrl: "https://tally.example",
      expectedCommit: commit,
      expectedAssets: ["/assets/app.js"],
      timeoutMs: 50,
      delaysMs: [0],
    });
    expect(result.commit).toBe(commit);
  });

  test("rejects a cacheable service worker", async () => {
    const commit = "f".repeat(40);
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === "/release.json") {
        return Response.json({ commit }, { headers: { "cache-control": "no-store" } });
      }
      if (path === "/tally-sw.js") return new Response("worker", { headers: { "cache-control": "public, max-age=3600" } });
      if (path === "/manifest.webmanifest") return Response.json({ name: "Tallied" });
      return new Response("<script src='/assets/app.js'></script>");
    };
    await expect(
      pollWebDeployment(fetcher, {
        baseUrl: "https://tally.example",
        expectedCommit: commit,
        expectedAssets: ["/assets/app.js"],
        timeoutMs: 2,
        delaysMs: [0],
      }),
    ).rejects.toThrow("service worker");
  });

  test("rejects cacheable release metadata", async () => {
    const commit = "a".repeat(40);
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === "/release.json") {
        return Response.json({ commit }, { headers: { "cache-control": "public, max-age=3600" } });
      }
      if (path === "/tally-sw.js") {
        return new Response("worker", { headers: { "cache-control": "no-cache" } });
      }
      if (path === "/manifest.webmanifest") return Response.json({ name: "Tallied" });
      return new Response("<script src='/assets/app.js'></script>");
    };
    await expect(
      pollWebDeployment(fetcher, {
        baseUrl: "https://tally.example",
        expectedCommit: commit,
        expectedAssets: ["/assets/app.js"],
        timeoutMs: 2,
        delaysMs: [0],
      }),
    ).rejects.toThrow("release metadata cache policy");
  });
});
