import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import type { AppConfig } from "./config";
import { enqueueEmail } from "./email";

function emailKey(kind: string, recipient: string, token: string): string {
  return createHash("sha256").update(`${kind}:${recipient}:${token}`).digest("hex");
}

export function createAuth(db: Database, config: AppConfig) {
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
      ).get(normalized),
    );
  };
  return betterAuth({
    appName: "Expenses",
    database: db,
    baseURL: config.publicApiUrl,
    secret: config.authSecret,
    trustedOrigins: [config.webOrigin],
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    plugins: [
      magicLink({
        expiresIn: 10 * 60,
        storeToken: "hashed",
        rateLimit: { window: 60, max: 5 },
        sendMagicLink: async ({ email, url, token }) => {
          if (!config.devAuthBypass && !canCreateAccount(email)) return;
          enqueueEmail(db, {
            idempotencyKey: emailKey("magic-link", email, token),
            recipient: email,
            subject: "Your secure Expenses sign-in link",
            text: `Open this single-use link to sign in to Expenses: ${url}`,
            html: `<p>Use this single-use link to sign in to Expenses:</p><p><a href="${url}">Open Expenses</a></p><p>This link expires in 10 minutes.</p>`,
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
            db.transaction(() => {
              const placeholders = db.query<{ group_id: string; display_name: string }, [string]>(
                "SELECT group_id, display_name FROM group_members WHERE lower(email) = ? AND status = 'placeholder'",
              ).all(email);
              for (const placeholder of placeholders) {
                db.query("DELETE FROM group_members WHERE group_id = ? AND lower(email) = ? AND status = 'placeholder'")
                  .run(placeholder.group_id, email);
                db.query(
                  `INSERT OR IGNORE INTO group_members(group_id, user_id, display_name, email, status, joined_at)
                   VALUES (?, ?, ?, ?, 'active', ?)`,
                ).run(placeholder.group_id, user.id, placeholder.display_name, email, now);
              }
              db.query(
                "UPDATE group_invitations SET status = 'accepted', accepted_at = ? WHERE lower(email) = ? AND status = 'pending'",
              ).run(now, email);

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
    },
    advanced: {
      useSecureCookies: config.nodeEnv === "production",
      ...(config.nodeEnv === "production"
        ? { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } }
        : {}),
      ...(config.nodeEnv === "production"
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: ".expenses.sanjaybaskaran.com",
            },
          }
        : {}),
    },
  });
}

export type ExpensesAuth = ReturnType<typeof createAuth>;
