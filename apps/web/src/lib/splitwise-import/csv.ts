import {
  type ImportGroup,
  type NormalizedImportDraft,
} from "@expenses/protocol";
import {
  appendWarning,
  blankDraft,
  calendarDate,
  cleanText,
  currencyCode,
  isFormulaLike,
  moneyMinor,
  normalizeHeader,
  personId,
  warning,
} from "./normalization";
import {
  IMPORT_FILE_BYTES_LIMIT,
  sourceRowLimit,
  sourceRowLimitMessage,
} from "./limits";
import type { SourceOptions } from "./types";

interface CsvTable {
  rows: string[][];
  unterminatedQuote: boolean;
}

const knownCsvColumns = new Set([
  "date", "transaction date", "description", "details", "notes", "category", "cost", "amount",
  "currency", "currency code", "payment", "is payment", "deleted", "deleted at", "status",
]);

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
