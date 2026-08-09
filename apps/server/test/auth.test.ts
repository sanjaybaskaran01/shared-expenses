import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { authRequestForPeer, canCreateTalliedAccount, claimPendingInvitations, createAuth, deriveDisplayNameFromEmail } from "../src/auth";
import {
  isTrustedProxyAddress,
  resolveGoogleAuthConfig,
  resolvePublicRateKey,
  resolveSplitwiseOAuthConfig,
  resolveTrustedProxies,
  validateProductionAuthDelivery,
  validateProductionAuthSecret,
  type AppConfig,
} from "../src/config";
import { ContactInviteStore } from "../src/contact-invites";
import { runDomainMigrations } from "../src/database";
import { LedgerStore } from "../src/ledger";
import { keyedDigest } from "../src/security-keys";

function testConfig(googleAuth?: AppConfig["googleAuth"]): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    databasePath: ":memory:",
    attachmentsPath: "/tmp/tally-test-attachments",
    webOrigin: "http://localhost:5173",
    publicApiUrl: "http://localhost:3000",
    authSecret: "test-only-auth-secret-not-for-production",
    devAuthBypass: false,
    trustCloudflareProxy: false,
    trustedProxies: [],
    ownerEmail: "owner@example.com",
    ...(googleAuth ? { googleAuth } : {}),
    bootstrapGroupName: "Test group",
    smtp: {
      enabled: false,
      host: "smtp.example.com",
      port: 465,
      secure: true,
      from: "test@example.com",
    },
  };
}

describe("invitation display names", () => {
  test("derives a readable name from the only required field", () => {
    expect(deriveDisplayNameFromEmail("sam.jones+trip@example.com")).toBe("Sam Jones Trip");
    expect(deriveDisplayNameFromEmail("alex-doe@example.com")).toBe("Alex Doe");
  });

  test("uses a safe fallback", () => {
    expect(deriveDisplayNameFromEmail("@example.com")).toBe("Friend");
  });
});

describe("group invitation account handoff", () => {
  test("moves pre-acceptance expenses to an existing verified account and keeps signed history immutable", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    runDomainMigrations(database, resolve(import.meta.dir, "../migrations"));
    const now = "2026-08-09T12:00:00.000Z";
    const placeholderId = "invite:synthetic-invitation";
    database.exec(`
      INSERT INTO groups(id, name, settlement_currency, created_by, created_at)
      VALUES ('group-1', 'Synthetic trip', 'USD', 'owner', '${now}');
      INSERT INTO group_members(group_id, user_id, display_name, email, status, joined_at) VALUES
        ('group-1', 'owner', 'Owner Example', 'owner@example.com', 'active', '${now}'),
        ('group-1', '${placeholderId}', 'Friend Example', 'friend@example.com', 'placeholder', '${now}');
      INSERT INTO group_invitations(id, group_id, email, display_name, invited_by, status, created_at)
      VALUES ('synthetic-invitation', 'group-1', 'friend@example.com', 'Friend Example', 'owner', 'pending', '${now}');
      INSERT INTO expenses(
        id, group_id, description, category, amount_minor, currency, expense_date,
        notes, status, version, created_by, created_at, updated_at
      ) VALUES (
        'expense-1', 'group-1', 'Coffee', 'Dining out', 2400, 'USD', '2026-08-09',
        '', 'active', 1, 'owner', '${now}', '${now}'
      );
      INSERT INTO expense_payers(expense_id, participant_id, amount_minor)
      VALUES ('expense-1', 'owner', 2400);
      INSERT INTO expense_allocations(expense_id, participant_id, amount_minor) VALUES
        ('expense-1', 'owner', 1200),
        ('expense-1', '${placeholderId}', 1200);
      INSERT INTO operations(
        id, group_id, actor_id, device_id, type, target_id, base_version,
        client_timestamp, payload_json, content_hash, signature, received_at, status
      ) VALUES (
        'operation-1', 'group-1', 'owner', 'device-1', 'ExpenseCreated', 'expense-1', 0,
        '${now}', '{"allocations":[{"participantId":"${placeholderId}","amountMinor":1200}]}',
        '${"a".repeat(64)}', 'synthetic-signature', '${now}', 'accepted'
      );
    `);
    const config = testConfig();
    const contactInvites = new ContactInviteStore(database, { emailHashSecret: config.authSecret });

    claimPendingInvitations(database, contactInvites, "verified-friend", "friend@example.com");

    expect(database.query<{ status: string }, [string, string]>(
      "SELECT status FROM group_members WHERE group_id = ? AND user_id = ?",
    ).get("group-1", "verified-friend")).toEqual({ status: "active" });
    expect(database.query<{ amount: number }, [string, string]>(
      "SELECT amount_minor AS amount FROM expense_allocations WHERE expense_id = ? AND participant_id = ?",
    ).get("expense-1", "verified-friend")).toEqual({ amount: 1200 });
    expect(database.query<{ payload: string }, [string]>(
      "SELECT payload_json AS payload FROM operations WHERE id = ?",
    ).get("operation-1")?.payload).toContain(placeholderId);
    expect(new LedgerStore(database).snapshot("verified-friend").participantAliases).toEqual([
      { groupId: "group-1", fromUserId: placeholderId, toUserId: "verified-friend" },
    ]);
    expect(database.query<{ status: string }, [string]>(
      "SELECT status FROM group_invitations WHERE id = ?",
    ).get("synthetic-invitation")).toEqual({ status: "accepted" });
    database.close();
  });
});

