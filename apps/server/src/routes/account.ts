import type { ApiContext, AuthenticatedRouteRequest, RouteResult } from "../api-context";

export async function handleAccountRoutes(
  context: ApiContext,
  { request, url, actorId }: AuthenticatedRouteRequest,
): Promise<RouteResult> {
  const { config, db, ledger, http } = context;
  const { json, error, bodyJson } = http;

  if (url.pathname === "/api/v1/dev/bootstrap" && request.method === "POST") {
    if (!config.devAuthBypass) return error(request, 404, "NOT_FOUND", "Not found");
    const body = await bodyJson<{
      groupId?: string;
      groupName?: string;
      displayName?: string;
      friendId?: string;
      friendName?: string;
    }>(request);
    const groupId = body.groupId ?? "dev-group";
    ledger.bootstrapGroup({
      id: groupId,
      name: body.groupName ?? "Weekend trip",
      settlementCurrency: "USD",
      userId: actorId,
      displayName: body.displayName ?? "You",
    });
    const friendId = body.friendId ?? "dev-friend";
    db.query(
      `INSERT OR IGNORE INTO group_members(group_id, user_id, display_name, status, joined_at)
       VALUES (?, ?, ?, 'active', ?)`,
    ).run(groupId, friendId, body.friendName ?? "Alex", new Date().toISOString());
    return json(request, { groupId, actorId, friendId }, 201);
  }

  if (url.pathname === "/api/v1/devices/register" && request.method === "POST") {
    const body = await bodyJson<{
      id: string;
      publicKeyJwk: JsonWebKey;
      encryptionPublicKeyJwk?: JsonWebKey;
      name: string;
    }>(request);
    if (
      !body.id || body.id.length > 100 ||
      !body.name || body.name.length > 100 ||
      !body.publicKeyJwk || body.publicKeyJwk.kty !== "EC" || body.publicKeyJwk.crv !== "P-256" ||
      (body.encryptionPublicKeyJwk &&
        (body.encryptionPublicKeyJwk.kty !== "EC" || body.encryptionPublicKeyJwk.crv !== "P-256"))
    ) {
      return error(request, 400, "INVALID_DEVICE", "Unable to register this device. Reload Tallied and try again.");
    }
    ledger.registerDevice({
      id: body.id,
      userId: actorId,
      publicKeyJwk: body.publicKeyJwk,
      ...(body.encryptionPublicKeyJwk ? { encryptionPublicKeyJwk: body.encryptionPublicKeyJwk } : {}),
      name: body.name,
    });
    return json(request, { id: body.id, status: "active" }, 201);
  }

  return null;
}
