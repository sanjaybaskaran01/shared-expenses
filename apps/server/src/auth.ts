import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import type { AppConfig } from "./config";
import type { ContactInviteStore } from "./contact-invites";
import { enqueueEmail } from "./email";
import { keyedDigest } from "./security-keys";
import { reassignFinancialParticipant } from "./participant-aliases";

function emailKey(kind: string, recipient: string, token: string): string {
  return createHash("sha256").update(`${kind}:${recipient}:${token}`).digest("hex");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]!);
}

export function deriveDisplayNameFromEmail(email: string): string {
  const localPart = email.split("@")[0]?.trim() || "Friend";
  const words = localPart.replace(/[._+-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const displayName = words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(" ");
  return (displayName || "Friend").slice(0, 100);
}

export function canCreateTalliedAccount(
  db: Database,
  config: AppConfig,
  contactInvites: ContactInviteStore,
  email: string,
): boolean {
  const normalized = email.trim().toLowerCase();
  if (normalized === config.ownerEmail) return true;
  const existingUser = db.query<{ one: number }, [string]>(
    `SELECT 1 AS one FROM "user" WHERE lower(email) = ? LIMIT 1`,
  ).get(normalized);
  if (existingUser) return true;
  const now = new Date().toISOString();
  const reservedImportClaim = db.query<{ one: number }, [string, string, string]>(
    `SELECT 1 AS one FROM imported_identities
     WHERE status = 'reserved' AND reserved_email_hash = ?
       AND reservation_expires_at > ? AND claim_expires_at > ?
     LIMIT 1`,
  ).get(keyedDigest(config.authSecret, "identity-email", normalized), now, now);
  return Boolean(
    db.query<{ one: number }, [string]>(
      "SELECT 1 AS one FROM group_members WHERE lower(email) = ? AND status = 'placeholder' LIMIT 1",
    ).get(normalized) || contactInvites.canCreateAccount(normalized) || reservedImportClaim,
  );
}

export function claimPendingInvitations(
  db: Database,
  contactInvites: ContactInviteStore,
  userId: string,
  email: string,
): void {
  const normalized = email.trim().toLowerCase();
  const now = new Date().toISOString();
  db.transaction(() => {
    const placeholders = db.query<{
      groupId: string;
      userId: string;
      displayName: string;
      invitationId: string | null;
    }, [string]>(
      `SELECT gm.group_id AS groupId, gm.user_id AS userId, gm.display_name AS displayName,
              gi.id AS invitationId
       FROM group_members gm
       LEFT JOIN group_invitations gi
         ON gi.group_id = gm.group_id AND lower(gi.email) = lower(gm.email) AND gi.status = 'pending'
       WHERE lower(gm.email) = ? AND gm.status = 'placeholder'`,
    ).all(normalized);
    for (const placeholder of placeholders) {
      reassignFinancialParticipant(db, placeholder.userId, userId);
      if (placeholder.invitationId) {
        db.query(
          `INSERT INTO invitation_participant_aliases(
             group_id, placeholder_user_id, claimed_user_id, invitation_id, created_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(group_id, placeholder_user_id) DO UPDATE SET
             claimed_user_id = excluded.claimed_user_id,
             invitation_id = excluded.invitation_id,
             created_at = excluded.created_at`,
        ).run(placeholder.groupId, placeholder.userId, userId, placeholder.invitationId, now);
      }
      db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'placeholder'")
        .run(placeholder.groupId, placeholder.userId);
      db.query(
        `INSERT OR IGNORE INTO group_members(group_id, user_id, display_name, email, status, joined_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      ).run(placeholder.groupId, userId, placeholder.displayName, normalized, now);
    }
    db.query(
      "UPDATE group_invitations SET status = 'accepted', accepted_at = ? WHERE lower(email) = ? AND status = 'pending'",
    ).run(now, normalized);
  })();
  contactInvites.acceptReservedForUser(userId, normalized);
}

export function createAuth(db: Database, config: AppConfig, contactInvites: ContactInviteStore) {
  const ownerEmail = config.ownerEmail;
  const canCreateAccount = (email: string): boolean => canCreateTalliedAccount(db, config, contactInvites, email);
  return betterAuth({
    appName: "Tallied",
    database: db,
    baseURL: config.publicApiUrl,
    secret: config.authSecret,
    trustedOrigins: [config.webOrigin],
    ...(config.googleAuth
      ? {
          socialProviders: {
            google: {
              clientId: config.googleAuth.clientId,
              clientSecret: config.googleAuth.clientSecret,
            },
          },
        }
      : {}),
    account: {
      encryptOAuthTokens: true,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    plugins: [
      magicLink({
        expiresIn: 10 * 60,
        storeToken: "hashed",
        rateLimit: { window: 60, max: 5 },
        sendMagicLink: async ({ email, url, token, metadata }) => {
          if (!config.devAuthBypass && !canCreateAccount(email)) return;
          const invitationId = typeof metadata?.invitationId === "string" ? metadata.invitationId : "";
          const contactInvitationId = typeof metadata?.contactInvitationId === "string"
            ? metadata.contactInvitationId
            : "";
          const migrationClaim = metadata?.migrationClaim === true;
          const invitation = invitationId
            ? db.query<{ groupName: string; inviterName: string }, [string, string]>(
                `SELECT g.name AS groupName, COALESCE(u.name, 'A friend') AS inviterName
                 FROM group_invitations gi
                 JOIN groups g ON g.id = gi.group_id
                 LEFT JOIN "user" u ON u.id = gi.invited_by
                 WHERE gi.id = ? AND lower(gi.email) = ? AND gi.status = 'pending'`,
              ).get(invitationId, email.trim().toLowerCase())
            : null;
          const contactInvitation = contactInvitationId
            ? contactInvites.invitationContext(contactInvitationId, email)
            : null;
          const subject = migrationClaim
            ? "Claim your imported Splitwise history on Tallied"
            : contactInvitation
            ? `${contactInvitation.inviterName} invited you to Tallied`
            : invitation
            ? `${invitation.inviterName} invited you to ${invitation.groupName}`
            : "Your secure Tallied sign-in link";
          const text = migrationClaim
            ? `Open this single-use link to verify your email, sign in, and review your imported-history claim: ${url}`
            : contactInvitation
            ? `${contactInvitation.inviterName} invited you to connect on Tallied. Open this single-use link to verify your email, join, and sign in: ${url}`
            : invitation
            ? `${invitation.inviterName} invited you to join ${invitation.groupName} on Tallied. Open this single-use link to join and sign in: ${url}`
            : `Open this single-use link to sign in to Tallied: ${url}`;
          const html = migrationClaim
            ? `<p>Verify your email to review an imported-history claim on Tallied.</p><p><a href="${escapeHtml(url)}">Continue to Tallied</a></p><p>This single-use link expires in 10 minutes. No balances are revealed until the claim is securely connected.</p>`
            : contactInvitation
            ? `<p><strong>${escapeHtml(contactInvitation.inviterName)}</strong> invited you to connect on Tallied.</p><p><a href="${escapeHtml(url)}">Join Tallied</a></p><p>This single-use link verifies your email and signs you in. It expires in 10 minutes.</p>`
            : invitation
            ? `<p><strong>${escapeHtml(invitation.inviterName)}</strong> invited you to join <strong>${escapeHtml(invitation.groupName)}</strong> on Tallied.</p><p><a href="${escapeHtml(url)}">Join ${escapeHtml(invitation.groupName)}</a></p><p>This single-use link verifies your email and signs you in. It expires in 10 minutes.</p>`
            : `<p>Use this single-use link to sign in to Tallied:</p><p><a href="${escapeHtml(url)}">Open Tallied</a></p><p>This link expires in 10 minutes.</p>`;
          enqueueEmail(db, {
            idempotencyKey: emailKey("magic-link", email, token),
            recipient: email,
            subject,
            text,
            html,
          });
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (config.devAuthBypass) return;
            const email = user.email.trim().toLowerCase();
            if (!canCreateAccount(email)) return false;
          },
          after: async (user) => {
            const email = user.email.trim().toLowerCase();
            const now = new Date().toISOString();
            claimPendingInvitations(db, contactInvites, user.id, email);
            db.transaction(() => {
              if (ownerEmail && email === ownerEmail) {
                const membership = db.query<{ one: number }, [string]>(
                  "SELECT 1 AS one FROM group_members WHERE user_id = ? LIMIT 1",
                ).get(user.id);
                if (!membership) {
                  const groupId = randomUUID();
                  db.query(
                    "INSERT INTO groups(id, name, settlement_currency, created_by, created_at) VALUES (?, ?, 'USD', ?, ?)",
                  ).run(groupId, config.bootstrapGroupName, user.id, now);
                  db.query(
                    `INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at)
                     VALUES (?, ?, ?, ?, 'active', ?)`,
                  ).run(groupId, user.id, user.name || email.split("@")[0] || email, email, now);
                }
              }
            })();
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            const user = db.query<{ email: string }, [string]>(
              `SELECT email FROM "user" WHERE id = ? LIMIT 1`,
            ).get(session.userId);
            if (user) claimPendingInvitations(db, contactInvites, session.userId, user.email);
          },
        },
      },
    },
    advanced: {
      useSecureCookies: config.nodeEnv === "production",
      ...(config.nodeEnv === "production"
        ? { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } }
        : {}),
      ...(config.nodeEnv === "production" && config.cookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: config.cookieDomain,
            },
          }
        : {}),
    },
  });
}

export type ExpensesAuth = ReturnType<typeof createAuth>;
