import {
  canonicalJson,
  parseDecimalToMinor,
  type ImportAmount,
  type ImportGroup,
  type ImportPerson,
  type ImportWarning,
  type NormalizedImportDraft,
  type NormalizedImportRecord,
  type ReconciliationLine,
} from "@expenses/protocol";

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

interface SourceOptions {
  sourceName: string;
  sourceHash: string;
  maxBytes?: number;
  maxRows?: number;
}

function sourceRowLimit(options: SourceOptions): number {
  return Number.isSafeInteger(options.maxRows) && (options.maxRows ?? 0) > 0
    ? Math.min(options.maxRows!, IMPORT_ROW_LIMIT)
    : IMPORT_ROW_LIMIT;
}

function sourceRowLimitMessage(maxRows: number, fallbackNoun: "rows" | "expenses"): string {
  if (maxRows < IMPORT_ROW_LIMIT) {
    return `This phone supports up to ${maxRows.toLocaleString("en-US")} ${maxRows === 1 ? "entry" : "entries"} in one migration. Use Tallied on a desktop for exports up to ${IMPORT_ROW_LIMIT.toLocaleString("en-US")}.`;
  }
  const noun = maxRows === 1 ? (fallbackNoun === "rows" ? "row" : "expense") : fallbackNoun;
  return `This ${fallbackNoun === "rows" ? "file" : "backup"} contains more than ${maxRows.toLocaleString("en-US")} ${noun}`;
}

interface CsvTable {
  rows: string[][];
  unterminatedQuote: boolean;
}

interface OpeningBalanceRow {
  personKey?: string;
  personName: string;
  direction: "owes_me" | "i_owe";
  amount: string;
  currency: string;
  groupName?: string;
  effectiveDate: string;
}

export interface OpeningBalanceReviewRow {
  recordId: string;
  personName: string;
  direction: "owes_me" | "i_owe";
  amountMinor: number;
  currency: string;
  groupName: string;
  effectiveDate: string;
}

const knownCsvColumns = new Set([
  "date", "transaction date", "description", "details", "notes", "category", "cost", "amount",
  "currency", "currency code", "payment", "is payment", "deleted", "deleted at", "status",
]);

function blankDraft(mode: NormalizedImportDraft["mode"], sourceHashes: string[] = []): NormalizedImportDraft {
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

function appendWarning(draft: NormalizedImportDraft, item: ImportWarning): void {
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

export function semanticImportRecordKey(record: NormalizedImportRecord, scope = record.externalGroupId): string {
  const sortedAmounts = (amounts: readonly ImportAmount[] | undefined) => [...(amounts ?? [])]
    .map(({ externalPersonId, amountMinor }) => ({ externalPersonId, amountMinor }))
    .sort((a, b) => a.externalPersonId.localeCompare(b.externalPersonId) || a.amountMinor - b.amountMinor);
  return canonicalJson({
    scope,
    kind: record.kind,
    description: record.description,
    category: record.category,
    amountMinor: record.amountMinor,
    currency: record.currency,
    transactionDate: record.transactionDate,
    notes: record.notes,
    recurrence: record.recurrence,
    deleted: record.deleted,
    payers: sortedAmounts(record.payers),
    allocations: sortedAmounts(record.allocations),
    effects: sortedAmounts(record.effects),
    payerExternalId: record.payerExternalId ?? null,
    recipientExternalId: record.recipientExternalId ?? null,
  });
}

export function csvImportScope(groupName: string, currency: string): string {
  const normalizedName = slug(groupName)
    .replace(/(?:\s*[-_ ]?copy|\s*\(\d+\))$/i, "")
    .trim() || "ungrouped";
  return `csv:${normalizedName}:${currency}`;
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function cleanText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\0/g, "").trim().slice(0, max) || fallback;
}

function slug(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function personId(name: string): string {
  return `name:${slug(name)}`;
}

function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows, unterminatedQuote: quoted };
}

