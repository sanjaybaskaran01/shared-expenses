import {
  parseDecimalToMinor,
  type ImportAmount,
  type ImportGroup,
  type ImportPerson,
  type ImportWarning,
  type NormalizedImportDraft,
  type NormalizedImportRecord,
} from "@expenses/protocol";
import type { SourceOptions } from "./types";

export function blankDraft(mode: NormalizedImportDraft["mode"], sourceHashes: string[] = []): NormalizedImportDraft {
  return {
    schemaVersion: 1,
    provider: "splitwise",
    mode,
    sourceHashes,
    people: [],
    groups: [],
    records: [],
    sourceBalances: [],
    warnings: [],
  };
}

const WARNING_DETAIL_LIMIT = 200;
const suppressedWarnings = new WeakMap<NormalizedImportDraft, { count: number; summary: ImportWarning }>();

export function appendWarning(draft: NormalizedImportDraft, item: ImportWarning): void {
  if (draft.warnings.length < WARNING_DETAIL_LIMIT) {
    draft.warnings.push(item);
    return;
  }
  const existing = suppressedWarnings.get(draft);
  if (existing) {
    existing.count += 1;
    existing.summary.blocking ||= item.blocking;
    existing.summary.message = `${existing.count.toLocaleString("en-US")} additional issues are hidden. Fix or remove the affected source files, then review again.`;
    return;
  }
  const summary: ImportWarning = {
    code: "ADDITIONAL_WARNINGS_HIDDEN",
    message: "1 additional issue is hidden. Fix or remove the affected source files, then review again.",
    blocking: item.blocking,
  };
  suppressedWarnings.set(draft, { count: 1, summary });
  draft.warnings.push(summary);
}

export function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function cleanText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\0/g, "").trim().slice(0, max) || fallback;
}

export function slug(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function personId(name: string): string {
  return `name:${slug(name)}`;
}

export function moneyMinor(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") throw new RangeError("Amount is missing");
  let normalized = String(value).trim();
  const parenthesized = /^\((.*)\)$/.exec(normalized);
  if (parenthesized) normalized = `-${parenthesized[1]}`;
  if (normalized.includes(",")) {
    if (!normalized.includes(".") && /^-?\d+,\d{1,2}$/.test(normalized)) {
      normalized = normalized.replace(",", ".");
    } else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(normalized)) {
      normalized = normalized.replace(/,/g, "");
    } else {
      throw new RangeError("Use 1,234.56 or 1234.56 for this amount");
    }
  }
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) throw new RangeError("Amount must use at most two decimal places");
  const negative = normalized.startsWith("-");
  const absolute = negative ? normalized.slice(1) : normalized;
  const minor = /^0+(?:\.0{1,2})?$/.test(absolute) ? 0 : parseDecimalToMinor(absolute);
  return negative ? -minor : minor;
}

export function currencyCode(value: unknown): string {
  const currency = cleanText(value, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError("Currency must be a three-letter code");
  let fractionDigits: number;
  try {
    fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new RangeError(`${currency} is not a recognized currency`);
  }
  if (fractionDigits !== 2) {
    throw new RangeError(`${currency} uses ${fractionDigits} decimal places; this migration currently supports only two-decimal currencies`);
  }
  return currency;
}

export function calendarDate(value: unknown): string {
  const source = cleanText(value, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(source)) return source.slice(0, 10);
  const american = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(source);
  if (american) return `${american[3]}-${american[1]!.padStart(2, "0")}-${american[2]!.padStart(2, "0")}`;
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) throw new RangeError("Date is not recognized");
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function warning(code: string, message: string, options: SourceOptions, row?: number, blocking = false): ImportWarning {
  return {
    code,
    message,
    sourceName: options.sourceName,
    sourceHash: options.sourceHash,
    ...(row === undefined ? {} : { row }),
    blocking,
  };
}

export function isFormulaLike(value: string): boolean {
  return /^[=+@]/.test(value.trim()) || /^-[A-Za-z=(]/.test(value.trim());
}

export function mergePeople(target: Map<string, ImportPerson>, people: readonly ImportPerson[]): void {
  for (const person of people) {
    const current = target.get(person.externalId);
    if (!current || (current.emailTrust === "none" && person.emailTrust !== "none")) target.set(person.externalId, person);
  }
}

export function mergeGroups(target: Map<string, ImportGroup>, groups: readonly ImportGroup[]): void {
  for (const group of groups) {
    const current = target.get(group.externalId);
    if (!current) {
      target.set(group.externalId, { ...group, memberExternalIds: [...new Set(group.memberExternalIds)] });
      continue;
    }
    current.memberExternalIds = [...new Set([...current.memberExternalIds, ...group.memberExternalIds])];
    current.sourceHashes = [...new Set([...(current.sourceHashes ?? []), ...(group.sourceHashes ?? [])])];
    if (group.status === "current") current.status = "current";
  }
}

export function recordEffects(record: NormalizedImportRecord): ImportAmount[] {
  if (record.effects) return record.effects;
  if (record.kind === "payment" && record.payerExternalId && record.recipientExternalId) {
    return [
      { externalPersonId: record.payerExternalId, amountMinor: record.amountMinor },
      { externalPersonId: record.recipientExternalId, amountMinor: -record.amountMinor },
    ];
  }
  const effects = new Map<string, number>();
  for (const payer of record.payers ?? []) effects.set(payer.externalPersonId, (effects.get(payer.externalPersonId) ?? 0) + payer.amountMinor);
  for (const allocation of record.allocations ?? []) effects.set(allocation.externalPersonId, (effects.get(allocation.externalPersonId) ?? 0) - allocation.amountMinor);
  return [...effects].map(([externalPersonId, amountMinor]) => ({ externalPersonId, amountMinor })).filter(({ amountMinor }) => amountMinor !== 0);
}
