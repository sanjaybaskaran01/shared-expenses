import {
  type ImportGroup,
  type ImportPerson,
  type ImportWarning,
  type NormalizedImportDraft,
} from "@expenses/protocol";
import {
  appendWarning,
  blankDraft,
  calendarDate,
  cleanText,
  currencyCode,
  moneyMinor,
  slug,
} from "./normalization";
import type { OpeningBalanceReviewRow, OpeningBalanceRow } from "./types";

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
      if (!name) throw new RangeError("Enter a person.");
      const personKey = cleanText(row.personKey, 100);
      const externalPersonId = personKey
        ? `opening-person:${slug(personKey)}`
        : `opening-person:${index + 1}:${slug(name)}`;
      field = "currency";
      const currency = currencyCode(row.currency);
      field = "amount";
      const amountMinor = moneyMinor(row.amount);
      if (amountMinor <= 0) throw new RangeError("Enter an amount greater than zero.");
      field = "groupName";
      const groupName = cleanText(row.groupName, 100, "Opening balances");
      const externalGroupId = `opening:${slug(groupName)}:${currency}`;
      field = "personName";
      const existingPerson = people.get(externalPersonId);
      if (existingPerson && existingPerson.displayName !== name) {
        throw new RangeError("Use the same name each time you select this person.");
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
