import type { SourceOptions } from "./types";

export const IMPORT_FILE_LIMIT = 20;
export const IMPORT_FILE_BYTES_LIMIT = 10 * 1024 * 1024;
export const IMPORT_TOTAL_BYTES_LIMIT = 50 * 1024 * 1024;
export const IMPORT_ROW_LIMIT = 100_000;
export const IMPORT_MOBILE_ROW_LIMIT = 10_000;

export function migrationRowLimit(isCoarsePointer: boolean): number {
  return isCoarsePointer ? IMPORT_MOBILE_ROW_LIMIT : IMPORT_ROW_LIMIT;
}

export type ImportFileKind = "csv" | "json";

export function supportedImportFileKind(name: string, mimeType = ""): ImportFileKind | undefined {
  const lowerName = name.trim().toLowerCase();
  const normalizedMime = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const genericMime = !normalizedMime || normalizedMime === "text/plain" || normalizedMime === "application/octet-stream";
  if (lowerName.endsWith(".csv") && (genericMime || normalizedMime === "text/csv" || normalizedMime === "application/csv")) return "csv";
  if (lowerName.endsWith(".json") && (genericMime || normalizedMime === "application/json" || normalizedMime === "text/json")) return "json";
  return undefined;
}

export function sourceRowLimit(options: SourceOptions): number {
  return Number.isSafeInteger(options.maxRows) && (options.maxRows ?? 0) > 0
    ? Math.min(options.maxRows!, IMPORT_ROW_LIMIT)
    : IMPORT_ROW_LIMIT;
}

export function sourceRowLimitMessage(maxRows: number, fallbackNoun: "rows" | "expenses"): string {
  if (maxRows < IMPORT_ROW_LIMIT) {
    return `This phone supports up to ${maxRows.toLocaleString("en-US")} ${maxRows === 1 ? "entry" : "entries"} in one migration. Use Tallied on a desktop for exports up to ${IMPORT_ROW_LIMIT.toLocaleString("en-US")}.`;
  }
  const noun = maxRows === 1 ? (fallbackNoun === "rows" ? "row" : "expense") : fallbackNoun;
  return `This ${fallbackNoun === "rows" ? "file" : "backup"} contains more than ${maxRows.toLocaleString("en-US")} ${noun}`;
}
