import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { keyedDigest } from "./security-keys";

const INVITE_LIMIT = 5;
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const RESERVATION_LIFETIME_MS = 15 * 60_000;

export type ContactInviteErrorCode =
  | "INVITE_LIMIT_REACHED"
  | "INVITE_NOT_AVAILABLE"
  | "INVITE_RESERVED"
  | "INVITE_NOT_FOUND";

export class ContactInviteError extends Error {
  constructor(
    readonly code: ContactInviteErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ContactInviteError";
  }
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface ContactInviteStoreOptions {
  emailHashSecret: string;
  now?: () => Date;
}

interface InvitationRow {
  id: string;
  inviter_user_id: string;
  status: "pending" | "reserved" | "accepted" | "revoked";
  reserved_email_hash: string | null;
  reservation_expires_at: string | null;
  claimed_by_user_id: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface ContactInviteSummary {
  id: string;
  status: InvitationRow["status"] | "expired";
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
}

export interface ContactSummary {
  userId: string;
  displayName: string;
  joinedAt: string;
}

export class ContactInviteStore {
  readonly limit = INVITE_LIMIT;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly options: ContactInviteStoreOptions,
  ) {
    if (options.emailHashSecret.length < 16) {
      throw new Error("Contact invitation email hash secret must be at least 16 characters");
    }
    this.now = options.now ?? (() => new Date());
  }

  private emailHash(email: string): string {
    return keyedDigest(this.options.emailHashSecret, "contact-invite-email", email.trim().toLowerCase());
  }

  create(inviterUserId: string): { id: string; token: string; expiresAt: string } {
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS).toISOString();
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashInviteToken(token);
    this.db.transaction(() => {
      const activeCount = this.db.query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count
         FROM contact_invitations
         WHERE inviter_user_id = ?
           AND (status = 'accepted' OR (status IN ('pending', 'reserved') AND expires_at > ?))`,
      ).get(inviterUserId, nowIso)?.count ?? 0;
      if (activeCount >= INVITE_LIMIT) {
        throw new ContactInviteError(
          "INVITE_LIMIT_REACHED",
          "All five invites are in use. Revoke a pending invite or wait for one to expire.",
          409,
        );
      }
      this.db.query(
        `INSERT INTO contact_invitations(
           id, token_hash, inviter_user_id, status, created_at, expires_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(id, tokenHash, inviterUserId, nowIso, expiresAt);
    })();
    return { id, token, expiresAt };
  }

  reserve(token: string, email: string): { invitationId: string } {
    const tokenHash = hashInviteToken(token);
    const requestedEmailHash = this.emailHash(email);
    const now = this.now();
    const nowIso = now.toISOString();
    const reservationExpiresAt = new Date(now.getTime() + RESERVATION_LIFETIME_MS).toISOString();
    return this.db.transaction(() => {
      const invitation = this.db.query<InvitationRow, [string]>(
        `SELECT id, inviter_user_id, status, reserved_email_hash, reservation_expires_at,
                claimed_by_user_id, created_at, expires_at, accepted_at
         FROM contact_invitations WHERE token_hash = ?`,
      ).get(tokenHash);
      if (!invitation || invitation.status === "revoked" || invitation.status === "accepted" || invitation.expires_at <= nowIso) {
        throw new ContactInviteError(
          "INVITE_NOT_AVAILABLE",
          "This invitation has expired or is no longer available. Ask the sender for a new one.",
          410,
        );
      }
      const reservationActive = invitation.status === "reserved" &&
        Boolean(invitation.reservation_expires_at && invitation.reservation_expires_at > nowIso);
      if (reservationActive && invitation.reserved_email_hash !== requestedEmailHash) {
        throw new ContactInviteError(
          "INVITE_RESERVED",
          "This invitation was opened with another email address. Use that email or ask the sender for a new link.",
          409,
        );
      }
      this.db.query(
        `UPDATE contact_invitations
         SET status = 'reserved', reserved_email_hash = ?, reservation_expires_at = ?
         WHERE id = ?`,
      ).run(requestedEmailHash, reservationExpiresAt, invitation.id);
      return { invitationId: invitation.id };
    })();
  }

  canCreateAccount(email: string): boolean {
    const nowIso = this.now().toISOString();
    return Boolean(this.db.query<{ one: number }, [string, string, string]>(
      `SELECT 1 AS one FROM contact_invitations
       WHERE status = 'reserved'
         AND reserved_email_hash = ?
         AND reservation_expires_at > ?
         AND expires_at > ?
       LIMIT 1`,
    ).get(this.emailHash(email), nowIso, nowIso));
  }

