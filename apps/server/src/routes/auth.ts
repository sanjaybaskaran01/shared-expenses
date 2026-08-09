import { authRequestForPeer, deriveDisplayNameFromEmail } from "../auth";
import type { ApiContext, RouteRequest, RouteResult } from "../api-context";

export async function handleAuthRoutes(
  context: ApiContext,
  { request, url, peerAddress }: RouteRequest,
): Promise<RouteResult> {
  const { config, auth, contactInvites, ledger, http } = context;
  const { json, error, bodyJson, validEmail, validInviteToken, consumeMutation, publicRateKey } = http;

  if (url.pathname === "/api/v1/auth/capabilities" && request.method === "GET") {
    return json(request, { google: Boolean(config.googleAuth), magicLink: config.smtp.enabled });
  }
  if (
    (url.pathname === "/api/v1/import-claims/reserve" || url.pathname === "/api/v1/import-claims/email") &&
    request.method === "POST"
  ) {
    if (!consumeMutation(`claim-auth:${publicRateKey(request, peerAddress)}`, 15, 60 * 60_000)) {
      return error(request, 429, "CLAIM_RATE_LIMITED", "Too many connection attempts. Wait a moment, then try again.");
    }
    const body = await bodyJson<{ token?: string; email?: string }>(request, 4_000);
    const token = body.token?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!validInviteToken(token) || !validEmail(email)) {
      return error(request, 400, "INVALID_CLAIM", "Enter a valid email address and use the full connection link.");
    }
    if (url.pathname.endsWith("/email") && !config.smtp.enabled) {
      return error(request, 503, "EMAIL_NOT_CONFIGURED", "Email verification is unavailable. Try Google sign-in instead.");
    }
    try {
      const reservation = ledger.reserveImportClaimEmail(token, email);
      if (url.pathname.endsWith("/email")) {
        const callback = new URL(config.webOrigin);
        callback.hash = new URLSearchParams({ migrationClaim: token }).toString();
        const failure = new URL(config.webOrigin);
        failure.searchParams.set("auth", "failed");
        failure.hash = callback.hash;
        await auth.api.signInMagicLink({
          headers: request.headers,
          body: {
            email,
            name: deriveDisplayNameFromEmail(email),
            callbackURL: callback.toString(),
            newUserCallbackURL: callback.toString(),
            errorCallbackURL: failure.toString(),
            metadata: { migrationClaim: true },
          },
        });
        return json(request, { status: "verification-sent", expiresAt: reservation.expiresAt }, 202);
      }
      return json(request, reservation, 201);
    } catch (cause) {
      return error(
        request,
        400,
        "CLAIM_RESERVATION_REJECTED",
        cause instanceof Error ? cause.message : "This connection is unavailable. Ask for a new link.",
      );
    }
  }

  if (url.pathname === "/api/v1/contact-invitations/claim" && request.method === "POST") {
    if (!config.smtp.enabled) {
      return error(request, 503, "EMAIL_NOT_CONFIGURED", "Email verification is unavailable. Try Google sign-in instead.");
    }
    const body = await bodyJson<{ token?: string; email?: string }>(request);
    const token = body.token?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!validInviteToken(token)) {
      return error(request, 400, "INVALID_INVITATION", "This invitation link has expired or is no longer available.");
    }
    if (!validEmail(email)) return error(request, 400, "INVALID_EMAIL", "Enter a valid email address.");
    const reservation = contactInvites.reserve(token, email);
    await auth.api.signInMagicLink({
      headers: request.headers,
      body: {
        email,
        name: deriveDisplayNameFromEmail(email),
        callbackURL: config.webOrigin,
        newUserCallbackURL: config.webOrigin,
        errorCallbackURL: `${config.webOrigin}/?auth=failed`,
        metadata: { contactInvitationId: reservation.invitationId },
      },
    });
    return json(request, { status: "verification-sent" }, 202);
  }

  if (url.pathname === "/api/v1/contact-invitations/reserve" && request.method === "POST") {
    if (!config.googleAuth) {
      return error(request, 503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is unavailable on this Tallied installation.");
    }
    const body = await bodyJson<{ token?: string; email?: string }>(request);
    const token = body.token?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!validInviteToken(token)) {
      return error(request, 400, "INVALID_INVITATION", "This invitation link has expired or is no longer available.");
    }
    if (!validEmail(email)) return error(request, 400, "INVALID_EMAIL", "Enter a valid email address.");
    const reservation = contactInvites.reserve(token, email);
    return json(request, { status: "reserved", invitationId: reservation.invitationId }, 201);
  }

  if (url.pathname.startsWith("/api/auth/")) {
    const response = await auth.handler(authRequestForPeer(request, config, peerAddress));
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(http.corsHeaders(request))) headers.set(key, value);
    for (const [key, value] of Object.entries(http.securityHeaders())) headers.set(key, value);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }


  return null;
}
