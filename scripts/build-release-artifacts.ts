import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertBackwardCompatibleMigration,
  buildChecksums,
  listFiles,
  type ReleaseIdentity,
  type ReleaseManifest,
} from "./release-lib";

export interface BuildReleaseArtifactsOptions {
  repositoryRoot: string;
  outputDirectory: string;
  commit: string;
  version: string;
  builtAt: string;
}

function assertCommit(commit: string): void {
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("Release commit must be a full 40-character Git SHA");
}

function assertSafeGeneratedDirectory(repositoryRoot: string, outputDirectory: string): void {
  const relativePath = relative(resolve(repositoryRoot), resolve(outputDirectory));
  const rootSegment = relativePath.split(sep)[0];
  if (
    !relativePath ||
    relativePath === "." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    (rootSegment !== ".release" && rootSegment !== "release-artifact")
  ) {
    throw new Error(`Release output must be a generated directory inside the repository: ${outputDirectory}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

export async function buildReleaseArtifacts(options: BuildReleaseArtifactsOptions): Promise<ReleaseManifest> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const outputDirectory = resolve(options.outputDirectory);
  assertCommit(options.commit);
  assertSafeGeneratedDirectory(repositoryRoot, outputDirectory);

  const webSource = resolve(repositoryRoot, "apps/web/dist");
  const serverSource = resolve(repositoryRoot, "apps/server/dist/index.js");
  const migrationsSource = resolve(repositoryRoot, "apps/server/migrations");
  for (const required of [webSource, serverSource, migrationsSource]) {
    if (!(await Bun.file(required).exists()) && !(await readdir(required).then(() => true).catch(() => false))) {
      throw new Error(`Required release input does not exist: ${required}`);
    }
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(resolve(outputDirectory, "web"), { recursive: true });
  await mkdir(resolve(outputDirectory, "api/server"), { recursive: true });
  await mkdir(resolve(outputDirectory, "api/migrations"), { recursive: true });

  await cp(webSource, resolve(outputDirectory, "web"), {
    recursive: true,
    filter(source) {
      const name = basename(source);
      return !name.endsWith(".map") && name !== "brand-concept.png";
    },
  });
  await cp(serverSource, resolve(outputDirectory, "api/server/index.js"));

  const migrationNames = (await readdir(migrationsSource))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrationNames.length === 0) throw new Error("The API release must include at least one SQL migration");
  for (const name of migrationNames) {
    const sql = await readFile(resolve(migrationsSource, name), "utf8");
    assertBackwardCompatibleMigration(sql, name);
    await writeFile(resolve(outputDirectory, "api/migrations", name), sql, { mode: 0o644 });
  }

  const identity: ReleaseIdentity = {
    schemaVersion: 1,
    version: options.version,
    commit: options.commit.toLowerCase(),
    builtAt: options.builtAt,
  };
  await writeJson(resolve(outputDirectory, "web/release.json"), identity);
  await writeJson(resolve(outputDirectory, "api/release.json"), identity);

  const apiFiles = (await listFiles(resolve(outputDirectory, "api"))).filter((file) => file !== "checksums.json");
  const apiChecksums = await buildChecksums(resolve(outputDirectory, "api"), apiFiles);
  await writeJson(resolve(outputDirectory, "api/checksums.json"), apiChecksums);

  const artifactFiles = (await listFiles(outputDirectory)).filter((file) => file !== "manifest.json");
  const manifest: ReleaseManifest = {
    ...identity,
    files: await buildChecksums(outputDirectory, artifactFiles),
    targets: {
      web: { entrypoint: "web/index.html", releaseMetadata: "web/release.json" },
      api: {
        entrypoint: "api/server/index.js",
        releaseMetadata: "api/release.json",
        migrations: migrationNames.map((name) => `api/migrations/${name}`),
      },
    },
  };
  await writeJson(resolve(outputDirectory, "manifest.json"), manifest);
  return manifest;
}

function argumentValue(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as { version: string };
  const commit = argumentValue(Bun.argv.slice(2), "--commit") ?? process.env.GITHUB_SHA;
  if (!commit) throw new Error("Pass --commit or set GITHUB_SHA");
  const outputDirectory = resolve(
    repositoryRoot,
    argumentValue(Bun.argv.slice(2), "--output") ?? ".release/artifact",
  );
  const builtAt = argumentValue(Bun.argv.slice(2), "--built-at") ?? new Date().toISOString();
  const manifest = await buildReleaseArtifacts({
    repositoryRoot,
    outputDirectory,
    commit,
    version: packageJson.version,
    builtAt,
  });
  console.log(`Built Tallied release ${manifest.commit} at ${outputDirectory}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
