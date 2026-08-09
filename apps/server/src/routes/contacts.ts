import type { ApiContext, AuthenticatedRouteRequest, RouteResult } from "../api-context";

export async function handleContactRoutes(
  context: ApiContext,
  { request, url, actorId }: AuthenticatedRouteRequest,
): Promise<RouteResult> {
  const { config, db, contactInvites, http } = context;
  const { json, error, bodyJson, validInviteToken } = http;

  if (url.pathname === "/api/v1/contact-invitations" && request.method === "POST") {
    const invitation = contactInvites.create(actorId);
    const shareUrl = new URL(config.webOrigin);
    shareUrl.hash = new URLSearchParams({ invite: invitation.token }).toString();
    return json(request, {
      id: invitation.id,
      url: shareUrl.toString(),
      expiresAt: invitation.expiresAt,
      ...contactInvites.list(actorId),
    }, 201);
  }

  if (url.pathname === "/api/v1/contacts" && request.method === "GET") {
    return json(request, contactInvites.list(actorId));
  }

  if (url.pathname === "/api/v1/contact-invitations/accept" && request.method === "POST") {
    const body = await bodyJson<{ token?: string }>(request);
    const token = body.token?.trim() ?? "";
    if (!validInviteToken(token)) {
      return error(request, 400, "INVALID_INVITATION", "This invitation link is invalid. Ask the sender for a new one.");
    }
    const user = db.query<{ email: string }, [string]>(`SELECT email FROM "user" WHERE id = ? LIMIT 1`).get(actorId);
    if (!user) return error(request, 401, "UNAUTHENTICATED", "Sign in to continue.");
    contactInvites.acceptForSignedInUser(token, actorId, user.email);
    return json(request, { status: "accepted", ...contactInvites.list(actorId) });
  }

  const invitationMatch = /^\/api\/v1\/contact-invitations\/([^/]+)\/revoke$/.exec(url.pathname);
  if (invitationMatch && request.method === "POST") {
    contactInvites.revoke(actorId, decodeURIComponent(invitationMatch[1]!));
    return json(request, { status: "revoked", ...contactInvites.list(actorId) });
  }

  return null;
}
