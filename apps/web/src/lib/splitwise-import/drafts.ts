import {
  canonicalJson,
  type ImportAmount,
  type ImportGroup,
  type ImportPerson,
  type ImportWarning,
  type NormalizedImportDraft,
  type NormalizedImportRecord,
  type ReconciliationLine,
} from "@expenses/protocol";
import {
  appendWarning,
  blankDraft,
  mergeGroups,
  mergePeople,
  recordEffects,
  slug,
} from "./normalization";

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
