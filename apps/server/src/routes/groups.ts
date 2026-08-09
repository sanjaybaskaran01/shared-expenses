import type { ApiContext, AuthenticatedRouteRequest, RouteResult } from "../api-context";
import { createGroupInvitation } from "../group-invitations";

export async function handleGroupRoutes(
  context: ApiContext,
  { request, url, actorId }: AuthenticatedRouteRequest,
): Promise<RouteResult> {
  const { config, db, auth, http } = context;
  const { json, error, bodyJson, validEmail } = http;

  const invitationMatch = /^\/api\/v1\/groups\/([^/]+)\/invitations$/.exec(url.pathname);
  if (invitationMatch && request.method === "POST") {
    const groupId = decodeURIComponent(invitationMatch[1]!);
    const body = await bodyJson<{ email?: string }>(request);
    const email = body.email?.trim().toLowerCase() ?? "";
    if (!validEmail(email)) return error(request, 400, "INVALID_EMAIL", "Enter a valid email address.");
    const invitation = await createGroupInvitation({
      db,
      actorId,
      groupId,
      email,
      webOrigin: config.webOrigin,
      smtpEnabled: config.smtp.enabled,
      googleEnabled: Boolean(config.googleAuth),
      sendMagicLink: async ({ email: recipient, displayName, invitationId }) => {
        await auth.api.signInMagicLink({
          headers: request.headers,
          body: {
            email: recipient,
            name: displayName,
            callbackURL: config.webOrigin,
            newUserCallbackURL: config.webOrigin,
            errorCallbackURL: `${config.webOrigin}/?auth=failed`,
            metadata: { invitationId },
          },
        });
      },
    });
    return json(request, invitation, 201);
  }

  return null;
}
