import type { JsonValue, OperationEnvelope } from "@expenses/protocol";
import { apiBaseUrl, bootstrapDevelopment, developmentActorId, getSnapshot, pullOperations, pushOperations, registerDevice } from "./api";
import { localDb, type LocalExpense, type LocalOperation } from "./db";
import { ensureDevice } from "./device";
import { foregroundActivityMessage, hasActiveLocalPushSubscription } from "./push-notifications";

export function staleSnapshotMemberIds(
  localMembers: ReadonlyArray<{ id: string; groupId: string; userId: string }>,
  remoteMembers: ReadonlyArray<{ groupId: string; userId: string }>,
  remoteGroupIds: ReadonlySet<string>,
): string[] {
  const remoteIds = new Set(remoteMembers.map(({ groupId, userId }) => `${groupId}:${userId}`));
  return localMembers
    .filter(({ id, groupId }) => remoteGroupIds.has(groupId) && !remoteIds.has(id))
    .map(({ id }) => id);
}

export function staleSnapshotGroupIds(
  localGroupIds: readonly string[],
  remoteGroupIds: ReadonlySet<string>,
  pendingGroupIds: ReadonlySet<string>,
): string[] {
  return localGroupIds.filter((id) => !remoteGroupIds.has(id) && !pendingGroupIds.has(id));
}

export function manifestNeedsBackfill(
  localOperations: ReadonlyArray<Pick<LocalOperation, "groupId" | "syncStatus" | "serverSequence">>,
  remoteGroups: ReadonlyArray<{ groupId: string; count: number; maxSequence: number }>,
): boolean {
  const localByGroup = new Map<string, { count: number; maxSequence: number }>();
  for (const operation of localOperations) {
    if (operation.syncStatus !== "accepted") continue;
    const current = localByGroup.get(operation.groupId) ?? { count: 0, maxSequence: 0 };
    current.count += 1;
    current.maxSequence = Math.max(current.maxSequence, operation.serverSequence ?? 0);
    localByGroup.set(operation.groupId, current);
  }
  return remoteGroups.some((group) => {
    const local = localByGroup.get(group.groupId) ?? { count: 0, maxSequence: 0 };
    return local.count !== group.count || local.maxSequence !== group.maxSequence;
  });
}

export function expenseFromOperation(
  operation: OperationEnvelope,
  syncStatus: LocalOperation["syncStatus"],
  currentActorId: string,
  originalCreatedBy?: string,
  participantAliases: ReadonlyMap<string, string> = new Map(),
): LocalExpense | null {
  if (operation.type !== "ExpenseCreated" && operation.type !== "ExpenseAmended") return null;
  const payload = operation.payload as Record<string, JsonValue>;
  const resolveParticipant = (participantId: string) => participantAliases.get(`${operation.groupId}:${participantId}`) ?? participantId;
  const payers = (payload.payers as Array<{ participantId: string; amountMinor: number }>).map((payer) => ({
    ...payer,
    participantId: resolveParticipant(payer.participantId),
  }));
  const allocations = (payload.allocations as Array<{ participantId: string; amountMinor: number }>).map((allocation) => ({
    ...allocation,
    participantId: resolveParticipant(allocation.participantId),
  }));
  const paid = payers.find(({ participantId }) => participantId === currentActorId)?.amountMinor ?? 0;
  const owed = allocations.find(({ participantId }) => participantId === currentActorId)?.amountMinor ?? 0;
  const importMetadata = payload.import && typeof payload.import === "object" && !Array.isArray(payload.import)
    ? payload.import as Record<string, JsonValue>
    : undefined;
  return {
    id: operation.targetId,
    groupId: operation.groupId,
    description: String(payload.description),
    category: String(payload.category),
    amountMinor: Number(payload.amountMinor),
    currency: String(payload.currency),
    expenseDate: String(payload.expenseDate),
    notes: String(payload.notes ?? ""),
    recurrence: (String(payload.recurrence ?? "none") as NonNullable<LocalExpense["recurrence"]>),
    payers,
    allocations,
    yourNetMinor: paid - owed,
    status: importMetadata?.sourceDeleted === true ? "voided" : "active",
    version: operation.baseVersion + 1,
    createdBy: originalCreatedBy ?? operation.actorId,
    updatedAt: operation.receivedAt ?? operation.clientTimestamp,
    syncStatus,
    ...(importMetadata?.readOnly === true ? { readOnly: true } : {}),
    ...(typeof importMetadata?.importBatchId === "string" ? { importBatchId: importMetadata.importBatchId } : {}),
    ...(typeof importMetadata?.importedByDisplayName === "string" ? { importedByDisplayName: importMetadata.importedByDisplayName } : {}),
    ...(typeof importMetadata?.importedAt === "string" ? { importedAt: importMetadata.importedAt } : {}),
    ...(typeof importMetadata?.sourceProvider === "string" ? { sourceProvider: importMetadata.sourceProvider } : {}),
  };
}

