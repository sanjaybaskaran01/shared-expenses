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

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
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
  ownerEmail?: string;
  cookieDomain?: string;
  googleAuth?: GoogleAuthConfig;
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
  if (Boolean(smtpUser) !== Boolean(smtpPassword)) {
    throw new Error("SMTP_USER and SMTP_APP_PASSWORD must be configured together");
  }
  if (nodeEnv === "production" && !ownerEmail) {
    throw new Error("OWNER_EMAIL is required in production");
  }
  if (nodeEnv === "production" && !smtpFrom) {
    throw new Error("SMTP_FROM is required in production");
  }
  return {
    nodeEnv,
    host: process.env.HOST ?? "127.0.0.1",
    port: integerEnv("PORT", 3000),
    databasePath: resolve(process.env.DATABASE_PATH ?? "./data/expenses.sqlite"),
    attachmentsPath: resolve(process.env.ATTACHMENTS_PATH ?? "./data/attachments"),
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    publicApiUrl: process.env.PUBLIC_API_URL ?? "http://localhost:3000",
    authSecret,
    devAuthBypass,
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(cookieDomain ? { cookieDomain } : {}),
    ...(googleAuth ? { googleAuth } : {}),
    bootstrapGroupName: process.env.BOOTSTRAP_GROUP_NAME ?? "Shared expenses",
    smtp: {
      enabled: Boolean(smtpUser && smtpPassword),
      host: process.env.SMTP_HOST ?? "smtp.gmail.com",
      port: integerEnv("SMTP_PORT", 465),
      secure: booleanEnv("SMTP_SECURE", true),
      ...(smtpUser ? { user: smtpUser } : {}),
      ...(smtpPassword ? { appPassword: smtpPassword } : {}),
      from: smtpFrom || "Tally <tally@example.com>",
    },
  };
}
