import { randomUUID } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertRepositoryReady,
  atomicSwitchSymlink,
  listFiles,
  parseReleaseArgs,
  planReleaseOperations,
  pollHealth,
  pollWebDeployment,
  rollbackAndRethrow,
  selectSuccessfulCiRun,
  verifyChecksums,
  type CiRun,
  type ReleaseHealth,
  type ReleaseManifest,
  type ReleaseMode,
} from "./release-lib";
import {
  bootstrapLegacyRuntime,
  currentRuntimeTarget,
  ensureProductionServerEntry,
  readRuntimeIdentity,
  stageApiRelease,
  type StagedApiRelease,
} from "./release-runtime";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ApiDeploymentState {
  previousTarget: string;
  previousCommit: string;
  previousIsLegacy: boolean;
  release: StagedApiRelease;
  localHealth: ReleaseHealth;
  publicHealth: ReleaseHealth;
  snapshotPath: string;
}

interface WebDeploymentState {
  previousVersion: string;
  previousCommit?: string;
  version: string;
}

interface ReleaseHistory {
  schemaVersion: 1;
  commit: string;
  version: string;
  mode: ReleaseMode;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed";
  dryRun: boolean;
  ciRunId: number;
  timingsMs: Record<string, number>;
  web?: Partial<WebDeploymentState>;
  api?: {
    previousTarget: string;
    previousCommit: string;
    target: string;
    snapshotPath: string;
  };
  error?: string;
}

interface ReleaseContext {
  repositoryRoot: string;
  supportRoot: string;
  runtimeRoot: string;
  environmentPath: string;
  artifactCacheRoot: string;
  historyRoot: string;
  snapshotRoot: string;
  webUrl: string;
  publicApiUrl: string;
  localApiUrl: string;
  launchdLabel: string;
  wranglerPath: string;
  wranglerConfig: string;
  workerName: string;
}

interface ObtainedArtifact {
  path: string;
  manifest: ReleaseManifest;
  cleanup?: () => Promise<void>;
}

const WEB_DEPLOYMENT_TIMEOUT_MS = 180_000;

function contextFromEnvironment(): ReleaseContext {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const supportRoot = resolve(process.env.TALLY_SUPPORT_ROOT ?? join(homedir(), "Library/Application Support/Tally"));
  return {
    repositoryRoot,
    supportRoot,
    runtimeRoot: resolve(process.env.TALLY_RUNTIME_ROOT ?? join(supportRoot, "runtime")),
    environmentPath: resolve(process.env.TALLY_ENV_FILE ?? join(supportRoot, "config/production.env")),
    artifactCacheRoot: resolve(process.env.TALLY_RELEASE_CACHE ?? join(supportRoot, "release-cache")),
    historyRoot: resolve(process.env.TALLY_RELEASE_HISTORY ?? join(supportRoot, "release-history")),
    snapshotRoot: resolve(process.env.TALLY_RELEASE_BACKUPS ?? join(supportRoot, "release-backups")),
    webUrl: process.env.TALLY_WEB_URL ?? "https://tally.example.com",
    publicApiUrl: process.env.TALLY_API_URL ?? "https://tally-api.example.com",
    localApiUrl: process.env.TALLY_LOCAL_API_URL ?? "http://127.0.0.1:3000",
    launchdLabel: process.env.TALLY_LAUNCHD_LABEL ?? "com.tally.api",
    wranglerPath: resolve(repositoryRoot, "node_modules/.bin/wrangler"),
    wranglerConfig: resolve(repositoryRoot, "apps/web/wrangler.jsonc"),
    workerName: process.env.TALLY_WORKER_NAME ?? "shared-expenses-web",
  };
}

async function command(
  arguments_: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const subprocess = Bun.spawn(arguments_, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`${arguments_[0]} ${arguments_.slice(1).join(" ")} failed: ${detail}`);
  }
  return { stdout, stderr, exitCode };
}