describe("public rate-limit identity", () => {
  test("ignores a forged Cloudflare header unless the proxy is explicitly trusted", () => {
    expect(resolvePublicRateKey({
      cloudflareIp: "203.0.113.9",
      peerAddress: "192.0.2.10",
      trustCloudflareProxy: false,
      trustedProxies: ["192.0.2.10"],
      production: true,
    })).toBe("unidentified");
    expect(resolvePublicRateKey({
      cloudflareIp: "203.0.113.9",
      peerAddress: "198.51.100.10",
      trustCloudflareProxy: true,
      trustedProxies: ["192.0.2.10"],
      production: true,
    })).toBe("unidentified");
    expect(resolvePublicRateKey({
      cloudflareIp: "203.0.113.9",
      peerAddress: "192.0.2.10",
      trustCloudflareProxy: true,
      trustedProxies: ["192.0.2.10"],
      production: true,
    })).toBe("203.0.113.9");
  });

  test("configures Better Auth IP tracking only behind the explicitly trusted proxy", () => {
    const database = new Database(":memory:");
    const contactInvites = new ContactInviteStore(database, { emailHashSecret: testConfig().authSecret });
    const untrusted = createAuth(database, { ...testConfig(), nodeEnv: "production" }, contactInvites);
    expect(untrusted.options.advanced?.ipAddress).toBeUndefined();

    const trusted = createAuth(database, {
      ...testConfig(),
      nodeEnv: "production",
      trustCloudflareProxy: true,
      trustedProxies: ["192.0.2.10", "2001:db8::10"],
    }, contactInvites);
    expect(trusted.options.advanced?.ipAddress).toEqual({
      ipAddressHeaders: ["cf-connecting-ip"],
      trustedProxies: ["192.0.2.10", "2001:db8::10"],
    });
    database.close();
  });

  test("rejects broad or untrusted proxy CIDR configuration", () => {
    expect(resolveTrustedProxies(undefined, false)).toEqual([]);
    expect(resolveTrustedProxies("192.0.2.10, 2001:db8::10", true)).toEqual(["192.0.2.10", "2001:db8::10"]);
    expect(() => resolveTrustedProxies("192.0.2.10", false)).toThrow("TRUST_CLOUDFLARE_PROXY");
    expect(() => resolveTrustedProxies(undefined, true)).toThrow("requires TRUSTED_PROXY_CIDRS");
    expect(() => resolveTrustedProxies("0.0.0.0/0", true)).toThrow("must not trust every address");
    expect(() => resolveTrustedProxies("10.0.0.0/8", true)).toThrow("too broad");
    expect(() => resolveTrustedProxies("100.0.0.0/1", true)).toThrow("too broad");
    expect(() => resolveTrustedProxies("999.999.999.999/99", true)).toThrow("valid IP");
    expect(() => resolveTrustedProxies("2001:db8::/32", true)).toThrow("too broad");
  });

  test("matches only validated proxy addresses and narrow subnets", () => {
    expect(isTrustedProxyAddress("192.0.2.10", ["192.0.2.10"])).toBe(true);
    expect(isTrustedProxyAddress("192.0.2.44", ["192.0.2.0/24"])).toBe(true);
    expect(isTrustedProxyAddress("192.0.3.1", ["192.0.2.0/24"])).toBe(false);
    expect(isTrustedProxyAddress("2001:db8::12", ["2001:db8::/64"])).toBe(true);
    expect(isTrustedProxyAddress("2001:db9::12", ["2001:db8::/64"])).toBe(false);
  });

  test("removes forwarded identity headers before auth for an untrusted peer", () => {
    const config = {
      ...testConfig(),
      nodeEnv: "production",
      trustCloudflareProxy: true,
      trustedProxies: ["192.0.2.10"],
    };
    const forged = new Request("https://example.com/api/auth/session", {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
      },
    });
    const sanitized = authRequestForPeer(forged, config, "198.51.100.10");
    expect(sanitized.headers.get("cf-connecting-ip")).toBeNull();
    expect(sanitized.headers.get("x-forwarded-for")).toBeNull();
    expect(sanitized.headers.get("x-real-ip")).toBeNull();

    const trusted = authRequestForPeer(forged, config, "192.0.2.10");
    expect(trusted.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
  });
});