  acceptReservedForUser(userId: string, email: string): number {
    const nowIso = this.now().toISOString();
    const emailHash = this.emailHash(email);
    return this.db.transaction(() => {
      const invitations = this.db.query<{ id: string; inviter_user_id: string }, [string, string, string, string]>(
        `SELECT id, inviter_user_id FROM contact_invitations
         WHERE status = 'reserved'
           AND reserved_email_hash = ?
           AND reservation_expires_at > ?
           AND expires_at > ?
           AND inviter_user_id <> ?`,
      ).all(emailHash, nowIso, nowIso, userId);
      for (const invitation of invitations) {
        this.db.query(
          `UPDATE contact_invitations
           SET status = 'accepted', claimed_by_user_id = ?, accepted_at = ?
           WHERE id = ? AND status = 'reserved'`,
        ).run(userId, nowIso, invitation.id);
        this.db.query(
          `INSERT OR IGNORE INTO contacts(owner_user_id, contact_user_id, invitation_id, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(invitation.inviter_user_id, userId, invitation.id, nowIso);
        this.db.query(
          `INSERT OR IGNORE INTO contacts(owner_user_id, contact_user_id, invitation_id, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(userId, invitation.inviter_user_id, invitation.id, nowIso);
      }
      return invitations.length;
    })();
  }

  acceptForSignedInUser(token: string, userId: string, email: string): void {
    this.reserve(token, email);
    if (this.acceptReservedForUser(userId, email) === 0) {
      throw new ContactInviteError("INVITE_NOT_AVAILABLE", "This invitation has expired or is no longer available. Ask the sender for a new one.", 409);
    }
  }

  revoke(inviterUserId: string, invitationId: string): void {
    const nowIso = this.now().toISOString();
    const result = this.db.query(
      `UPDATE contact_invitations
       SET status = 'revoked', revoked_at = ?, reserved_email_hash = NULL,
           reservation_expires_at = NULL
       WHERE id = ? AND inviter_user_id = ? AND status IN ('pending', 'reserved')`,
    ).run(nowIso, invitationId, inviterUserId);
    if (result.changes !== 1) {
      throw new ContactInviteError("INVITE_NOT_FOUND", "This invitation is no longer available.", 404);
    }
  }

  list(userId: string): {
    creditsTotal: number;
    creditsRemaining: number;
    invitations: ContactInviteSummary[];
    contacts: ContactSummary[];
  } {
    const nowIso = this.now().toISOString();
    const invitations = this.db.query<InvitationRow, [string]>(
      `SELECT id, inviter_user_id, status, reserved_email_hash, reservation_expires_at,
              claimed_by_user_id, created_at, expires_at, accepted_at
       FROM contact_invitations
       WHERE inviter_user_id = ?
       ORDER BY created_at DESC`,
    ).all(userId);
    const activeCount = invitations.filter((invitation) =>
      invitation.status === "accepted" ||
      (invitation.status !== "revoked" && invitation.expires_at > nowIso)
    ).length;
    const contacts = this.db.query<
      { user_id: string; display_name: string; joined_at: string },
      [string]
    >(
      `SELECT u.id AS user_id, u.name AS display_name, c.created_at AS joined_at
       FROM contacts c
       JOIN "user" u ON u.id = c.contact_user_id
       WHERE c.owner_user_id = ?
       ORDER BY lower(u.name), c.created_at`,
    ).all(userId);
    return {
      creditsTotal: INVITE_LIMIT,
      creditsRemaining: Math.max(0, INVITE_LIMIT - activeCount),
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        status: invitation.status !== "accepted" && invitation.status !== "revoked" && invitation.expires_at <= nowIso
          ? "expired"
          : invitation.status,
        createdAt: invitation.created_at,
        expiresAt: invitation.expires_at,
        ...(invitation.accepted_at ? { acceptedAt: invitation.accepted_at } : {}),
      })),
      contacts: contacts.map((contact) => ({
        userId: contact.user_id,
        displayName: contact.display_name,
        joinedAt: contact.joined_at,
      })),
    };
  }

  invitationContext(invitationId: string, email: string): { inviterName: string } | null {
    const nowIso = this.now().toISOString();
    return this.db.query<{ inviterName: string }, [string, string, string, string]>(
      `SELECT COALESCE(u.name, 'A friend') AS inviterName
       FROM contact_invitations ci
       LEFT JOIN "user" u ON u.id = ci.inviter_user_id
       WHERE ci.id = ? AND ci.status = 'reserved' AND ci.reserved_email_hash = ?
         AND ci.reservation_expires_at > ? AND ci.expires_at > ?`,
    ).get(invitationId, this.emailHash(email), nowIso, nowIso) ?? null;
  }
}
