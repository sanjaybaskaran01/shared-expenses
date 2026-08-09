import { randomUUID } from "node:crypto";
import {
  type ImportActivationResult,
  type ImportBatchCommitRequest,
  type ImportIdentitySummary,
  type ImportIdentityResolutionRequest,
  type ImportIdentityResolutionResult,
  type ImportUndoRequest,
  type ImportUndoResult,
  type OperationEnvelope,
} from "@expenses/protocol";

import { ImportStagingService } from "./ledger-import-staging";
import {
  importEffects,
  jsonObject,
  parseExpensePayload,
  parseImportMetadata,
  requiredCurrency,
  requiredMinor,
  requiredString,
} from "./ledger-core";

export abstract class ImportActivationService extends ImportStagingService {
  resolveImportIdentityTargets(
    actorId: string,
    request: ImportIdentityResolutionRequest,
  ): ImportIdentityResolutionResult {
    if (request.provider !== "splitwise" || request.identities.length === 0 || request.identities.length > 500) {
      throw new TypeError("Import identities are invalid");
    }
    const resolved: Record<string, string> = {};
    for (const identity of request.identities) {
      if (
        !identity.id || identity.id.length > 100 || !identity.externalId || identity.externalId.length > 300 ||
        !identity.displayName.trim() || identity.displayName.length > 100 || resolved[identity.externalId]
      ) {
        throw new TypeError("Imported identity details are invalid");
      }
      if (identity.isImporter) {
        resolved[identity.externalId] = actorId;
        continue;
      }
      const providerMapping = this.db.query<{ local_id: string }, [string, string, string]>(
        `SELECT m.local_id FROM import_external_mappings m
         JOIN import_batches b ON b.id = m.batch_id
         WHERE m.imported_by = ? AND m.provider = ? AND m.external_type = 'person'
           AND m.external_id_hash = ? AND m.local_id NOT LIKE 'import:%'
           AND b.status IN ('completed', 'undone')
         ORDER BY b.completed_at DESC LIMIT 1`,
      ).get(actorId, request.provider, this.importExternalIdHash(request.provider, "person", identity.externalId));
      if (providerMapping) {
        resolved[identity.externalId] = providerMapping.local_id;
        continue;
      }
      // Export contents are client-controlled and therefore never authorize
      // another Tallied account or disclose whether an email is registered.
      // A placeholder becomes active only through the explicit claim flow.
      resolved[identity.externalId] = `import:${identity.id}`;
    }
    return { resolved };
  }

  protected resolvedImportIdentities(actorId: string, request: ImportBatchCommitRequest): Map<string, string> {
    const importer = request.identities.filter((identity) => identity.isImporter);
    if (importer.length === 0) throw new TypeError("Choose at least one imported identity as yourself");
    const resolution = this.resolveImportIdentityTargets(actorId, {
      provider: request.provider,
      identities: request.identities.map(({ id, externalId, displayName, email, emailTrust, isImporter }) => ({
        id,
        externalId,
        displayName,
        ...(email ? { email } : {}),
        emailTrust,
        ...(isImporter ? { isImporter } : {}),
      })),
    });
    const resolved = new Map<string, string>();
    for (const identity of request.identities) {
      if (!identity.id || identity.id.length > 100 || !identity.externalId || identity.externalId.length > 300) {
        throw new TypeError("Imported identity ids are invalid");
      }
      if (!identity.displayName.trim() || identity.displayName.length > 100 || identity.groupIds.length > 100) {
        throw new TypeError("Imported identity details are invalid");
      }
      if (resolved.has(identity.externalId)) throw new TypeError("Imported identities must be unique");
      const localUserId = resolution.resolved[identity.externalId];
      if (!localUserId || identity.localUserId !== localUserId) {
        throw new TypeError("A person in this import changed. Review the import again.");
      }
      resolved.set(identity.externalId, localUserId);
    }
    return resolved;
  }

