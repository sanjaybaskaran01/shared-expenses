import {
  canonicalJson,
  importPreparationMaterial,
  sha256Hex,
  type ImportActivationResult,
  type ImportBatchCommitRequest,
  type ImportBatchSummary,
  type ImportStageChunkRequest,
  type ImportStageStartRequest,
  type ImportStageStatus,
  type ImportUndoRequest,
  type ImportUndoResult,
  type ImportUndoStageChunkRequest,
  type ImportUndoStageStartRequest,
  type ImportUndoStageStatus,
  type JsonValue,
  type OperationEnvelope,
} from "@expenses/protocol";

import {
  LedgerCore,
  stagedUploadLimitBytes,
} from "./ledger-core";

export abstract class ImportStagingService extends LedgerCore {
  listImports(actorId: string): ImportBatchSummary[] {
    const ids = this.db.query<{ id: string }, [string]>(
      `SELECT id FROM import_batches
       WHERE imported_by = ? AND status IN ('completed', 'undone', 'cancelled')
       ORDER BY started_at DESC`,
    ).all(actorId);
    return ids.map(({ id }) => this.importBatchSummary(id, actorId));
  }

  /**
   * A process restart proves that no activation from the prior process is
   * still running. Return claimed uploads to their retry-safe ready state.
   */
  recoverInterruptedImportActivations(): { imports: number; undos: number } {
    const imports = this.db.query(
      "UPDATE import_uploads SET status = 'ready' WHERE status = 'activating'",
    ).run().changes;
    const undos = this.db.query(
      "UPDATE import_undo_uploads SET status = 'ready' WHERE status = 'activating'",
    ).run().changes;
    return { imports, undos };
  }

  groupIdsForImportBatch(actorId: string, batchId: string): string[] {
    return this.db.query<{ local_id: string }, [string, string]>(
      `SELECT DISTINCT m.local_id FROM import_external_mappings m
       JOIN import_batches b ON b.id = m.batch_id
       WHERE m.batch_id = ? AND b.imported_by = ? AND m.external_type = 'group'`,
    ).all(batchId, actorId).map(({ local_id }) => local_id);
  }

