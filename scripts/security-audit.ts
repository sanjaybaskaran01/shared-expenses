import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

interface Detector {
  name: string;
  pattern: RegExp;
}

const highConfidenceDetectors: Detector[] = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "Google OAuth client secret", pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "AWS access key", pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/ },
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: "Stripe live key", pattern: /(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: "credential-bearing URL", pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@/]+@/ },
];

const assignmentPattern = /\b[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?([A-Za-z0-9_+/.=-]{16,})/g;
const propertyAssignmentPattern = /\b(?:authSecret|clientSecret|appPassword|password|token|apiKey)\s*:\s*["']([^"']{16,})["']/gi;
const safeValue = /(example|replace|placeholder|development|test-only|not-a-real|fake|mock|fixture|secrets\.|process\.env)/i;

function findings(content: string, includeGenericAssignments: boolean): string[] {
  const detected = highConfidenceDetectors
    .filter((detector) => detector.pattern.test(content))
    .map((detector) => detector.name);
  if (includeGenericAssignments) {
    for (const match of content.matchAll(assignmentPattern)) {
      const value = match[1] ?? "";
      if (!safeValue.test(value)) detected.push("credential-like assignment");
    }
    for (const match of content.matchAll(propertyAssignmentPattern)) {
      const value = match[1] ?? "";
      if (!safeValue.test(value)) detected.push("credential-like object property");
    }
  }
  return [...new Set(detected)];
}

function command(arguments_: string[], input?: Uint8Array): Uint8Array {
  const result = Bun.spawnSync(arguments_, {
    cwd: repositoryRoot,
    ...(input ? { stdin: input } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim());
  return result.stdout;
}

async function commandAsync(arguments_: string[], input?: Uint8Array): Promise<Uint8Array> {
  const process = Bun.spawn(arguments_, {
    cwd: repositoryRoot,
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const outputPromise = new Response(process.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer));
  const errorPromise = new Response(process.stderr).text();
  if (input) {
    const stdin = process.stdin;
    if (!stdin) throw new Error("Could not open command input");
    stdin.write(input);
    await stdin.end();
  }
  const [exitCode, output, errorOutput] = await Promise.all([
    process.exited,
    outputPromise,
    errorPromise,
  ]);
  if (exitCode !== 0) throw new Error(errorOutput.trim());
  return output;
}

interface TrackedIndexFile {
  path: string;
  objectId: string;
}

interface GitObject {
  objectId: string;
  type: string;
  bytes: Uint8Array;
}

function parseGitObjectBatch(objects: Uint8Array): GitObject[] {
  const parsed: GitObject[] = [];
  let offset = 0;
  while (offset < objects.length) {
    let headerEnd = offset;
    while (headerEnd < objects.length && objects[headerEnd] !== 10) headerEnd += 1;
    if (headerEnd === objects.length) throw new Error("Could not parse Git object batch header");
    const [objectId, type, sizeValue] = new TextDecoder().decode(objects.subarray(offset, headerEnd)).split(" ");
    const size = Number(sizeValue);
    if (!objectId || !type || !Number.isFinite(size) || size < 0) throw new Error("Could not parse Git object batch metadata");
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd > objects.length) throw new Error(`Truncated Git object ${objectId}`);
    parsed.push({ objectId, type, bytes: objects.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }
  return parsed;
}

function trackedIndexFiles(): TrackedIndexFile[] {
  return new TextDecoder().decode(command(["git", "ls-files", "--stage", "-z"]))
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^\d+ ([0-9a-f]+) \d+\t([\s\S]+)$/.exec(entry);
      if (!match?.[1] || !match[2]) throw new Error(`Could not parse tracked Git entry: ${entry}`);
      return { objectId: match[1], path: match[2] };
    });
}

function modifiedTrackedFiles(): Set<string> {
  return new Set(
    new TextDecoder().decode(command(["git", "ls-files", "--modified", "--deleted", "-z"]))
      .split("\0")
      .filter(Boolean),
  );
}

async function indexedBlobs(files: readonly TrackedIndexFile[]): Promise<Map<string, Uint8Array>> {
  const objectIds = [...new Set(files.map(({ objectId }) => objectId))];
  if (objectIds.length === 0) return new Map();
  const input = new TextEncoder().encode(`${objectIds.join("\n")}\n`);
  const objects = parseGitObjectBatch(await commandAsync(["git", "cat-file", "--batch"], input));
  return new Map(objects.map(({ objectId, bytes }) => [objectId, bytes]));
}

async function scanTrackedTree(): Promise<Array<{ target: string; detectors: string[] }>> {
  const results: Array<{ target: string; detectors: string[] }> = [];
  const modified = modifiedTrackedFiles();
  const indexedFiles = trackedIndexFiles();
  const blobs = await indexedBlobs(indexedFiles.filter(({ path }) => !modified.has(path)));
  for (const { path, objectId } of indexedFiles) {
    const absolutePath = resolve(repositoryRoot, path);
    if (modified.has(path) && !existsSync(absolutePath)) continue;
    if (/\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example")) {
      results.push({ target: path, detectors: ["tracked environment file"] });
      continue;
    }
    if (/\.(?:sqlite|db|pem|p12|pfx|key)$/i.test(path)) {
      results.push({ target: path, detectors: ["tracked sensitive file type"] });
      continue;
    }
    const bytes = modified.has(path) ? readFileSync(absolutePath) : blobs.get(objectId);
    if (!bytes) throw new Error(`Missing indexed Git blob for ${path}`);
    if (bytes.includes(0)) continue;
    const detected = findings(bytes.toString("utf8"), true);
    if (detected.length) results.push({ target: path, detectors: detected });
  }
  return results;
}

async function scanEveryLocalGitBlob(): Promise<Array<{ target: string; detectors: string[] }>> {
  const listing = new TextDecoder().decode(command([
    "git",
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  ]));
  const objectIds = listing.trim().split("\n").flatMap((line) => {
    const [objectId, type, sizeValue] = line.split(" ");
    const size = Number(sizeValue);
    return objectId && type === "blob" && Number.isFinite(size) && size <= 2_000_000 ? [objectId] : [];
  });
  const input = new TextEncoder().encode(`${objectIds.join("\n")}\n`);
  const objects = parseGitObjectBatch(await commandAsync(["git", "cat-file", "--batch"], input));
  const results: Array<{ target: string; detectors: string[] }> = [];
  for (const { objectId, type, bytes } of objects) {
    if (type === "blob" && bytes.length <= 2_000_000) {
      if (!bytes.includes(0)) {
        const detected = findings(new TextDecoder().decode(bytes), false);
        if (detected.length) results.push({ target: `git object ${objectId}`, detectors: detected });
      }
    }
  }
  return results;
}

const allObjects = Bun.argv.includes("--all-objects");
const results = [...await scanTrackedTree(), ...(allObjects ? await scanEveryLocalGitBlob() : [])];
if (results.length) {
  for (const result of results) console.error(`${result.target}: ${result.detectors.join(", ")}`);
  console.error("Security audit failed. Values are intentionally omitted from this report.");
  process.exit(1);
}
console.info(`Security audit passed (${allObjects ? "tracked tree and every local Git blob" : "tracked tree"}).`);
