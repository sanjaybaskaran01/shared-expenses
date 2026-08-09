import type {
  ImportBatchCommitRequest,
  ImportIdentityResolutionRequest,
  ImportStageChunkRequest,
  ImportStageStartRequest,
  ImportUndoRequest,
  ImportUndoStageChunkRequest,
  ImportUndoStageStartRequest,
} from "@expenses/protocol";
import type { ApiContext, AuthenticatedRouteRequest, RouteResult } from "../api-context";

export async function handleImportRoutes(
  context: ApiContext,
  { request, url, actorId }: AuthenticatedRouteRequest,
): Promise<RouteResult> {
  const { config, ledger, splitwiseConnector, publish, http } = context;
  const { json, error, bodyJson, validInviteToken, consumeMutation } = http;
  const publishGroups = (groupIds: readonly string[]) => {
    for (const memberId of ledger.activeMemberIdsForGroups(groupIds)) {
      publish(memberId, ledger.latestSequenceFor(memberId));
    }
  };

  if (url.pathname === "/api/v1/imports" && request.method === "GET") {
    return json(request, { imports: ledger.listImports(actorId) });
  }

  if (url.pathname === "/api/v1/imports/resolve-identities" && request.method === "POST") {
    if (!consumeMutation(`import-identity:${actorId}`, 30, 60 * 60_000)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many identity checks. Try again later.");
    }
    const body = await bodyJson<ImportIdentityResolutionRequest>(request, 200_000);
    try {
      return json(request, ledger.resolveImportIdentityTargets(actorId, body));
    } catch (cause) {
      return error(request, 400, "IMPORT_IDENTITIES_INVALID", cause instanceof Error ? cause.message : "Tallied could not match the imported people. Review them and try again.");
    }
  }

  if (url.pathname === "/api/v1/imports/splitwise/start" && request.method === "POST") {
    if (!splitwiseConnector) {
      return error(request, 403, "SPLITWISE_APPROVAL_REQUIRED", "Direct connection is unavailable until Splitwise grants written API approval.");
    }
    if (!consumeMutation(actorId, 10)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many import attempts. Wait a moment, then try again.");
    }
    return json(request, splitwiseConnector.start(actorId), 201);
  }

  if (url.pathname === "/api/v1/imports/splitwise/snapshot" && request.method === "POST") {
    if (!splitwiseConnector) return error(request, 404, "NOT_FOUND", "Not found");
    const body = await bodyJson<{ sessionId?: string }>(request, 2_000);
    const sessionId = body.sessionId?.trim() ?? "";
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) {
      return error(request, 400, "INVALID_SESSION", "This Splitwise connection has expired. Connect again.");
    }
    try {
      return json(request, { snapshot: await splitwiseConnector.snapshot(actorId, sessionId) });
    } catch (cause) {
      return error(request, 400, "SPLITWISE_READ_FAILED", cause instanceof Error ? cause.message : "Unable to read your Splitwise data. Try again.");
    }
  }

  if (url.pathname === "/api/v1/imports/splitwise/cancel" && request.method === "POST") {
    if (!splitwiseConnector) return error(request, 404, "NOT_FOUND", "Not found");
    const body = await bodyJson<{ sessionId?: string }>(request, 2_000);
    const sessionId = body.sessionId?.trim() ?? "";
    if (/^[0-9a-f-]{36}$/.test(sessionId)) splitwiseConnector.cancel(actorId, sessionId);
    return json(request, { status: "cancelled" });
  }

  if (url.pathname === "/api/v1/imports/activate" && request.method === "POST") {
    if (!consumeMutation(actorId, 10)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many import attempts. Wait a moment, then try again.");
    }
    const body = await bodyJson<ImportBatchCommitRequest>(request, 12_000_000);
    try {
      const result = await ledger.activateImport(actorId, body);
      if (!result.duplicate) publishGroups(body.operations.map(({ groupId }) => groupId));
      return json(request, result, result.duplicate ? 200 : 201);
    } catch (cause) {
      return error(request, 400, "IMPORT_REJECTED", cause instanceof Error ? cause.message : "Unable to verify this import. Review it and try again.");
    }
  }

  if (url.pathname === "/api/v1/imports/stage" && request.method === "POST") {
    if (!consumeMutation(actorId, 30)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many import attempts. Wait a moment, then try again.");
    }
    const body = await bodyJson<ImportStageStartRequest>(request, 12_000_000);
    try {
      return json(request, ledger.startImportStage(actorId, body), 201);
    } catch (cause) {
      return error(request, 400, "IMPORT_STAGE_REJECTED", cause instanceof Error ? cause.message : "This import upload is unavailable. Start again.");
    }
  }

  const chunkMatch = /^\/api\/v1\/imports\/([^/]+)\/chunks$/.exec(url.pathname);
  if (chunkMatch && request.method === "POST") {
    if (!consumeMutation(`import-chunk:${actorId}`, 1_000, 60 * 60_000)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "This import is uploading too quickly. Wait a moment, then try again.");
    }
    const body = await bodyJson<ImportStageChunkRequest>(request, 4_000_000);
    try {
      return json(request, await ledger.stageImportOperations(actorId, decodeURIComponent(chunkMatch[1]!), body));
    } catch (cause) {
      return error(request, 400, "IMPORT_CHUNK_REJECTED", cause instanceof Error ? cause.message : "This import upload is unavailable. Start again.");
    }
  }

  const activateMatch = /^\/api\/v1\/imports\/([^/]+)\/activate$/.exec(url.pathname);
  if (activateMatch && request.method === "POST") {
    const batchId = decodeURIComponent(activateMatch[1]!);
    try {
      const result = await ledger.activateImportStage(actorId, batchId);
      if (!result.duplicate) publishGroups(ledger.groupIdsForImportBatch(actorId, batchId));
      return json(request, result, result.duplicate ? 200 : 201);
    } catch (cause) {
      return error(request, 400, "IMPORT_REJECTED", cause instanceof Error ? cause.message : "This import is unavailable. Review it and try again.");
    }
  }

  const cancelMatch = /^\/api\/v1\/imports\/([^/]+)\/cancel$/.exec(url.pathname);
  if (cancelMatch && request.method === "POST") {
    if (!ledger.cancelImportStage(actorId, decodeURIComponent(cancelMatch[1]!))) {
      return error(request, 409, "IMPORT_CANCEL_TOO_LATE", "This import is unavailable or is already being finished.");
    }
    return json(request, { status: "cancelled" });
  }

  const undoStageMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-stage$/.exec(url.pathname);
  if (undoStageMatch && request.method === "POST") {
    if (!consumeMutation(actorId, 10)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many import attempts. Wait a moment, then try again.");
    }
    const batchId = decodeURIComponent(undoStageMatch[1]!);
    const body = await bodyJson<ImportUndoStageStartRequest>(request, 10_000);
    try {
      return json(request, ledger.startImportUndoStage(actorId, batchId, body), 201);
    } catch (cause) {
      return error(request, 400, "IMPORT_UNDO_STAGE_REJECTED", cause instanceof Error ? cause.message : "Tallied could not prepare to undo this import. Try again.");
    }
  }

  const undoChunkMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-chunks$/.exec(url.pathname);
  if (undoChunkMatch && request.method === "POST") {
    if (!consumeMutation(`import-undo-chunk:${actorId}`, 1_000, 60 * 60_000)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many undo chunks. Try again later.");
    }
    const batchId = decodeURIComponent(undoChunkMatch[1]!);
    const body = await bodyJson<ImportUndoStageChunkRequest>(request, 4_000_000);
    try {
      return json(request, ledger.stageImportUndoOperations(actorId, batchId, body));
    } catch (cause) {
      return error(request, 400, "IMPORT_UNDO_CHUNK_REJECTED", cause instanceof Error ? cause.message : "Tallied could not continue undoing this import. Try again.");
    }
  }

  const undoActivateMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-activate$/.exec(url.pathname);
  if (undoActivateMatch && request.method === "POST") {
    const batchId = decodeURIComponent(undoActivateMatch[1]!);
    try {
      const result = await ledger.activateImportUndoStage(actorId, batchId);
      if (!result.duplicate) publishGroups(ledger.groupIdsForImportBatch(actorId, batchId));
      return json(request, result);
    } catch (cause) {
      return error(request, 400, "IMPORT_UNDO_REJECTED", cause instanceof Error ? cause.message : "Tallied could not undo this import. Try again.");
    }
  }

  const undoCancelMatch = /^\/api\/v1\/imports\/([^/]+)\/undo-cancel$/.exec(url.pathname);
  if (undoCancelMatch && request.method === "POST") {
    if (!ledger.cancelImportUndoStage(actorId, decodeURIComponent(undoCancelMatch[1]!))) {
      return error(request, 409, "IMPORT_CANCEL_TOO_LATE", "This undo is unavailable or is already being finished.");
    }
    return json(request, { status: "cancelled" });
  }

  const undoMatch = /^\/api\/v1\/imports\/([^/]+)\/undo$/.exec(url.pathname);
  if (undoMatch && request.method === "POST") {
    if (!consumeMutation(actorId, 10)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many import attempts. Wait a moment, then try again.");
    }
    const body = await bodyJson<ImportUndoRequest>(request, 12_000_000);
    try {
      const result = await ledger.undoImport(actorId, decodeURIComponent(undoMatch[1]!), body);
      if (!result.duplicate) publishGroups(body.operations.map(({ groupId }) => groupId));
      return json(request, result);
    } catch (cause) {
      return error(request, 400, "IMPORT_UNDO_REJECTED", cause instanceof Error ? cause.message : "Unable to undo this import. Try again.");
    }
  }

  const identitiesMatch = /^\/api\/v1\/imports\/([^/]+)\/identities$/.exec(url.pathname);
  if (identitiesMatch && request.method === "GET") {
    return json(request, { identities: ledger.listImportIdentities(actorId, decodeURIComponent(identitiesMatch[1]!)) });
  }

  const claimLinkMatch = /^\/api\/v1\/imports\/([^/]+)\/identities\/([^/]+)\/claim-link$/.exec(url.pathname);
  if (claimLinkMatch && request.method === "POST") {
    if (!consumeMutation(actorId)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many import actions. Wait a moment, then try again.");
    }
    try {
      const claim = ledger.createImportClaimLink(
        actorId,
        decodeURIComponent(claimLinkMatch[1]!),
        decodeURIComponent(claimLinkMatch[2]!),
      );
      const shareUrl = new URL(config.webOrigin);
      shareUrl.hash = new URLSearchParams({ migrationClaim: claim.token }).toString();
      return json(request, { identityId: claim.identityId, url: shareUrl.toString(), expiresAt: claim.expiresAt }, 201);
    } catch (cause) {
      return error(request, 403, "CLAIM_LINK_REJECTED", cause instanceof Error ? cause.message : "Unable to create a connection link. Try again.");
    }
  }

  if (url.pathname === "/api/v1/import-claims/claim" && request.method === "POST") {
    if (!consumeMutation(actorId)) {
      return error(request, 429, "IMPORT_RATE_LIMITED", "Too many import actions. Wait a moment, then try again.");
    }
    const body = await bodyJson<{ token?: string }>(request, 2_000);
    const token = body.token?.trim() ?? "";
    if (!validInviteToken(token)) {
      return error(request, 400, "INVALID_CLAIM", "This connection link has expired or is no longer available.");
    }
    try {
      return json(request, ledger.claimImportedIdentity(actorId, token));
    } catch (cause) {
      return error(request, 400, "CLAIM_REJECTED", cause instanceof Error ? cause.message : "This connection is unavailable. Ask for a new link.");
    }
  }

  if (url.pathname === "/api/v1/import-claims/status" && request.method === "POST") {
    const body = await bodyJson<{ requestId?: string }>(request, 2_000);
    const requestId = body.requestId?.trim() ?? "";
    if (!validInviteToken(requestId)) {
      return error(request, 400, "INVALID_CLAIM_REQUEST", "This connection request is unavailable.");
    }
    try {
      return json(request, ledger.importClaimStatus(actorId, requestId));
    } catch (cause) {
      return error(request, 404, "CLAIM_REQUEST_UNAVAILABLE", cause instanceof Error ? cause.message : "This connection request is unavailable.");
    }
  }

  const approveMatch = /^\/api\/v1\/import-identities\/([^/]+)\/approve$/.exec(url.pathname);
  if (approveMatch && request.method === "POST") {
    try {
      return json(request, ledger.approveImportIdentityClaim(actorId, decodeURIComponent(approveMatch[1]!)));
    } catch (cause) {
      return error(request, 403, "CLAIM_APPROVAL_REJECTED", cause instanceof Error ? cause.message : "Unable to connect this account. Try again.");
    }
  }

  const rejectMatch = /^\/api\/v1\/import-identities\/([^/]+)\/reject$/.exec(url.pathname);
  if (rejectMatch && request.method === "POST") {
    try {
      return json(request, ledger.rejectImportIdentityClaim(actorId, decodeURIComponent(rejectMatch[1]!)));
    } catch (cause) {
      return error(request, 403, "CLAIM_REJECTION_REJECTED", cause instanceof Error ? cause.message : "Unable to decline this request. Try again.");
    }
  }

  const sourceDeleteMatch = /^\/api\/v1\/imports\/([^/]+)\/source-data\/delete$/.exec(url.pathname);
  if (sourceDeleteMatch && request.method === "POST") {
    try {
      return json(request, ledger.deleteImportSourceData(actorId, decodeURIComponent(sourceDeleteMatch[1]!)));
    } catch (cause) {
      return error(request, 403, "SOURCE_DELETE_REJECTED", cause instanceof Error ? cause.message : "This source data is no longer available.");
    }
  }

  return null;
}