  pruneExpiredImportUploads(now = new Date()): { imports: number; undos: number } {
    const timestamp = now.toISOString();
    const staleActivation = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const imports = this.db.query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count FROM import_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready', 'expired', 'cancelled'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).get(timestamp, staleActivation)?.count ?? 0;
    this.db.query(
      `DELETE FROM import_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready', 'expired', 'cancelled'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).run(timestamp, staleActivation);
    const undos = this.db.query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count FROM import_undo_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).get(timestamp, staleActivation)?.count ?? 0;
    this.db.query(
      `DELETE FROM import_undo_uploads
       WHERE (expires_at <= ? AND status IN ('staging', 'ready'))
          OR (status = 'activating' AND expires_at <= ?)`,
    ).run(timestamp, staleActivation);
    return { imports, undos };
  }

  protected activeImportRecordCount(batchId: string): number {
    return this.db.query<{ count: number }, [string, string, string]>(
      `SELECT (
         (SELECT COUNT(*) FROM expenses WHERE import_batch_id = ? AND status = 'active') +
         (SELECT COUNT(*) FROM payments WHERE import_batch_id = ? AND status = 'active') +
         (SELECT COUNT(*) FROM imported_transactions WHERE batch_id = ? AND status = 'active')
       ) AS count`,
    ).get(batchId, batchId, batchId)?.count ?? 0;
  }

  startImportStage(actorId: string, request: ImportStageStartRequest): ImportStageStatus {
    const { batch } = request;
    if (
      !/^[0-9a-f-]{36}$/.test(batch.id) ||
      !/^[a-f0-9]{64}$/.test(batch.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(request.preparationHash)
    ) {
      throw new TypeError("Tallied could not verify this import. Start again.");
    }
    if (batch.provider !== "splitwise" || !["current", "history", "balances", "custom"].includes(batch.mode)) {
      throw new TypeError("Import provider or mode is invalid");
    }
    if (
      !Number.isSafeInteger(request.expectedOperationCount) ||
      request.expectedOperationCount <= 0 ||
      request.expectedOperationCount > 100_500 ||
      batch.sourceHashes.length > 20 ||
      batch.sourceHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
      batch.identities.length > 500
    ) {
      throw new TypeError("Import size is outside the supported limit");
    }
    if (!batch.reconciliation.zeroSum || batch.reconciliation.blockingWarnings.length > 0) {
      throw new TypeError("Resolve each import issue before uploading.");
    }
    const completed = this.db.query<{ id: string }, [string, string, string]>(
      `SELECT id FROM import_batches WHERE imported_by = ? AND provider = ? AND fingerprint = ?
       AND status IN ('completed', 'undone', 'cancelled') LIMIT 1`,
    ).get(actorId, batch.provider, batch.fingerprint);
    if (completed) {
      return {
        batchId: completed.id,
        expectedOperationCount: request.expectedOperationCount,
        receivedOperationCount: request.expectedOperationCount,
        status: "activated",
        expiresAt: new Date().toISOString(),
        missingRanges: [],
        completedBatch: this.importBatchSummary(completed.id, actorId),
      };
    }
    const now = new Date();
    this.pruneExpiredImportUploads(now);
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const existing = this.db.query<{
      batch_id: string;
      expected_operation_count: number;
      status: "staging" | "ready" | "activating";
      expires_at: string;
      received: number;
      preparation_hash: string;
    }, [string, string]>(
      `SELECT u.batch_id, u.expected_operation_count, u.status, u.expires_at, u.preparation_hash,
              (SELECT COUNT(*) FROM import_staged_operations s WHERE s.batch_id = u.batch_id) AS received
       FROM import_uploads u WHERE u.actor_id = ? AND u.fingerprint = ? LIMIT 1`,
    ).get(actorId, batch.fingerprint);
    if (existing) {
      if (existing.batch_id !== batch.id || existing.expected_operation_count !== request.expectedOperationCount) {
        throw new TypeError("A different upload already uses this import fingerprint");
      }
      if (existing.preparation_hash !== request.preparationHash) {
        throw new TypeError("The prepared import changed. Cancel the earlier upload and start again.");
      }
      if (existing.status === "activating") throw new Error("This import is already being finished.");
      return {
        batchId: existing.batch_id,
        expectedOperationCount: existing.expected_operation_count,
        receivedOperationCount: existing.received,
        status: existing.status,
        expiresAt: existing.expires_at,
        missingRanges: this.missingStageRanges(existing.batch_id, existing.expected_operation_count),
      };
    }
    const activeUploadCount = this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM import_uploads
       WHERE actor_id = ? AND status IN ('staging', 'ready', 'activating')`,
    ).get(actorId)?.count ?? 0;
    if (activeUploadCount >= 2) {
      throw new Error("Finish or cancel the current import before starting another.");
    }
    const serializedEnvelope = JSON.stringify(batch);
    if (new TextEncoder().encode(serializedEnvelope).byteLength > 2_000_000) {
      throw new TypeError("Import review data is too large");
    }
    const encryptedEnvelope = this.encryptImportEnvelope(serializedEnvelope);
    const envelopeBytes = new TextEncoder().encode(encryptedEnvelope).byteLength;
    this.db.transaction(() => {
      this.assertGlobalStagingCapacity(envelopeBytes);
      this.db.query(
        `INSERT INTO import_uploads(
           batch_id, actor_id, fingerprint, envelope_json, expected_operation_count,
           status, created_at, expires_at, payload_bytes, preparation_hash
         ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?)`,
      ).run(
        batch.id,
        actorId,
        batch.fingerprint,
        encryptedEnvelope,
        request.expectedOperationCount,
        now.toISOString(),
        expiresAt,
        envelopeBytes,
        request.preparationHash,
      );
    })();
    return {
      batchId: batch.id,
      expectedOperationCount: request.expectedOperationCount,
      receivedOperationCount: 0,
      status: "staging",
      expiresAt,
      missingRanges: [{ start: 0, endExclusive: request.expectedOperationCount }],
    };
  }

