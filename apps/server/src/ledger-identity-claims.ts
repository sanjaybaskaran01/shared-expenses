import { randomBytes, randomUUID } from "node:crypto";
import {
  type ImportBatchSummary,
  type ImportClaimLink,
  type ImportClaimPreview,
  type ImportClaimResult,
  type ImportClaimStatus,
} from "@expenses/protocol";

import { ImportActivationService } from "./ledger-import-activation";

export abstract class IdentityClaimService extends ImportActivationService {
  createImportClaimLink(actorId: string, batchId: string, identityId: string): ImportClaimLink {
    const identity = this.db.query<{ status: string; display_name: string }, [string, string, string]>(
      `SELECT i.status, i.display_name FROM imported_identities i
       JOIN import_batches b ON b.id = i.batch_id
       WHERE i.id = ? AND i.batch_id = ? AND b.imported_by = ? AND b.status = 'completed' LIMIT 1`,
    ).get(identityId, batchId, actorId);
    if (!identity) throw new Error("Only the person who imported this history can create a connection link.");
    if (identity.status === "claimed" || identity.status === "revoked") {
      throw new Error("This imported history can no longer be connected.");
    }
    if (identity.status === "awaiting_owner") {
      throw new Error("Review or decline the pending request before creating a new link.");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.secretHash("import-claim-token", token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE imported_identities SET
           status = 'unclaimed', claim_token_hash = ?, claim_expires_at = ?,
           reserved_email_hash = NULL, reservation_requested_at = NULL,
           reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE id = ? AND batch_id = ?`,
      ).run(tokenHash, expiresAt, identityId, batchId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_link_created', ?, ?)`,
      ).run(randomUUID(), batchId, actorId, now.toISOString(), JSON.stringify({ identityId }));
    })();
    return { identityId, token, expiresAt };
  }

  previewImportClaim(token: string): ImportClaimPreview {
    const row = this.db.query<{
      provider: "splitwise";
      claim_expires_at: string;
      status: string;
    }, [string]>(
      `SELECT i.provider, i.claim_expires_at, i.status
       FROM imported_identities i WHERE i.claim_token_hash = ? LIMIT 1`,
    ).get(this.secretHash("import-claim-token", token));
    if (
      !row ||
      !["unclaimed", "reserved"].includes(row.status) ||
      !row.claim_expires_at ||
      Date.parse(row.claim_expires_at) <= Date.now()
    ) {
      throw new Error("This connection link has expired or is no longer available.");
    }
    return { provider: row.provider, expiresAt: row.claim_expires_at };
  }

  reserveImportClaimEmail(token: string, email: string): { status: "reserved"; expiresAt: string } {
    const normalizedEmail = email.trim().toLowerCase();
    const emailHash = this.emailHash(normalizedEmail);
    const tokenHash = this.secretHash("import-claim-token", token);
    const identity = this.db.query<{
      id: string;
      batch_id: string;
      email_hash: string | null;
      email_trust: string;
      status: string;
      claim_expires_at: string | null;
      reserved_email_hash: string | null;
      reservation_expires_at: string | null;
    }, [string]>(
      `SELECT id, batch_id, email_hash, email_trust, status, claim_expires_at,
              reserved_email_hash, reservation_expires_at
       FROM imported_identities WHERE claim_token_hash = ? LIMIT 1`,
    ).get(tokenHash);
    const now = new Date();
    if (
      !identity || !["unclaimed", "reserved"].includes(identity.status) ||
      !identity.claim_expires_at || Date.parse(identity.claim_expires_at) <= now.getTime()
    ) {
      throw new Error("This connection link has expired or is no longer available.");
    }
    if (
      ["provider", "exported"].includes(identity.email_trust) &&
      identity.email_hash !== emailHash
    ) {
      throw new Error("Use the verified email associated with this imported history.");
    }
    if (
      identity.status === "reserved" && identity.reserved_email_hash &&
      identity.reserved_email_hash !== emailHash && identity.reservation_expires_at &&
      Date.parse(identity.reservation_expires_at) > now.getTime()
    ) {
      throw new Error("This connection link is already being verified.");
    }
    const expiresAt = new Date(Math.min(
      Date.parse(identity.claim_expires_at),
      now.getTime() + 15 * 60_000,
    )).toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE imported_identities SET status = 'reserved', reserved_email_hash = ?,
           reservation_requested_at = ?, reservation_expires_at = ?, reserved_by_user_id = NULL
         WHERE id = ? AND claim_token_hash = ? AND status IN ('unclaimed', 'reserved')`,
      ).run(emailHash, now.toISOString(), expiresAt, identity.id, tokenHash);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_auth_reserved', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, "pre-auth", now.toISOString(), JSON.stringify({ identityId: identity.id }));
    })();
    return { status: "reserved", expiresAt };
  }

  claimImportedIdentity(actorId: string, token: string): ImportClaimResult {
    const identity = this.db.query<{
      id: string;
      batch_id: string;
      display_name: string;
      email_hash: string | null;
      email_trust: string;
      claim_expires_at: string;
      status: string;
      reserved_email_hash: string | null;
      reservation_expires_at: string | null;
    }, [string]>(
      `SELECT id, batch_id, display_name, email_hash, email_trust, claim_expires_at, status,
              reserved_email_hash, reservation_expires_at
       FROM imported_identities WHERE claim_token_hash = ? LIMIT 1`,
    ).get(this.secretHash("import-claim-token", token));
    if (
      !identity ||
      !["unclaimed", "reserved"].includes(identity.status) ||
      Date.parse(identity.claim_expires_at) <= Date.now()
    ) {
      throw new Error("This connection link has expired or is no longer available.");
    }
    const user = this.db.query<{ email: string; email_verified: number }, [string]>(
      `SELECT email, emailVerified AS email_verified FROM "user" WHERE id = ? LIMIT 1`,
    ).get(actorId);
    if (!user || !user.email_verified) throw new Error("Verify your email before connecting imported history.");
    if (
      identity.status === "reserved" && (
        identity.reserved_email_hash !== this.emailHash(user.email) ||
        !identity.reservation_expires_at || Date.parse(identity.reservation_expires_at) <= Date.now()
      )
    ) {
      throw new Error("Sign in with the email used for this connection link.");
    }
    const trustedEmail = ["provider", "exported"].includes(identity.email_trust)
      && identity.email_hash === this.emailHash(user.email);
    if (trustedEmail) return this.completeImportClaim(identity.id, actorId);

    const now = new Date();
    const reservationExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
    const requestToken = randomBytes(32).toString("base64url");
    this.db.transaction(() => {
      this.db.query(
        `UPDATE imported_identities SET status = 'awaiting_owner', claim_token_hash = NULL,
           claim_expires_at = NULL, reserved_email_hash = ?, reservation_requested_at = ?,
           reservation_expires_at = ?, reserved_by_user_id = ?
         WHERE id = ?`,
      ).run(this.emailHash(user.email), now.toISOString(), reservationExpiresAt, actorId, identity.id);
      this.db.query(
        `UPDATE import_claim_requests SET status = 'expired', resolved_at = ?
         WHERE identity_id = ? AND status = 'pending'`,
      ).run(now.toISOString(), identity.id);
      this.db.query(
        `INSERT INTO import_claim_requests(
           token_hash, identity_id, claimant_user_id, status, requested_at, expires_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(this.secretHash("import-claim-request", requestToken), identity.id, actorId, now.toISOString(), reservationExpiresAt);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_awaiting_owner', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, actorId, now.toISOString(), JSON.stringify({ identityId: identity.id }));
    })();
    return {
      status: "awaiting_owner",
      displayName: identity.display_name,
      requestId: requestToken,
      expiresAt: reservationExpiresAt,
    };
  }

  importClaimStatus(actorId: string, requestId: string): ImportClaimStatus {
    const row = this.db.query<{
      status: "pending" | "approved" | "rejected" | "expired";
      display_name: string;
      expires_at: string;
    }, [string, string]>(
      `SELECT r.status, i.display_name, r.expires_at
       FROM import_claim_requests r JOIN imported_identities i ON i.id = r.identity_id
       WHERE r.token_hash = ? AND r.claimant_user_id = ? LIMIT 1`,
    ).get(this.secretHash("import-claim-request", requestId), actorId);
    if (!row) throw new Error("This connection request is unavailable.");
    let status = row.status;
    if (status === "pending" && Date.parse(row.expires_at) <= Date.now()) {
      status = "expired";
      this.db.query(
        "UPDATE import_claim_requests SET status = 'expired', resolved_at = ? WHERE token_hash = ? AND status = 'pending'",
      ).run(new Date().toISOString(), this.secretHash("import-claim-request", requestId));
    }
    return {
      status: status === "pending" ? "awaiting_owner" : status === "approved" ? "claimed" : status,
      displayName: row.display_name,
      expiresAt: row.expires_at,
    };
  }

  approveImportIdentityClaim(actorId: string, identityId: string): ImportClaimResult {
    const identity = this.db.query<{
      reserved_by_user_id: string | null;
      reservation_expires_at: string | null;
    }, [string, string]>(
      `SELECT i.reserved_by_user_id, i.reservation_expires_at
       FROM imported_identities i JOIN import_batches b ON b.id = i.batch_id
       WHERE i.id = ? AND b.imported_by = ? AND i.status = 'awaiting_owner' LIMIT 1`,
    ).get(identityId, actorId);
    if (!identity) throw new Error("Only the person who imported this history can approve the connection.");
    if (
      !identity.reserved_by_user_id ||
      !identity.reservation_expires_at ||
      Date.parse(identity.reservation_expires_at) <= Date.now()
    ) {
      throw new Error("This connection request expired. Share a new link.");
    }
    return this.completeImportClaim(identityId, identity.reserved_by_user_id);
  }

  rejectImportIdentityClaim(actorId: string, identityId: string): { status: "rejected" } {
    const identity = this.db.query<{ batch_id: string }, [string, string]>(
      `SELECT i.batch_id FROM imported_identities i JOIN import_batches b ON b.id = i.batch_id
       WHERE i.id = ? AND b.imported_by = ? AND i.status = 'awaiting_owner' LIMIT 1`,
    ).get(identityId, actorId);
    if (!identity) throw new Error("Only the person who imported this history can decline the request.");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE import_claim_requests SET status = 'rejected', resolved_at = ?
         WHERE identity_id = ? AND status = 'pending'`,
      ).run(now, identityId);
      this.db.query(
        `UPDATE imported_identities SET status = 'unclaimed', reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE id = ? AND status = 'awaiting_owner'`,
      ).run(identityId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'claim_rejected', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, actorId, now, JSON.stringify({ identityId }));
    })();
    return { status: "rejected" };
  }

  protected completeImportClaim(identityId: string, claimedBy: string): ImportClaimResult {
    const identity = this.db.query<{
      batch_id: string;
      display_name: string;
      placeholder_user_id: string;
      status: string;
    }, [string]>(
      "SELECT batch_id, display_name, placeholder_user_id, status FROM imported_identities WHERE id = ? LIMIT 1",
    ).get(identityId);
    if (!identity || identity.status === "claimed" || identity.status === "revoked") {
      throw new Error("This imported history can no longer be connected.");
    }
    const user = this.db.query<{ email: string }, [string]>('SELECT email FROM "user" WHERE id = ? LIMIT 1').get(claimedBy);
    if (!user) throw new Error("This Tallied account no longer exists.");

    const duplicatePayer = this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM expense_payers old
       JOIN expense_payers current ON current.expense_id = old.expense_id AND current.participant_id = ?
       WHERE old.participant_id = ? LIMIT 1`,
    ).get(claimedBy, identity.placeholder_user_id);
    const duplicateAllocation = this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM expense_allocations old
       JOIN expense_allocations current ON current.expense_id = old.expense_id AND current.participant_id = ?
       WHERE old.participant_id = ? LIMIT 1`,
    ).get(claimedBy, identity.placeholder_user_id);
    const duplicateEffect = this.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM imported_transaction_effects old
       JOIN imported_transaction_effects current
         ON current.transaction_id = old.transaction_id AND current.participant_id = ?
       WHERE old.participant_id = ? LIMIT 1`,
    ).get(claimedBy, identity.placeholder_user_id);
    const selfPayment = this.db.query<{ one: number }, [string, string, string, string]>(
      `SELECT 1 AS one FROM payments WHERE
         (payer_id = ? AND recipient_id = ?) OR (payer_id = ? AND recipient_id = ?) LIMIT 1`,
    ).get(identity.placeholder_user_id, claimedBy, claimedBy, identity.placeholder_user_id);
    const conflict = duplicatePayer || duplicateAllocation || duplicateEffect || selfPayment;
    if (conflict) throw new Error("This account already appears in the same imported expense. The person who imported it must resolve the duplicate.");

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query("UPDATE expense_payers SET participant_id = ? WHERE participant_id = ?")
        .run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE expense_allocations SET participant_id = ? WHERE participant_id = ?")
        .run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE payments SET payer_id = ? WHERE payer_id = ?").run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE payments SET recipient_id = ? WHERE recipient_id = ?").run(claimedBy, identity.placeholder_user_id);
      this.db.query("UPDATE imported_transaction_effects SET participant_id = ? WHERE participant_id = ?")
        .run(claimedBy, identity.placeholder_user_id);

      const memberships = this.db.query<{ group_id: string }, [string]>(
        "SELECT group_id FROM group_members WHERE user_id = ? AND status = 'placeholder'",
      ).all(identity.placeholder_user_id);
      for (const { group_id: groupId } of memberships) {
        this.db.query(
          `INSERT INTO import_participant_aliases(
             group_id, placeholder_user_id, claimed_user_id, identity_id, created_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(group_id, placeholder_user_id) DO UPDATE SET
             claimed_user_id = excluded.claimed_user_id,
             identity_id = excluded.identity_id,
             created_at = excluded.created_at`,
        ).run(groupId, identity.placeholder_user_id, claimedBy, identityId, now);
        const existing = this.db.query<{ one: number }, [string, string]>(
          "SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1",
        ).get(groupId, claimedBy);
        if (existing) {
          this.db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
            .run(groupId, identity.placeholder_user_id);
        } else {
          this.db.query(
            `UPDATE group_members SET user_id = ?, email = ?, status = 'active', removed_at = NULL
             WHERE group_id = ? AND user_id = ?`,
          ).run(claimedBy, user.email, groupId, identity.placeholder_user_id);
        }
      }
      this.db.query(
        `UPDATE imported_identities SET status = 'claimed', claimed_by_user_id = ?, claimed_at = ?,
           claim_token_hash = NULL, claim_expires_at = NULL, reserved_email_hash = NULL,
           reservation_requested_at = NULL, reservation_expires_at = NULL, reserved_by_user_id = NULL
         WHERE id = ?`,
      ).run(claimedBy, now, identityId);
      this.db.query(
        `UPDATE import_claim_requests SET status = 'approved', resolved_at = ?
         WHERE identity_id = ? AND claimant_user_id = ? AND status = 'pending'`,
      ).run(now, identityId, claimedBy);
      this.db.query(
        `UPDATE import_external_mappings SET local_id = ?
         WHERE batch_id = ? AND external_type = 'person' AND local_id = ?`,
      ).run(claimedBy, identity.batch_id, identity.placeholder_user_id);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'identity_claimed', ?, ?)`,
      ).run(randomUUID(), identity.batch_id, claimedBy, now, JSON.stringify({ identityId }));
    })();
    return { status: "claimed", displayName: identity.display_name };
  }

  deleteImportSourceData(actorId: string, batchId: string): ImportBatchSummary {
    const batch = this.db.query<{ source_data_deleted_at: string | null; fingerprint: string }, [string, string]>(
      "SELECT source_data_deleted_at, fingerprint FROM import_batches WHERE id = ? AND imported_by = ? LIMIT 1",
    ).get(batchId, actorId);
    if (!batch) throw new Error("This import is no longer available. Start again.");
    if (batch.source_data_deleted_at) return this.importBatchSummary(batchId, actorId);
    const now = new Date().toISOString();
    const deletedFingerprint = this.secretHash("import-deleted-fingerprint", `${batchId}:${batch.fingerprint}`);
    this.db.transaction(() => {
      const claimed = this.db.query(
        `UPDATE import_batches SET source_account_key = NULL, selected_source_groups_json = '[]',
           warnings_json = '[]', reconciliation_json = '{"sourceDataDeleted":true}',
           fingerprint = ?, source_data_deleted_at = ?
         WHERE id = ? AND imported_by = ? AND source_data_deleted_at IS NULL`,
      ).run(deletedFingerprint, now, batchId, actorId);
      if (claimed.changes !== 1) return;
      this.db.query("DELETE FROM import_sources WHERE batch_id = ?").run(batchId);
      for (const table of ["expenses", "payments"] as const) {
        const rows = this.db.query<{ id: string; source_record_id: string }, [string]>(
          `SELECT id, source_record_id FROM ${table} WHERE import_batch_id = ?`,
        ).all(batchId);
        for (const row of rows) {
          this.db.query(
            `UPDATE ${table} SET source_record_id = ?, source_metadata_json = '{"deleted":true}' WHERE id = ?`,
          ).run(`deleted:${this.secretHash("import-source-tombstone", row.source_record_id)}`, row.id);
        }
      }
      const transactions = this.db.query<{ id: string; source_record_id: string }, [string]>(
        "SELECT id, source_record_id FROM imported_transactions WHERE batch_id = ?",
      ).all(batchId);
      for (const row of transactions) {
        this.db.query(
          `UPDATE imported_transactions SET source_record_id = ?, source_metadata_json = '{"deleted":true}' WHERE id = ?`,
        ).run(`deleted:${this.secretHash("import-source-tombstone", row.source_record_id)}`, row.id);
      }
      const mappings = this.db.query<{ external_type: string; external_id: string }, [string]>(
        "SELECT external_type, external_id FROM import_external_mappings WHERE batch_id = ?",
      ).all(batchId);
      for (const mapping of mappings) {
        this.db.query(
          `UPDATE import_external_mappings SET external_id = ?, source_metadata_json = NULL
           WHERE batch_id = ? AND external_type = ? AND external_id = ?`,
        ).run(`deleted:${this.secretHash("import-source-tombstone", mapping.external_id)}`, batchId, mapping.external_type, mapping.external_id);
      }
      const identities = this.db.query<{ id: string; external_user_id: string }, [string]>(
        "SELECT id, external_user_id FROM imported_identities WHERE batch_id = ?",
      ).all(batchId);
      for (const identity of identities) {
        this.db.query(
          `UPDATE imported_identities SET external_user_id = ?, email_hash = NULL,
             claim_token_hash = NULL, claim_expires_at = NULL, reserved_email_hash = NULL,
             reservation_requested_at = NULL, reservation_expires_at = NULL,
             reserved_by_user_id = NULL,
             status = CASE WHEN status IN ('unclaimed', 'reserved', 'awaiting_owner') THEN 'revoked' ELSE status END,
             revoked_at = CASE WHEN status IN ('unclaimed', 'reserved', 'awaiting_owner') THEN ? ELSE revoked_at END
           WHERE id = ?`,
        ).run(`deleted:${this.secretHash("import-source-tombstone", identity.external_user_id)}`, now, identity.id);
      }
      this.db.query(
        `UPDATE import_claim_requests SET status = 'rejected', resolved_at = ?
         WHERE identity_id IN (SELECT id FROM imported_identities WHERE batch_id = ?)
           AND status = 'pending'`,
      ).run(now, batchId);
      this.db.query(
        `INSERT INTO import_batch_events(id, batch_id, actor_id, type, created_at, details_json)
         VALUES (?, ?, ?, 'source_data_deleted', ?, '{}')`,
      ).run(randomUUID(), batchId, actorId, now);
    })();
    return this.importBatchSummary(batchId, actorId);
  }
}
