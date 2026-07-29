import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import type { AppConfig } from "./config";
import type { ContactInviteStore } from "./contact-invites";
import { enqueueEmail } from "./email";

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

function claimPendingInvitations(
  db: Database,
  contactInvites: ContactInviteStore,
  userId: string,
  email: string,
): void {
  const normalized = email.trim().toLowerCase();
  const now = new Date().toISOString();
  db.transaction(() => {
    const placeholders = db.query<{ group_id: string; display_name: string }, [string]>(
      "SELECT group_id, display_name FROM group_members WHERE lower(email) = ? AND status = 'placeholder'",
    ).all(normalized);
    for (const placeholder of placeholders) {
      db.query("DELETE FROM group_members WHERE group_id = ? AND lower(email) = ? AND status = 'placeholder'")
        .run(placeholder.group_id, normalized);
      db.query(
        `INSERT OR IGNORE INTO group_members(group_id, user_id, display_name, email, status, joined_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      ).run(placeholder.group_id, userId, placeholder.display_name, normalized, now);
    }
    db.query(
      "UPDATE group_invitations SET status = 'accepted', accepted_at = ? WHERE lower(email) = ? AND status = 'pending'",
    ).run(now, normalized);
  })();
  contactInvites.acceptReservedForUser(userId, normalized);
}

export function createAuth(db: Database, config: AppConfig, contactInvites: ContactInviteStore) {
  const ownerEmail = config.ownerEmail;
  const canCreateAccount = (email: string): boolean => {
    const normalized = email.trim().toLowerCase();
    if (normalized === ownerEmail) return true;
    const existingUser = db.query<{ one: number }, [string]>(
      `SELECT 1 AS one FROM "user" WHERE lower(email) = ? LIMIT 1`,
    ).get(normalized);
    if (existingUser) return true;
    return Boolean(
      db.query<{ one: number }, [string]>(
        "SELECT 1 AS one FROM group_members WHERE lower(email) = ? AND status = 'placeholder' LIMIT 1",
      ).get(normalized) || contactInvites.canCreateAccount(normalized),
    );
  };
  return betterAuth({
    appName: "Tally",
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
          const subject = contactInvitation
            ? `${contactInvitation.inviterName} invited you to Tally`
            : invitation
            ? `${invitation.inviterName} invited you to ${invitation.groupName}`
            : "Your secure Tally sign-in link";
          const text = contactInvitation
            ? `${contactInvitation.inviterName} invited you to connect on Tally. Open this single-use link to verify your email, join, and sign in: ${url}`
            : invitation
            ? `${invitation.inviterName} invited you to join ${invitation.groupName} on Tally. Open this single-use link to join and sign in: ${url}`
            : `Open this single-use link to sign in to Tally: ${url}`;
          const html = contactInvitation
            ? `<p><strong>${escapeHtml(contactInvitation.inviterName)}</strong> invited you to connect on Tally.</p><p><a href="${escapeHtml(url)}">Join Tally</a></p><p>This single-use link verifies your email and signs you in. It expires in 10 minutes.</p>`
            : invitation
            ? `<p><strong>${escapeHtml(invitation.inviterName)}</strong> invited you to join <strong>${escapeHtml(invitation.groupName)}</strong> on Tally.</p><p><a href="${escapeHtml(url)}">Join ${escapeHtml(invitation.groupName)}</a></p><p>This single-use link verifies your email and signs you in. It expires in 10 minutes.</p>`
            : `<p>Use this single-use link to sign in to Tally:</p><p><a href="${escapeHtml(url)}">Open Tally</a></p><p>This link expires in 10 minutes.</p>`;
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
