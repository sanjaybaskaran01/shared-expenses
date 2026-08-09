import type {
  ConfidentialOperationEnvelope,
  GroupKeyEnvelope,
  JsonValue,
  OperationEnvelope,
  SyncPushRequest,
} from "@expenses/protocol";
import type { ApiContext, AuthenticatedRouteRequest, RouteResult } from "../api-context";
import {
  enqueueOperationNotifications,
  loadAcceptedOperations,
} from "../push-notifications";

export async function handleSyncRoutes(
  context: ApiContext,
  { request, url, actorId }: AuthenticatedRouteRequest,
): Promise<RouteResult> {
  const { db, ledger, confidentialLedger, http, publish } = context;
  const { json, error, bodyJson } = http;

  if (url.pathname === "/api/v1/snapshot" && request.method === "GET") {
    return json(request, { ...ledger.snapshot(actorId), manifest: ledger.manifest(actorId) });
  }

  if (url.pathname === "/api/v1/sync/push" && request.method === "POST") {
    const body = await bodyJson<SyncPushRequest>(request);
    if (!Array.isArray(body.operations)) {
      return error(request, 400, "INVALID_BATCH", "Tallied could not sync these changes. Reload and try again.");
    }
    const result = await ledger.push(actorId, body.operations as OperationEnvelope<JsonValue>[]);
    if (result.accepted.length > 0 || result.duplicates.length > 0) {
      const acknowledgedIds = new Set([...result.accepted, ...result.duplicates].map(({ id }) => id));
      enqueueOperationNotifications(db, loadAcceptedOperations(db, [...acknowledgedIds]));
    }
    if (result.accepted.length > 0) {
      const acceptedIds = new Set(result.accepted.map(({ id }) => id));
      const groupIds = body.operations.filter(({ id }) => acceptedIds.has(id)).map(({ groupId }) => groupId);
      for (const memberId of ledger.activeMemberIdsForGroups(groupIds)) {
        publish(memberId, ledger.latestSequenceFor(memberId));
      }
    }
    return json(request, result);
  }

  if (url.pathname === "/api/v1/sync/pull" && request.method === "GET") {
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    return json(request, {
      operations: ledger.pull(actorId, after),
      generation: ledger.generation,
      latestServerSequence: ledger.latestSequenceFor(actorId),
    });
  }

  if (url.pathname === "/api/v1/sync/manifest" && request.method === "GET") {
    return json(request, ledger.manifest(actorId));
  }

  if (url.pathname === "/api/v2/sync/push" && request.method === "POST") {
    const body = await bodyJson<{ operations?: ConfidentialOperationEnvelope[] }>(request);
    if (!Array.isArray(body.operations) || body.operations.length > 100) {
      return error(request, 400, "INVALID_BATCH", "Sync no more than 100 changes at a time.");
    }
    return json(request, await confidentialLedger.push(actorId, body.operations));
  }

  if (url.pathname === "/api/v2/sync/pull" && request.method === "GET") {
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    return json(request, {
      operations: confidentialLedger.pull(actorId, after),
      latestServerSequence: confidentialLedger.latestSequenceFor(actorId),
    });
  }

  const devicesMatch = /^\/api\/v2\/groups\/([^/]+)\/devices$/.exec(url.pathname);
  if (devicesMatch && request.method === "GET") {
    try {
      return json(request, { devices: confidentialLedger.groupDevices(actorId, decodeURIComponent(devicesMatch[1]!)) });
    } catch {
      return error(request, 403, "NOT_A_GROUP_MEMBER", "You need to be a current group member to do this.");
    }
  }

  const keyEnvelopesMatch = /^\/api\/v2\/groups\/([^/]+)\/key-envelopes$/.exec(url.pathname);
  if (keyEnvelopesMatch && request.method === "GET") {
    try {
      return json(request, {
        envelopes: confidentialLedger.keyEnvelopes(actorId, decodeURIComponent(keyEnvelopesMatch[1]!)),
      });
    } catch {
      return error(request, 403, "NOT_A_GROUP_MEMBER", "You need to be a current group member to do this.");
    }
  }

  if (keyEnvelopesMatch && request.method === "POST") {
    const groupId = decodeURIComponent(keyEnvelopesMatch[1]!);
    const body = await bodyJson<{ envelope?: GroupKeyEnvelope }>(request);
    if (!body.envelope || body.envelope.groupId !== groupId) {
      return error(request, 400, "INVALID_KEY_ENVELOPE", "This device is missing the group encryption key. Reload and try again.");
    }
    try {
      const status = await confidentialLedger.putKeyEnvelope(actorId, body.envelope);
      return json(request, { status }, status === "created" ? 201 : 200);
    } catch {
      return error(request, 400, "INVALID_KEY_ENVELOPE", "Tallied could not verify the group encryption key. Reload and try again.");
    }
  }

  if (url.pathname === "/api/v1/sync/events" && request.method === "GET") {
    return new Response(context.createEventStream(actorId), {
      headers: {
        ...http.corsHeaders(request),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return null;
}
