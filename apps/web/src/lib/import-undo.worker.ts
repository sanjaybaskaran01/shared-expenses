import {
  operationContentHash,
  type ImportUndoResult,
  type JsonValue,
  type OperationEnvelope,
  type UnsignedOperation,
} from "@expenses/protocol";
import type { LocalOperation } from "./db";
import { undoImport } from "./api";
import { buildImportUndo } from "./import-undo";

interface UndoRequest {
  batchId: string;
  operations: LocalOperation[];
  actorId: string;
  deviceId: string;
  timestamp: string;
  privateKey: CryptoKey;
}

type UndoResponse =
  | { type: "progress"; phase: "planning" | "uploading"; completed: number; total: number }
  | { type: "complete"; result: ImportUndoResult }
  | { type: "error"; message: string };

function encodeBase64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signOperation<TPayload extends JsonValue>(
  operation: UnsignedOperation<TPayload>,
  privateKey: CryptoKey,
): Promise<OperationEnvelope<TPayload>> {
  const contentHash = await operationContentHash(operation);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(contentHash),
  );
  return { ...operation, contentHash, signature: encodeBase64Url(signature) };
}

self.addEventListener("message", async (event: MessageEvent<UndoRequest>) => {
  const request = event.data;
  try {
    const undo = await buildImportUndo(request.batchId, request.operations, {
      actorId: request.actorId,
      deviceId: request.deviceId,
      timestamp: request.timestamp,
      sign: (operation) => signOperation(operation, request.privateKey),
      onProgress: (completed, total) => self.postMessage({
        type: "progress",
        phase: "planning",
        completed,
        total,
      } satisfies UndoResponse),
    });
    if (undo.operations.length === 0) throw new Error("Sync this device before undoing the import.");
    const result = await undoImport(request.batchId, undo, (completed, total) => self.postMessage({
      type: "progress",
      phase: "uploading",
      completed,
      total,
    } satisfies UndoResponse));
    self.postMessage({ type: "complete", result } satisfies UndoResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Unable to undo this import. Try again.",
    } satisfies UndoResponse);
  }
});