export function remoteProjectionSyncStatus(
  _currentStatus: LocalExpense["syncStatus"] | undefined,
): LocalExpense["syncStatus"] {
  // A server operation is canonical. Failed local operations remain in the
  // activity log for review instead of tainting the projection they lost to.
  return "accepted";
}

const expenseProjectionOperationTypes = new Set([
  "ExpenseCreated",
  "ExpenseAmended",
  "ExpenseVoided",
  "ExpenseRestored",
]);

export function acceptedExpenseProjection(
  operations: readonly LocalOperation[],
  targetId: string,
  currentActorId: string,
  participantAliases: ReadonlyMap<string, string> = new Map(),
): LocalExpense | undefined {
  let projection: LocalExpense | undefined;
  const accepted = operations
    .filter((operation) =>
      operation.targetId === targetId &&
      operation.syncStatus === "accepted" &&
      expenseProjectionOperationTypes.has(operation.type),
    )
    .slice()
    .sort((left, right) =>
      (left.serverSequence ?? Number.MAX_SAFE_INTEGER) - (right.serverSequence ?? Number.MAX_SAFE_INTEGER) ||
      left.clientTimestamp.localeCompare(right.clientTimestamp) ||
      left.id.localeCompare(right.id),
    );
  for (const operation of accepted) {
    const next = expenseFromOperation(operation, "accepted", currentActorId, projection?.createdBy, participantAliases);
    if (next) {
      projection = next;
    } else if (projection && (operation.type === "ExpenseVoided" || operation.type === "ExpenseRestored")) {
      projection = {
        ...projection,
        status: operation.type === "ExpenseVoided" ? "voided" : "active",
        version: operation.baseVersion + 1,
        updatedAt: operation.receivedAt ?? operation.clientTimestamp,
        syncStatus: "accepted",
      };
    }
  }
  return projection;
}

async function restoreCanonicalExpense(
  operation: LocalOperation,
  currentActorId: string,
  participantAliases: ReadonlyMap<string, string>,
): Promise<void> {
  if (!expenseProjectionOperationTypes.has(operation.type)) return;
  const projection = acceptedExpenseProjection(
    await localDb.operations.where("targetId").equals(operation.targetId).toArray(),
    operation.targetId,
    currentActorId,
    participantAliases,
  );
  if (projection) await localDb.expenses.put(projection);
  else await localDb.expenses.update(operation.targetId, { syncStatus: operation.syncStatus });
}

