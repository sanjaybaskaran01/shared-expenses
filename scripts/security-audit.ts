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

function trackedFiles(): string[] {
  return new TextDecoder().decode(command(["git", "ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
}

function scanTrackedTree(): Array<{ target: string; detectors: string[] }> {
  const results: Array<{ target: string; detectors: string[] }> = [];
  for (const path of trackedFiles()) {
    if (!existsSync(path)) continue;
    if (/\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example")) {
      results.push({ target: path, detectors: ["tracked environment file"] });
      continue;
    }
    if (/\.(?:sqlite|db|pem|p12|pfx|key)$/i.test(path)) {
      results.push({ target: path, detectors: ["tracked sensitive file type"] });
      continue;
    }
    const bytes = readFileSync(path);
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
const results = [...scanTrackedTree(), ...(allObjects ? scanEveryLocalGitBlob() : [])];
if (results.length) {
  for (const result of results) console.error(`${result.target}: ${result.detectors.join(", ")}`);
  console.error("Security audit failed. Values are intentionally omitted from this report.");
  process.exit(1);
}
console.info(`Security audit passed (${allObjects ? "tracked tree and every local Git blob" : "tracked tree"}).`);
