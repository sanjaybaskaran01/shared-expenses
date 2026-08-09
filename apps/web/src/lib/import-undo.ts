import type { JsonValue, OperationEnvelope, UnsignedOperation } from "@expenses/protocol";
import type { LocalOperation } from "./db";
import { deterministicImportId } from "./import-commit";

export interface BuildImportUndoOptions {
  actorId: string;
  deviceId: string;
  timestamp: string;
  sign: (operation: UnsignedOperation) => Promise<OperationEnvelope>;
  onProgress?: (completed: number, total: number) => void;
}

function payload(operation: LocalOperation): Record<string, JsonValue> {
  return operation.payload as Record<string, JsonValue>;
}

function importBatchId(operation: LocalOperation): string | undefined {
  const metadata = payload(operation).import;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return typeof (metadata as Record<string, JsonValue>).importBatchId === "string"
    ? String((metadata as Record<string, JsonValue>).importBatchId)
    : undefined;
}

function sourceDeleted(operation: LocalOperation): boolean {
  const metadata = payload(operation).import;
  return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && (metadata as Record<string, JsonValue>).sourceDeleted === true);
}

export async function buildImportUndo(
  batchId: string,
  operations: readonly LocalOperation[],
  options: BuildImportUndoOptions,
): Promise<{ operations: OperationEnvelope[] }> {
  const alreadyUndone = new Set(
    operations
      .filter((operation) => {
        if (!["ExpenseVoided", "PaymentReversed", "ImportedTransactionVoided", "OpeningBalanceVoided"].includes(operation.type)) return false;
        return payload(operation).undoImportBatchId === batchId && operation.syncStatus !== "rejected" && operation.syncStatus !== "conflicted";
      })
      .map(({ targetId }) => targetId),
  );
  const creations = operations
    .filter((operation) =>
      importBatchId(operation) === batchId
      && ["ExpenseCreated", "PaymentRecorded", "ImportedTransactionRecorded", "OpeningBalanceCreated"].includes(operation.type)
      && !sourceDeleted(operation)
      && !alreadyUndone.has(operation.targetId)
      && operation.syncStatus !== "rejected"
      && operation.syncStatus !== "conflicted",
    )
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
  const reversals = new Array<OperationEnvelope>(creations.length);
  let next = 0;
  let completed = 0;
  let lastReported = 0;
  const worker = async (): Promise<void> => {
    while (next < creations.length) {
      const index = next++;
      const operation = creations[index]!;
    const type = operation.type === "ExpenseCreated"
      ? "ExpenseVoided"
      : operation.type === "PaymentRecorded"
        ? "PaymentReversed"
        : operation.type === "OpeningBalanceCreated"
          ? "OpeningBalanceVoided"
          : "ImportedTransactionVoided";
      reversals[index] = await options.sign({
      id: await deterministicImportId("undo-operation", `${batchId}:${operation.targetId}`),
      groupId: operation.groupId,
      actorId: options.actorId,
      deviceId: options.deviceId,
      type,
      targetId: operation.targetId,
      baseVersion: operation.baseVersion + 1,
      clientTimestamp: options.timestamp,
      payload: { undoImportBatchId: batchId, reason: "Undo import" },
      });
      completed += 1;
      if (completed === creations.length || completed - lastReported >= 250) {
        lastReported = completed;
        options.onProgress?.(completed, creations.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, creations.length) }, () => worker()));
  return { operations: reversals };
}