async function applyRemoteBatch(
  operations: readonly OperationEnvelope[],
  currentActorId: string,
  participantAliases: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  if (operations.length === 0) return;
  await localDb.transaction("rw", localDb.operations, localDb.expenses, localDb.groups, async () => {
    await localDb.operations.bulkPut(operations.map((operation): LocalOperation => ({
      ...operation,
      syncStatus: "accepted",
      ...(() => {
        const prefix = `${operation.groupId}:`;
        const aliases = Object.fromEntries(
          [...participantAliases]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key.slice(prefix.length), value]),
        );
        return Object.keys(aliases).length > 0 ? { participantAliases: aliases } : {};
      })(),
    })));
    const targetIds = [...new Set(operations
      .filter(({ type }) => ["ExpenseCreated", "ExpenseAmended", "ExpenseVoided", "ExpenseRestored"].includes(type))
      .map(({ targetId }) => targetId))];
    const existing = await localDb.expenses.bulkGet(targetIds);
    const expenses = new Map(targetIds.flatMap((id, index) => existing[index] ? [[id, existing[index]!] as const] : []));
    const touched = new Set<string>();
    for (const operation of operations) {
      const current = expenses.get(operation.targetId);
      const projectionStatus = remoteProjectionSyncStatus(current?.syncStatus);
      const projected = expenseFromOperation(operation, projectionStatus, currentActorId, current?.createdBy, participantAliases);
      if (projected) {
        expenses.set(operation.targetId, projected);
        touched.add(operation.targetId);
      } else if ((operation.type === "ExpenseVoided" || operation.type === "ExpenseRestored") && current) {
        expenses.set(operation.targetId, {
          ...current,
          status: operation.type === "ExpenseVoided" ? "voided" : "active",
          version: operation.baseVersion + 1,
          updatedAt: operation.receivedAt ?? operation.clientTimestamp,
          syncStatus: projectionStatus,
        });
        touched.add(operation.targetId);
      }
      if (operation.type === "GroupCurrencyChanged") {
        const payload = operation.payload as Record<string, JsonValue>;
        await localDb.groups.update(operation.groupId, {
          settlementCurrency: String(payload.settlementCurrency),
          version: operation.baseVersion + 1,
        });
      }
    }
    const changedExpenses = [...touched].flatMap((id) => {
      const expense = expenses.get(id);
      return expense ? [expense] : [];
    });
    if (changedExpenses.length > 0) await localDb.expenses.bulkPut(changedExpenses);
  });
}

async function capturePreviousExpenseNet(
  operations: readonly OperationEnvelope[],
  currentActorId: string,
  result: Map<string, number>,
  participantAliases: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const targetIds = [...new Set(operations
    .filter(({ type }) => type === "ExpenseAmended")
    .map(({ targetId }) => targetId))];
  const stored = await localDb.expenses.bulkGet(targetIds);
  const projections = new Map(targetIds.flatMap((id, index) => stored[index] ? [[id, stored[index]!] as const] : []));
  for (const operation of operations) {
    const previous = projections.get(operation.targetId);
    if (operation.type === "ExpenseAmended" && previous) {
      result.set(operation.id, -previous.yourNetMinor);
    }
    if (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended") {
      const projected = expenseFromOperation(operation, "accepted", currentActorId, previous?.createdBy, participantAliases);
      if (projected) projections.set(operation.targetId, projected);
    }
  }
}

export type ConnectionState = "connecting" | "online" | "offline" | "error";

export function eventStreamRetryDelay(): number {
  return 2_000;
}

export class SyncRequestQueue {
  private running: Promise<void> | undefined;
  private rerunRequested = false;

  run(task: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    const execution = (async () => {
      do {
        this.rerunRequested = false;
        await task();
      } while (this.rerunRequested);
    })();
    this.running = execution;
    void execution.then(
      () => {
        if (this.running === execution) this.running = undefined;
      },
      () => {
        if (this.running === execution) this.running = undefined;
      },
    );
    return execution;
  }
}

export class SyncEngine {
  private eventSource: EventSource | undefined;
  private eventRetryTimer: number | undefined;
  private disposed = false;
  private readonly requests = new SyncRequestQueue();

  constructor(private readonly onState: (state: ConnectionState, message?: string) => void) {}

  async sync(): Promise<void> {
    return this.requests.run(() => this.syncOnce());
  }

