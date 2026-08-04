import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type ReleaseMode = "web" | "api" | "all";

export interface ReleaseArguments {
  mode: ReleaseMode;
  dryRun: boolean;
}

export interface ReleaseOperations {
  includeWeb: boolean;
  includeApi: boolean;
  mutateWeb: boolean;
  mutateApi: boolean;
}

export interface RepositoryState {
  branch: string;
  trackedDirty: boolean;
  ahead: number;
  behind: number;
}

export interface CiRun {
  databaseId: number;
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
}

export interface ReleaseIdentity {
  schemaVersion: 1;
  version: string;
  commit: string;
  builtAt: string;
}

export interface ReleaseManifest extends ReleaseIdentity {
  files: Record<string, string>;
  targets: {
    web: { entrypoint: string; releaseMetadata: string };
    api: { entrypoint: string; releaseMetadata: string; migrations: string[] };
  };
}

export interface ReleaseHealth {
  status: string;
  version: string;
  commit?: string;
  builtAt?: string;
  serverTime: string;
}

export function parseReleaseArgs(arguments_: string[]): ReleaseArguments {
  let mode: ReleaseMode = "all";
  let modeWasSet = false;
  let dryRun = false;

  for (const argument of arguments_) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "web" || argument === "api" || argument === "all") {
      if (modeWasSet) throw new Error("Specify only one release target: web, api, or all");
      mode = argument;
      modeWasSet = true;
      continue;
    }
    throw new Error(`Unknown release option: ${argument}`);
  }

  return { mode, dryRun };
}

export function planReleaseOperations(arguments_: ReleaseArguments): ReleaseOperations {
  const includeWeb = arguments_.mode !== "api";
  const includeApi = arguments_.mode !== "web";
  return {
    includeWeb,
    includeApi,
    mutateWeb: includeWeb && !arguments_.dryRun,
    mutateApi: includeApi && !arguments_.dryRun,
  };
}

export function assertRepositoryReady(state: RepositoryState): void {
  if (state.branch !== "main") throw new Error(`Production releases must run from main, not ${state.branch}`);
  if (state.trackedDirty) throw new Error("Production releases require a working tree without tracked changes");
  if (state.ahead !== 0 || state.behind !== 0) {
    throw new Error(`HEAD must exactly match origin/main (ahead ${state.ahead}, behind ${state.behind})`);
  }
}

export function selectSuccessfulCiRun(runs: CiRun[], commit: string): CiRun {
  const run = runs.find(
    (candidate) =>
      candidate.headSha === commit &&
      candidate.event === "push" &&
      candidate.status === "completed" &&
      candidate.conclusion === "success",
  );
  if (!run) throw new Error(`No successful CI push run exists for ${commit}`);
  return run;
}

function assertSafeRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe artifact path: ${path}`);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        result.push(relative(root, absolute).split(sep).join("/"));
      } else {
        throw new Error(`Release artifacts may not contain symbolic links: ${absolute}`);
      }
    }
  }

  await visit(resolve(root));
  return result;
}

export async function buildChecksums(root: string, files: string[]): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  for (const file of [...files].sort()) {
    assertSafeRelativePath(file);
    checksums[file] = await sha256File(resolve(root, file));
  }
  return checksums;
}

export async function verifyChecksums(root: string, checksums: Record<string, string>): Promise<void> {
  for (const [file, expected] of Object.entries(checksums).sort(([left], [right]) => left.localeCompare(right))) {
    assertSafeRelativePath(file);
    const actual = await sha256File(resolve(root, file)).catch(() => "missing");
    if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: expected ${expected}, received ${actual}`);
  }
}

