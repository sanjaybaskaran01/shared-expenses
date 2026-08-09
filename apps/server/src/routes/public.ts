import type { ApiContext, RouteRequest, RouteResult } from "../api-context";

export async function handlePublicRoutes(
  context: ApiContext,
  { request, url, peerAddress }: RouteRequest,
): Promise<RouteResult> {
  const { config, releaseMetadata, ledger, splitwiseConnector, http } = context;
  const { json, error, bodyJson, validInviteToken, consumeMutation, publicRateKey } = http;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...http.corsHeaders(request),
        "Access-Control-Allow-Headers": "Content-Type, X-Dev-User",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return json(request, { status: "ok", ...releaseMetadata, serverTime: new Date().toISOString() });
  }

  if (url.pathname === "/api/v1/imports/capabilities" && request.method === "GET") {
    return json(request, {
      localFiles: true,
      balanceOnly: true,
      splitwiseOAuth: {
        available: Boolean(config.splitwiseOAuth),
        reason: config.splitwiseOAuth
          ? null
          : "Direct connection requires written Splitwise API approval. You can still use exported CSV or JSON files, or enter balances only.",
      },
      limits: { files: 20, fileBytes: 10_485_760, totalBytes: 52_428_800, rows: 100_000 },
    });
  }

  if (url.pathname === "/api/v1/import-claims/preview" && request.method === "POST") {
    if (!consumeMutation(`claim-preview:${publicRateKey(request, peerAddress)}`, 30, 60 * 60_000)) {
      return error(request, 429, "CLAIM_RATE_LIMITED", "Too many connection checks. Wait a moment, then try again.");
    }
    const body = await bodyJson<{ token?: string }>(request, 2_000);
    const token = body.token?.trim() ?? "";
    if (!validInviteToken(token)) {
      return error(request, 400, "INVALID_CLAIM", "This connection link has expired or is no longer available.");
    }
    try {
      return json(request, ledger.previewImportClaim(token));
    } catch {
      return error(request, 404, "INVALID_CLAIM", "This connection link has expired or is no longer available.");
    }
  }

  if (url.pathname === "/api/v1/imports/splitwise/callback" && request.method === "GET") {
    if (!splitwiseConnector) return error(request, 404, "NOT_FOUND", "Not found");
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const destination = new URL(config.webOrigin);
    if (!consumeMutation(`splitwise-callback:${publicRateKey(request, peerAddress)}`, 60, 60 * 60_000)) {
      destination.hash = new URLSearchParams({ migration: "splitwise-auth-rate-limited" }).toString();
      return new Response(null, {
        status: 303,
        headers: { ...http.securityHeaders(), Location: destination.toString(), "Cache-Control": "no-store" },
      });
    }
    try {
      if (url.searchParams.has("error")) {
        splitwiseConnector.deny(state);
        destination.hash = new URLSearchParams({ migration: "splitwise-auth-cancelled" }).toString();
      } else {
        const completed = await splitwiseConnector.complete(state, code);
        destination.hash = new URLSearchParams({ splitwiseSession: completed.sessionId }).toString();
      }
    } catch {
      destination.hash = new URLSearchParams({ migration: "splitwise-auth-failed" }).toString();
    }
    return new Response(null, {
      status: 303,
      headers: { ...http.securityHeaders(), Location: destination.toString(), "Cache-Control": "no-store" },
    });
  }

  return null;
}
