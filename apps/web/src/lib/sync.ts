import type { JsonValue, OperationEnvelope } from "@expenses/protocol";
import { apiBaseUrl, bootstrapDevelopment, developmentActorId, getSnapshot, pullOperations, pushOperations, registerDevice } from "./api";
import { localDb, type LocalExpense, type LocalOperation } from "./db";
import { ensureDevice } from "./device";

export function expenseFromOperation(
  operation: OperationEnvelope,
  syncStatus: LocalOperation["syncStatus"],
  currentActorId: string,
  originalCreatedBy?: string,
): LocalExpense | null {
  if (operation.type !== "ExpenseCreated" && operation.type !== "ExpenseAmended") return null;
  const payload = operation.payload as Record<string, JsonValue>;
  const payers = payload.payers as Array<{ participantId: string; amountMinor: number }>;
  const allocations = payload.allocations as Array<{ participantId: string; amountMinor: number }>;
  const paid = payers.find(({ participantId }) => participantId === currentActorId)?.amountMinor ?? 0;
  const owed = allocations.find(({ participantId }) => participantId === currentActorId)?.amountMinor ?? 0;
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
    status: "active",
    version: operation.baseVersion + 1,
    createdBy: originalCreatedBy ?? operation.actorId,
    updatedAt: operation.receivedAt ?? operation.clientTimestamp,
    syncStatus,
  };
}

export function remoteProjectionSyncStatus(
  currentStatus: LocalExpense["syncStatus"] | undefined,
): LocalExpense["syncStatus"] {
  return currentStatus === "conflicted" || currentStatus === "rejected" ? currentStatus : "accepted";
}

async function applyRemote(operation: OperationEnvelope, currentActorId: string): Promise<void> {
  const localOperation: LocalOperation = { ...operation, syncStatus: "accepted" };
  await localDb.operations.put(localOperation);
  const existingExpense = await localDb.expenses.get(operation.targetId);
  const projectionStatus = remoteProjectionSyncStatus(existingExpense?.syncStatus);
  const expense = expenseFromOperation(operation, projectionStatus, currentActorId, existingExpense?.createdBy);
  if (expense) await localDb.expenses.put(expense);
  if (operation.type === "ExpenseVoided") {
    await localDb.expenses.update(operation.targetId, {
      status: "voided",
      version: operation.baseVersion + 1,
      updatedAt: operation.receivedAt ?? operation.clientTimestamp,
      syncStatus: projectionStatus,
    });
  }
  if (operation.type === "ExpenseRestored") {
    await localDb.expenses.update(operation.targetId, {
      status: "active",
      version: operation.baseVersion + 1,
      updatedAt: operation.receivedAt ?? operation.clientTimestamp,
      syncStatus: projectionStatus,
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

export type ConnectionState = "connecting" | "online" | "offline" | "error";

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
      const knownGeneration = String((await localDb.settings.get("generation"))?.value ?? "");
      const recovering = Boolean(knownGeneration && knownGeneration !== snapshot.manifest.generation);
      await localDb.transaction("rw", localDb.groups, localDb.members, async () => {
        await localDb.groups.bulkPut(snapshot.groups);
        await localDb.members.bulkPut(
          snapshot.members.map((member) => ({
            id: `${member.groupId}:${member.userId}`,
            groupId: member.groupId,
            userId: member.userId,
            displayName: member.displayName,
            ...(member.email ? { email: member.email } : {}),
            status: member.status,
          })),
        );
      });

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
              const expense = expenseFromOperation(operation, "accepted", device.actorId, existingExpense?.createdBy);
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
            if (operation) await localDb.expenses.update(operation.targetId, { syncStatus: "conflicted" });
          }
          for (const rejected of result.rejected) {
            await localDb.operations.update(rejected.id, { syncStatus: "rejected", errorCode: rejected.code });
            const operation = await localDb.operations.get(rejected.id);
            if (operation) await localDb.expenses.update(operation.targetId, { syncStatus: "rejected" });
          }
        });
      }

      let cursor = recovering ? 0 : Number((await localDb.settings.get("serverSequence"))?.value ?? 0);
      let generation = snapshot.manifest.generation;
      while (true) {
        const pulled = await pullOperations(cursor);
        generation = pulled.generation;
        for (const operation of pulled.operations) await applyRemote(operation, device.actorId);
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
      this.onState("online");
      this.ensureEvents();
    } catch (error) {
      this.onState(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : "Sync unavailable");
    }
  }

  private ensureEvents(): void {
    if (this.eventSource) return;
    const eventsUrl = new URL(`${apiBaseUrl}/api/v1/sync/events`);
    if (import.meta.env.DEV) eventsUrl.searchParams.set("devUser", developmentActorId);
    this.eventSource = new EventSource(eventsUrl, { withCredentials: true });
    this.eventSource.addEventListener("sequence", () => void this.sync());
    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = undefined;
    };
  }

  dispose(): void {
    this.eventSource?.close();
  }
}
