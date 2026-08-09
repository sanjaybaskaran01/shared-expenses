import type { ImportPreparedReview, NormalizedImportDraft } from "@expenses/protocol";
import { resolveImportIdentities, stageImport } from "./api";
import { signOperation } from "./device";
import { buildImportCommit, preparedImportReview } from "./import-commit";

export interface PlanImportOptions {
  selectedGroupIds: string[];
  importerExternalIds: string[];
  importedByDisplayName: string;
  actorId: string;
  deviceId: string;
  importedAt: string;
  privateKey: CryptoKey;
  onProgress?: (phase: "planning" | "uploading", completed: number, total: number) => void;
}

type PlanResponse =
  | { type: "progress"; phase: "planning" | "uploading"; completed: number; total: number }
  | { type: "complete"; review: ImportPreparedReview }
  | { type: "error"; message: string };

async function planOnCurrentThread(
  draft: NormalizedImportDraft,
  options: PlanImportOptions,
): Promise<ImportPreparedReview> {
  const commit = await buildImportCommit(draft, {
    selectedGroupIds: options.selectedGroupIds,
    importerExternalIds: options.importerExternalIds,
    importedByDisplayName: options.importedByDisplayName,
    actorId: options.actorId,
    deviceId: options.deviceId,
    importedAt: options.importedAt,
    sign: (operation) => signOperation(operation, options.privateKey),
    resolveIdentities: resolveImportIdentities,
    ...(options.onProgress ? { onProgress: (completed: number, total: number) => options.onProgress!("planning", completed, total) } : {}),
  });
  await stageImport(commit, (completed, total) => options.onProgress?.("uploading", completed, total));
  return preparedImportReview(commit, draft, options.selectedGroupIds);
}

/**
 * Plans and signs large migrations in a dedicated Worker. The fallback keeps
 * migration available in older embedded browsers that cannot clone CryptoKey.
 */
export function planImportOffMainThread(
  draft: NormalizedImportDraft,
  options: PlanImportOptions,
): Promise<ImportPreparedReview> {
  if (typeof Worker === "undefined") return planOnCurrentThread(draft, options);

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./import-commit.worker.ts", import.meta.url), { type: "module" });
    const timeout = globalThis.setTimeout(() => {
      worker.terminate();
      reject(new Error("This import took too long to prepare. Try again."));
    }, 10 * 60_000);
    const finish = (): void => {
      globalThis.clearTimeout(timeout);
      worker.terminate();
    };
    worker.addEventListener("message", (event: MessageEvent<PlanResponse>) => {
      if (event.data.type === "progress") {
        options.onProgress?.(event.data.phase, event.data.completed, event.data.total);
        return;
      }
      finish();
      if (event.data.type === "complete") resolve(event.data.review);
      else reject(new Error(event.data.message));
    });
    worker.addEventListener("error", () => {
      finish();
      reject(new Error("Unable to prepare this import on this device."));
    }, { once: true });
    try {
      worker.postMessage({
        draft,
        selectedGroupIds: options.selectedGroupIds,
        importerExternalIds: options.importerExternalIds,
        importedByDisplayName: options.importedByDisplayName,
        actorId: options.actorId,
        deviceId: options.deviceId,
        importedAt: options.importedAt,
        privateKey: options.privateKey,
      });
    } catch (error) {
      finish();
      if (error instanceof DOMException && error.name === "DataCloneError") {
        void planOnCurrentThread(draft, options).then(resolve, reject);
        return;
      }
      reject(error);
    }
  });
}
