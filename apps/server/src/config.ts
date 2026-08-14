import { BlockList, isIP } from "node:net";
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
  peerAddress?: string;
  trustCloudflareProxy: boolean;
  trustedProxies: readonly string[];
  production: boolean;
}): string {
  const cloudflareIp = input.cloudflareIp?.trim() ?? "";
  if (
    input.production &&
    input.trustCloudflareProxy &&
    isIP(cloudflareIp) !== 0 &&
    isTrustedProxyAddress(input.peerAddress, input.trustedProxies)
  ) return cloudflareIp;
  return input.production ? "unidentified" : "local-development";
}

interface ProxyNetwork {
  address: string;
  family: "ipv4" | "ipv6";
  prefix?: number;
}

function parseProxyNetwork(entry: string): ProxyNetwork {
  const slash = entry.lastIndexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const familyValue = isIP(address);
  if (familyValue === 0) throw new Error("TRUSTED_PROXY_CIDRS must contain valid IP addresses or CIDR ranges");
  const family = familyValue === 4 ? "ipv4" : "ipv6";
  if (slash === -1) return { address, family };
  const prefixValue = entry.slice(slash + 1);
  if (!/^\d+$/.test(prefixValue)) throw new Error("TRUSTED_PROXY_CIDRS must contain valid IP addresses or CIDR ranges");
  const prefix = Number(prefixValue);
  const maximum = family === "ipv4" ? 32 : 128;
  const minimum = family === "ipv4" ? 24 : 64;
  if (prefix > maximum) throw new Error("TRUSTED_PROXY_CIDRS must contain valid IP addresses or CIDR ranges");
  if (prefix < minimum) {
    if (prefix === 0) throw new Error("TRUSTED_PROXY_CIDRS must not trust every address");
    throw new Error("TRUSTED_PROXY_CIDRS range is too broad; list the proxy addresses or a narrow subnet");
  }
  return { address, family, prefix };
}

export function resolveTrustedProxies(value: string | undefined, enabled: boolean): string[] {
  const configured = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (!enabled && configured.length) {
    throw new Error("TRUSTED_PROXY_CIDRS requires TRUST_CLOUDFLARE_PROXY=true");
  }
  if (enabled && configured.length === 0) {
    throw new Error("TRUST_CLOUDFLARE_PROXY=true requires TRUSTED_PROXY_CIDRS");
  }
  if (configured.length > 32) throw new Error("TRUSTED_PROXY_CIDRS accepts at most 32 addresses or narrow CIDR ranges");
  const unique = [...new Set(configured)];
  for (const entry of unique) {
    if (entry.length > 64) throw new Error("TRUSTED_PROXY_CIDRS must contain valid IP addresses or CIDR ranges");
    parseProxyNetwork(entry);
  }
  return unique;
}

export function isTrustedProxyAddress(peerAddress: string | undefined, trustedProxies: readonly string[]): boolean {
  if (!peerAddress || isIP(peerAddress) === 0 || trustedProxies.length === 0) return false;
  const blockList = new BlockList();
  for (const entry of trustedProxies) {
    const network = parseProxyNetwork(entry);
    if (network.prefix === undefined) blockList.addAddress(network.address, network.family);
    else blockList.addSubnet(network.address, network.prefix, network.family);
  }
  return blockList.check(peerAddress, isIP(peerAddress) === 4 ? "ipv4" : "ipv6");
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function validatedBaseUrl(name: string, value: string, production: boolean): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} cannot contain credentials, a query, or a fragment`);
  }
  const localHttp = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (production && parsed.protocol !== "https:" && !localHttp) {
    throw new Error(`${name} must use HTTPS in production except for a loopback-only local deployment`);
  }
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

export function validateProductionAuthDelivery(input: {
  production: boolean;
  googleEnabled: boolean;
  smtpEnabled: boolean;
  smtpFrom?: string;
}): void {
  if (!input.production) return;
  if (!input.googleEnabled && !input.smtpEnabled) {
    throw new Error("SMTP or Google OAuth must be configured in production");
  }
  if (input.smtpEnabled && !input.smtpFrom?.trim()) {
    throw new Error("SMTP_FROM is required when SMTP delivery is enabled in production");
  }
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
  experimentalConfidentialSync: boolean;
  trustCloudflareProxy: boolean;
  trustedProxies: string[];
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
  const experimentalConfidentialSync = booleanEnv("EXPERIMENTAL_CONFIDENTIAL_SYNC", false);
  if (nodeEnv === "production") validateProductionAuthSecret(authSecret);
  const trustCloudflareProxy = booleanEnv("TRUST_CLOUDFLARE_PROXY", false);
  const trustedProxies = resolveTrustedProxies(process.env.TRUSTED_PROXY_CIDRS, trustCloudflareProxy);

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
  const smtpEnabled = Boolean(smtpUser && smtpPassword);
  validateProductionAuthDelivery({
    production: nodeEnv === "production",
    googleEnabled: Boolean(googleAuth),
    smtpEnabled,
    ...(smtpFrom ? { smtpFrom } : {}),
  });
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
    experimentalConfidentialSync,
    trustCloudflareProxy,
    trustedProxies,
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(cookieDomain ? { cookieDomain } : {}),
    ...(googleAuth ? { googleAuth } : {}),
    ...(splitwiseOAuth ? { splitwiseOAuth } : {}),
    bootstrapGroupName: process.env.BOOTSTRAP_GROUP_NAME ?? "Shared expenses",
    smtp: {
      enabled: smtpEnabled,
      host: process.env.SMTP_HOST ?? "smtp.gmail.com",
      port: integerEnv("SMTP_PORT", 465),
      secure: booleanEnv("SMTP_SECURE", true),
      ...(smtpUser ? { user: smtpUser } : {}),
      ...(smtpPassword ? { appPassword: smtpPassword } : {}),
      from: smtpFrom || "Tallied <tally@example.com>",
    },
  };
}
