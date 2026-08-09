import type { ApiHttp, ServerConfig, TalliedAuth } from "./api-context";
import { resolvePublicRateKey } from "./config";

const mutationWindows = new Map<string, number[]>();

export function createApiHttp(config: ServerConfig, auth: TalliedAuth): ApiHttp {
  const corsHeaders = (request: Request): HeadersInit => {
    const origin = request.headers.get("origin");
    if (!origin || origin !== config.webOrigin) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
  };

  const securityHeaders = (): Record<string, string> => ({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Resource-Policy": "same-site",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  });

  const json = (request: Request, value: unknown, status = 200): Response =>
    Response.json(value, {
      status,
      headers: {
        ...corsHeaders(request),
        ...securityHeaders(),
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      },
    });

  const error = (request: Request, status: number, code: string, message: string): Response =>
    json(request, { error: { code, message } }, status);

  const bodyJson = async <T>(request: Request, maxBytes = 1_000_000): Promise<T> => {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) throw new RangeError("Request body is too large");
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) throw new RangeError("Request body is too large");
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new RangeError("Request body must be valid JSON");
    }
  };

  const consumeMutation = (key: string, limit = 30, windowMs = 60 * 60_000): boolean => {
    const cutoff = Date.now() - windowMs;
    if (mutationWindows.size >= 5_000) {
      for (const [candidate, timestamps] of mutationWindows) {
        const active = timestamps.filter((timestamp) => timestamp > cutoff);
        if (active.length === 0) mutationWindows.delete(candidate);
        else mutationWindows.set(candidate, active);
      }
      if (mutationWindows.size >= 5_000 && !mutationWindows.has(key)) return false;
    }
    const recent = (mutationWindows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= limit) {
      mutationWindows.set(key, recent);
      return false;
    }
    recent.push(Date.now());
    mutationWindows.set(key, recent);
    return true;
  };

  const publicRateKey = (request: Request, peerAddress: string | undefined): string => {
    const cloudflareIp = request.headers.get("cf-connecting-ip");
    return resolvePublicRateKey({
      ...(cloudflareIp ? { cloudflareIp } : {}),
      ...(peerAddress ? { peerAddress } : {}),
      trustCloudflareProxy: config.trustCloudflareProxy,
      trustedProxies: config.trustedProxies,
      production: config.nodeEnv === "production",
    });
  };

  const currentActor = async (request: Request): Promise<string | null> => {
    if (config.devAuthBypass) {
      const candidate = request.headers.get("x-dev-user") ?? new URL(request.url).searchParams.get("devUser") ?? "dev-user";
      return /^[a-z][a-z0-9-]{0,47}$/.test(candidate) ? candidate : "dev-user";
    }
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user.emailVerified ? session.user.id : null;
  };

  return {
    corsHeaders,
    securityHeaders,
    json,
    error,
    bodyJson,
    validEmail: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320,
    validInviteToken: (value) => /^[A-Za-z0-9_-]{43}$/.test(value),
    consumeMutation,
    publicRateKey,
    requireActor: async (request) =>
      (await currentActor(request)) ?? error(request, 401, "UNAUTHENTICATED", "Sign in to continue."),
  };
}
