import {
  type ImportAmount,
  type ImportGroup,
  type ImportPerson,
  type NormalizedImportDraft,
} from "@expenses/protocol";
import {
  appendWarning,
  blankDraft,
  calendarDate,
  cleanText,
  currencyCode,
  mergePeople,
  moneyMinor,
  recordEffects,
  warning,
} from "./normalization";
import {
  IMPORT_FILE_BYTES_LIMIT,
  IMPORT_TOTAL_BYTES_LIMIT,
  sourceRowLimit,
  sourceRowLimitMessage,
} from "./limits";
import type { SourceOptions } from "./types";

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