const destructiveMigrationPatterns = [
  /\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bUPDATE\s+["`\[]?[A-Za-z_]/i,
  /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i,
  /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i,
  /\bREPLACE\s+INTO\b/i,
];

export function assertBackwardCompatibleMigration(sql: string, filename: string): void {
  const withoutComments = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (destructiveMigrationPatterns.some((pattern) => pattern.test(withoutComments))) {
    throw new Error(`Migration ${filename} is not rollback-safe; use an expand/contract migration`);
  }
}

export async function atomicSwitchSymlink(currentPath: string, nextTarget: string): Promise<string | null> {
  await mkdir(dirname(currentPath), { recursive: true });
  let previous: string | null = null;
  try {
    const stat = await lstat(currentPath);
    if (!stat.isSymbolicLink()) throw new Error(`${currentPath} exists but is not a symbolic link`);
    previous = await readlink(currentPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const temporaryPath = `${currentPath}.next-${process.pid}-${randomUUID()}`;
  await symlink(nextTarget, temporaryPath);
  try {
    await rename(temporaryPath, currentPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return previous;
}

export async function rollbackAndRethrow(
  originalError: unknown,
  rollback: () => Promise<void>,
  message: string,
): Promise<never> {
  try {
    await rollback();
  } catch (rollbackError) {
    throw new AggregateError([originalError, rollbackError], message);
  }
  throw originalError;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function upsertEnvAssignment(source: string, key: string, value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
  const assignment = `${key}=${shellQuote(value)}`;
  const lines = source.split("\n");
  let replaced = false;
  const output = lines.map((line) => {
    if (new RegExp(`^${key}=`).test(line)) {
      if (replaced) return null;
      replaced = true;
      return assignment;
    }
    return line;
  }).filter((line): line is string => line !== null);
  if (!replaced) {
    if (output.at(-1) !== "") output.push("");
    output.push(assignment, "");
  }
  return output.join("\n");
}

export async function pollHealth(
  request: () => Promise<ReleaseHealth>,
  options: { expectedCommit?: string; timeoutMs: number; delaysMs?: number[] },
): Promise<ReleaseHealth> {
  const startedAt = Date.now();
  const delays = options.delaysMs ?? [0, 250, 500, 1_000, 2_000, 3_000];
  let lastError: unknown;

  for (let index = 0; Date.now() - startedAt <= options.timeoutMs; index += 1) {
    const delay = delays[Math.min(index, delays.length - 1)] ?? 0;
    if (delay > 0) await Bun.sleep(delay);
    try {
      const health = await request();
      if (health.status !== "ok") throw new Error(`Health status is ${health.status}`);
      if (options.expectedCommit && health.commit !== options.expectedCommit) {
        throw new Error(`Expected commit ${options.expectedCommit}, received ${health.commit ?? "none"}`);
      }
      return health;
    } catch (error) {
      lastError = error;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown health failure");
  throw new Error(`Health verification failed${options.expectedCommit ? ` for ${options.expectedCommit}` : ""}: ${reason}`);
}

export interface WebDeploymentResult {
  commit: string;
  version?: string;
  builtAt?: string;
}

export async function pollWebDeployment(
  fetcher: (input: string | URL | Request) => Promise<Response>,
  options: {
    baseUrl: string;
    expectedCommit: string;
    expectedAssets: string[];
    timeoutMs: number;
    delaysMs?: number[];
  },
): Promise<WebDeploymentResult> {
  const startedAt = Date.now();
  const delays = options.delaysMs ?? [0, 250, 500, 1_000, 2_000, 3_000];
  let lastError: unknown;

  for (let index = 0; Date.now() - startedAt <= options.timeoutMs; index += 1) {
    const delay = delays[Math.min(index, delays.length - 1)] ?? 0;
    if (delay > 0) await Bun.sleep(delay);
    const cacheBust = encodeURIComponent(`${options.expectedCommit}-${Date.now()}`);
    try {
      const [metadataResponse, indexResponse, workerResponse, manifestResponse] = await Promise.all([
        fetcher(new URL(`/release.json?release=${cacheBust}`, options.baseUrl)),
        fetcher(new URL(`/?release=${cacheBust}`, options.baseUrl)),
        fetcher(new URL(`/tally-sw.js?release=${cacheBust}`, options.baseUrl)),
        fetcher(new URL(`/manifest.webmanifest?release=${cacheBust}`, options.baseUrl)),
      ]);
      if (!metadataResponse.ok) throw new Error(`release metadata returned ${metadataResponse.status}`);
      if (!indexResponse.ok) throw new Error(`index returned ${indexResponse.status}`);
      if (!workerResponse.ok) throw new Error(`service worker returned ${workerResponse.status}`);
      if (!manifestResponse.ok) throw new Error(`manifest returned ${manifestResponse.status}`);

      const metadata = await metadataResponse.json() as WebDeploymentResult;
      if (metadata.commit !== options.expectedCommit) {
        throw new Error(`release metadata reports ${metadata.commit ?? "no commit"}`);
      }
      const html = await indexResponse.text();
      for (const asset of options.expectedAssets) {
        if (!html.includes(asset)) throw new Error(`index does not reference ${asset}`);
      }
      const workerCacheControl = workerResponse.headers.get("cache-control")?.toLowerCase() ?? "";
      if (!/(?:no-cache|no-store|max-age=0)/.test(workerCacheControl)) {
        throw new Error(`service worker cache policy is unsafe: ${workerCacheControl || "missing"}`);
      }
      const manifest = await manifestResponse.json() as { name?: string };
      if (manifest.name !== "Tallied") throw new Error(`manifest name is ${manifest.name ?? "missing"}`);
      return metadata;
    } catch (error) {
      lastError = error;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown web failure");
  throw new Error(`Web release verification failed for ${options.expectedCommit}: ${reason}`);
}