describe("Google authentication configuration", () => {
  test("stays disabled when no credentials are configured", () => {
    expect(resolveGoogleAuthConfig(undefined, undefined)).toBeUndefined();
    expect(resolveGoogleAuthConfig("", "")).toBeUndefined();
  });

  test("requires the client id and secret as a pair", () => {
    expect(() => resolveGoogleAuthConfig("client-id", undefined)).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
    expect(() => resolveGoogleAuthConfig(undefined, "not-a-real-google-client-secret")).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
  });

  test("normalizes a complete credential pair", () => {
    expect(resolveGoogleAuthConfig(" client-id ", " not-a-real-google-client-secret ")).toEqual({
      clientId: "client-id",
      clientSecret: "not-a-real-google-client-secret",
    });
  });

  test("registers Google with encrypted OAuth token storage", () => {
    const database = new Database(":memory:");
    const config = testConfig({ clientId: "client-id", clientSecret: "not-a-real-google-client-secret" });
    const contactInvites = new ContactInviteStore(database, { emailHashSecret: config.authSecret });
    const auth = createAuth(database, config, contactInvites);
    expect(auth.options.socialProviders?.google?.clientId).toBe("client-id");
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
    database.close();
  });

  test("supports Google-only production and requires a sender only when SMTP is enabled", () => {
    expect(() => validateProductionAuthDelivery({ production: true, googleEnabled: true, smtpEnabled: false })).not.toThrow();
    expect(() => validateProductionAuthDelivery({ production: true, googleEnabled: false, smtpEnabled: false })).toThrow(
      "SMTP or Google OAuth",
    );
    expect(() => validateProductionAuthDelivery({ production: true, googleEnabled: false, smtpEnabled: true })).toThrow(
      "SMTP_FROM",
    );
    expect(() => validateProductionAuthDelivery({
      production: true,
      googleEnabled: false,
      smtpEnabled: true,
      smtpFrom: "Tallied <tally@example.com>",
    })).not.toThrow();
  });
});

