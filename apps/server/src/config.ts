import { resolve } from "node:path";

function booleanEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function validateProductionAuthSecret(value: string): void {
  if (value.length < 32 || /(development|replace|example|test)/i.test(value)) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 non-example characters in production");
  }
}

export function resolvePublicRateKey(input: {
  cloudflareIp?: string;
  trustCloudflareProxy: boolean;
  production: boolean;
}): string {
  const cloudflareIp = input.cloudflareIp?.trim() ?? "";
  if (input.trustCloudflareProxy && /^[0-9a-f:.]{2,64}$/i.test(cloudflareIp)) return cloudflareIp;
  return input.production ? "unidentified" : "local-development";
}

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface SplitwiseOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function validatedBaseUrl(name: string, value: string, production: boolean): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} cannot contain credentials, a query, or a fragment`);
  }
  if (production && parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  if (!production && !["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} must be HTTP or HTTPS`);
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, ""));
}

export function resolveSplitwiseOAuthConfig(input: {
  approved: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}): SplitwiseOAuthConfig | undefined {
  if (!input.approved) return undefined;
  const clientId = input.clientId?.trim();
  const clientSecret = input.clientSecret?.trim();
  const redirectUri = input.redirectUri?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "SPLITWISE_CLIENT_ID, SPLITWISE_CLIENT_SECRET, and SPLITWISE_REDIRECT_URI are required after approval",
    );
  }
  const parsed = new URL(redirectUri);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("SPLITWISE_REDIRECT_URI must use HTTPS outside local development");
  }
  if (
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== "/api/v1/imports/splitwise/callback"
  ) {
    throw new Error("SPLITWISE_REDIRECT_URI must be the exact Tallied callback URL without credentials, query, or fragment");
  }
  return { clientId, clientSecret, redirectUri: parsed.toString() };
}

export function resolveGoogleAuthConfig(
  clientIdValue: string | undefined,
  clientSecretValue: string | undefined,
): GoogleAuthConfig | undefined {
  const clientId = clientIdValue?.trim();
  const clientSecret = clientSecretValue?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together");
  }
  return { clientId, clientSecret };
}

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  databasePath: string;
  attachmentsPath: string;
  webOrigin: string;
  publicApiUrl: string;
  authSecret: string;
  devAuthBypass: boolean;
  trustCloudflareProxy: boolean;
  ownerEmail?: string;
  cookieDomain?: string;
  googleAuth?: GoogleAuthConfig;
  splitwiseOAuth?: SplitwiseOAuthConfig;
  bootstrapGroupName: string;
  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    appPassword?: string;
    from: string;
  };
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const authSecret = process.env.BETTER_AUTH_SECRET ?? "development-only-secret-change-before-production";
  const devAuthBypass = booleanEnv("DEV_AUTH_BYPASS", nodeEnv !== "production");
  if (nodeEnv === "production" && devAuthBypass) {
    throw new Error("DEV_AUTH_BYPASS cannot be enabled in production");
  }
  if (nodeEnv === "production") validateProductionAuthSecret(authSecret);

  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_APP_PASSWORD;
  const smtpFrom = process.env.SMTP_FROM?.trim();
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const cookieDomain = process.env.COOKIE_DOMAIN?.trim().toLowerCase();
  const googleAuth = resolveGoogleAuthConfig(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  const splitwiseOAuth = resolveSplitwiseOAuthConfig({
    approved: booleanEnv("SPLITWISE_API_APPROVED", false),
    ...(process.env.SPLITWISE_CLIENT_ID ? { clientId: process.env.SPLITWISE_CLIENT_ID } : {}),
    ...(process.env.SPLITWISE_CLIENT_SECRET ? { clientSecret: process.env.SPLITWISE_CLIENT_SECRET } : {}),
    ...(process.env.SPLITWISE_REDIRECT_URI ? { redirectUri: process.env.SPLITWISE_REDIRECT_URI } : {}),
  });
  if (Boolean(smtpUser) !== Boolean(smtpPassword)) {
    throw new Error("SMTP_USER and SMTP_APP_PASSWORD must be configured together");
  }
  if (nodeEnv === "production" && !ownerEmail) {
    throw new Error("OWNER_EMAIL is required in production");
  }
  if (nodeEnv === "production" && !smtpFrom) {
    throw new Error("SMTP_FROM is required in production");
  }
  const webOrigin = validatedBaseUrl("WEB_ORIGIN", process.env.WEB_ORIGIN ?? "http://localhost:5173", nodeEnv === "production");
  const publicApiUrl = validatedBaseUrl(
    "PUBLIC_API_URL",
    process.env.PUBLIC_API_URL ?? "http://localhost:3000",
    nodeEnv === "production",
  );
  if (nodeEnv === "production" && new URL(webOrigin).origin !== new URL(publicApiUrl).origin) {
    throw new Error("WEB_ORIGIN and PUBLIC_API_URL must use the same public origin in production");
  }
  return {
    nodeEnv,
    host: process.env.HOST ?? "127.0.0.1",
    port: integerEnv("PORT", 3000),
    databasePath: resolve(process.env.DATABASE_PATH ?? "./data/expenses.sqlite"),
    attachmentsPath: resolve(process.env.ATTACHMENTS_PATH ?? "./data/attachments"),
    webOrigin,
    publicApiUrl,
    authSecret,
    devAuthBypass,
    trustCloudflareProxy: booleanEnv("TRUST_CLOUDFLARE_PROXY", false),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(cookieDomain ? { cookieDomain } : {}),
    ...(googleAuth ? { googleAuth } : {}),
    ...(splitwiseOAuth ? { splitwiseOAuth } : {}),
    bootstrapGroupName: process.env.BOOTSTRAP_GROUP_NAME ?? "Shared expenses",
    smtp: {
      enabled: Boolean(smtpUser && smtpPassword),
      host: process.env.SMTP_HOST ?? "smtp.gmail.com",
      port: integerEnv("SMTP_PORT", 465),
      secure: booleanEnv("SMTP_SECURE", true),
      ...(smtpUser ? { user: smtpUser } : {}),
      ...(smtpPassword ? { appPassword: smtpPassword } : {}),
      from: smtpFrom || "Tallied <tally@example.com>",
    },
  };
}
