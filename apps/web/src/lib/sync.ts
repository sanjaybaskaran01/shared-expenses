import type { JsonValue, OperationEnvelope } from "@expenses/protocol";
import { apiBaseUrl, bootstrapDevelopment, getSnapshot, pullOperations, pushOperations, registerDevice } from "./api";
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

async function applyRemote(operation: OperationEnvelope, currentActorId: string): Promise<void> {
  const localOperation: LocalOperation = { ...operation, syncStatus: "accepted" };
  await localDb.operations.put(localOperation);
  const existingExpense = await localDb.expenses.get(operation.targetId);
  const expense = expenseFromOperation(operation, "accepted", currentActorId, existingExpense?.createdBy);
  if (expense) await localDb.expenses.put(expense);
  if (operation.type === "ExpenseVoided") {
    await localDb.expenses.update(operation.targetId, {
      status: "voided",
      version: operation.baseVersion + 1,
      updatedAt: operation.receivedAt ?? operation.clientTimestamp,
      syncStatus: "accepted",
    });
  }
}

export type ConnectionState = "connecting" | "online" | "offline" | "error";

export class SyncEngine {
  private eventSource: EventSource | undefined;
  private syncing = false;

  constructor(private readonly onState: (state: ConnectionState, message?: string) => void) {}

  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.onState("connecting");
    try {
      const device = await ensureDevice();
      await bootstrapDevelopment();
      await registerDevice({ id: device.deviceId, publicKeyJwk: device.publicKeyJwk, name: "This browser" });
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
        await localDb.transaction("rw", localDb.operations, localDb.expenses, async () => {
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

      const cursor = recovering ? 0 : Number((await localDb.settings.get("serverSequence"))?.value ?? 0);
      const pulled = await pullOperations(cursor);
      for (const operation of pulled.operations) await applyRemote(operation, device.actorId);
      await localDb.settings.bulkPut([
        { key: "serverSequence", value: pulled.latestServerSequence },
        { key: "generation", value: pulled.generation },
      ]);
      this.onState("online");
      this.ensureEvents();
    } catch (error) {
      this.onState(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : "Sync unavailable");
    } finally {
      this.syncing = false;
    }
  }

  private ensureEvents(): void {
    if (this.eventSource) return;
    this.eventSource = new EventSource(`${apiBaseUrl}/api/v1/sync/events`, { withCredentials: true });
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
