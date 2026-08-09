import { randomUUID } from "node:crypto";
import {
  type JsonValue,
  type OperationEnvelope,
} from "@expenses/protocol";

import { IdentityClaimService } from "./ledger-identity-claims";
import {
  importEffects,
  jsonObject,
  type OperationRow,
  optionalString,
  parseExpensePayload,
  parseImportMetadata,
  requiredCurrency,
  requiredMinor,
  requiredString,
  versionedTypes,
} from "./ledger-core";

export class LedgerProjectionService extends IdentityClaimService {
  protected ingestVerified(operation: OperationEnvelope):
    | { kind: "accepted"; serverSequence: number }
    | { kind: "conflict"; conflictId: string; currentVersion: number } {
    const current = this.db
      .query<{ version: number }, [string, string]>(
        "SELECT version FROM entity_versions WHERE group_id = ? AND target_id = ?",
      )
      .get(operation.groupId, operation.targetId)?.version ?? 0;
    const receivedAt = new Date().toISOString();

    if (versionedTypes.has(operation.type) && operation.baseVersion !== current) {
      this.insertOperation(operation, receivedAt, "conflicted");
      const conflictId = randomUUID();
      this.db
        .query(
          `INSERT INTO conflicts(
            id, operation_id, group_id, target_id, submitted_base_version, current_version, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          conflictId,
          operation.id,
          operation.groupId,
          operation.targetId,
          operation.baseVersion,
          current,
          receivedAt,
        );
      return { kind: "conflict", conflictId, currentVersion: current };
    }

    const serverSequence = this.insertOperation(operation, receivedAt, "accepted");
    this.applyProjection(operation, current + 1, receivedAt);
    if (versionedTypes.has(operation.type)) {
      this.db
        .query(
          `INSERT INTO entity_versions(group_id, target_id, version, operation_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(group_id, target_id) DO UPDATE SET
             version = excluded.version,
             operation_id = excluded.operation_id`,
        )
        .run(operation.groupId, operation.targetId, current + 1, operation.id);
    }
    return { kind: "accepted", serverSequence };
  }

  protected insertOperation(
    operation: OperationEnvelope,
    receivedAt: string,
    status: "accepted" | "conflicted",
  ): number {
    const result = this.db
      .query(
        `INSERT INTO operations(
          id, group_id, actor_id, device_id, type, target_id, base_version,
          client_timestamp, payload_json, content_hash, signature, received_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.id,
        operation.groupId,
        operation.actorId,
        operation.deviceId,
        operation.type,
        operation.targetId,
        operation.baseVersion,
        operation.clientTimestamp,
        JSON.stringify(operation.payload),
        operation.contentHash,
        operation.signature,
        receivedAt,
        status,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Membership is checked against the group the operation *declares*, so without
   * this every active member of any group could mutate an expense in any other
   * group by targeting its id. Confines the write to the row's real owner group.
   */
  protected assertTargetGroup(
    table: "expenses" | "payments",
    targetId: string,
    groupId: string,
  ): { status: string; readOnly: boolean; importBatchId: string | null } | null {
    const existing = this.db
      .query<{ group_id: string; status: string; read_only: number; import_batch_id: string | null }, [string]>(
        `SELECT group_id, status, read_only, import_batch_id FROM ${table} WHERE id = ?`,
      )
      .get(targetId);
    if (!existing) return null;
    if (existing.group_id !== groupId) throw new Error("This item belongs to another group. Reload Tallied and try again.");
    return { status: existing.status, readOnly: existing.read_only === 1, importBatchId: existing.import_batch_id };
  }

  protected assertImportedUndo(
    operation: OperationEnvelope,
    existing: { readOnly: boolean; importBatchId: string | null },
  ): void {
    if (!existing.readOnly) return;
    const requestedBatchId = requiredString(jsonObject(operation.payload), "undoImportBatchId", 100);
    if (!existing.importBatchId || requestedBatchId !== existing.importBatchId) {
      throw new Error("Imported entries cannot be changed individually. Undo the import instead.");
    }
    const owned = this.db.query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM import_batches WHERE id = ? AND imported_by = ? AND status = 'completed'",
    ).get(requestedBatchId, operation.actorId);
    if (!owned) throw new Error("Only the person who imported this history can undo it.");
  }

  protected applyProjection(operation: OperationEnvelope, version: number, receivedAt: string): void {
    if (operation.type === "GroupCreated") {
      if (operation.groupId !== operation.targetId) throw new TypeError("A new group must target its own group id");
      const payload = jsonObject(operation.payload);
      const name = requiredString(payload, "name", 100);
      const settlementCurrency = requiredString(payload, "settlementCurrency", 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(settlementCurrency)) throw new TypeError("settlementCurrency must be a three-letter ISO code");
      const profile = this.db.query<{ displayName: string; email: string | null }, [string]>(
        `SELECT display_name AS displayName, email
         FROM group_members WHERE user_id = ? ORDER BY joined_at LIMIT 1`,
      ).get(operation.actorId);
      this.db.query(
        "INSERT INTO groups(id, name, settlement_currency, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(operation.groupId, name, settlementCurrency, operation.actorId, receivedAt);
      this.db.query(
        `INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      ).run(operation.groupId, operation.actorId, profile?.displayName ?? operation.actorId, profile?.email ?? null, receivedAt);
      return;
    }

    if (operation.type === "GroupCurrencyChanged") {
      if (operation.groupId !== operation.targetId) throw new TypeError("A currency change must target its group id");
      const payload = jsonObject(operation.payload);
      const settlementCurrency = requiredString(payload, "settlementCurrency", 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(settlementCurrency)) throw new TypeError("settlementCurrency must be a three-letter ISO code");
      const ledgerEntries = this.db
        .query<{ count: number }, [string, string, string]>(
          `SELECT
             (SELECT COUNT(*) FROM expenses WHERE group_id = ?) +
             (SELECT COUNT(*) FROM payments WHERE group_id = ?) +
             (SELECT COUNT(*) FROM imported_transactions WHERE group_id = ?) AS count`,
        )
        .get(operation.groupId, operation.groupId, operation.groupId)?.count ?? 0;
      if (ledgerEntries > 0) throw new Error("The group currency cannot change after the first expense or payment.");
      const result = this.db
        .query("UPDATE groups SET settlement_currency = ? WHERE id = ? AND deleted_at IS NULL")
        .run(settlementCurrency, operation.groupId);
      if (result.changes !== 1) throw new Error("This group no longer exists.");
      return;
    }

    if (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended") {
      const payload = parseExpensePayload(operation.payload);
      const importMetadata = parseImportMetadata(jsonObject(operation.payload));
      // A placeholder is a real group ledger participant whose account has not
      // been linked yet. Active members may keep recording expenses with that
      // person; the explicit claim flow later moves those rows to the verified
      // account without rewriting the signed operation history.
      this.assertFinancialParticipants(operation.groupId, "payers", payload.payers, true);
      this.assertFinancialParticipants(operation.groupId, "allocations", payload.allocations, true);

      const settlementCurrency = this.db
        .query<{ settlement_currency: string }, [string]>("SELECT settlement_currency FROM groups WHERE id = ?")
        .get(operation.groupId)?.settlement_currency;
      if (!settlementCurrency) throw new Error("This group no longer exists.");
      if (payload.currency !== settlementCurrency) {
        throw new Error(`Expense currency must match the group settlement currency (${settlementCurrency})`);
      }

      const existing = this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      if (operation.type === "ExpenseCreated") {
        if (existing) throw new Error("This expense already exists. Reload Tallied to see it.");
      } else {
        if (!existing) throw new Error("This expense no longer exists.");
        if (existing.status !== "active") throw new Error("Restore this expense before editing it.");
        if (existing.readOnly) throw new Error("Imported expenses cannot be edited. Undo the import, then import them again.");
        if (importMetadata) throw new Error("Tallied could not verify this imported expense. Reload and try again.");
      }

      this.db
        .query(
          `INSERT INTO expenses(
            id, group_id, description, category, amount_minor, currency, expense_date,
            notes, status, version, created_by, created_at, updated_at,
            import_batch_id, source_provider, source_record_id, source_metadata_json,
            imported_by, imported_at, read_only
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            description = excluded.description,
            category = excluded.category,
            amount_minor = excluded.amount_minor,
            currency = excluded.currency,
            expense_date = excluded.expense_date,
            notes = excluded.notes,
            version = excluded.version,
            updated_at = excluded.updated_at`,
        )
        .run(
          operation.targetId,
          operation.groupId,
          payload.description,
          payload.category,
          payload.amountMinor,
          payload.currency,
          payload.expenseDate,
          payload.notes,
          importMetadata?.sourceDeleted ? "voided" : "active",
          version,
          operation.actorId,
          receivedAt,
          receivedAt,
          importMetadata?.importBatchId ?? null,
          importMetadata?.sourceProvider ?? null,
          importMetadata?.sourceRecordId ?? null,
          null,
          importMetadata ? operation.actorId : null,
          importMetadata?.importedAt ?? null,
          importMetadata ? 1 : 0,
        );
      this.db.query("DELETE FROM expense_payers WHERE expense_id = ?").run(operation.targetId);
      this.db.query("DELETE FROM expense_allocations WHERE expense_id = ?").run(operation.targetId);
      const payerInsert = this.db.query(
        "INSERT INTO expense_payers(expense_id, participant_id, amount_minor) VALUES (?, ?, ?)",
      );
      for (const payer of payload.payers) payerInsert.run(operation.targetId, payer.participantId, payer.amountMinor);
      const allocationInsert = this.db.query(
        "INSERT INTO expense_allocations(expense_id, participant_id, amount_minor) VALUES (?, ?, ?)",
      );
      for (const allocation of payload.allocations) {
        allocationInsert.run(operation.targetId, allocation.participantId, allocation.amountMinor);
      }
      return;
    }

    if (operation.type === "ExpenseVoided") {
      const existing = this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      if (!existing) throw new Error("This expense no longer exists.");
      this.assertImportedUndo(operation, existing);
      const result = this.db
        .query("UPDATE expenses SET status = 'voided', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("This expense no longer exists.");
      return;
    }

    if (operation.type === "ExpenseRestored") {
      const existing = this.assertTargetGroup("expenses", operation.targetId, operation.groupId);
      if (!existing) throw new Error("This expense no longer exists.");
      if (existing.readOnly) throw new Error("Undo the import to restore an imported expense.");
      if (existing.status !== "voided") throw new Error("This expense is already active.");
      const result = this.db
        .query("UPDATE expenses SET status = 'active', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("This expense no longer exists.");
      return;
    }

    if (operation.type === "CommentAdded") {
      if (!this.assertTargetGroup("expenses", operation.targetId, operation.groupId)) {
        throw new Error("This expense no longer exists.");
      }
      const payload = jsonObject(operation.payload);
      this.db
        .query("INSERT INTO comments(id, group_id, target_id, actor_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          operation.id,
          operation.groupId,
          operation.targetId,
          operation.actorId,
          requiredString(payload, "body", 2_000),
          receivedAt,
        );
      return;
    }

    if (operation.type === "PaymentRecorded") {
      const payload = jsonObject(operation.payload);
      const importMetadata = parseImportMetadata(payload);
      const payerId = requiredString(payload, "payerId", 100);
      const recipientId = requiredString(payload, "recipientId", 100);
      if (payerId === recipientId) throw new TypeError("Choose two different people for the payment.");
      this.assertFinancialParticipants(
        operation.groupId,
        "payment",
        [
          { participantId: payerId, amountMinor: 0 },
          { participantId: recipientId, amountMinor: 0 },
        ],
        Boolean(importMetadata),
      );
      const settlementCurrency = this.db
        .query<{ settlement_currency: string }, [string]>("SELECT settlement_currency FROM groups WHERE id = ?")
        .get(operation.groupId)?.settlement_currency;
      if (!settlementCurrency) throw new Error("This group no longer exists.");
      const currency = requiredCurrency(payload, "currency");
      if (currency !== settlementCurrency) {
        throw new Error(`Payment currency must match the group settlement currency (${settlementCurrency})`);
      }
      if (this.assertTargetGroup("payments", operation.targetId, operation.groupId)) {
        throw new Error("This payment already exists. Reload Tallied to see it.");
      }
      this.db
        .query(
          `INSERT INTO payments(
            id, group_id, payer_id, recipient_id, amount_minor, currency,
            payment_date, note, status, version, created_at, updated_at,
            import_batch_id, source_provider, source_record_id, source_metadata_json,
            imported_by, imported_at, read_only
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.targetId,
          operation.groupId,
          payerId,
          recipientId,
          requiredMinor(payload, "amountMinor"),
          currency,
          requiredString(payload, "paymentDate", 32),
          optionalString(payload, "note"),
          importMetadata?.sourceDeleted ? "reversed" : "active",
          version,
          receivedAt,
          receivedAt,
          importMetadata?.importBatchId ?? null,
          importMetadata?.sourceProvider ?? null,
          importMetadata?.sourceRecordId ?? null,
          null,
          importMetadata ? operation.actorId : null,
          importMetadata?.importedAt ?? null,
          importMetadata ? 1 : 0,
        );
      return;
    }

    if (operation.type === "PaymentReversed") {
      const existing = this.assertTargetGroup("payments", operation.targetId, operation.groupId);
      if (!existing) throw new Error("This payment no longer exists.");
      if (existing.status !== "active") throw new Error("This payment is already reversed.");
      this.assertImportedUndo(operation, existing);
      const result = this.db
        .query("UPDATE payments SET status = 'reversed', version = ?, updated_at = ? WHERE id = ? AND group_id = ?")
        .run(version, receivedAt, operation.targetId, operation.groupId);
      if (result.changes !== 1) throw new Error("This payment no longer exists.");
      return;
    }

    if (operation.type === "ImportedTransactionRecorded" || operation.type === "OpeningBalanceCreated") {
      const payload = jsonObject(operation.payload);
      const importMetadata = parseImportMetadata(payload);
      if (!importMetadata) throw new TypeError("Imported transactions require source provenance");
      const effects = importEffects(payload);
      this.assertFinancialParticipants(
        operation.groupId,
        "effects",
        effects.map((effect) => ({ participantId: effect.participantId, amountMinor: Math.abs(effect.amountMinor) })),
        true,
      );
      const settlementCurrency = this.db
        .query<{ settlement_currency: string }, [string]>("SELECT settlement_currency FROM groups WHERE id = ?")
        .get(operation.groupId)?.settlement_currency;
      if (!settlementCurrency) throw new Error("This group no longer exists.");
      const currency = requiredCurrency(payload, "currency");
      if (currency !== settlementCurrency) {
        throw new Error(`Imported currency must match the group settlement currency (${settlementCurrency})`);
      }
      const amountMinor = requiredMinor(payload, "amountMinor");
      const positiveTotal = effects.reduce((sum, effect) => sum + Math.max(0, effect.amountMinor), 0);
      if (positiveTotal !== amountMinor) throw new TypeError("Imported amount must equal its positive balance effects");
      const kind = operation.type === "OpeningBalanceCreated" ? "opening_balance" : "balance_effect";
      this.db.query(
        `INSERT INTO imported_transactions(
           id, batch_id, group_id, kind, description, category, amount_minor, currency,
           transaction_date, notes, source_provider, source_record_id, source_metadata_json,
           imported_by, imported_at, status, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        operation.targetId,
        importMetadata.importBatchId,
        operation.groupId,
        kind,
        requiredString(payload, "description", 200),
        requiredString(payload, "category", 100),
        amountMinor,
        currency,
        requiredString(payload, "transactionDate", 32),
        optionalString(payload, "notes"),
        importMetadata.sourceProvider,
        importMetadata.sourceRecordId,
        null,
        operation.actorId,
        importMetadata.importedAt,
        importMetadata.sourceDeleted ? "voided" : "active",
        version,
      );
      const insertEffect = this.db.query(
        "INSERT INTO imported_transaction_effects(transaction_id, participant_id, amount_minor) VALUES (?, ?, ?)",
      );
      for (const effect of effects) insertEffect.run(operation.targetId, effect.participantId, effect.amountMinor);
      return;
    }

    if (operation.type === "ImportedTransactionVoided" || operation.type === "OpeningBalanceVoided") {
      const existing = this.db.query<{ group_id: string; batch_id: string; status: string }, [string]>(
        "SELECT group_id, batch_id, status FROM imported_transactions WHERE id = ? LIMIT 1",
      ).get(operation.targetId);
      if (!existing || existing.group_id !== operation.groupId) throw new Error("This imported transaction no longer exists.");
      if (existing.status !== "active") throw new Error("This imported transaction is already removed.");
      const requestedBatchId = requiredString(jsonObject(operation.payload), "undoImportBatchId", 100);
      if (requestedBatchId !== existing.batch_id) {
        throw new Error("Imported entries cannot be changed individually. Undo the import instead.");
      }
      const owned = this.db.query<{ one: number }, [string, string]>(
        "SELECT 1 AS one FROM import_batches WHERE id = ? AND imported_by = ? AND status = 'completed'",
      ).get(existing.batch_id, operation.actorId);
      if (!owned) throw new Error("Only the person who imported this history can undo it.");
      this.db.query("UPDATE imported_transactions SET status = 'voided', version = ? WHERE id = ?")
        .run(version, operation.targetId);
      return;
    }
  }

  pull(actorId: string, after: number, limit = 500): OperationEnvelope[] {
    const rows = this.db
      .query<OperationRow, [string, number, number]>(
        `SELECT o.* FROM operations o
         JOIN group_members gm ON gm.group_id = o.group_id
         WHERE gm.user_id = ? AND gm.status = 'active'
           AND o.status = 'accepted' AND o.server_sequence > ?
         ORDER BY o.server_sequence ASC LIMIT ?`,
      )
      .all(actorId, after, Math.min(limit, 500));
    return rows.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      actorId: row.actor_id,
      deviceId: row.device_id,
      type: row.type as OperationEnvelope["type"],
      targetId: row.target_id,
      baseVersion: row.base_version,
      clientTimestamp: row.client_timestamp,
      payload: JSON.parse(row.payload_json) as JsonValue,
      contentHash: row.content_hash,
      signature: row.signature,
      serverSequence: row.server_sequence,
      receivedAt: row.received_at,
    }));
  }

  manifest(actorId: string): { generation: string; latestServerSequence: number; groups: Array<{ groupId: string; count: number; maxSequence: number }> } {
    const groups = this.db
      .query<{ groupId: string; count: number; maxSequence: number }, [string]>(
        `SELECT o.group_id AS groupId, COUNT(*) AS count, MAX(o.server_sequence) AS maxSequence
         FROM operations o
         JOIN group_members gm ON gm.group_id = o.group_id
         WHERE gm.user_id = ? AND gm.status = 'active' AND o.status = 'accepted'
         GROUP BY o.group_id ORDER BY o.group_id`,
      )
      .all(actorId);
    return { generation: this.generation, latestServerSequence: this.latestSequenceFor(actorId), groups };
  }

  snapshot(actorId: string): { groups: unknown[]; expenses: unknown[]; members: unknown[]; participantAliases: unknown[] } {
    const groups = this.db
      .query(
        `SELECT g.id, g.name, g.settlement_currency AS settlementCurrency, g.created_at AS createdAt,
                COALESCE(ev.version, 0) AS version
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
         LEFT JOIN entity_versions ev ON ev.group_id = g.id AND ev.target_id = g.id
         WHERE gm.user_id = ? AND gm.status = 'active' AND g.deleted_at IS NULL
         ORDER BY g.created_at`,
      )
      .all(actorId);
    const expenses = this.db
      .query(
        `SELECT e.id, e.group_id AS groupId, e.description, e.category,
                e.amount_minor AS amountMinor, e.currency, e.expense_date AS expenseDate,
                e.notes, e.status, e.version, e.created_by AS createdBy
         FROM expenses e JOIN group_members gm ON gm.group_id = e.group_id
         WHERE gm.user_id = ? AND gm.status = 'active'
         ORDER BY e.expense_date DESC, e.created_at DESC`,
      )
      .all(actorId);
    const memberRows = this.db
      .query<{
        groupId: string;
        userId: string;
        displayName: string;
        email: string | null;
        status: string;
        importIdentityId: string | null;
        importBatchId: string | null;
        importClaimStatus: "unclaimed" | "reserved" | "awaiting_owner" | null;
      }, [string, string]>(
        `SELECT gm.group_id AS groupId, gm.user_id AS userId, gm.display_name AS displayName,
                gm.email, gm.status, ii.id AS importIdentityId, ib.id AS importBatchId,
                CASE WHEN ii.status IN ('unclaimed', 'reserved', 'awaiting_owner') THEN ii.status END AS importClaimStatus
         FROM group_members gm
         LEFT JOIN imported_identities ii ON ii.placeholder_user_id = gm.user_id
         LEFT JOIN import_batches ib ON ib.id = ii.batch_id AND ib.imported_by = ? AND ib.status = 'completed'
         WHERE gm.group_id IN (
           SELECT group_id FROM group_members WHERE user_id = ? AND status = 'active'
         ) ORDER BY gm.joined_at`,
      )
      .all(actorId, actorId);
    const members = memberRows.map(({ importIdentityId, importBatchId, importClaimStatus, ...member }) => ({
      ...member,
      ...(importIdentityId && importBatchId && importClaimStatus
        ? { importClaim: { identityId: importIdentityId, batchId: importBatchId, status: importClaimStatus } }
        : {}),
    }));
    const importedParticipantAliases = this.db.query<{ groupId: string; fromUserId: string; toUserId: string }, [string]>(
      `SELECT aliases.group_id AS groupId,
              aliases.placeholder_user_id AS fromUserId,
              aliases.claimed_user_id AS toUserId
       FROM import_participant_aliases aliases
       JOIN imported_identities identity
         ON identity.id = aliases.identity_id AND identity.status = 'claimed'
       JOIN group_members viewer ON viewer.group_id = aliases.group_id
       JOIN group_members claimed_member
         ON claimed_member.group_id = viewer.group_id
        AND claimed_member.user_id = aliases.claimed_user_id
        AND claimed_member.status = 'active'
       WHERE viewer.user_id = ? AND viewer.status = 'active'
       ORDER BY aliases.group_id, aliases.placeholder_user_id`,
    ).all(actorId);
    const invitationParticipantAliases = this.db.query<{ groupId: string; fromUserId: string; toUserId: string }, [string]>(
      `SELECT aliases.group_id AS groupId,
              aliases.placeholder_user_id AS fromUserId,
              aliases.claimed_user_id AS toUserId
       FROM invitation_participant_aliases aliases
       JOIN group_invitations invitation
         ON invitation.id = aliases.invitation_id AND invitation.status = 'accepted'
       JOIN group_members viewer ON viewer.group_id = aliases.group_id
       JOIN group_members claimed_member
         ON claimed_member.group_id = viewer.group_id
        AND claimed_member.user_id = aliases.claimed_user_id
        AND claimed_member.status = 'active'
       WHERE viewer.user_id = ? AND viewer.status = 'active'
       ORDER BY aliases.group_id, aliases.placeholder_user_id`,
    ).all(actorId);
    const participantAliases = [...importedParticipantAliases, ...invitationParticipantAliases]
      .sort((left, right) => left.groupId.localeCompare(right.groupId) || left.fromUserId.localeCompare(right.fromUserId));
    return { groups, expenses, members, participantAliases };
  }
}
