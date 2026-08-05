import type { OperationEnvelope, UnsignedOperation } from "../packages/protocol/src";
import { buildImportCommit, preparedImportReview } from "../apps/web/src/lib/import-commit";
import { buildImportUndo } from "../apps/web/src/lib/import-undo";
import { parseSplitwiseCsv, reconcileImportDraft } from "../apps/web/src/lib/splitwise-import";
import type { LocalOperation } from "../apps/web/src/lib/db";

const RECORD_COUNT = 100_000;
const startedAt = performance.now();
const rows = Array.from(
  { length: RECORD_COUNT },
  (_, index) => `2026-08-01,Entry ${index},Imported,1.00,USD,0.50,-0.50`,
);
const csv = ["Date,Description,Category,Cost,Currency,Owner,Friend", ...rows].join("\n");
const draft = parseSplitwiseCsv(csv, { sourceName: "scale.csv", sourceHash: "a".repeat(64) });
if (draft.records.length !== RECORD_COUNT || draft.warnings.length !== 0) {
  throw new Error(`Parser scale smoke failed: ${draft.records.length} records, ${draft.warnings.length} warnings`);
}
const reconciliation = reconcileImportDraft(draft);
if (!reconciliation.zeroSum || reconciliation.blockingWarnings.length > 0) {
  throw new Error("Parser scale smoke did not reconcile");
}
const parsedAt = performance.now();

const commit = await buildImportCommit(draft, {
  selectedGroupIds: draft.groups.map(({ externalId }) => externalId),
  importerExternalIds: ["name:owner"],
  importedByDisplayName: "Scale owner",
  actorId: "scale-user",
  deviceId: "scale-device",
  importedAt: "2026-08-04T00:00:00.000Z",
  sign: async (operation: UnsignedOperation): Promise<OperationEnvelope> => ({
    ...operation,
    contentHash: "0".repeat(64),
    signature: "scale-signature",
  }),
  resolveIdentities: async ({ identities }) => ({
    resolved: Object.fromEntries(identities.map((identity) => [
      identity.externalId,
      identity.isImporter ? "scale-user" : `import:${identity.id}`,
    ])),
  }),
});
if (commit.operations.length !== RECORD_COUNT + draft.groups.length) {
  throw new Error(`Import planner scale smoke failed: ${commit.operations.length} operations`);
}
const review = preparedImportReview(commit, draft, draft.groups.map(({ externalId }) => externalId));
const reviewBytes = new TextEncoder().encode(JSON.stringify(review)).byteLength;
if (reviewBytes > 1024 * 1024 || "operations" in review) {
  throw new Error(`Prepared review is not compact: ${reviewBytes} bytes`);
}
const plannedAt = performance.now();
const operations: LocalOperation[] = commit.operations
  .filter(({ type }) => type !== "GroupCreated")
  .map((operation) => ({ ...operation, syncStatus: "accepted" as const }));
const undo = await buildImportUndo(commit.id, operations, {
  actorId: "scale-user",
  deviceId: "scale-device",
  timestamp: "2026-08-04T00:01:00.000Z",
  sign: async (operation: UnsignedOperation): Promise<OperationEnvelope> => ({
    ...operation,
    contentHash: "1".repeat(64),
    signature: "scale-signature",
  }),
});
if (undo.operations.length !== RECORD_COUNT) {
  throw new Error("Undo planner scale smoke failed");
}
const finishedAt = performance.now();

console.info(JSON.stringify({
  records: RECORD_COUNT,
  csvMiB: Number((new TextEncoder().encode(csv).byteLength / (1024 * 1024)).toFixed(2)),
  draftMiB: Number((new TextEncoder().encode(JSON.stringify(draft)).byteLength / (1024 * 1024)).toFixed(2)),
  signedCommitMiB: Number((new TextEncoder().encode(JSON.stringify(commit)).byteLength / (1024 * 1024)).toFixed(2)),
  uiReviewKiB: Number((reviewBytes / 1024).toFixed(2)),
  parseAndReconcileMs: Math.round(parsedAt - startedAt),
  planImportMs: Math.round(plannedAt - parsedAt),
  planUndoMs: Math.round(finishedAt - plannedAt),
  totalMs: Math.round(finishedAt - startedAt),
}));