function requireExecutable(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Required executable is unavailable: ${name}`);
  return path;
}

function print(message: string): void {
  console.log(`[tally-release] ${message}`);
}

async function timed<T>(history: ReleaseHistory, name: string, action: () => Promise<T>): Promise<T> {
  return timedInto(history.timingsMs, name, action);
}

async function timedInto<T>(
  timingsMs: Record<string, number>,
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  print(name);
  try {
    return await action();
  } finally {
    timingsMs[name] = Math.round(performance.now() - started);
  }
}

async function repositoryPreflight(context: ReleaseContext): Promise<{ commit: string; untracked: string[] }> {
  await command(["git", "fetch", "origin", "main"], { cwd: context.repositoryRoot });
  const [branchResult, statusResult, countsResult, commitResult, untrackedResult] = await Promise.all([
    command(["git", "branch", "--show-current"], { cwd: context.repositoryRoot }),
    command(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: context.repositoryRoot }),
    command(["git", "rev-list", "--left-right", "--count", "origin/main...HEAD"], { cwd: context.repositoryRoot }),
    command(["git", "rev-parse", "HEAD"], { cwd: context.repositoryRoot }),
    command(["git", "ls-files", "--others", "--exclude-standard"], { cwd: context.repositoryRoot }),
  ]);
  const [behindText, aheadText] = countsResult.stdout.trim().split(/\s+/);
  assertRepositoryReady({
    branch: branchResult.stdout.trim(),
    trackedDirty: statusResult.stdout.trim().length > 0,
    ahead: Number(aheadText),
    behind: Number(behindText),
  });
  return {
    commit: commitResult.stdout.trim().toLowerCase(),
    untracked: untrackedResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
  };
}

async function successfulCiRun(context: ReleaseContext, commit: string): Promise<CiRun> {
  await command(["gh", "auth", "status"], { cwd: context.repositoryRoot });
  const result = await command([
    "gh", "run", "list",
    "--workflow", "CI",
    "--commit", commit,
    "--event", "push",
    "--json", "databaseId,headSha,event,status,conclusion",
    "--limit", "20",
  ], { cwd: context.repositoryRoot });
  return selectSuccessfulCiRun(JSON.parse(result.stdout) as CiRun[], commit);
}

function assertManifest(value: unknown, expectedCommit: string): asserts value is ReleaseManifest {
  const manifest = value as Partial<ReleaseManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.commit !== expectedCommit ||
    typeof manifest.version !== "string" ||
    typeof manifest.builtAt !== "string" ||
    !manifest.files ||
    manifest.targets?.web?.entrypoint !== "web/index.html" ||
    manifest.targets.web.releaseMetadata !== "web/release.json" ||
    manifest.targets?.api?.entrypoint !== "api/server/index.js" ||
    manifest.targets.api.releaseMetadata !== "api/release.json" ||
    !Array.isArray(manifest.targets.api.migrations) ||
    manifest.targets.api.migrations.some((path) => !/^api\/migrations\/[^/]+\.sql$/.test(path))
  ) {
    throw new Error(`Release artifact metadata does not match ${expectedCommit}`);
  }
}

async function verifyArtifact(path: string, expectedCommit: string): Promise<ReleaseManifest> {
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  assertManifest(manifest, expectedCommit);
  await verifyChecksums(path, manifest.files);
  const actualFiles = (await listFiles(path)).filter((file) => file !== "manifest.json").sort();
  const declaredFiles = Object.keys(manifest.files).sort();
  if (actualFiles.join("\n") !== declaredFiles.join("\n")) {
    throw new Error("Release artifact contains undeclared or missing files");
  }
  return manifest;
}

async function obtainArtifact(
  context: ReleaseContext,
  commit: string,
  runId: number,
  persist: boolean,
): Promise<ObtainedArtifact> {
  if (!persist) {
    const temporary = await mkdtemp(join(tmpdir(), "tally-release-dry-run-"));
    try {
      await command([
        "gh", "run", "download", String(runId),
        "--name", `tally-release-${commit}`,
        "--dir", temporary,
      ], { cwd: context.repositoryRoot });
      const manifest = await verifyArtifact(temporary, commit);
      return {
        path: temporary,
        manifest,
        cleanup: () => rm(temporary, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  const destination = join(context.artifactCacheRoot, commit);
  const cached = await lstat(join(destination, "manifest.json")).then(() => true).catch(() => false);
  if (cached) return { path: destination, manifest: await verifyArtifact(destination, commit) };

  await mkdir(context.artifactCacheRoot, { recursive: true, mode: 0o700 });
  const temporary = join(context.artifactCacheRoot, `.download-${commit}-${process.pid}-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await command([
      "gh", "run", "download", String(runId),
      "--name", `tally-release-${commit}`,
      "--dir", temporary,
    ], { cwd: context.repositoryRoot });
    const manifest = await verifyArtifact(temporary, commit);
    await rename(temporary, destination);
    return { path: destination, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function fetchWithTimeout(url: string | URL | Request): Promise<Response> {
  return fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
}

async function fetchHealth(url: string): Promise<ReleaseHealth> {
  const response = await fetchWithTimeout(`${url.replace(/\/$/, "")}/health`);
  if (!response.ok) throw new Error(`${url} health returned ${response.status}`);
  return response.json() as Promise<ReleaseHealth>;
}

async function restartApi(context: ReleaseContext): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The API release requires a Unix user identifier");
  await command(["launchctl", "kickstart", "-k", `gui/${uid}/${context.launchdLabel}`]);
}

async function verifyApiHealth(
  context: ReleaseContext,
  expectedCommit?: string,
): Promise<{ local: ReleaseHealth; public: ReleaseHealth }> {
  const healthOptions = { ...(expectedCommit ? { expectedCommit } : {}), timeoutMs: 30_000 };
  const [local, publicHealth] = await Promise.all([
    pollHealth(() => fetchHealth(context.localApiUrl), healthOptions),
    pollHealth(() => fetchHealth(context.publicApiUrl), healthOptions),
  ]);
  return { local, public: publicHealth };
}

async function createDatabaseSnapshot(
  context: ReleaseContext,
  previousCommit: string,
  nextCommit: string,
): Promise<string> {
  await mkdir(context.snapshotRoot, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const snapshot = join(
    context.snapshotRoot,
    `${previousCommit.slice(0, 12)}-to-${nextCommit.slice(0, 12)}-${timestamp}.sqlite`,
  );
  if (snapshot.includes("'")) throw new Error("Database snapshot path may not contain a single quote");
  const script = `
set -euo pipefail
set -a
source "$EXPENSES_ENV_FILE"
set +a
: "\${DATABASE_PATH:?Set DATABASE_PATH}"
sqlite3 "$DATABASE_PATH" ".backup '$TALLY_RELEASE_SNAPSHOT'"
`;
  await command(["/bin/zsh", "-c", script], {
    env: {
      EXPENSES_ENV_FILE: context.environmentPath,
      TALLY_RELEASE_SNAPSHOT: snapshot,
    },
  });
  if (!(await Bun.file(snapshot).exists())) throw new Error(`SQLite backup was not created: ${snapshot}`);
  await chmod(snapshot, 0o600);
  return snapshot;
}

async function rollbackApi(context: ReleaseContext, state: ApiDeploymentState): Promise<void> {
  print(`rolling API back to ${state.previousTarget}`);
  await atomicSwitchSymlink(join(context.runtimeRoot, "current"), state.previousTarget);
  await restartApi(context);
  await verifyApiHealth(context, state.previousIsLegacy ? undefined : state.previousCommit);
}

async function deployApi(
  context: ReleaseContext,
  artifactPath: string,
  manifest: ReleaseManifest,
): Promise<ApiDeploymentState> {
  const initialCurrent = await currentRuntimeTarget(context.runtimeRoot);
  let bootstrapped = false;
  if (!initialCurrent) {
    const legacy = await bootstrapLegacyRuntime(context.runtimeRoot, process.env.APP_VERSION ?? manifest.version);
    if (!legacy) throw new Error("Unable to preserve the legacy API runtime");
    bootstrapped = true;
    print(`preserved the existing API as ${legacy.target}`);
  }
  const environmentBackup = await ensureProductionServerEntry(
    context.environmentPath,
    join(context.runtimeRoot, "current/server/index.js"),
  );
  if (environmentBackup) print(`updated the production server entry; backup: ${environmentBackup}`);

  const previousTarget = await currentRuntimeTarget(context.runtimeRoot);
  if (!previousTarget) throw new Error("The API runtime has no current release");
  const previousIdentity = await readRuntimeIdentity(context.runtimeRoot, previousTarget);
  const release = await stageApiRelease(join(artifactPath, "api"), context.runtimeRoot);
  const snapshotPath = await createDatabaseSnapshot(context, previousIdentity.commit, release.commit);
  const switchedFrom = await atomicSwitchSymlink(join(context.runtimeRoot, "current"), release.target);
  if (switchedFrom !== previousTarget) throw new Error("The API current release changed during activation");

  const state: ApiDeploymentState = {
    previousTarget,
    previousCommit: previousIdentity.commit,
    previousIsLegacy: previousTarget.includes("/legacy-") || previousTarget.startsWith("releases/legacy-"),
    release,
    localHealth: { status: "pending", version: manifest.version, serverTime: "pending" },
    publicHealth: { status: "pending", version: manifest.version, serverTime: "pending" },
    snapshotPath,
  };

  try {
    await restartApi(context);
    const health = await verifyApiHealth(context, release.commit);
    state.localHealth = health.local;
    state.publicHealth = health.public;
    if (bootstrapped) print("production runner now follows runtime/current");
    return state;
  } catch (error) {
    return rollbackAndRethrow(
      error,
      () => rollbackApi(context, state),
      "API activation and rollback both failed",
    );
  }
}

async function wrangler(context: ReleaseContext, arguments_: string[]): Promise<CommandResult> {
  return command([context.wranglerPath, ...arguments_], { cwd: context.repositoryRoot });
}

async function currentWorkerVersion(context: ReleaseContext): Promise<string> {
  const result = await wrangler(context, [
    "deployments", "status", "--config", context.wranglerConfig, "--name", context.workerName, "--json",
  ]);
  const deployment = JSON.parse(result.stdout) as { versions?: Array<{ version_id?: string; percentage?: number }> };
  const active = deployment.versions?.find((version) => version.percentage === 100)?.version_id;
  if (!active) throw new Error("Cloudflare did not report an active 100% Worker version");
  return active;
}

async function liveWebCommit(context: ReleaseContext): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(`${context.webUrl.replace(/\/$/, "")}/release.json?before=${Date.now()}`);
    if (!response.ok) return undefined;
    const value = await response.json() as { commit?: string };
    return value.commit;
  } catch {
    return undefined;
  }
}

