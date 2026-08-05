import {
  canonicalJson,
  sha256Hex,
  type ImportBatchCommitRequest,
  type ImportIdentityResolutionRequest,
  type ImportIdentityResolutionResult,
  type ImportPreparedReview,
  type JsonValue,
  type NormalizedImportDraft,
  type NormalizedImportRecord,
  type OperationEnvelope,
  type PlannedImportIdentity,
  type UnsignedOperation,
} from "@expenses/protocol";
import { csvImportScope, reconcileImportDraft, semanticImportRecordKey } from "./splitwise-import";

export interface BuildImportCommitOptions {
  selectedGroupIds: string[];
  importerExternalId?: string;
  importerExternalIds?: string[];
  importedByDisplayName: string;
  actorId: string;
  deviceId: string;
  importedAt: string;
  sign: (operation: UnsignedOperation) => Promise<OperationEnvelope>;
  resolveIdentities?: (request: ImportIdentityResolutionRequest) => Promise<ImportIdentityResolutionResult>;
  onProgress?: (completed: number, total: number) => void;
}

function uuidFromHash(hash: string): string {
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function deterministicImportId(namespace: string, value: string): Promise<string> {
  return uuidFromHash(await sha256Hex(`tallied-import:${namespace}:${value}`));
}

export function preparedImportReview(
  commit: ImportBatchCommitRequest,
  draft: NormalizedImportDraft,
  selectedGroupIds: readonly string[],
): ImportPreparedReview {
  const selected = new Set(selectedGroupIds);
  return {
    id: commit.id,
    mode: commit.mode,
    operationCount: commit.operations.length,
    reconciliation: commit.reconciliation,
    people: commit.identities.map(({ externalId, displayName }) => ({ externalId, displayName })),
    groups: draft.groups
      .filter(({ externalId }) => selected.has(externalId))
      .map(({ externalId, name }) => ({ externalId, name })),
  };
}

function recordParticipantIds(record: NormalizedImportRecord): string[] {
  return [...new Set([
    ...(record.payers ?? []).map(({ externalPersonId }) => externalPersonId),
    ...(record.allocations ?? []).map(({ externalPersonId }) => externalPersonId),
    ...(record.effects ?? []).map(({ externalPersonId }) => externalPersonId),
    ...(record.payerExternalId ? [record.payerExternalId] : []),
    ...(record.recipientExternalId ? [record.recipientExternalId] : []),
  ])];
}

function compactJson(input: Record<string, unknown>): JsonValue {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

function sourceMetadata(record: NormalizedImportRecord): JsonValue {
  return compactJson({
    fileHash: record.source.fileHash,
    row: record.source.row,
    providerRecordId: record.source.providerRecordId,
    providerGroupId: record.source.providerGroupId,
    providerFriendshipId: record.source.providerFriendshipId,
    createdAt: record.source.createdAt,
    updatedAt: record.source.updatedAt,
    deletedAt: record.source.deletedAt,
    rawKind: record.source.rawKind,
    recurrence: record.recurrence,
  });
}

export async function buildImportCommit(
  draft: NormalizedImportDraft,
  options: BuildImportCommitOptions,
): Promise<ImportBatchCommitRequest> {
  const importerExternalIds = new Set(
    options.importerExternalIds ?? (options.importerExternalId ? [options.importerExternalId] : []),
  );
  if (importerExternalIds.size === 0) throw new RangeError("Choose every imported name that represents you");
  const selected = new Set(options.selectedGroupIds);
  const selectedGroups = draft.groups.filter((group) => selected.has(group.externalId));
  if (selectedGroups.length === 0) throw new RangeError("Choose at least one group to migrate");
  const selectedRecords = draft.records.filter((record) => selected.has(record.externalGroupId));
  const selectedSourceHashes = new Set(selectedGroups.flatMap((group) => group.sourceHashes ?? []));
  const selectableSourceHashes = new Set(draft.groups.flatMap((group) => group.sourceHashes ?? []));
  const selectedWarnings = draft.warnings.filter((warning) =>
    !warning.sourceHash || selectedSourceHashes.has(warning.sourceHash) || !selectableSourceHashes.has(warning.sourceHash));
  const selectedBalances = draft.sourceBalances
    .filter((balance) => !balance.externalGroupId || selected.has(balance.externalGroupId))
    .map(({ sourceHash: _sourceHash, ...balance }) => balance);
  const involved = new Set<string>(importerExternalIds);
  for (const group of selectedGroups) for (const personId of group.memberExternalIds) involved.add(personId);
  for (const record of selectedRecords) for (const personId of recordParticipantIds(record)) involved.add(personId);
  const people = draft.people.filter((person) => involved.has(person.externalId));
  if ([...importerExternalIds].some((externalId) => !people.some((person) => person.externalId === externalId))) {
    throw new RangeError("A selected self identity is not part of the chosen groups");
  }
  const filteredDraft: NormalizedImportDraft = {
    ...draft,
    groups: selectedGroups,
    records: selectedRecords,
    people,
    sourceBalances: selectedBalances,
    warnings: selectedWarnings,
  };
  const reconciliation = reconcileImportDraft(filteredDraft);
  if (reconciliation.blockingWarnings.length > 0 || !reconciliation.zeroSum) {
    throw new RangeError("Resolve every migration check before finishing the import");
  }

  const fingerprintSource: JsonValue = {
    importerExternalIds: [...importerExternalIds].sort(),
    mode: draft.mode,
    provider: draft.provider,
    recordIds: selectedRecords.map(({ externalId }) => externalId).sort(),
    selectedGroupIds: selectedGroups.map(({ externalId }) => externalId).sort(),
    sourceHashes: [...selectedSourceHashes].sort(),
  };
  const fingerprint = await sha256Hex(canonicalJson(fingerprintSource));
  const batchId = await deterministicImportId("batch", `${options.actorId}:${fingerprint}`);

  const groupIds = new Map<string, string>();
  await Promise.all(selectedGroups.map(async (group) => {
    groupIds.set(group.externalId, await deterministicImportId("group", `${batchId}:${group.externalId}`));
  }));
  const identityIds = new Map<string, string>();
  await Promise.all(people.map(async (person) => {
    identityIds.set(person.externalId, await deterministicImportId("person", `${batchId}:${person.externalId}`));
  }));
  const identityDrafts = people.map((person) => ({
    id: identityIds.get(person.externalId)!,
    externalId: person.externalId,
    displayName: person.displayName,
    ...(person.email ? { email: person.email } : {}),
    emailTrust: person.emailTrust,
    groupIds: selectedGroups
      .filter((group) => group.memberExternalIds.includes(person.externalId)
        || selectedRecords.some((record) => record.externalGroupId === group.externalId && recordParticipantIds(record).includes(person.externalId)))
      .map((group) => groupIds.get(group.externalId)!),
    ...(importerExternalIds.has(person.externalId) ? { isImporter: true as const } : {}),
  }));
  const defaultResolution = Object.fromEntries(identityDrafts.map((identity) => [
    identity.externalId,
    importerExternalIds.has(identity.externalId) ? options.actorId : `import:${identity.id}`,
  ]));
  const { resolved: resolvedPeople } = options.resolveIdentities
    ? await options.resolveIdentities({ provider: draft.provider, identities: identityDrafts })
    : { resolved: defaultResolution };
  const participantId = (externalId: string): string => {
    const localUserId = resolvedPeople[externalId];
    if (!localUserId) throw new RangeError("A transaction references a person who could not be verified");
    return localUserId;
  };
  const resolvedAmounts = (amounts: readonly { externalPersonId: string; amountMinor: number }[]) => {
    const combined = new Map<string, number>();
    for (const amount of amounts) {
      const id = participantId(amount.externalPersonId);
      combined.set(id, (combined.get(id) ?? 0) + amount.amountMinor);
    }
    return [...combined].map(([participantId, amountMinor]) => ({ participantId, amountMinor }));
  };

  const currenciesByName = new Map<string, Set<string>>();
  for (const group of selectedGroups) {
    const currencies = currenciesByName.get(group.name) ?? new Set<string>();
    currencies.add(group.currency);
    currenciesByName.set(group.name, currencies);
  }
  const identities: PlannedImportIdentity[] = identityDrafts.map((identity) => ({
    ...identity,
    localUserId: participantId(identity.externalId),
  }));

  const operations: OperationEnvelope[] = [];
  const operationLinks: ImportBatchCommitRequest["operationLinks"] = [];
  const plannedGroups = await mapWithConcurrency(selectedGroups, 16, async (group) => {
    const groupId = groupIds.get(group.externalId)!;
    const operation = await options.sign({
      id: await deterministicImportId("group-operation", `${batchId}:${group.externalId}`),
      groupId,
      actorId: options.actorId,
      deviceId: options.deviceId,
      type: "GroupCreated",
      targetId: groupId,
      baseVersion: 0,
      clientTimestamp: options.importedAt,
      payload: {
        name: (currenciesByName.get(group.name)?.size ?? 0) > 1 ? `${group.name} · ${group.currency}` : group.name,
        settlementCurrency: group.currency,
      },
    });
    return {
      operation,
      link: { operationId: operation.id, externalType: "group" as const, externalId: group.externalId },
    };
  });
  operations.push(...plannedGroups.map(({ operation }) => operation));
  operationLinks.push(...plannedGroups.map(({ link }) => link));

  let plannedRecordCount = 0;
  const plannedRecords = await mapWithConcurrency(selectedRecords, 16, async (record) => {
    const groupId = groupIds.get(record.externalGroupId);
    const sourceGroup = selectedGroups.find(({ externalId }) => externalId === record.externalGroupId);
    if (!groupId || !sourceGroup) throw new RangeError("A transaction references a group that was not selected");
    const dedupeStrategy = record.source.providerRecordId ? "provider_id" as const : "csv_candidate" as const;
    const semanticScope = dedupeStrategy === "csv_candidate"
      ? csvImportScope(sourceGroup.name, record.currency)
      : record.externalGroupId;
    const [targetId, operationId, semanticId] = await Promise.all([
      deterministicImportId("record", `${batchId}:${record.externalId}`),
      deterministicImportId("record-operation", `${batchId}:${record.externalId}`),
      sha256Hex(semanticImportRecordKey(record, semanticScope)),
    ]);
    const metadata: JsonValue = {
      importBatchId: batchId,
      sourceProvider: "splitwise",
      // This is deliberately a Tallied identifier. Provider record ids and
      // file provenance remain in the owner-scoped operation link below.
      sourceRecordId: targetId,
      importedAt: options.importedAt,
      importedByDisplayName: options.importedByDisplayName,
      readOnly: true,
      ...(record.deleted ? { sourceDeleted: true } : {}),
    };
    const common = {
      description: record.description,
      category: record.category,
      amountMinor: record.amountMinor,
      currency: record.currency,
      notes: record.notes,
      import: metadata,
    };
    let type: UnsignedOperation["type"];
    let payload: JsonValue;
    if (record.kind === "expense") {
      type = "ExpenseCreated";
      payload = {
        ...common,
        expenseDate: record.transactionDate,
        recurrence: record.recurrence,
        payers: resolvedAmounts(record.payers ?? []),
        allocations: resolvedAmounts(record.allocations ?? []),
      };
    } else if (record.kind === "payment") {
      if (!record.payerExternalId || !record.recipientExternalId) throw new RangeError("An imported payment is incomplete");
      const payerId = participantId(record.payerExternalId);
      const recipientId = participantId(record.recipientExternalId);
      if (payerId === recipientId) {
        throw new RangeError("A payment is between two imported names both marked as you; review your identity choices");
      }
      type = "PaymentRecorded";
      payload = {
        payerId,
        recipientId,
        amountMinor: record.amountMinor,
        currency: record.currency,
        paymentDate: record.transactionDate,
        note: record.notes,
        import: metadata,
      };
    } else {
      type = record.kind === "opening_balance" ? "OpeningBalanceCreated" : "ImportedTransactionRecorded";
      const effects = resolvedAmounts(record.effects ?? []).filter(({ amountMinor }) => amountMinor !== 0);
      if (effects.length < 2) {
        throw new RangeError("A balance entry collapses after combining names marked as you; review your identity choices");
      }
      payload = {
        ...common,
        transactionDate: record.transactionDate,
        effects,
      };
    }
    const operation = await options.sign({
      id: operationId,
      groupId,
      actorId: options.actorId,
      deviceId: options.deviceId,
      type,
      targetId,
      baseVersion: 0,
      clientTimestamp: options.importedAt,
      payload,
    });
    const planned = {
      operation,
      link: {
        operationId: operation.id,
        externalType: "record" as const,
        externalId: record.externalId,
        dedupeStrategy,
        semanticId,
        sourceMetadata: sourceMetadata(record),
      },
    };
    plannedRecordCount += 1;
    options.onProgress?.(plannedRecordCount, selectedRecords.length);
    return planned;
  });
  operations.push(...plannedRecords.map(({ operation }) => operation));
  operationLinks.push(...plannedRecords.map(({ link }) => link));

  return {
    id: batchId,
    provider: "splitwise",
    mode: draft.mode,
    fingerprint,
    ...(draft.sourceAccountId ? { sourceAccountId: draft.sourceAccountId } : {}),
    sourceHashes: [...selectedSourceHashes].sort(),
    selectedSourceGroups: selectedGroups.map(({ externalId }) => externalId),
    identities,
    operations,
    operationLinks,
    sourceBalances: selectedBalances,
    reconciliation,
    warnings: selectedWarnings,
  };
}
