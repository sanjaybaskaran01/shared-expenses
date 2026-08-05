import { describe, expect, test } from "bun:test";
import type { OperationEnvelope, UnsignedOperation } from "@expenses/protocol";
import type { LocalOperation } from "../src/lib/db";
import { buildImportUndo } from "../src/lib/import-undo";

const sign = async (operation: UnsignedOperation): Promise<OperationEnvelope> => ({
  ...operation,
  contentHash: "a".repeat(64),
  signature: "signed",
});

function creation(type: LocalOperation["type"], targetId: string, sourceDeleted = false): LocalOperation {
  return {
    id: `operation-${targetId}`,
    groupId: "group-1",
    actorId: "user-1",
    deviceId: "device-1",
    type,
    targetId,
    baseVersion: 0,
    clientTimestamp: "2026-08-04T00:00:00.000Z",
    payload: {
      import: { importBatchId: "batch-1", sourceDeleted },
    },
    contentHash: "a".repeat(64),
    signature: "signed",
    syncStatus: "accepted",
  };
}

describe("migration undo planner", () => {
  test("creates one typed signed reversal for every active imported record", async () => {
    const result = await buildImportUndo("batch-1", [
      creation("ExpenseCreated", "expense"),
      creation("PaymentRecorded", "payment"),
      creation("ImportedTransactionRecorded", "effect"),
      creation("OpeningBalanceCreated", "opening"),
      creation("ExpenseCreated", "source-deleted", true),
    ], {
      actorId: "user-1",
      deviceId: "device-1",
      timestamp: "2026-08-05T00:00:00.000Z",
      sign,
    });
    expect(result.operations.map(({ type }) => type).sort()).toEqual([
      "ExpenseVoided",
      "ImportedTransactionVoided",
      "OpeningBalanceVoided",
      "PaymentReversed",
    ].sort());
    expect(result.operations.every((operation) => operation.baseVersion === 1)).toBe(true);
  });

  test("excludes records already reversed by this batch undo", async () => {
    const reversed = {
      ...creation("ImportedTransactionVoided", "effect"),
      payload: { undoImportBatchId: "batch-1" },
    } satisfies LocalOperation;
    const result = await buildImportUndo("batch-1", [creation("ImportedTransactionRecorded", "effect"), reversed], {
      actorId: "user-1",
      deviceId: "device-1",
      timestamp: "2026-08-05T00:00:00.000Z",
      sign,
    });
    expect(result.operations).toEqual([]);
  });

  test("reports bounded signing progress for a large undo", async () => {
    const progress: Array<[number, number]> = [];
    const operations = Array.from({ length: 501 }, (_, index) => creation("ImportedTransactionRecorded", `effect-${index}`));
    const result = await buildImportUndo("batch-1", operations, {
      actorId: "user-1",
      deviceId: "device-1",
      timestamp: "2026-08-05T00:00:00.000Z",
      sign,
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(result.operations).toHaveLength(501);
    expect(progress.at(-1)).toEqual([501, 501]);
    expect(progress.length).toBeLessThanOrEqual(3);
  });
});
