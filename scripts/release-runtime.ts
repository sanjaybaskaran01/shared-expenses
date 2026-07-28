import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  atomicSwitchSymlink,
  buildChecksums,
  listFiles,
  sha256File,
  upsertEnvAssignment,
  verifyChecksums,
  type ReleaseIdentity,
} from "./release-lib";

export interface StagedApiRelease extends ReleaseIdentity {
  releasePath: string;
  target: string;
}

export interface LegacyRelease extends StagedApiRelease {}

async function readIdentity(path: string): Promise<ReleaseIdentity> {
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReleaseIdentity>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}$/i.test(value.commit) ||
    typeof value.builtAt !== "string" ||
    Number.isNaN(Date.parse(value.builtAt))
  ) {
    throw new Error(`Invalid release metadata: ${path}`);
  }
  return {
    schemaVersion: 1,
    version: value.version,
    commit: value.commit.toLowerCase(),
    builtAt: value.builtAt,
  };
}

async function verifyApiDirectory(path: string): Promise<ReleaseIdentity> {
  const identity = await readIdentity(join(path, "release.json"));
  const checksums = JSON.parse(await readFile(join(path, "checksums.json"), "utf8")) as Record<string, string>;
  await verifyChecksums(path, checksums);
  if (!(await Bun.file(join(path, "server/index.js")).exists())) throw new Error("API artifact is missing server/index.js");
  const migrations = await readdir(join(path, "migrations")).catch(() => []);
  if (!migrations.some((name) => name.endsWith(".sql"))) throw new Error("API artifact contains no migrations");
  return identity;
}

function releaseTarget(runtimeRoot: string, releasePath: string): string {
  return relative(resolve(runtimeRoot), resolve(releasePath)).split(sep).join("/");
}

export async function stageApiRelease(apiArtifactPath: string, runtimeRoot: string): Promise<StagedApiRelease> {
  const source = resolve(apiArtifactPath);
  const runtime = resolve(runtimeRoot);
  const identity = await verifyApiDirectory(source);
  const releases = join(runtime, "releases");
  const releasePath = join(releases, identity.commit);
  await mkdir(releases, { recursive: true, mode: 0o700 });

  if (await lstat(releasePath).then(() => true).catch(() => false)) {
    const existing = await verifyApiDirectory(releasePath);
    if (existing.commit !== identity.commit) throw new Error(`Existing release does not match ${identity.commit}`);
    return { ...existing, releasePath, target: releaseTarget(runtime, releasePath) };
  }

  const staging = join(releases, `.staging-${identity.commit}-${process.pid}-${randomUUID()}`);
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
    await chmod(staging, 0o700);
    await verifyApiDirectory(staging);
    await rename(staging, releasePath);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { ...identity, releasePath, target: releaseTarget(runtime, releasePath) };
}

export async function bootstrapLegacyRuntime(
  runtimeRoot: string,
  version: string,
  builtAt = new Date().toISOString(),
): Promise<LegacyRelease | null> {
  const runtime = resolve(runtimeRoot);
  const current = join(runtime, "current");
  const currentStat = await lstat(current).catch(() => null);
  if (currentStat) {
    if (!currentStat.isSymbolicLink()) throw new Error(`${current} exists but is not a symbolic link`);
    return null;
  }

  const legacyServer = join(runtime, "server/index.js");
  const legacyMigrations = join(runtime, "migrations");
  if (!(await Bun.file(legacyServer).exists())) throw new Error(`Legacy API entry does not exist: ${legacyServer}`);
  const migrationNames = (await readdir(legacyMigrations)).filter((name) => name.endsWith(".sql")).sort();
  if (migrationNames.length === 0) throw new Error(`Legacy migrations do not exist: ${legacyMigrations}`);

  const commit = (await sha256File(legacyServer)).slice(0, 40);
  const releaseName = `legacy-${commit.slice(0, 12)}`;
  const releasePath = join(runtime, "releases", releaseName);
  await mkdir(join(releasePath, "server"), { recursive: true, mode: 0o700 });
  await mkdir(join(releasePath, "migrations"), { recursive: true, mode: 0o700 });
  await copyFile(legacyServer, join(releasePath, "server/index.js"));
  for (const name of migrationNames) await copyFile(join(legacyMigrations, name), join(releasePath, "migrations", name));

  const identity: ReleaseIdentity = { schemaVersion: 1, version, commit, builtAt };
  await writeFile(join(releasePath, "release.json"), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  const files = (await listFiles(releasePath)).filter((file) => file !== "checksums.json");
  await writeFile(
    join(releasePath, "checksums.json"),
    `${JSON.stringify(await buildChecksums(releasePath, files), null, 2)}\n`,
    { mode: 0o600 },
  );
  const target = releaseTarget(runtime, releasePath);
  await atomicSwitchSymlink(current, target);
  return { ...identity, releasePath, target };
}

export async function updateProductionServerEntry(
  environmentPath: string,
  serverEntry: string,
  timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z"),
): Promise<string> {
  const path = resolve(environmentPath);
  const information = await stat(path);
  const source = await readFile(path, "utf8");
  const updated = upsertEnvAssignment(source, "EXPENSES_SERVER_ENTRY", resolve(serverEntry));
  const backup = `${path}.before-release-pipeline-${timestamp}`;
  await copyFile(path, backup);
  await chmod(backup, information.mode & 0o777);

  const temporary = join(dirname(path), `.${basename(path)}.next-${process.pid}-${randomUUID()}`);
  await writeFile(temporary, updated, { mode: information.mode & 0o777 });
  await rename(temporary, path);
  return backup;
}

export async function ensureProductionServerEntry(
  environmentPath: string,
  serverEntry: string,
): Promise<string | null> {
  const path = resolve(environmentPath);
  const source = await readFile(path, "utf8");
  const updated = upsertEnvAssignment(source, "EXPENSES_SERVER_ENTRY", resolve(serverEntry));
  if (updated === source) return null;
  return updateProductionServerEntry(path, serverEntry);
}

export async function currentRuntimeTarget(runtimeRoot: string): Promise<string | null> {
  const path = join(resolve(runtimeRoot), "current");
  const information = await lstat(path).catch(() => null);
  if (!information) return null;
  if (!information.isSymbolicLink()) throw new Error(`${path} exists but is not a symbolic link`);
  return readlink(path);
}

export async function readRuntimeIdentity(runtimeRoot: string, target: string): Promise<ReleaseIdentity> {
  return readIdentity(resolve(runtimeRoot, target, "release.json"));
}