function moneyMinor(value: unknown): number {
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

function currencyCode(value: unknown): string {
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

function calendarDate(value: unknown): string {
  const source = cleanText(value, 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(source)) return source.slice(0, 10);
  const american = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(source);
  if (american) return `${american[3]}-${american[1]!.padStart(2, "0")}-${american[2]!.padStart(2, "0")}`;
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) throw new RangeError("Date is not recognized");
  return new Date(timestamp).toISOString().slice(0, 10);
}

function warning(code: string, message: string, options: SourceOptions, row?: number, blocking = false): ImportWarning {
  return {
    code,
    message,
    sourceName: options.sourceName,
    sourceHash: options.sourceHash,
    ...(row === undefined ? {} : { row }),
    blocking,
  };
}

function isFormulaLike(value: string): boolean {
  return /^[=+@]/.test(value.trim()) || /^-[A-Za-z=(]/.test(value.trim());
}

function mergePeople(target: Map<string, ImportPerson>, people: readonly ImportPerson[]): void {
  for (const person of people) {
    const current = target.get(person.externalId);
    if (!current || (current.emailTrust === "none" && person.emailTrust !== "none")) target.set(person.externalId, person);
  }
}

function mergeGroups(target: Map<string, ImportGroup>, groups: readonly ImportGroup[]): void {
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

export function parseSplitwiseCsv(text: string, options: SourceOptions): NormalizedImportDraft {
  const draft = blankDraft("history", [options.sourceHash]);
  const byteLength = new TextEncoder().encode(text).byteLength;
  draft.sourceByteSizes = { [options.sourceHash]: byteLength };
  draft.sourceNames = { [options.sourceHash]: options.sourceName };
  if (byteLength > IMPORT_FILE_BYTES_LIMIT) {
    draft.warnings.push(warning("FILE_TOO_LARGE", "Choose a CSV smaller than 10 MiB", options, undefined, true));
    return draft;
  }
  const table = parseCsv(text.replace(/^\uFEFF/, ""));
  if (table.unterminatedQuote) {
    draft.warnings.push(warning("CORRUPT_CSV", "A quoted field is not closed", options, undefined, true));
    return draft;
  }
  const nonEmptyRows = table.rows.filter((row) => row.some((field) => field.trim() !== ""));
  if (nonEmptyRows.length === 0) {
    draft.warnings.push(warning("EMPTY_FILE", "This file is empty", options));
    return draft;
  }
  const maxRows = sourceRowLimit(options);
  if (nonEmptyRows.length - 1 > maxRows) {
    draft.warnings.push(warning("TOO_MANY_ROWS", sourceRowLimitMessage(maxRows, "rows"), options, undefined, true));
    return draft;
  }
  const headers = nonEmptyRows[0]!.map(normalizeHeader);
  const column = (aliases: string[]): number => headers.findIndex((header) => aliases.includes(header));
  const dateIndex = column(["date", "transaction date"]);
  const descriptionIndex = column(["description"]);
  const categoryIndex = column(["category"]);
  const costIndex = column(["cost", "amount"]);
  const currencyIndex = column(["currency", "currency code"]);
  const notesIndex = column(["details", "notes"]);
  const paymentIndex = column(["payment", "is payment"]);
  const deletedIndex = column(["deleted", "deleted at", "status"]);
  if ([dateIndex, descriptionIndex, costIndex, currencyIndex].some((index) => index < 0)) {
    draft.warnings.push(warning(
      "MISSING_COLUMNS",
      "The CSV needs Date, Description, Cost, and Currency columns",
      options,
      1,
      true,
    ));
    return draft;
  }
  const personColumns = headers
    .map((header, index) => ({ header: cleanText(nonEmptyRows[0]![index], 100), normalized: header, index }))
    .filter(({ header, normalized }) => header && !knownCsvColumns.has(normalized));
  if (personColumns.length < 2) {
    draft.warnings.push(warning("MISSING_PEOPLE", "The CSV needs at least two person balance columns", options, 1, true));
    return draft;
  }
  draft.people = personColumns.map(({ header }) => ({
    externalId: personId(header),
    displayName: header,
    emailTrust: "none",
  }));

  const groupStem = cleanText(options.sourceName.replace(/\.[^.]+$/, ""), 100, "Splitwise import");
  const groups = new Map<string, ImportGroup>();
  for (let index = 1; index < nonEmptyRows.length; index += 1) {
    const rowNumber = index + 1;
    const row = nonEmptyRows[index]!;
    try {
      const description = cleanText(row[descriptionIndex], 200, "Imported transaction");
      const category = categoryIndex >= 0 ? cleanText(row[categoryIndex], 100, "Imported") : "Imported";
      const amountMinor = Math.abs(moneyMinor(row[costIndex]));
      if (amountMinor === 0) throw new RangeError("Amount must be greater than zero");
      const currency = currencyCode(row[currencyIndex]);
      const transactionDate = calendarDate(row[dateIndex]);
      const effects = personColumns.map(({ header, index: personColumn }) => ({
        externalPersonId: personId(header),
        amountMinor: moneyMinor(row[personColumn]?.trim() || "0"),
      })).filter(({ amountMinor }) => amountMinor !== 0);
      const effectTotal = effects.reduce((sum, effect) => sum + effect.amountMinor, 0);
      if (effects.length < 2 || effectTotal !== 0) {
        appendWarning(draft, warning("NOT_ZERO_SUM", "Person balances in this row do not add to zero", options, rowNumber, true));
        continue;
      }
      if (isFormulaLike(description) || isFormulaLike(category)) {
        appendWarning(draft, warning("FORMULA_LIKE_TEXT", "Formula-like text will be displayed as plain text", options, rowNumber));
      }
      const rawPayment = paymentIndex >= 0 ? normalizeHeader(row[paymentIndex] ?? "") : "";
      const looksLikePayment = ["true", "yes", "1"].includes(rawPayment) || /payment|settle/i.test(category);
      const positive = effects.filter((effect) => effect.amountMinor > 0);
      const negative = effects.filter((effect) => effect.amountMinor < 0);
      const kind = looksLikePayment && positive.length === 1 && negative.length === 1 ? "payment" : "balance_effect";
      const deletedValue = deletedIndex >= 0 ? normalizeHeader(row[deletedIndex] ?? "") : "";
      const deleted = Boolean(deletedValue && !["false", "no", "0", "active"].includes(deletedValue));
      const externalGroupId = `csv-group:${options.sourceHash}:${currency}`;
      groups.set(externalGroupId, {
        externalId: externalGroupId,
        name: groupStem,
        currency,
        status: "current",
        memberExternalIds: draft.people.map((person) => person.externalId),
        sourceHashes: [options.sourceHash],
      });
      draft.records.push({
        externalId: `csv-record:${options.sourceHash}:${rowNumber}`,
        externalGroupId,
        kind,
        description,
        category,
        amountMinor,
        currency,
        transactionDate,
        notes: notesIndex >= 0 ? cleanText(row[notesIndex], 5_000) : "",
        recurrence: "none",
        deleted,
        ...(kind === "payment"
          ? { payerExternalId: positive[0]!.externalPersonId, recipientExternalId: negative[0]!.externalPersonId }
          : { effects }),
        source: { fileHash: options.sourceHash, row: rowNumber, rawKind: kind },
      });
    } catch (error) {
      appendWarning(draft, warning(
        "INVALID_AMOUNT",
        error instanceof Error ? error.message : "This row is malformed",
        options,
        rowNumber,
        true,
      ));
    }
  }
  draft.groups = [...groups.values()];
  return draft;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function splitwisePerson(value: unknown): ImportPerson | null {
  try {
    const object = objectValue(value);
    const id = String(object.id ?? "").trim();
    if (!id) return null;
    const displayName = [cleanText(object.first_name, 60), cleanText(object.last_name, 60)].filter(Boolean).join(" ") || `Splitwise user ${id}`;
    const email = cleanText(object.email, 320);
    return {
      externalId: `splitwise-user:${id}`,
      displayName,
      ...(email ? { email } : {}),
      emailTrust: email ? "exported" : "none",
    };
  } catch {
    return null;
  }
}

export function parseSplitwiseJson(text: string, options: SourceOptions): NormalizedImportDraft {
  const draft = blankDraft("history", [options.sourceHash]);
  const maxBytes = options.maxBytes ?? IMPORT_FILE_BYTES_LIMIT;
  const byteLength = new TextEncoder().encode(text).byteLength;
  draft.sourceByteSizes = { [options.sourceHash]: byteLength };
  draft.sourceNames = { [options.sourceHash]: options.sourceName };
  if (byteLength > maxBytes) {
    const maximum = maxBytes === IMPORT_TOTAL_BYTES_LIMIT ? "50 MiB" : "10 MiB";
    draft.warnings.push(warning("FILE_TOO_LARGE", `Choose a JSON backup smaller than ${maximum}`, options, undefined, true));
    return draft;
  }
  let root: Record<string, unknown>;
  try {
    root = objectValue(JSON.parse(text));
  } catch {
    draft.warnings.push(warning("INVALID_JSON", "This file is not valid JSON", options, undefined, true));
    return draft;
  }
  const people = new Map<string, ImportPerson>();
  const addPerson = (value: unknown): ImportPerson | null => {
    const person = splitwisePerson(value);
    if (person) mergePeople(people, [person]);
    return person;
  };
  const currentUser = addPerson(root.user);
  if (currentUser) draft.sourceAccountId = currentUser.externalId;
  for (const friend of arrayValue(root.friends)) addPerson(friend);
  const sourceGroups = new Map<string, {
    name: string;
    members: string[];
    balances: Array<{ externalPersonId: string; currency: string; amountMinor: number }>;
  }>();
  for (const value of arrayValue(root.groups)) {
    try {
      const group = objectValue(value);
      const id = String(group.id ?? "").trim();
      if (!id) continue;
      const balances: Array<{ externalPersonId: string; currency: string; amountMinor: number }> = [];
      const members = arrayValue(group.members).flatMap((member) => {
        const person = addPerson(member);
        if (person) {
          try {
            const memberObject = objectValue(member);
            for (const rawBalance of arrayValue(memberObject.balance ?? memberObject.balances)) {
              const balance = objectValue(rawBalance);
              balances.push({
                externalPersonId: person.externalId,
                currency: currencyCode(balance.currency_code ?? balance.currency),
                amountMinor: moneyMinor(balance.amount),
              });
            }
          } catch (error) {
            appendWarning(draft, warning(
              "MALFORMED_SOURCE_BALANCE",
              error instanceof Error ? error.message : "A Splitwise balance is malformed",
              options,
              undefined,
              true,
            ));
          }
        }
        return person ? [person.externalId] : [];
      });
      sourceGroups.set(id, { name: cleanText(group.name, 100, `Splitwise group ${id}`), members, balances });
    } catch {
      continue;
    }
  }
  const groups = new Map<string, ImportGroup>();
  const expenses = arrayValue(root.expenses);
  const maxRows = sourceRowLimit(options);
  if (expenses.length > maxRows) {
    draft.warnings.push(warning("TOO_MANY_ROWS", sourceRowLimitMessage(maxRows, "expenses"), options, undefined, true));
    return draft;
  }
  for (let index = 0; index < expenses.length; index += 1) {
    const rowNumber = index + 1;
    try {
      const expense = objectValue(expenses[index]);
      const providerId = String(expense.id ?? "").trim();
      if (!providerId) throw new RangeError("Expense id is missing");
      const amountMinor = Math.abs(moneyMinor(expense.cost));
      const currency = currencyCode(expense.currency_code);
      const sourceGroupId = String(expense.group_id ?? "0");
      const friendshipId = String(expense.friendship_id ?? "").trim();
      const sourceGroup = sourceGroups.get(sourceGroupId);
      const externalGroupId = sourceGroupId !== "0"
        ? `splitwise-group:${sourceGroupId}:${currency}`
        : `splitwise-friendship:${friendshipId || providerId}:${currency}`;
      const shares = arrayValue(expense.users).flatMap((value) => {
        try {
          const share = objectValue(value);
          const person = addPerson(share.user ?? share);
          if (!person) return [];
          return [{
            person,
            paid: moneyMinor(share.paid_share ?? "0"),
            owed: moneyMinor(share.owed_share ?? "0"),
          }];
        } catch {
          return [];
        }
      });
      const payers: ImportAmount[] = shares.filter((share) => share.paid > 0).map((share) => ({ externalPersonId: share.person.externalId, amountMinor: share.paid }));
      const allocations: ImportAmount[] = shares.filter((share) => share.owed > 0).map((share) => ({ externalPersonId: share.person.externalId, amountMinor: share.owed }));
      if (payers.reduce((sum, item) => sum + item.amountMinor, 0) !== amountMinor || allocations.reduce((sum, item) => sum + item.amountMinor, 0) !== amountMinor) {
        appendWarning(draft, warning("MALFORMED_ALLOCATION", "Paid and owed shares must both equal the expense total", options, rowNumber, true));
        continue;
      }
      const isPayment = expense.payment === true;
      const effects = shares.map((share) => ({ externalPersonId: share.person.externalId, amountMinor: share.paid - share.owed })).filter((item) => item.amountMinor !== 0);
      const positive = effects.filter((item) => item.amountMinor > 0);
      const negative = effects.filter((item) => item.amountMinor < 0);
      if (isPayment && (positive.length !== 1 || negative.length !== 1)) {
        appendWarning(draft, warning("MALFORMED_PAYMENT", "The payment does not identify one sender and one recipient", options, rowNumber, true));
        continue;
      }
      const memberExternalIds = [...new Set([...(sourceGroup?.members ?? []), ...shares.map((share) => share.person.externalId)])];
      groups.set(externalGroupId, {
        externalId: externalGroupId,
        name: sourceGroup?.name ?? `${shares.find((share) => share.person.externalId !== currentUser?.externalId)?.person.displayName ?? "Friend"}`,
        currency,
        status: effects.every((effect) => effect.amountMinor === 0) ? "settled" : "current",
        memberExternalIds,
        sourceHashes: [options.sourceHash],
      });
      const repeat = cleanText(expense.repeat_interval, 20, "none");
      const recurrence = (["weekly", "fortnightly", "monthly", "yearly"] as const).find((item) => item === repeat) ?? "none";
      draft.records.push({
        externalId: `splitwise-expense:${providerId}`,
        externalGroupId,
        kind: isPayment ? "payment" : "expense",
        description: cleanText(expense.description, 200, isPayment ? "Payment" : "Imported expense"),
        category: cleanText(expense.category_name, 100, isPayment ? "Payment" : "Imported"),
        amountMinor,
        currency,
        transactionDate: calendarDate(expense.date ?? expense.created_at),
        notes: cleanText(expense.details, 5_000),
        recurrence,
        deleted: Boolean(expense.deleted_at),
        ...(isPayment
          ? { payerExternalId: positive[0]!.externalPersonId, recipientExternalId: negative[0]!.externalPersonId }
          : { payers, allocations }),
        source: {
          fileHash: options.sourceHash,
          row: rowNumber,
          providerRecordId: providerId,
          providerGroupId: sourceGroupId,
          ...(friendshipId ? { providerFriendshipId: friendshipId } : {}),
          ...(typeof expense.created_at === "string" ? { createdAt: expense.created_at } : {}),
          ...(typeof expense.updated_at === "string" ? { updatedAt: expense.updated_at } : {}),
          ...(typeof expense.deleted_at === "string" ? { deletedAt: expense.deleted_at } : {}),
          rawKind: isPayment ? "payment" : "expense",
        },
      });
    } catch (error) {
      appendWarning(draft, warning("MALFORMED_RECORD", error instanceof Error ? error.message : "This record is malformed", options, rowNumber, true));
    }
  }
  // A group's status is a property of its aggregate balance, not whichever
  // expense happened to appear last in the backup.
  const netByGroupPerson = new Map<string, number>();
  for (const record of draft.records) {
    if (record.deleted) continue;
    for (const effect of recordEffects(record)) {
      const key = `${record.externalGroupId}\0${effect.externalPersonId}`;
      netByGroupPerson.set(key, (netByGroupPerson.get(key) ?? 0) + effect.amountMinor);
    }
  }
  const currentGroupIds = new Set<string>();
  for (const [key, amount] of netByGroupPerson) {
    if (amount !== 0) currentGroupIds.add(key.slice(0, key.indexOf("\0")));
  }
  for (const group of groups.values()) group.status = currentGroupIds.has(group.externalId) ? "current" : "settled";
  for (const [sourceGroupId, sourceGroup] of sourceGroups) {
    const sourceStatus = sourceGroup.balances.length > 0
      ? (sourceGroup.balances.some(({ amountMinor }) => amountMinor !== 0) ? "current" : "settled")
      : undefined;
    for (const balance of sourceGroup.balances) {
      const externalGroupId = `splitwise-group:${sourceGroupId}:${balance.currency}`;
      const existingGroup = groups.get(externalGroupId);
      if (existingGroup && sourceStatus) {
        existingGroup.status = sourceStatus;
      } else if (!existingGroup) {
        groups.set(externalGroupId, {
          externalId: externalGroupId,
          name: sourceGroup.name,
          currency: balance.currency,
          status: sourceStatus ?? "current",
          memberExternalIds: sourceGroup.members,
          sourceHashes: [options.sourceHash],
        });
      }
      draft.sourceBalances.push({
        externalGroupId,
        externalPersonId: balance.externalPersonId,
        currency: balance.currency,
        amountMinor: balance.amountMinor,
        sourceHash: options.sourceHash,
      });
    }
  }
  draft.people = [...people.values()];
  draft.groups = [...groups.values()];
  return draft;
}

export function combineImportDrafts(drafts: readonly NormalizedImportDraft[]): NormalizedImportDraft {
  const combined = blankDraft("history");
  const hashes = new Set<string>();
  const people = new Map<string, ImportPerson>();
  const groups = new Map<string, ImportGroup>();
  const records = new Map<string, NormalizedImportRecord>();
  const sourceByteSizes: Record<string, number> = {};
  const sourceNames: Record<string, string> = {};
  const semanticCsvRecords = new Map<string, { sourceHash: string; recordId: string }>();
  for (const draft of drafts) {
    const duplicate = draft.sourceHashes.some((hash) => hashes.has(hash));
    for (const hash of draft.sourceHashes) hashes.add(hash);
    if (duplicate) {
      appendWarning(combined, {
        code: "DUPLICATE_SOURCE",
        message: "A duplicate file was ignored",
        ...(draft.sourceHashes[0] ? { sourceHash: draft.sourceHashes[0] } : {}),
        blocking: false,
      });
      continue;
    }
    mergePeople(people, draft.people);
    mergeGroups(groups, draft.groups);
    for (const record of draft.records) {
      const fileHash = record.source.fileHash;
      if (fileHash && record.externalId.startsWith("csv-record:")) {
        const sourceGroup = draft.groups.find(({ externalId }) => externalId === record.externalGroupId);
        const semanticKey = semanticImportRecordKey(record, csvImportScope(sourceGroup?.name ?? "ungrouped", record.currency));
        const previous = semanticCsvRecords.get(semanticKey);
        if (previous && previous.sourceHash !== fileHash) {
          appendWarning(combined, {
            code: "POSSIBLE_OVERLAPPING_CSV",
            message: "This transaction also appears in another CSV. Remove one overlapping export before continuing.",
            ...(draft.sourceNames?.[fileHash] ? { sourceName: draft.sourceNames[fileHash] } : {}),
            sourceHash: fileHash,
            recordExternalId: record.externalId,
            blocking: true,
          });
        } else {
          semanticCsvRecords.set(semanticKey, { sourceHash: fileHash, recordId: record.externalId });
        }
      }
      if (records.has(record.externalId)) {
        const sameContent = semanticImportRecordKey(records.get(record.externalId)!) === semanticImportRecordKey(record);
        appendWarning(combined, {
          code: sameContent ? "DUPLICATE_RECORD" : "CONFLICTING_RECORD",
          message: sameContent ? "An identical duplicate transaction was ignored" : "Two files contain different versions of the same transaction",
          recordExternalId: record.externalId,
          ...(record.source.fileHash ?? draft.sourceHashes[0]
            ? { sourceHash: record.source.fileHash ?? draft.sourceHashes[0]! }
            : {}),
          blocking: !sameContent,
        });
      } else {
        records.set(record.externalId, record);
      }
    }
    combined.sourceBalances.push(...draft.sourceBalances);
    for (const item of draft.warnings) appendWarning(combined, item);
    Object.assign(sourceByteSizes, draft.sourceByteSizes ?? {});
    Object.assign(sourceNames, draft.sourceNames ?? {});
    if (!combined.sourceAccountId && draft.sourceAccountId) combined.sourceAccountId = draft.sourceAccountId;
  }
  combined.sourceHashes = [...hashes].sort();
  if (Object.keys(sourceByteSizes).length > 0) combined.sourceByteSizes = sourceByteSizes;
  if (Object.keys(sourceNames).length > 0) combined.sourceNames = sourceNames;
  combined.people = [...people.values()];
  combined.groups = [...groups.values()];
  combined.records = [...records.values()];
  return combined;
}

function recordEffects(record: NormalizedImportRecord): ImportAmount[] {
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

export function reconcileImportDraft(draft: NormalizedImportDraft) {
  const people = new Set(draft.people.map((person) => person.externalId));
  const seen = new Set<string>();
  let duplicateCount = 0;
  let unresolvedPeople = 0;
  let zeroSum = true;
  const groupBalances = new Map<string, number>();
  const detailed = new Map<string, number>();
  const aggregate = new Map<string, number>();
  const participantFinancials = new Map<string, {
    externalPersonId: string;
    currency: string;
    paidMinor: number;
    owedMinor: number;
    paymentsSentMinor: number;
    paymentsReceivedMinor: number;
    netMinor: number;
  }>();
  const groupFinancials = new Map<string, {
    externalGroupId: string;
    currency: string;
    paidMinor: number;
    owedMinor: number;
    paymentsMinor: number;
    netMinor: number;
  }>();
  const participantTotal = (externalPersonId: string, currency: string) => {
    const key = `${externalPersonId}\0${currency}`;
    const current = participantFinancials.get(key) ?? {
      externalPersonId,
      currency,
      paidMinor: 0,
      owedMinor: 0,
      paymentsSentMinor: 0,
      paymentsReceivedMinor: 0,
      netMinor: 0,
    };
    participantFinancials.set(key, current);
    return current;
  };
  const groupTotal = (externalGroupId: string, currency: string) => {
    const key = `${externalGroupId}\0${currency}`;
    const current = groupFinancials.get(key) ?? {
      externalGroupId,
      currency,
      paidMinor: 0,
      owedMinor: 0,
      paymentsMinor: 0,
      netMinor: 0,
    };
    groupFinancials.set(key, current);
    return current;
  };
  for (const record of draft.records) {
    if (seen.has(record.externalId)) duplicateCount += 1;
    seen.add(record.externalId);
    if (record.deleted) continue;
    const effects = recordEffects(record);
    const groupSummary = groupTotal(record.externalGroupId, record.currency);
    if (record.kind === "expense") {
      for (const payer of record.payers ?? []) {
        participantTotal(payer.externalPersonId, record.currency).paidMinor += payer.amountMinor;
        groupSummary.paidMinor += payer.amountMinor;
      }
      for (const allocation of record.allocations ?? []) {
        participantTotal(allocation.externalPersonId, record.currency).owedMinor += allocation.amountMinor;
        groupSummary.owedMinor += allocation.amountMinor;
      }
    } else if (record.kind === "payment" && record.payerExternalId && record.recipientExternalId) {
      participantTotal(record.payerExternalId, record.currency).paymentsSentMinor += record.amountMinor;
      participantTotal(record.recipientExternalId, record.currency).paymentsReceivedMinor += record.amountMinor;
      groupSummary.paymentsMinor += record.amountMinor;
    }
    if (effects.reduce((sum, effect) => sum + effect.amountMinor, 0) !== 0) zeroSum = false;
    for (const effect of effects) {
      if (!people.has(effect.externalPersonId)) unresolvedPeople += 1;
      const groupKey = `${record.externalGroupId}\0${record.currency}`;
      groupBalances.set(groupKey, (groupBalances.get(groupKey) ?? 0) + effect.amountMinor);
      const key = `${record.externalGroupId}\0${effect.externalPersonId}\0${record.currency}`;
      detailed.set(key, (detailed.get(key) ?? 0) + effect.amountMinor);
      const aggregateKey = `${effect.externalPersonId}\0${record.currency}`;
      aggregate.set(aggregateKey, (aggregate.get(aggregateKey) ?? 0) + effect.amountMinor);
      participantTotal(effect.externalPersonId, record.currency).netMinor += effect.amountMinor;
      groupSummary.netMinor += effect.amountMinor;
    }
  }
  if ([...groupBalances.values()].some((amount) => amount !== 0)) zeroSum = false;
  const lines: ReconciliationLine[] = draft.sourceBalances.map((source) => {
    const key = source.externalGroupId
      ? `${source.externalGroupId}\0${source.externalPersonId}\0${source.currency}`
      : `${source.externalPersonId}\0${source.currency}`;
    const computedMinor = source.externalGroupId ? detailed.get(key) ?? 0 : aggregate.get(key) ?? 0;
    const differenceMinor = computedMinor - source.amountMinor;
    return {
      ...(source.externalGroupId ? { externalGroupId: source.externalGroupId } : {}),
      externalPersonId: source.externalPersonId,
      currency: source.currency,
      sourceMinor: source.amountMinor,
      computedMinor,
      differenceMinor,
      matches: differenceMinor === 0,
    };
  });
  const mismatchWarnings: ImportWarning[] = lines.filter((line) => !line.matches).map((line) => ({
    code: "BALANCE_MISMATCH",
    message: `The ${line.currency} balance does not match the source`,
    recordExternalId: line.externalPersonId,
    blocking: true,
  }));
  const blockingWarnings = [...draft.warnings.filter((item) => item.blocking), ...mismatchWarnings];
  if (!zeroSum) blockingWarnings.push({ code: "NOT_ZERO_SUM", message: "Imported balances do not add to zero", blocking: true });
  if (unresolvedPeople > 0) blockingWarnings.push({ code: "UNKNOWN_PARTICIPANT", message: "Some transactions reference an unknown person", blocking: true });
  return {
    groupCount: draft.groups.length,
    personCount: draft.people.length,
    recordCount: draft.records.length,
    duplicateCount,
    unresolvedPeople,
    malformedRecords: draft.warnings.filter((item) => /INVALID|MALFORMED|NOT_ZERO_SUM/.test(item.code)).length,
    zeroSum,
    lines,
    participantTotals: [...participantFinancials.values()].sort((left, right) =>
      left.externalPersonId.localeCompare(right.externalPersonId) || left.currency.localeCompare(right.currency)),
    groupTotals: [...groupFinancials.values()].sort((left, right) =>
      left.externalGroupId.localeCompare(right.externalGroupId) || left.currency.localeCompare(right.currency)),
    blockingWarnings,
  };
}

export function createOpeningBalanceDraft(input: {
  ownerExternalId: string;
  ownerName: string;
  rows: readonly OpeningBalanceRow[];
}): NormalizedImportDraft {
  const draft = blankDraft("balances");
  const people = new Map<string, ImportPerson>();
  people.set(input.ownerExternalId, { externalId: input.ownerExternalId, displayName: input.ownerName, emailTrust: "none" });
  const groups = new Map<string, ImportGroup>();
  input.rows.forEach((row, index) => {
    let field: ImportWarning["field"] = "personName";
    try {
      const name = cleanText(row.personName, 100);
      if (!name) throw new RangeError("Enter a person");
      const personKey = cleanText(row.personKey, 100);
      const externalPersonId = personKey
        ? `opening-person:${slug(personKey)}`
        : `opening-person:${index + 1}:${slug(name)}`;
      field = "currency";
      const currency = currencyCode(row.currency);
      field = "amount";
      const amountMinor = moneyMinor(row.amount);
      if (amountMinor <= 0) throw new RangeError("Amount must be greater than zero");
      field = "groupName";
      const groupName = cleanText(row.groupName, 100, "Opening balances");
      const externalGroupId = `opening:${slug(groupName)}:${currency}`;
      field = "personName";
      const existingPerson = people.get(externalPersonId);
      if (existingPerson && existingPerson.displayName !== name) {
        throw new RangeError("A reused person must keep the same name");
      }
      people.set(externalPersonId, { externalId: externalPersonId, displayName: name, emailTrust: "none" });
      const existingGroup = groups.get(externalGroupId);
      groups.set(externalGroupId, {
        externalId: externalGroupId,
        name: groupName,
        currency,
        status: "current",
        memberExternalIds: [...new Set([
          ...(existingGroup?.memberExternalIds ?? [input.ownerExternalId]),
          externalPersonId,
        ])],
      });
      const ownerAmount = row.direction === "owes_me" ? amountMinor : -amountMinor;
      field = "effectiveDate";
      const effectiveDate = calendarDate(row.effectiveDate);
      draft.records.push({
        externalId: `opening-balance:${index + 1}:${externalPersonId}:${currency}`,
        externalGroupId,
        kind: "opening_balance",
        description: "Opening balance from Splitwise",
        category: "Opening balance",
        amountMinor,
        currency,
        transactionDate: effectiveDate,
        notes: "Historical transactions remain in Splitwise.",
        recurrence: "none",
        deleted: false,
        effects: [
          { externalPersonId: input.ownerExternalId, amountMinor: ownerAmount },
          { externalPersonId, amountMinor: -ownerAmount },
        ],
        source: { rawKind: "opening_balance" },
      });
    } catch (error) {
      appendWarning(draft, {
        code: "INVALID_OPENING_BALANCE",
        message: error instanceof Error ? error.message : "This opening balance is invalid",
        row: index + 1,
        field,
        blocking: true,
      });
    }
  });
  draft.people = [...people.values()];
  draft.groups = [...groups.values()];
  return draft;
}

export function openingBalanceReviewRows(
  draft: NormalizedImportDraft,
  importerExternalIds: readonly string[],
  selectedGroupIds: readonly string[],
): OpeningBalanceReviewRow[] {
  const importers = new Set(importerExternalIds);
  const selected = new Set(selectedGroupIds);
  const people = new Map(draft.people.map((person) => [person.externalId, person.displayName]));
  const groups = new Map(draft.groups.map((group) => [group.externalId, group.name]));
  return draft.records.flatMap((record) => {
    if (record.kind !== "opening_balance" || !selected.has(record.externalGroupId)) return [];
    const ownerEffect = (record.effects ?? [])
      .filter(({ externalPersonId }) => importers.has(externalPersonId))
      .reduce((sum, { amountMinor }) => sum + amountMinor, 0);
    const counterpart = (record.effects ?? []).find(({ externalPersonId }) => !importers.has(externalPersonId));
    if (!counterpart || ownerEffect === 0) return [];
    return [{
      recordId: record.externalId,
      personName: people.get(counterpart.externalPersonId) ?? "Unknown person",
      direction: ownerEffect > 0 ? "owes_me" as const : "i_owe" as const,
      amountMinor: record.amountMinor,
      currency: record.currency,
      groupName: groups.get(record.externalGroupId) ?? "Opening balances",
      effectiveDate: record.transactionDate,
    }];
  });
}

export async function sha256ImportSource(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
