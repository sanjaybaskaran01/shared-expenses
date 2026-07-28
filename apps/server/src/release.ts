import { readFileSync } from "node:fs";

export interface RuntimeReleaseMetadata {
  version: string;
  commit: string;
  builtAt: string;
}

interface ReleaseFile {
  schemaVersion?: unknown;
  version?: unknown;
  commit?: unknown;
  builtAt?: unknown;
}

interface ValidReleaseFile {
  schemaVersion: 1;
  version: string;
  commit: string;
  builtAt: string;
}

function validReleaseFile(value: ReleaseFile): value is ValidReleaseFile {
  return value.schemaVersion === 1 &&
    typeof value.version === "string" && value.version.length > 0 &&
    typeof value.commit === "string" && /^[a-f0-9]{40}$/i.test(value.commit) &&
    typeof value.builtAt === "string" && !Number.isNaN(Date.parse(value.builtAt));
}

export function loadReleaseMetadata(
  path: string,
  environment: Record<string, string | undefined> = process.env,
): RuntimeReleaseMetadata {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ReleaseFile;
    if (!validReleaseFile(value)) throw new Error("Release metadata is invalid");
    return { version: value.version, commit: value.commit.toLowerCase(), builtAt: value.builtAt };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return {
      version: environment.APP_VERSION ?? "dev",
      commit: environment.APP_COMMIT ?? "dev",
      builtAt: environment.APP_BUILT_AT ?? "dev",
    };
  }
}
