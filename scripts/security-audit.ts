import { existsSync, readFileSync } from "node:fs";

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
    ...(input ? { stdin: input } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim());
  return result.stdout;
}

async function commandAsync(arguments_: string[], input?: Uint8Array): Promise<Uint8Array> {
  const process = Bun.spawn(arguments_, {
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
  const blobs = new Map<string, Uint8Array>();
  for (let offset = 0; offset < objectIds.length; offset += 24) {
    const entries = await Promise.all(
      objectIds.slice(offset, offset + 24).map(async (objectId) =>
        [objectId, await commandAsync(["git", "cat-file", "blob", objectId])] as const),
    );
    for (const [objectId, bytes] of entries) blobs.set(objectId, bytes);
  }
  return blobs;
}

async function scanTrackedTree(): Promise<Array<{ target: string; detectors: string[] }>> {
  const results: Array<{ target: string; detectors: string[] }> = [];
  const modified = modifiedTrackedFiles();
  const indexedFiles = trackedIndexFiles();
  const blobs = await indexedBlobs(indexedFiles.filter(({ path }) => !modified.has(path)));
  for (const { path, objectId } of indexedFiles) {
    if (modified.has(path) && !existsSync(path)) continue;
    if (/\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example")) {
      results.push({ target: path, detectors: ["tracked environment file"] });
      continue;
    }
    if (/\.(?:sqlite|db|pem|p12|pfx|key)$/i.test(path)) {
      results.push({ target: path, detectors: ["tracked sensitive file type"] });
      continue;
    }
    const bytes = modified.has(path) ? readFileSync(path) : blobs.get(objectId);
    if (!bytes) throw new Error(`Missing indexed Git blob for ${path}`);
    if (bytes.includes(0)) continue;
    const detected = findings(bytes.toString("utf8"), true);
    if (detected.length) results.push({ target: path, detectors: detected });
  }
  return results;
}

function scanEveryLocalGitBlob(): Array<{ target: string; detectors: string[] }> {
  const listing = new TextDecoder().decode(command([
    "git",
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  ]));
  const results: Array<{ target: string; detectors: string[] }> = [];
  for (const line of listing.trim().split("\n")) {
    const [objectId, type, sizeValue] = line.split(" ");
    const size = Number(sizeValue);
    if (!objectId || type !== "blob" || !Number.isFinite(size) || size > 2_000_000) continue;
    const bytes = command(["git", "cat-file", "blob", objectId]);
    if (bytes.includes(0)) continue;
    const detected = findings(new TextDecoder().decode(bytes), false);
    if (detected.length) results.push({ target: `git object ${objectId}`, detectors: detected });
  }
  return results;
}

const allObjects = Bun.argv.includes("--all-objects");
const results = [...await scanTrackedTree(), ...(allObjects ? scanEveryLocalGitBlob() : [])];
if (results.length) {
  for (const result of results) console.error(`${result.target}: ${result.detectors.join(", ")}`);
  console.error("Security audit failed. Values are intentionally omitted from this report.");
  process.exit(1);
}
console.info(`Security audit passed (${allObjects ? "tracked tree and every local Git blob" : "tracked tree"}).`);