  private async syncOnce(): Promise<void> {
    this.onState("connecting");
    try {
      const device = await ensureDevice();
      await bootstrapDevelopment();
      await registerDevice({
        id: device.deviceId,
        publicKeyJwk: device.publicKeyJwk,
        ...(device.agreementPublicKeyJwk
          ? { encryptionPublicKeyJwk: device.agreementPublicKeyJwk }
          : {}),
        name: "This browser",
      });
      const snapshot = await getSnapshot();
      const participantAliases = new Map(
        (snapshot.participantAliases ?? []).map(({ groupId, fromUserId, toUserId }) => [`${groupId}:${fromUserId}`, toUserId]),
      );
      const knownGeneration = String((await localDb.settings.get("generation"))?.value ?? "");
      const recovering = Boolean(knownGeneration && knownGeneration !== snapshot.manifest.generation);
      await localDb.transaction(
        "rw",
        [
          localDb.groups,
          localDb.members,
          localDb.operations,
          localDb.expenses,
          localDb.confidentialOperations,
          localDb.groupKeyEnvelopes,
        ],
        async () => {
        const remoteGroupIds = new Set(snapshot.groups.map(({ id }) => id));
        const pendingGroupIds = new Set(
          (await localDb.operations.where("syncStatus").equals("pending").toArray())
            .filter(({ type }) => type === "GroupCreated")
            .map(({ groupId }) => groupId),
        );
        const removedGroupIds = staleSnapshotGroupIds(
          (await localDb.groups.toArray()).map(({ id }) => id),
          remoteGroupIds,
          pendingGroupIds,
        );
        if (removedGroupIds.length > 0) {
          await localDb.groups.bulkDelete(removedGroupIds);
          await localDb.members.where("groupId").anyOf(removedGroupIds).delete();
          await localDb.operations.where("groupId").anyOf(removedGroupIds).delete();
          await localDb.expenses.where("groupId").anyOf(removedGroupIds).delete();
          await localDb.confidentialOperations.where("groupId").anyOf(removedGroupIds).delete();
          await localDb.groupKeyEnvelopes.where("groupId").anyOf(removedGroupIds).delete();
        }
        const staleMemberIds = staleSnapshotMemberIds(
          await localDb.members.toArray(),
          snapshot.members,
          remoteGroupIds,
        );
        if (staleMemberIds.length > 0) await localDb.members.bulkDelete(staleMemberIds);
        await localDb.groups.bulkPut(snapshot.groups);
        await localDb.members.bulkPut(
          snapshot.members.map((member) => ({
            id: `${member.groupId}:${member.userId}`,
            groupId: member.groupId,
            userId: member.userId,
            displayName: member.displayName,
            ...(member.email ? { email: member.email } : {}),
            status: member.status,
            ...(member.importClaim ? { importClaim: member.importClaim } : {}),
          })),
        );
      });
      const needsManifestBackfill = manifestNeedsBackfill(
        await localDb.operations.toArray(),
        snapshot.manifest.groups,
      );
      if (participantAliases.size > 0) {
        const visibleGroupIds = new Set(snapshot.groups.map(({ id }) => id));
        const acceptedOperations = (await localDb.operations.toArray())
          .filter((operation) => operation.syncStatus === "accepted" && visibleGroupIds.has(operation.groupId))
          .sort((left, right) => (left.serverSequence ?? 0) - (right.serverSequence ?? 0));
        await applyRemoteBatch(acceptedOperations, device.actorId, participantAliases);
      }

      const outbound = recovering
        ? (await localDb.operations.toArray()).filter((operation) => operation.syncStatus !== "rejected" && operation.syncStatus !== "conflicted")
        : await localDb.operations.where("syncStatus").equals("pending").toArray();
      outbound.sort((left, right) => left.clientTimestamp.localeCompare(right.clientTimestamp));
      for (let offset = 0; offset < outbound.length; offset += 100) {
        const result = await pushOperations(outbound.slice(offset, offset + 100));
        await localDb.transaction("rw", localDb.operations, localDb.expenses, localDb.groups, async () => {
          for (const accepted of [...result.accepted, ...result.duplicates]) {
            await localDb.operations.update(accepted.id, {
              syncStatus: "accepted",
              serverSequence: accepted.serverSequence,
            });
            const operation = await localDb.operations.get(accepted.id);
            if (operation) {
              const existingExpense = await localDb.expenses.get(operation.targetId);
              const expense = expenseFromOperation(operation, "accepted", device.actorId, existingExpense?.createdBy, participantAliases);
              if (expense) await localDb.expenses.put(expense);
              if (operation.type === "ExpenseVoided" || operation.type === "ExpenseRestored") {
                await localDb.expenses.update(operation.targetId, {
                  status: operation.type === "ExpenseVoided" ? "voided" : "active",
                  version: operation.baseVersion + 1,
                  updatedAt: operation.receivedAt ?? operation.clientTimestamp,
                  syncStatus: "accepted",
                });
              }
              if (operation.type === "GroupCurrencyChanged") {
                const payload = operation.payload as Record<string, JsonValue>;
                await localDb.groups.update(operation.groupId, {
                  settlementCurrency: String(payload.settlementCurrency),
                  version: operation.baseVersion + 1,
                });
              }
            }
          }
          for (const conflict of result.conflicts) {
            await localDb.operations.update(conflict.id, { syncStatus: "conflicted", errorCode: "CONFLICT" });
            const operation = await localDb.operations.get(conflict.id);
            if (operation) {
              operation.syncStatus = "conflicted";
              await restoreCanonicalExpense(operation, device.actorId, participantAliases);
            }
          }
          for (const rejected of result.rejected) {
            await localDb.operations.update(rejected.id, {
              syncStatus: "rejected",
              errorCode: rejected.code,
              errorMessage: rejected.message,
            });
            const operation = await localDb.operations.get(rejected.id);
            if (operation) {
              operation.syncStatus = "rejected";
              await restoreCanonicalExpense(operation, device.actorId, participantAliases);
            }
          }
        });
      }

      const needsBackfill = recovering || needsManifestBackfill;
      const storedCursor = needsBackfill ? undefined : await localDb.settings.get("serverSequence");
      let cursor = needsBackfill ? 0 : Number(storedCursor?.value ?? 0);
      let generation = snapshot.manifest.generation;
      const foregroundOperations: OperationEnvelope[] = [];
      const previousExpenseNetMinor = new Map<string, number>();
      while (true) {
        const pulled = await pullOperations(cursor);
        generation = pulled.generation;
        if (storedCursor) {
          foregroundOperations.push(...pulled.operations.filter(({ actorId }) => actorId !== device.actorId));
          await capturePreviousExpenseNet(pulled.operations, device.actorId, previousExpenseNetMinor, participantAliases);
        }
        await applyRemoteBatch(pulled.operations, device.actorId, participantAliases);
        const receivedCursor = pulled.operations.reduce(
          (maximum, operation) => Math.max(maximum, operation.serverSequence ?? 0),
          cursor,
        );
        cursor = receivedCursor > cursor ? receivedCursor : pulled.latestServerSequence;
        await localDb.settings.bulkPut([
          { key: "serverSequence", value: cursor },
          { key: "generation", value: generation },
        ]);
        if (cursor >= pulled.latestServerSequence || pulled.operations.length === 0) break;
      }
      const foregroundMessage = foregroundActivityMessage(foregroundOperations, {
        currentActorId: device.actorId,
        actorNames: new Map(snapshot.members.map((member) => [member.userId, member.displayName])),
        groupNames: new Map(snapshot.groups.map((group) => [group.id, group.name])),
        previousExpenseNetMinor,
      });
      if (foregroundMessage && !(await hasActiveLocalPushSubscription().catch(() => false))) {
        window.dispatchEvent(new CustomEvent("tallied:remote-activity", { detail: { message: foregroundMessage } }));
      }
      this.onState("online");
      this.ensureEvents();
    } catch (error) {
      this.onState(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : "Sync unavailable");
    }
  }

  private ensureEvents(): void {
    if (this.eventSource || this.disposed) return;
    if (this.eventRetryTimer !== undefined) {
      window.clearTimeout(this.eventRetryTimer);
      this.eventRetryTimer = undefined;
    }
    const eventsUrl = new URL(`${apiBaseUrl}/api/v1/sync/events`);
    if (import.meta.env.DEV) eventsUrl.searchParams.set("devUser", developmentActorId);
    this.eventSource = new EventSource(eventsUrl, { withCredentials: true });
    this.eventSource.addEventListener("sequence", () => void this.sync());
    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = undefined;
      if (!this.disposed) {
        this.eventRetryTimer = window.setTimeout(() => {
          this.eventRetryTimer = undefined;
          this.ensureEvents();
        }, eventStreamRetryDelay());
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    this.eventSource?.close();
    if (this.eventRetryTimer !== undefined) window.clearTimeout(this.eventRetryTimer);
  }
}
