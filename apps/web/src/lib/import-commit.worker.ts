import {
  type ImportPreparedReview,
  type NormalizedImportDraft,
} from "@expenses/protocol";
import { resolveImportIdentities, stageImport } from "./api";
import { buildImportCommit, preparedImportReview } from "./import-commit";
import { signOperation } from "./operation-signing";

interface PlanRequest {
  draft: NormalizedImportDraft;
  selectedGroupIds: string[];
  importerExternalIds: string[];
  importedByDisplayName: string;
  actorId: string;
  deviceId: string;
  importedAt: string;
  privateKey: CryptoKey;
}

type PlanResponse =
  | { type: "progress"; phase: "planning" | "uploading"; completed: number; total: number }
  | { type: "complete"; review: ImportPreparedReview }
  | { type: "error"; message: string };

self.addEventListener("message", async (event: MessageEvent<PlanRequest>) => {
  const request = event.data;
  let lastReported = 0;
  try {
    const commit = await buildImportCommit(request.draft, {
      selectedGroupIds: request.selectedGroupIds,
      importerExternalIds: request.importerExternalIds,
      importedByDisplayName: request.importedByDisplayName,
      actorId: request.actorId,
      deviceId: request.deviceId,
      importedAt: request.importedAt,
      sign: (operation) => signOperation(operation, request.privateKey),
      resolveIdentities: resolveImportIdentities,
      onProgress: (completed, total) => {
        if (completed === total || completed - lastReported >= 250) {
          lastReported = completed;
          self.postMessage({ type: "progress", phase: "planning", completed, total } satisfies PlanResponse);
        }
      },
    });
    const review: ImportPreparedReview = preparedImportReview(commit, request.draft, request.selectedGroupIds);
    // The compact review above is all that remains necessary from the
    // normalized draft while encrypted chunks upload.
    request.draft.records.length = 0;
    request.draft.sourceBalances.length = 0;
    request.draft.warnings.length = 0;
    lastReported = 0;
    await stageImport(commit, (completed, total) => {
      if (completed === total || completed - lastReported >= 1_000) {
        lastReported = completed;
        self.postMessage({ type: "progress", phase: "uploading", completed, total } satisfies PlanResponse);
      }
    });
    self.postMessage({ type: "complete", review } satisfies PlanResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Tallied could not prepare this import. Try again.",
    } satisfies PlanResponse);
  }
});