describe("production authentication secret", () => {
  test("rejects empty, short, and example secrets", () => {
    expect(() => validateProductionAuthSecret("")).toThrow();
    expect(() => validateProductionAuthSecret("too-short")).toThrow();
    expect(() => validateProductionAuthSecret("development-only-secret-change-before-production")).toThrow();
    expect(() => validateProductionAuthSecret("replace-with-at-least-32-random-characters")).toThrow();
    expect(() => validateProductionAuthSecret("example-secret-that-is-intentionally-long-enough")).toThrow();
    expect(() => validateProductionAuthSecret("test-only-auth-secret-not-for-production")).toThrow();
  });

  test("accepts a sufficiently long non-example secret", () => {
    expect(() => validateProductionAuthSecret("a-secure-random-value-that-is-long-enough")).not.toThrow();
  });
});

describe("migration-claim account gate", () => {
  test("allows only the email currently reserved by a valid claim", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE group_members (email TEXT, status TEXT NOT NULL);
      CREATE TABLE contact_invitations (
        status TEXT NOT NULL, reserved_email_hash TEXT,
        reservation_expires_at TEXT, expires_at TEXT NOT NULL
      );
      CREATE TABLE imported_identities (
        status TEXT NOT NULL, reserved_email_hash TEXT,
        reservation_expires_at TEXT, claim_expires_at TEXT
      );
    `);
    const config = testConfig();
    const contactInvites = new ContactInviteStore(database, { emailHashSecret: config.authSecret });
    const email = "new-friend@example.com";
    const emailHash = keyedDigest(config.authSecret, "identity-email", email);
    database.query(
      `INSERT INTO imported_identities(
         status, reserved_email_hash, reservation_expires_at, claim_expires_at
       ) VALUES ('reserved', ?, '2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z')`,
    ).run(emailHash);

    expect(canCreateTalliedAccount(database, config, contactInvites, email)).toBe(true);
    expect(canCreateTalliedAccount(database, config, contactInvites, "forwarded@example.com")).toBe(false);
    database.query("UPDATE imported_identities SET reservation_expires_at = '2020-01-01T00:00:00.000Z'").run();
    expect(canCreateTalliedAccount(database, config, contactInvites, email)).toBe(false);
    database.close();
  });
});

describe("Splitwise API approval gate", () => {
  test("stays disabled even when credentials exist without written approval", () => {
    expect(resolveSplitwiseOAuthConfig({
      approved: false,
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://example.com/callback",
    })).toBeUndefined();
  });

  test("requires a complete approved configuration", () => {
    expect(() => resolveSplitwiseOAuthConfig({ approved: true, clientId: "client-id" })).toThrow(
      "required after approval",
    );
  });

  test("accepts an approved HTTPS callback", () => {
    expect(resolveSplitwiseOAuthConfig({
      approved: true,
      clientId: " client-id ",
      clientSecret: " client-secret ",
      redirectUri: " https://expenses.example.com/api/v1/imports/splitwise/callback ",
    })).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://expenses.example.com/api/v1/imports/splitwise/callback",
    });
  });

  test("rejects callback URLs with a wrong path, credentials, query, or fragment", () => {
    const base = { approved: true, clientId: "client-id", clientSecret: "client-secret" };
    for (const redirectUri of [
      "https://expenses.example.com/callback",
      "https://user:pass@expenses.example.com/api/v1/imports/splitwise/callback",
      "https://expenses.example.com/api/v1/imports/splitwise/callback?next=evil",
      "https://expenses.example.com/api/v1/imports/splitwise/callback#fragment",
    ]) {
      expect(() => resolveSplitwiseOAuthConfig({ ...base, redirectUri })).toThrow("exact Tallied callback");
    }
  });
});
