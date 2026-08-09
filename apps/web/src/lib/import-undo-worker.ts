import type { ImportUndoResult } from "@expenses/protocol";
import type { LocalOperation } from "./db";
import { signOperation } from "./device";
import { undoImport } from "./api";
import { buildImportUndo } from "./import-undo";

export interface UndoImportWorkerOptions {
  actorId: string;
  deviceId: string;
  timestamp: string;
  privateKey: CryptoKey;
  onProgress?: (phase: "planning" | "uploading", completed: number, total: number) => void;
}

type UndoResponse =
  | { type: "progress"; phase: "planning" | "uploading"; completed: number; total: number }
  | { type: "complete"; result: ImportUndoResult }
  | { type: "error"; message: string };

async function undoOnCurrentThread(
  batchId: string,
  operations: readonly LocalOperation[],
  options: UndoImportWorkerOptions,
): Promise<ImportUndoResult> {
  const request = await buildImportUndo(batchId, operations, {
    actorId: options.actorId,
    deviceId: options.deviceId,
    timestamp: options.timestamp,
    sign: (operation) => signOperation(operation, options.privateKey),
    onProgress: (completed, total) => options.onProgress?.("planning", completed, total),
  });
  if (request.operations.length === 0) throw new Error("Sync this device before undoing the import.");
  return undoImport(batchId, request, (completed, total) => options.onProgress?.("uploading", completed, total));
}

/** Plans, signs, and uploads a migration undo away from the UI thread. */
export function undoImportOffMainThread(
  batchId: string,
  operations: readonly LocalOperation[],
  options: UndoImportWorkerOptions,
): Promise<ImportUndoResult> {
  if (typeof Worker === "undefined") return undoOnCurrentThread(batchId, operations, options);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./import-undo.worker.ts", import.meta.url), { type: "module" });
    const timeout = globalThis.setTimeout(() => {
      worker.terminate();
      reject(new Error("Undoing this import took too long. Try again."));
    }, 10 * 60_000);
    const finish = (): void => {
      globalThis.clearTimeout(timeout);
      worker.terminate();
    };
    worker.addEventListener("message", (event: MessageEvent<UndoResponse>) => {
      if (event.data.type === "progress") {
        options.onProgress?.(event.data.phase, event.data.completed, event.data.total);
        return;
      }
      finish();
      if (event.data.type === "complete") resolve(event.data.result);
      else reject(new Error(event.data.message));
    });
    worker.addEventListener("error", () => {
      finish();
      reject(new Error("This device could not undo the import. Try again here or use another device."));
    }, { once: true });
    try {
      worker.postMessage({
        batchId,
        operations,
        actorId: options.actorId,
        deviceId: options.deviceId,
        timestamp: options.timestamp,
        privateKey: options.privateKey,
      });
    } catch (error) {
      finish();
      if (error instanceof DOMException && error.name === "DataCloneError") {
        void undoOnCurrentThread(batchId, operations, options).then(resolve, reject);
        return;
      }
      reject(error);
    }
  });
}