  protected validateImportReconciliation(
    request: ImportBatchCommitRequest,
    resolvedPeople: ReadonlyMap<string, string>,
    operationById: ReadonlyMap<string, OperationEnvelope>,
  ): void {
    if (!request.reconciliation.zeroSum || request.reconciliation.blockingWarnings.length > 0) {
      throw new TypeError("Resolve each import issue before continuing.");
    }
    const groupMapping = new Map<string, string>();
    for (const link of request.operationLinks) {
      if (link.externalType !== "group") continue;
      const operation = operationById.get(link.operationId);
      if (!operation || operation.type !== "GroupCreated") throw new TypeError("Group mappings must reference group creation operations");
      groupMapping.set(link.externalId, operation.groupId);
    }
    const detailed = new Map<string, number>();
    const aggregate = new Map<string, number>();
    const groupTotals = new Map<string, number>();
    const participantFinancials = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsSentMinor: number;
      paymentsReceivedMinor: number;
      netMinor: number;
    }>();
    const groupFinancials = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsMinor: number;
      netMinor: number;
    }>();
    const participantTotal = (participantId: string, currency: string) => {
      const key = `${participantId}\0${currency}`;
      const current = participantFinancials.get(key) ?? {
        paidMinor: 0,
        owedMinor: 0,
        paymentsSentMinor: 0,
        paymentsReceivedMinor: 0,
        netMinor: 0,
      };
      participantFinancials.set(key, current);
      return current;
    };
    const groupTotal = (groupId: string, currency: string) => {
      const key = `${groupId}\0${currency}`;
      const current = groupFinancials.get(key) ?? {
        paidMinor: 0,
        owedMinor: 0,
        paymentsMinor: 0,
        netMinor: 0,
      };
      groupFinancials.set(key, current);
      return current;
    };
    const add = (groupId: string, participantId: string, currency: string, amountMinor: number): void => {
      const detailKey = `${groupId}\0${participantId}\0${currency}`;
      detailed.set(detailKey, (detailed.get(detailKey) ?? 0) + amountMinor);
      const aggregateKey = `${participantId}\0${currency}`;
      aggregate.set(aggregateKey, (aggregate.get(aggregateKey) ?? 0) + amountMinor);
      const groupKey = `${groupId}\0${currency}`;
      groupTotals.set(groupKey, (groupTotals.get(groupKey) ?? 0) + amountMinor);
      participantTotal(participantId, currency).netMinor += amountMinor;
      groupTotal(groupId, currency).netMinor += amountMinor;
    };
    for (const operation of request.operations) {
      if (operation.type === "GroupCreated") continue;
      const payload = jsonObject(operation.payload);
      const metadata = parseImportMetadata(payload);
      if (!metadata || metadata.importBatchId !== request.id) throw new TypeError("Every imported record needs matching provenance");
      if (metadata.sourceDeleted) continue;
      if (operation.type === "ExpenseCreated") {
        const expense = parseExpensePayload(operation.payload);
        for (const payer of expense.payers) {
          participantTotal(payer.participantId, expense.currency).paidMinor += payer.amountMinor;
          groupTotal(operation.groupId, expense.currency).paidMinor += payer.amountMinor;
          add(operation.groupId, payer.participantId, expense.currency, payer.amountMinor);
        }
        for (const allocation of expense.allocations) {
          participantTotal(allocation.participantId, expense.currency).owedMinor += allocation.amountMinor;
          groupTotal(operation.groupId, expense.currency).owedMinor += allocation.amountMinor;
          add(operation.groupId, allocation.participantId, expense.currency, -allocation.amountMinor);
        }
      } else if (operation.type === "PaymentRecorded") {
        const currency = requiredCurrency(payload, "currency");
        const amountMinor = requiredMinor(payload, "amountMinor");
        const payerId = requiredString(payload, "payerId", 100);
        const recipientId = requiredString(payload, "recipientId", 100);
        participantTotal(payerId, currency).paymentsSentMinor += amountMinor;
        participantTotal(recipientId, currency).paymentsReceivedMinor += amountMinor;
        groupTotal(operation.groupId, currency).paymentsMinor += amountMinor;
        add(operation.groupId, payerId, currency, amountMinor);
        add(operation.groupId, recipientId, currency, -amountMinor);
      } else if (operation.type === "ImportedTransactionRecorded" || operation.type === "OpeningBalanceCreated") {
        const currency = requiredCurrency(payload, "currency");
        for (const effect of importEffects(payload)) add(operation.groupId, effect.participantId, currency, effect.amountMinor);
      } else {
        throw new TypeError("An import contains an unsupported operation");
      }
    }
    if ([...groupTotals.values()].some((amount) => amount !== 0)) throw new TypeError("Imported balances do not add to zero");
    const expectedParticipants = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsSentMinor: number;
      paymentsReceivedMinor: number;
      netMinor: number;
    }>();
    for (const total of request.reconciliation.participantTotals) {
      const localPersonId = resolvedPeople.get(total.externalPersonId);
      if (!localPersonId) throw new TypeError("A reconciliation total references an unknown person");
      const key = `${localPersonId}\0${total.currency}`;
      const current = expectedParticipants.get(key) ?? {
        paidMinor: 0,
        owedMinor: 0,
        paymentsSentMinor: 0,
        paymentsReceivedMinor: 0,
        netMinor: 0,
      };
      current.paidMinor += total.paidMinor;
      current.owedMinor += total.owedMinor;
      current.paymentsSentMinor += total.paymentsSentMinor;
      current.paymentsReceivedMinor += total.paymentsReceivedMinor;
      current.netMinor += total.netMinor;
      expectedParticipants.set(key, current);
    }
    const expectedGroups = new Map<string, {
      paidMinor: number;
      owedMinor: number;
      paymentsMinor: number;
      netMinor: number;
    }>();
    for (const total of request.reconciliation.groupTotals) {
      const localGroupId = groupMapping.get(total.externalGroupId);
      if (!localGroupId) throw new TypeError("A reconciliation total references an unknown group");
      const key = `${localGroupId}\0${total.currency}`;
      if (expectedGroups.has(key)) throw new TypeError("Reconciliation group totals must be unique");
      expectedGroups.set(key, total);
    }
    if (expectedParticipants.size !== participantFinancials.size || expectedGroups.size !== groupFinancials.size) {
      throw new TypeError("Reconciliation totals are incomplete");
    }
    for (const [key, computed] of participantFinancials) {
      const expected = expectedParticipants.get(key);
      if (!expected ||
        expected.paidMinor !== computed.paidMinor || expected.owedMinor !== computed.owedMinor ||
        expected.paymentsSentMinor !== computed.paymentsSentMinor ||
        expected.paymentsReceivedMinor !== computed.paymentsReceivedMinor || expected.netMinor !== computed.netMinor
      ) throw new TypeError("A participant reconciliation total does not match the imported records");
    }
    for (const [key, computed] of groupFinancials) {
      const expected = expectedGroups.get(key);
      if (!expected || expected.paidMinor !== computed.paidMinor || expected.owedMinor !== computed.owedMinor ||
        expected.paymentsMinor !== computed.paymentsMinor || expected.netMinor !== computed.netMinor
      ) throw new TypeError("A group reconciliation total does not match the imported records");
    }
    const expectedSourceBalances = new Map<string, number>();
    for (const source of request.sourceBalances) {
      const localPersonId = resolvedPeople.get(source.externalPersonId);
      if (!localPersonId) throw new TypeError("A source balance references an unknown person");
      const localGroupId = source.externalGroupId ? groupMapping.get(source.externalGroupId) : undefined;
      if (source.externalGroupId && !localGroupId) throw new TypeError("A source balance references an unknown group");
      const key = localGroupId
        ? `${localGroupId}\0${localPersonId}\0${source.currency}`
        : `${localPersonId}\0${source.currency}`;
      expectedSourceBalances.set(key, (expectedSourceBalances.get(key) ?? 0) + source.amountMinor);
    }
    for (const [key, expectedMinor] of expectedSourceBalances) {
      const localGroupId = key.split("\0").length === 3;
      const computed = localGroupId ? detailed.get(key) ?? 0 : aggregate.get(key) ?? 0;
      if (computed !== expectedMinor) throw new TypeError("A computed balance does not match the source");
    }
  }

  async activateImport(
    actorId: string,
    request: ImportBatchCommitRequest,
    options: { signaturesPreverified?: boolean } = {},
  ): Promise<ImportActivationResult> {
    if (!/^[0-9a-f-]{36}$/.test(request.id) || !/^[a-f0-9]{64}$/.test(request.fingerprint)) {
      throw new TypeError("Tallied could not verify this import. Start again.");
    }
    if (request.provider !== "splitwise" || !["current", "history", "balances", "custom"].includes(request.mode)) {
      throw new TypeError("Import provider or mode is invalid");
    }
    if (request.sourceHashes.length > 20 || request.sourceHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new TypeError("Source fingerprints are invalid");
    }
    if (request.operations.length === 0 || request.operations.length > 100_500 || request.identities.length > 500) {
      throw new TypeError("Import size is outside the supported limit");
    }
    const previous = this.db.query<{ id: string; status: string }, [string, string, string]>(
      "SELECT id, status FROM import_batches WHERE imported_by = ? AND provider = ? AND fingerprint = ? LIMIT 1",
    ).get(actorId, request.provider, request.fingerprint);
    if (previous && ["completed", "undone", "cancelled"].includes(previous.status)) {
      return { batch: this.importBatchSummary(previous.id, actorId), duplicate: true, accepted: [] };
    }
    if (previous) throw new TypeError("This import is already being processed");

    const operationIds = new Set<string>();
    const operationById = new Map<string, OperationEnvelope>();
    const plannedGroupIds = new Set(request.operations.filter((operation) => operation.type === "GroupCreated").map((operation) => operation.groupId));
    if (plannedGroupIds.size === 0) throw new TypeError("An import must create at least one group");
    for (const operation of request.operations) {
      if (operationIds.has(operation.id)) throw new TypeError("Import operations must be unique");
      operationIds.add(operation.id);
      operationById.set(operation.id, operation);
      if (!["GroupCreated", "ExpenseCreated", "PaymentRecorded", "ImportedTransactionRecorded", "OpeningBalanceCreated"].includes(operation.type)) {
        throw new TypeError("An import contains an unsupported operation");
      }
      if (this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM operations WHERE id = ?").get(operation.id)) {
        throw new TypeError("An imported entry already exists outside this import.");
      }
    }
    // Chunk staging already proved immutable hash/signature integrity. Device
    // trust remains mutable and must be checked again at the commit point.
    this.assertImportActivationAuthorization(actorId, request.operations, plannedGroupIds);
    if (!options.signaturesPreverified) {
      await this.verifyImportOperationBatch(actorId, request.operations, plannedGroupIds);
    }
    const linkedOperationIds = new Set<string>();
    for (const link of request.operationLinks) {
      const operation = operationById.get(link.operationId);
      if (!operation || linkedOperationIds.has(link.operationId) || !link.externalId || link.externalId.length > 500) {
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
      if (link.externalType === "record") {
        const metadata = parseImportMetadata(jsonObject(operation.payload));
        if (!metadata || metadata.importBatchId !== request.id || metadata.sourceRecordId !== operation.targetId) {
          throw new TypeError("Imported provenance does not match its Tallied record");
        }
      }
      linkedOperationIds.add(link.operationId);
    }
    if (linkedOperationIds.size !== request.operations.length) throw new TypeError("Every import operation needs one source mapping");

    const resolvedPeople = this.resolvedImportIdentities(actorId, request);
    this.validateImportReconciliation(request, resolvedPeople, operationById);
    const now = new Date().toISOString();
    const accepted: Array<{ id: string; serverSequence: number }> = [];

    try {
      this.db.transaction(() => {
      for (const link of request.operationLinks) {
        if (link.externalType !== "record") continue;
        const dedupeHash = link.dedupeStrategy === "provider_id"
          ? this.importExternalIdHash(request.provider, link.externalType, link.externalId)
          : this.importSemanticIdHash(request.provider, link.semanticId!);
        const dedupeColumn = link.dedupeStrategy === "provider_id" ? "external_id_hash" : "semantic_id_hash";
        const duplicate = this.db.query<{ batch_id: string }, [string, string, string, string, string]>(
          `SELECT m.batch_id FROM import_external_mappings m
           JOIN import_batches b ON b.id = m.batch_id
           WHERE m.imported_by = ? AND m.provider = ? AND m.external_type = ?
             AND m.${dedupeColumn} = ? AND m.batch_id <> ? AND b.status = 'completed'
           LIMIT 1`,
        ).get(
          actorId,
          request.provider,
          link.externalType,
          dedupeHash,
          request.id,
        );
        if (duplicate) throw new TypeError("One or more Splitwise entries were already added by another import.");
      }
      this.db.query(
        `INSERT INTO import_batches(
           id, imported_by, provider, mode, source_account_key, fingerprint,
           selected_source_groups_json, warnings_json, reconciliation_json,
           status, rollback_status, started_at, reviewed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activating', 'available', ?, ?)`,
      ).run(
        request.id,
        actorId,
        request.provider,
        request.mode,
        request.sourceAccountId ? this.secretHash("import-source-account", request.sourceAccountId) : null,
        request.fingerprint,
        JSON.stringify(request.selectedSourceGroups),
        JSON.stringify(request.warnings),
        JSON.stringify(request.reconciliation),
        now,
        now,
      );
      const sourceInsert = this.db.query("INSERT INTO import_sources(batch_id, source_hash) VALUES (?, ?)");
      for (const sourceHash of new Set(request.sourceHashes)) sourceInsert.run(request.id, sourceHash);

      const groupOperations = request.operations.filter((operation) => operation.type === "GroupCreated");
      for (const operation of groupOperations) {
        const outcome = this.ingestVerified(operation);
        if (outcome.kind !== "accepted") throw new TypeError("An imported group conflicted with existing data");
        accepted.push({ id: operation.id, serverSequence: outcome.serverSequence });
      }

      for (const identity of request.identities) {
        const localUserId = resolvedPeople.get(identity.externalId)!;
        const normalizedEmail = identity.email?.trim().toLowerCase();
        const claimed = localUserId === actorId || !localUserId.startsWith("import:");
        if (localUserId !== actorId) {
          this.db.query(
            `INSERT INTO imported_identities(
               id, batch_id, provider, external_user_id, display_name, email_hash, email_trust,
               placeholder_user_id, claimed_by_user_id, status, created_at, claimed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            identity.id,
            request.id,
            request.provider,
            identity.externalId,
            identity.displayName.trim(),
            normalizedEmail ? this.emailHash(normalizedEmail) : null,
            identity.emailTrust,
            `import:${identity.id}`,
            claimed ? localUserId : null,
            claimed ? "claimed" : "unclaimed",
            now,
            claimed ? now : null,
          );
        }
        for (const groupId of new Set(identity.groupIds)) {
          if (!plannedGroupIds.has(groupId)) throw new TypeError("An imported person references an unknown group");
          if (localUserId === actorId) continue;
          this.db.query(
            `INSERT OR IGNORE INTO group_members(group_id, user_id, display_name, status, joined_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(groupId, localUserId, identity.displayName.trim(), claimed ? "active" : "placeholder", now);
        }
        this.db.query(
          `INSERT INTO import_external_mappings(
             batch_id, imported_by, provider, external_type, external_id,
             external_id_hash, semantic_id_hash, source_metadata_json, local_id
           ) VALUES (?, ?, ?, 'person', ?, ?, NULL, NULL, ?)`,
        ).run(
          request.id,
          actorId,
          request.provider,
          identity.externalId,
          this.importExternalIdHash(request.provider, "person", identity.externalId),
          localUserId,
        );
      }

      for (const operation of request.operations.filter((item) => item.type !== "GroupCreated")) {
        const metadata = parseImportMetadata(jsonObject(operation.payload));
        if (!metadata || metadata.importBatchId !== request.id) throw new TypeError("Tallied could not verify the source of an imported entry. Start again.");
        const outcome = this.ingestVerified(operation);
        if (outcome.kind !== "accepted") throw new TypeError("An imported record conflicted with existing data");
        accepted.push({ id: operation.id, serverSequence: outcome.serverSequence });
      }

      for (const link of request.operationLinks) {
        const operation = operationById.get(link.operationId)!;
        this.db.query(
          `INSERT INTO import_external_mappings(
             batch_id, imported_by, provider, external_type, external_id,
             external_id_hash, semantic_id_hash, source_metadata_json, local_id, operation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          request.id,
          actorId,
          request.provider,
          link.externalType,
          link.externalId,
          this.importExternalIdHash(request.provider, link.externalType, link.externalId),
          link.dedupeStrategy === "csv_candidate" && link.semanticId
            ? this.importSemanticIdHash(request.provider, link.semanticId)
            : null,
          link.sourceMetadata === undefined ? null : JSON.stringify(link.sourceMetadata),
          operation.targetId,
          operation.id,
        );
      }
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'activated', ?, ?)`,
      ).run(randomUUID(), request.id, actorId, now, JSON.stringify({ operationCount: accepted.length }));
      this.db.query(
        `UPDATE import_batches SET status = 'completed', completed_at = ?
         WHERE id = ? AND imported_by = ? AND status = 'activating'`,
      ).run(now, request.id, actorId);
      })();
    } catch (error) {
      // Verification yields between operations. A concurrent retry can therefore
      // finish the same fingerprint before this transaction begins. Treat that
      // unique-key race exactly like any other lost-response retry.
      accepted.length = 0;
      const completed = this.db.query<{ id: string; status: string }, [string, string, string]>(
        "SELECT id, status FROM import_batches WHERE imported_by = ? AND provider = ? AND fingerprint = ? LIMIT 1",
      ).get(actorId, request.provider, request.fingerprint);
      if (completed && ["completed", "undone", "cancelled"].includes(completed.status)) {
        return { batch: this.importBatchSummary(completed.id, actorId), duplicate: true, accepted: [] };
      }
      throw error;
    }

    return { batch: this.importBatchSummary(request.id, actorId), duplicate: false, accepted };
  }

  async undoImport(actorId: string, batchId: string, request: ImportUndoRequest): Promise<ImportUndoResult> {
    const batch = this.db.query<{ status: string }, [string, string]>(
      "SELECT status FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!batch) throw new Error("This import is no longer available. Start again.");
    if (batch.status === "undone") {
      return { batch: this.importBatchSummary(batchId, actorId), duplicate: true, accepted: [] };
    }
    if (batch.status !== "completed") throw new Error("Only a completed import can be undone");

    const active = this.db.query<{
      target_id: string;
      group_id: string;
      version: number;
      undo_type: OperationEnvelope["type"];
    }, [string, string, string]>(
      `SELECT id AS target_id, group_id, version, 'ExpenseVoided' AS undo_type
       FROM expenses WHERE import_batch_id = ? AND status = 'active'
       UNION ALL
       SELECT id AS target_id, group_id, version, 'PaymentReversed' AS undo_type
       FROM payments WHERE import_batch_id = ? AND status = 'active'
       UNION ALL
       SELECT id AS target_id, group_id, version,
              CASE kind WHEN 'opening_balance' THEN 'OpeningBalanceVoided' ELSE 'ImportedTransactionVoided' END AS undo_type
       FROM imported_transactions WHERE batch_id = ? AND status = 'active'`,
    ).all(batchId, batchId, batchId);
    if (request.operations.length !== active.length) {
      throw new TypeError("Undo must include every active imported record exactly once");
    }
    const expected = new Map(active.map((row) => [row.target_id, row]));
    const operationIds = new Set<string>();
    for (const operation of request.operations) {
      const row = expected.get(operation.targetId);
      if (
        !row ||
        row.group_id !== operation.groupId ||
        row.version !== operation.baseVersion ||
        row.undo_type !== operation.type ||
        operationIds.has(operation.id)
      ) {
        throw new TypeError("Undo operations do not exactly match the active imported records");
      }
      operationIds.add(operation.id);
      const payloadBatchId = requiredString(jsonObject(operation.payload), "undoImportBatchId", 100);
      if (payloadBatchId !== batchId) throw new TypeError("Tallied could not verify which import to undo. Try again.");
      if (this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM operations WHERE id = ?").get(operation.id)) {
        throw new TypeError("An undo operation id is already in use");
      }
      expected.delete(operation.targetId);
    }
    if (expected.size > 0) throw new TypeError("Undo must include every active imported record exactly once");
    await this.verifyImportOperationBatch(actorId, request.operations, new Set(), "Undo");

    const accepted: Array<{ id: string; serverSequence: number }> = [];
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const operation of request.operations) {
        const outcome = this.ingestVerified(operation);
        if (outcome.kind !== "accepted") throw new TypeError("An imported record changed before undo could finish");
        accepted.push({ id: operation.id, serverSequence: outcome.serverSequence });
      }
      this.db.query(
        `UPDATE groups SET deleted_at = ?
         WHERE id IN (
           SELECT local_id FROM import_external_mappings
           WHERE batch_id = ? AND external_type = 'group'
         )
           AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.group_id = groups.id AND e.status = 'active')
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.group_id = groups.id AND p.status = 'active')
           AND NOT EXISTS (
             SELECT 1 FROM imported_transactions t WHERE t.group_id = groups.id AND t.status = 'active'
           )`,
      ).run(now, batchId);
      this.db.query(
        `UPDATE import_batches SET status = 'undone', rollback_status = 'completed', undone_at = ?
         WHERE id = ? AND imported_by = ? AND status = 'completed'`,
      ).run(now, batchId, actorId);
      this.db.query(
        `UPDATE import_claim_requests SET status = 'rejected', resolved_at = ?
         WHERE identity_id IN (SELECT id FROM imported_identities WHERE batch_id = ?)
           AND status = 'pending'`,
      ).run(now, batchId);
      this.db.query(
        `UPDATE imported_identities SET status = 'revoked', claim_token_hash = NULL,
           claim_expires_at = NULL, reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL,
           reserved_by_user_id = NULL, revoked_at = ?
         WHERE batch_id = ? AND status IN ('unclaimed', 'reserved', 'awaiting_owner')`,
      ).run(now, batchId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'undone', ?, ?)`,
      ).run(randomUUID(), batchId, actorId, now, JSON.stringify({ operationCount: accepted.length }));
    })();
    return { batch: this.importBatchSummary(batchId, actorId), duplicate: false, accepted };
  }

  listImportIdentities(actorId: string, batchId: string): ImportIdentitySummary[] {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE import_claim_requests SET status = 'expired', resolved_at = ?
         WHERE status = 'pending' AND expires_at <= ?`,
      ).run(now, now);
      this.db.query(
        `UPDATE imported_identities SET status = 'unclaimed', reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE status = 'awaiting_owner' AND reservation_expires_at <= ?`,
      ).run(now);
    })();
    const rows = this.db.query<{
      id: string;
      display_name: string;
      status: ImportIdentitySummary["status"];
      email_trust: ImportIdentitySummary["emailTrust"];
      claim_expires_at: string | null;
      claimant_name: string | null;
      claimant_email: string | null;
      requested_at: string | null;
      reservation_expires_at: string | null;
    }, [string, string]>(
      `SELECT i.id, i.display_name, i.status, i.email_trust, i.claim_expires_at,
              u.name AS claimant_name, u.email AS claimant_email,
              r.requested_at, r.expires_at AS reservation_expires_at
       FROM imported_identities i JOIN import_batches b ON b.id = i.batch_id
       LEFT JOIN import_claim_requests r ON r.identity_id = i.id AND r.status = 'pending'
       LEFT JOIN "user" u ON u.id = r.claimant_user_id
       WHERE i.batch_id = ? AND b.imported_by = ? ORDER BY i.display_name COLLATE NOCASE`,
    ).all(batchId, actorId);
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      emailTrust: row.email_trust,
      ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
      ...(row.claimant_name && row.claimant_email && row.requested_at && row.reservation_expires_at
        ? {
            claimant: {
              displayName: row.claimant_name,
              email: row.claimant_email,
              requestedAt: row.requested_at,
              expiresAt: row.reservation_expires_at,
            },
          }
        : {}),
    }));
  }
}
