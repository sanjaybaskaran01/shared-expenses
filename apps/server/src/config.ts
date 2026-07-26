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
  bootstrapGroupName: string;
  smtp: {
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
  if (nodeEnv === "production" && authSecret.includes("development-only")) {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_APP_PASSWORD;
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (nodeEnv === "production" && !ownerEmail) {
    throw new Error("OWNER_EMAIL is required in production");
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
    bootstrapGroupName: process.env.BOOTSTRAP_GROUP_NAME ?? "Shared expenses",
    smtp: {
      host: process.env.SMTP_HOST ?? "smtp.gmail.com",
      port: integerEnv("SMTP_PORT", 465),
      secure: booleanEnv("SMTP_SECURE", true),
      ...(smtpUser ? { user: smtpUser } : {}),
      ...(smtpPassword ? { appPassword: smtpPassword } : {}),
      from: process.env.SMTP_FROM ?? "expenses@example.com",
    },
  };
}