function expectedWebAssets(indexHtml: string): string[] {
  const assets = [...indexHtml.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((asset): asset is string => typeof asset === "string");
  if (assets.length === 0) throw new Error("The release index references no hashed assets");
  return [...new Set(assets)].sort();
}

function successfulWebMarker(context: ReleaseContext, commit: string): string {
  return join(context.artifactCacheRoot, ".successful-web", `${commit}.json`);
}

async function markSuccessfulWebArtifact(context: ReleaseContext, manifest: ReleaseManifest): Promise<void> {
  const marker = successfulWebMarker(context, manifest.commit);
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  const temporary = `${marker}.next-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify({
    schemaVersion: 1,
    commit: manifest.commit,
    version: manifest.version,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, marker);
}

async function cachedSuccessfulWebArtifact(
  context: ReleaseContext,
  commit: string,
): Promise<{ path: string; manifest: ReleaseManifest } | null> {
  const marker = successfulWebMarker(context, commit);
  if (!(await Bun.file(marker).exists())) return null;
  const markerValue = JSON.parse(await readFile(marker, "utf8")) as { commit?: string };
  if (markerValue.commit !== commit) throw new Error(`Successful web marker does not match ${commit}`);
  const path = join(context.artifactCacheRoot, commit);
  return { path, manifest: await verifyArtifact(path, commit) };
}

async function rollbackWeb(context: ReleaseContext, previousVersion: string, previousCommit?: string): Promise<void> {
  if (previousCommit) {
    try {
      const cached = await cachedSuccessfulWebArtifact(context, previousCommit);
      if (cached) {
        print(`redeploying cached web artifact ${previousCommit}`);
        const indexHtml = await readFile(join(cached.path, cached.manifest.targets.web.entrypoint), "utf8");
        await wrangler(context, [
          "deploy",
          "--config", context.wranglerConfig,
          "--name", context.workerName,
          "--assets", join(cached.path, "web"),
        ]);
        await pollWebDeployment(fetchWithTimeout, {
          baseUrl: context.webUrl,
          expectedCommit: previousCommit,
          expectedAssets: expectedWebAssets(indexHtml),
          timeoutMs: WEB_DEPLOYMENT_TIMEOUT_MS,
        });
        return;
      }
    } catch {
      print(`cached web rollback failed; falling back to Cloudflare version ${previousVersion}`);
    }
  }
  print(`rolling web back to Cloudflare version ${previousVersion}`);
  await wrangler(context, [
    "rollback", previousVersion,
    "--config", context.wranglerConfig,
    "--name", context.workerName,
    "--message", "Automatic rollback after failed Tallied release verification",
    "--yes",
  ]);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= 30_000) {
    if ((await currentWorkerVersion(context)) === previousVersion) break;
    await Bun.sleep(500);
  }
  if ((await currentWorkerVersion(context)) !== previousVersion) {
    throw new Error(`Cloudflare rollback did not activate version ${previousVersion}`);
  }
  const response = await fetchWithTimeout(`${context.webUrl}?rollback=${Date.now()}`);
  if (!response.ok) throw new Error(`Rolled-back web root returned ${response.status}`);
  if (previousCommit) {
    const metadata = await fetchWithTimeout(`${context.webUrl}/release.json?rollback=${Date.now()}`);
    const value = metadata.ok ? await metadata.json() as { commit?: string } : {};
    if (value.commit !== previousCommit) throw new Error(`Web rollback reports ${value.commit ?? "no commit"}`);
  }
}

async function deployWeb(
  context: ReleaseContext,
  artifactPath: string,
  manifest: ReleaseManifest,
): Promise<WebDeploymentState> {
  const previousVersion = await currentWorkerVersion(context);
  const previousCommit = await liveWebCommit(context);
  const indexHtml = await readFile(join(artifactPath, manifest.targets.web.entrypoint), "utf8");
  const expectedAssets = expectedWebAssets(indexHtml);
  try {
    await wrangler(context, [
      "deploy",
      "--config", context.wranglerConfig,
      "--name", context.workerName,
      "--assets", join(artifactPath, "web"),
    ]);
    const version = await currentWorkerVersion(context);
    if (version === previousVersion) throw new Error("Cloudflare Worker version did not change");
    await pollWebDeployment(fetchWithTimeout, {
      baseUrl: context.webUrl,
      expectedCommit: manifest.commit,
      expectedAssets,
      timeoutMs: WEB_DEPLOYMENT_TIMEOUT_MS,
    });
    await markSuccessfulWebArtifact(context, manifest);
    return { previousVersion, ...(previousCommit ? { previousCommit } : {}), version };
  } catch (error) {
    return rollbackAndRethrow(
      error,
      () => rollbackWeb(context, previousVersion, previousCommit),
      "Web deployment and rollback both failed",
    );
  }
}

async function writeHistory(context: ReleaseContext, history: ReleaseHistory): Promise<void> {
  await mkdir(context.historyRoot, { recursive: true, mode: 0o700 });
  const filename = `${history.startedAt.replace(/[-:.]/g, "")}-${history.commit.slice(0, 12)}-${history.mode}.json`;
  const destination = join(context.historyRoot, filename);
  const temporary = `${destination}.next-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function assertApiPrerequisites(context: ReleaseContext): Promise<void> {
  requireExecutable("launchctl");
  requireExecutable("sqlite3");
  if (!(await Bun.file(context.environmentPath).exists())) throw new Error(`Production environment file is missing: ${context.environmentPath}`);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The API release requires a Unix user identifier");
  await Promise.all([
    access(context.runtimeRoot, filesystemConstants.R_OK | filesystemConstants.W_OK),
    access(context.environmentPath, filesystemConstants.R_OK),
    access(dirname(context.environmentPath), filesystemConstants.W_OK),
    command(["launchctl", "print", `gui/${uid}/${context.launchdLabel}`]),
    command(["sqlite3", "--version"]),
  ]);
}

async function run(): Promise<void> {
  const releaseArguments = parseReleaseArgs(Bun.argv.slice(2));
  const operations = planReleaseOperations(releaseArguments);
  const context = contextFromEnvironment();
  const startedAt = new Date().toISOString();
  const timingsMs: Record<string, number> = {};
  requireExecutable("git");
  requireExecutable("gh");

  const repository = await timedInto(timingsMs, "Repository gates", () => repositoryPreflight(context));
  if (repository.untracked.length > 0) print(`warning: ignoring ${repository.untracked.length} untracked path(s)`);
  const ciRun = await timedInto(timingsMs, "CI verification", () => successfulCiRun(context, repository.commit));
  const artifact = await timedInto(timingsMs, "Artifact download and verification", () => obtainArtifact(
    context,
    repository.commit,
    ciRun.databaseId,
    !releaseArguments.dryRun,
  ));
  const history: ReleaseHistory = {
    schemaVersion: 1,
    commit: repository.commit,
    version: artifact.manifest.version,
    mode: releaseArguments.mode,
    startedAt,
    status: "running",
    dryRun: releaseArguments.dryRun,
    ciRunId: ciRun.databaseId,
    timingsMs,
  };

  try {
    if (operations.includeWeb) {
      if (!(await Bun.file(context.wranglerPath).exists())) throw new Error("Pinned Wrangler executable is missing; run bun install --frozen-lockfile");
      await timed(history, "Cloudflare authentication", () => wrangler(context, ["whoami"]).then(() => undefined));
    }
    if (operations.includeApi) await assertApiPrerequisites(context);

    if (releaseArguments.dryRun) {
      if (operations.includeWeb) {
        await timed(history, "Wrangler dry run", () => wrangler(context, [
          "deploy", "--dry-run", "--config", context.wranglerConfig,
          "--name", context.workerName,
          "--assets", join(artifact.path, "web"),
        ]).then(() => undefined));
      }
      print(`dry run passed for ${repository.commit}`);
      return;
    }

    let apiState: ApiDeploymentState | undefined;
    if (operations.mutateApi) {
      apiState = await timed(history, "API activation", () => deployApi(context, artifact.path, artifact.manifest));
      history.api = {
        previousTarget: apiState.previousTarget,
        previousCommit: apiState.previousCommit,
        target: apiState.release.target,
        snapshotPath: apiState.snapshotPath,
      };
    }
    if (operations.mutateWeb) {
      try {
        const webState = await timed(history, "Web deployment", () => deployWeb(context, artifact.path, artifact.manifest));
        history.web = webState;
      } catch (error) {
        if (apiState) {
          return await rollbackAndRethrow(
            error,
            () => rollbackApi(context, apiState),
            "Web deployment failed and API rollback also failed",
          );
        }
        throw error;
      }
    }
    history.status = "succeeded";
    history.finishedAt = new Date().toISOString();
    await writeHistory(context, history);
    print(`released ${repository.commit} (${releaseArguments.mode})`);
  } catch (error) {
    if (!releaseArguments.dryRun) {
      history.status = "failed";
      history.finishedAt = new Date().toISOString();
      history.error = error instanceof Error ? error.message : String(error);
      await writeHistory(context, history).catch(() => undefined);
    }
    throw error;
  } finally {
    await artifact.cleanup?.();
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(`[tally-release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