  async stageImportOperations(
    actorId: string,
    batchId: string,
    request: ImportStageChunkRequest,
  ): Promise<ImportStageStatus> {
    if (
      !Number.isSafeInteger(request.start) ||
      request.start < 0 ||
      request.operations.length === 0 ||
      request.operations.length > 250 ||
      request.operationLinks.length !== request.operations.length
    ) {
      throw new TypeError("An import chunk must contain 1 to 250 mapped operations");
    }
    const upload = this.db.query<{
      expected_operation_count: number;
      status: "staging" | "ready";
      expires_at: string;
      payload_bytes: number;
    }, [string, string]>(
      `SELECT expected_operation_count, status, expires_at, payload_bytes FROM import_uploads
       WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
    ).get(batchId, actorId);
    if (!upload || Date.parse(upload.expires_at) <= Date.now()) throw new Error("Import upload is unavailable or expired");
    if (request.start + request.operations.length > upload.expected_operation_count) {
      throw new TypeError("Import chunk exceeds the declared operation count");
    }
    const links = new Map(request.operationLinks.map((link) => [link.operationId, link]));
    if (links.size !== request.operations.length) throw new TypeError("Every staged operation needs one unique source mapping");
    const plannedGroupIds = new Set([
      ...this.db.query<{ group_id: string }, [string]>(
        "SELECT DISTINCT group_id FROM import_staged_operations WHERE batch_id = ? AND operation_type = 'GroupCreated'",
      ).all(batchId).map(({ group_id }) => group_id),
      ...request.operations.filter(({ type }) => type === "GroupCreated").map(({ groupId }) => groupId),
    ]);
    for (const operation of request.operations) {
      const link = links.get(operation.id);
      if (!link || !["group", "record"].includes(link.externalType) || !link.externalId) {
        throw new TypeError("Import operation mappings are invalid");
      }
      if ((link.externalType === "group") !== (operation.type === "GroupCreated")) {
        throw new TypeError("Import mapping type does not match its operation");
      }
      if (link.externalType === "record" && (
        !["provider_id", "csv_candidate"].includes(link.dedupeStrategy ?? "") ||
        !/^[a-f0-9]{64}$/.test(link.semanticId ?? "")
      )) {
        throw new TypeError("Import semantic mapping is invalid");
      }
      const sourceMetadataJson = link.sourceMetadata === undefined ? null : JSON.stringify(link.sourceMetadata);
      if (sourceMetadataJson && new TextEncoder().encode(sourceMetadataJson).byteLength > 10_000) {
        throw new TypeError("Import source metadata is too large");
      }
      if (!["GroupCreated", "ExpenseCreated", "PaymentRecorded", "ImportedTransactionRecorded", "OpeningBalanceCreated"].includes(operation.type)) {
        throw new TypeError("An import contains an unsupported operation");
      }
      const verificationError = await this.verifyOperation(actorId, operation, plannedGroupIds);
      if (verificationError) throw new TypeError(`Import operation verification failed: ${verificationError}`);
    }
    this.db.transaction(() => {
      const currentUpload = this.db.query<{ payload_bytes: number }, [string, string]>(
        `SELECT payload_bytes FROM import_uploads
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
      ).get(batchId, actorId);
      if (!currentUpload) throw new Error("Import upload is unavailable");
      let addedBytes = 0;
      for (let index = 0; index < request.operations.length; index += 1) {
        const ordinal = request.start + index;
        const operation = request.operations[index]!;
        const link = links.get(operation.id)!;
        const existing = this.db.query<{
          operation_id: string;
          content_hash: string;
          external_type: string;
          external_id: string;
          semantic_id: string | null;
          dedupe_strategy: string | null;
          source_metadata_json: string | null;
        }, [string, number]>(
          `SELECT operation_id, content_hash, external_type, external_id, semantic_id, dedupe_strategy, source_metadata_json
           FROM import_staged_operations WHERE batch_id = ? AND ordinal = ? LIMIT 1`,
        ).get(batchId, ordinal);
        const sourceMetadataJson = link.sourceMetadata === undefined ? null : JSON.stringify(link.sourceMetadata);
        const operationJson = JSON.stringify(operation);
        const encryptedOperation = this.encryptImportStagedOperation(operationJson);
        const encryptedExternalId = this.encryptImportStagedSource(link.externalId);
        const encryptedSemanticId = link.semanticId ? this.encryptImportStagedSemantic(link.semanticId) : null;
        const encryptedSourceMetadata = sourceMetadataJson ? this.encryptImportStagedSource(sourceMetadataJson) : null;
        const rowBytes = new TextEncoder().encode(encryptedOperation).byteLength
          + (encryptedSourceMetadata ? new TextEncoder().encode(encryptedSourceMetadata).byteLength : 0)
          + new TextEncoder().encode(encryptedExternalId).byteLength
          + (encryptedSemanticId ? new TextEncoder().encode(encryptedSemanticId).byteLength : 0);
        if (rowBytes > 512_000) throw new TypeError("An import operation is too large");
        if (existing) {
          if (
            existing.operation_id !== operation.id ||
            existing.content_hash !== operation.contentHash ||
            existing.external_type !== link.externalType ||
            this.decryptImportStagedSource(existing.external_id) !== link.externalId ||
            (existing.semantic_id ? this.decryptImportStagedSemantic(existing.semantic_id) : null) !== (link.semanticId ?? null) ||
            existing.dedupe_strategy !== (link.dedupeStrategy ?? null) ||
            (existing.source_metadata_json ? this.decryptImportStagedSource(existing.source_metadata_json) : null) !== sourceMetadataJson
          ) throw new TypeError("A retried import chunk does not match the staged data");
          continue;
        }
        addedBytes += rowBytes;
        this.db.query(
          `INSERT INTO import_staged_operations(
             batch_id, ordinal, operation_id, content_hash, operation_json, operation_type,
             group_id, external_type, external_id, semantic_id, dedupe_strategy, source_metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          batchId,
          ordinal,
          operation.id,
          operation.contentHash,
          encryptedOperation,
          operation.type,
          operation.groupId,
          link.externalType,
          encryptedExternalId,
          encryptedSemanticId,
          link.dedupeStrategy ?? null,
          encryptedSourceMetadata,
        );
      }
      const received = this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
      ).get(batchId)?.count ?? 0;
      this.assertGlobalStagingCapacity(addedBytes);
      const reserved = this.db.query(
        `UPDATE import_uploads SET status = ?, payload_bytes = payload_bytes + ?
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') AND payload_bytes <= ?`,
      ).run(
        received === upload.expected_operation_count ? "ready" : "staging",
        addedBytes,
        batchId,
        actorId,
        stagedUploadLimitBytes - addedBytes,
      );
      if (reserved.changes !== 1) throw new TypeError("Import upload exceeds the 192 MiB staged-data limit");
    })();
    const receivedOperationCount = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_operations WHERE batch_id = ?",
    ).get(batchId)?.count ?? 0;
    return {
      batchId,
      expectedOperationCount: upload.expected_operation_count,
      receivedOperationCount,
      status: receivedOperationCount === upload.expected_operation_count ? "ready" : "staging",
      expiresAt: upload.expires_at,
    };
  }

  async activateImportStage(actorId: string, batchId: string): Promise<ImportActivationResult> {
    const upload = this.db.query<{
      envelope_json: string;
      expected_operation_count: number;
      preparation_hash: string;
      status: string;
    }, [string, string]>(
      "SELECT envelope_json, expected_operation_count, preparation_hash, status FROM import_uploads WHERE batch_id = ? AND actor_id = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!upload) {
      const completed = this.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
      ).get(batchId, actorId);
      if (completed && ["completed", "undone", "cancelled"].includes(completed.status)) {
        return { batch: this.importBatchSummary(batchId, actorId), duplicate: true, accepted: [] };
      }
      throw new Error("Import upload is unavailable");
    }
    if (upload.status !== "ready") throw new Error("Import upload is incomplete");
    const rows = this.db.query<{
      ordinal: number;
      operation_id: string;
      content_hash: string;
      group_id: string;
      operation_json: string;
      external_type: "group" | "record";
      external_id: string;
      semantic_id: string | null;
      dedupe_strategy: "provider_id" | "csv_candidate" | null;
      source_metadata_json: string | null;
    }, [string]>(
      `SELECT ordinal, operation_id, content_hash, group_id, operation_json, external_type, external_id, semantic_id, dedupe_strategy, source_metadata_json FROM import_staged_operations
       WHERE batch_id = ? ORDER BY ordinal`,
    ).all(batchId);
    if (rows.length !== upload.expected_operation_count || rows.some((row, index) => row.ordinal !== index)) {
      throw new Error("Import upload is incomplete");
    }
    const base = JSON.parse(this.decryptImportEnvelope(upload.envelope_json)) as Omit<ImportBatchCommitRequest, "operations" | "operationLinks">;
    const operations = rows.map(({ operation_json }) => JSON.parse(this.decryptImportStagedOperation(operation_json)) as OperationEnvelope);
    if (operations.some((operation, index) =>
      operation.id !== rows[index]!.operation_id ||
      operation.contentHash !== rows[index]!.content_hash ||
      operation.groupId !== rows[index]!.group_id
    )) throw new Error("The prepared import no longer matches its signed data. Start again.");
    const operationLinks = rows.map((row, index) => ({
      operationId: operations[index]!.id,
      externalType: row.external_type,
      externalId: this.decryptImportStagedSource(row.external_id),
      ...(row.dedupe_strategy ? { dedupeStrategy: row.dedupe_strategy } : {}),
      ...(row.semantic_id ? { semanticId: this.decryptImportStagedSemantic(row.semantic_id) } : {}),
      ...(row.source_metadata_json
        ? { sourceMetadata: JSON.parse(this.decryptImportStagedSource(row.source_metadata_json)) as JsonValue }
        : {}),
    }));
    const reconstructedRequest: ImportBatchCommitRequest = { ...base, operations, operationLinks };
    const preparationHash = await sha256Hex(canonicalJson(importPreparationMaterial(reconstructedRequest)));
    if (preparationHash !== upload.preparation_hash) {
      throw new Error("The prepared import does not match the uploaded data. Start again.");
    }
    const claimed = this.db.query(
      `UPDATE import_uploads SET status = 'activating'
       WHERE batch_id = ? AND actor_id = ? AND status = 'ready'`,
    ).run(batchId, actorId);
    if (claimed.changes !== 1) throw new Error("Import activation is already in progress");
    let result: ImportActivationResult;
    try {
      result = await this.activateImport(actorId, reconstructedRequest, { signaturesPreverified: true });
    } catch (error) {
      this.db.query(
        "UPDATE import_uploads SET status = 'ready' WHERE batch_id = ? AND actor_id = ? AND status = 'activating'",
      ).run(batchId, actorId);
      throw error;
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM import_staged_operations WHERE batch_id = ?").run(batchId);
      this.db.query("DELETE FROM import_uploads WHERE batch_id = ? AND actor_id = ?").run(batchId, actorId);
    })();
    return result;
  }

  cancelImportStage(actorId: string, batchId: string): boolean {
    // Delete the owner-scoped parent only. Foreign-key cascade removes chunks
    // without letting one authenticated actor target another actor's batch id.
    return this.db.query(
      "DELETE FROM import_uploads WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready')",
    ).run(batchId, actorId).changes > 0;
  }

  startImportUndoStage(
    actorId: string,
    batchId: string,
    request: ImportUndoStageStartRequest,
  ): ImportUndoStageStatus {
    if (!Number.isSafeInteger(request.expectedOperationCount) || request.expectedOperationCount <= 0 || request.expectedOperationCount > 100_500) {
      throw new TypeError("Undo size is outside the supported limit");
    }
    const batch = this.db.query<{ status: string }, [string, string]>(
      "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!batch) throw new Error("This import is no longer available. Start again.");
    if (batch.status === "undone") {
      return {
        batchId,
        expectedOperationCount: request.expectedOperationCount,
        receivedOperationCount: request.expectedOperationCount,
        status: "undone",
        expiresAt: new Date().toISOString(),
        missingRanges: [],
        completedBatch: this.importBatchSummary(batchId, actorId),
      };
    }
    if (batch.status !== "completed") throw new Error("Only a completed import can be undone");
    const activeCount = this.activeImportRecordCount(batchId);
    if (activeCount !== request.expectedOperationCount) {
      throw new TypeError("Undo must include every active imported record exactly once");
    }
    const now = new Date();
    this.pruneExpiredImportUploads(now);
    const existing = this.db.query<{
      expected_operation_count: number;
      status: "staging" | "ready";
      expires_at: string;
      received: number;
    }, [string, string]>(
      `SELECT u.expected_operation_count, u.status, u.expires_at,
              (SELECT COUNT(*) FROM import_staged_undo_operations s WHERE s.batch_id = u.batch_id) AS received
       FROM import_undo_uploads u WHERE u.batch_id = ? AND u.actor_id = ? LIMIT 1`,
    ).get(batchId, actorId);
    if (existing) {
      if (existing.expected_operation_count !== request.expectedOperationCount) {
        throw new TypeError("A different undo upload already exists for this import");
      }
      return {
        batchId,
        expectedOperationCount: existing.expected_operation_count,
        receivedOperationCount: existing.received,
        status: existing.status,
        expiresAt: existing.expires_at,
        missingRanges: this.missingStageRanges(batchId, existing.expected_operation_count, true),
      };
    }
    const concurrent = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_undo_uploads WHERE actor_id = ?",
    ).get(actorId)?.count ?? 0;
    if (concurrent >= 2) throw new Error("Finish or cancel an existing undo upload before starting another");
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    this.db.query(
      `INSERT INTO import_undo_uploads(
         batch_id, actor_id, expected_operation_count, status, payload_bytes, created_at, expires_at
       ) VALUES (?, ?, ?, 'staging', 0, ?, ?)`,
    ).run(batchId, actorId, request.expectedOperationCount, now.toISOString(), expiresAt);
    return {
      batchId,
      expectedOperationCount: request.expectedOperationCount,
      receivedOperationCount: 0,
      status: "staging",
      expiresAt,
      missingRanges: [{ start: 0, endExclusive: request.expectedOperationCount }],
    };
  }

  stageImportUndoOperations(
    actorId: string,
    batchId: string,
    request: ImportUndoStageChunkRequest,
  ): ImportUndoStageStatus {
    if (!Number.isSafeInteger(request.start) || request.start < 0 || request.operations.length === 0 || request.operations.length > 250) {
      throw new TypeError("An undo chunk must contain 1 to 250 operations");
    }
    const upload = this.db.query<{
      expected_operation_count: number;
      expires_at: string;
      payload_bytes: number;
    }, [string, string]>(
      `SELECT expected_operation_count, expires_at, payload_bytes FROM import_undo_uploads
       WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
    ).get(batchId, actorId);
    if (!upload || Date.parse(upload.expires_at) <= Date.now()) throw new Error("Undo upload is unavailable or expired");
    if (request.start + request.operations.length > upload.expected_operation_count) {
      throw new TypeError("Undo chunk exceeds the declared operation count");
    }
    this.db.transaction(() => {
      const currentUpload = this.db.query<{ payload_bytes: number }, [string, string]>(
        `SELECT payload_bytes FROM import_undo_uploads
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') LIMIT 1`,
      ).get(batchId, actorId);
      if (!currentUpload) throw new Error("Undo upload is unavailable");
      let addedBytes = 0;
      for (let index = 0; index < request.operations.length; index += 1) {
        const ordinal = request.start + index;
        const operation = request.operations[index]!;
        const operationJson = JSON.stringify(operation);
        const encryptedOperation = this.encryptImportStagedUndo(operationJson);
        const rowBytes = new TextEncoder().encode(encryptedOperation).byteLength;
        if (rowBytes > 512_000) throw new TypeError("An undo operation is too large");
        const existing = this.db.query<{ operation_id: string; content_hash: string }, [string, number]>(
          `SELECT operation_id, content_hash FROM import_staged_undo_operations
           WHERE batch_id = ? AND ordinal = ? LIMIT 1`,
        ).get(batchId, ordinal);
        if (existing) {
          if (existing.operation_id !== operation.id || existing.content_hash !== operation.contentHash) {
            throw new TypeError("A retried undo chunk does not match the staged data");
          }
          continue;
        }
        addedBytes += rowBytes;
        this.db.query(
          `INSERT INTO import_staged_undo_operations(
             batch_id, ordinal, operation_id, content_hash, operation_json
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(batchId, ordinal, operation.id, operation.contentHash, encryptedOperation);
      }
      const received = this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM import_staged_undo_operations WHERE batch_id = ?",
      ).get(batchId)?.count ?? 0;
      this.assertGlobalStagingCapacity(addedBytes);
      const reserved = this.db.query(
        `UPDATE import_undo_uploads SET status = ?, payload_bytes = payload_bytes + ?
         WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready') AND payload_bytes <= ?`,
      ).run(
        received === upload.expected_operation_count ? "ready" : "staging",
        addedBytes,
        batchId,
        actorId,
        stagedUploadLimitBytes - addedBytes,
      );
      if (reserved.changes !== 1) throw new TypeError("Undo upload exceeds the 192 MiB staged-data limit");
    })();
    const receivedOperationCount = this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM import_staged_undo_operations WHERE batch_id = ?",
    ).get(batchId)?.count ?? 0;
    return {
      batchId,
      expectedOperationCount: upload.expected_operation_count,
      receivedOperationCount,
      status: receivedOperationCount === upload.expected_operation_count ? "ready" : "staging",
      expiresAt: upload.expires_at,
    };
  }

  async activateImportUndoStage(actorId: string, batchId: string): Promise<ImportUndoResult> {
    const upload = this.db.query<{ expected_operation_count: number; status: string }, [string, string]>(
      "SELECT expected_operation_count, status FROM import_undo_uploads WHERE batch_id = ? AND actor_id = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!upload) {
      const batch = this.db.query<{ status: string }, [string, string]>(
        "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
      ).get(batchId, actorId);
      if (batch?.status === "undone") {
        return { batch: this.importBatchSummary(batchId, actorId), duplicate: true, accepted: [] };
      }
      throw new Error("Undo upload is unavailable");
    }
    if (upload.status !== "ready") throw new Error("Undo upload is incomplete");
    const rows = this.db.query<{ ordinal: number; operation_json: string }, [string]>(
      `SELECT ordinal, operation_json FROM import_staged_undo_operations
       WHERE batch_id = ? ORDER BY ordinal`,
    ).all(batchId);
    if (rows.length !== upload.expected_operation_count || rows.some((row, index) => row.ordinal !== index)) {
      throw new Error("Undo upload is incomplete");
    }
    const operations = rows.map(({ operation_json }) => JSON.parse(this.decryptImportStagedUndo(operation_json)) as OperationEnvelope);
    const claimed = this.db.query(
      `UPDATE import_undo_uploads SET status = 'activating'
       WHERE batch_id = ? AND actor_id = ? AND status = 'ready'`,
    ).run(batchId, actorId);
    if (claimed.changes !== 1) throw new Error("Undo activation is already in progress");
    let result: ImportUndoResult;
    try {
      result = await this.undoImport(actorId, batchId, { operations });
    } catch (error) {
      this.db.query(
        "UPDATE import_undo_uploads SET status = 'ready' WHERE batch_id = ? AND actor_id = ? AND status = 'activating'",
      ).run(batchId, actorId);
      throw error;
    }
    this.db.query("DELETE FROM import_undo_uploads WHERE batch_id = ? AND actor_id = ?").run(batchId, actorId);
    return result;
  }

  cancelImportUndoStage(actorId: string, batchId: string): boolean {
    return this.db.query(
      "DELETE FROM import_undo_uploads WHERE batch_id = ? AND actor_id = ? AND status IN ('staging', 'ready')",
    ).run(batchId, actorId).changes > 0;
  }


  abstract activateImport(
    actorId: string,
    request: ImportBatchCommitRequest,
    options?: { signaturesPreverified?: boolean },
  ): Promise<ImportActivationResult>;

  abstract undoImport(
    actorId: string,
    batchId: string,
    request: ImportUndoRequest,
  ): Promise<ImportUndoResult>;
}
