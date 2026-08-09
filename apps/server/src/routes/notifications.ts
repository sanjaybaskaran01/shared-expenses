import {
  markNotificationsRead,
  pushSubscriptionStatus,
  refreshPushSubscription,
  registerPushSubscription,
  revokePushSubscription,
  type BrowserPushSubscription,
} from "../push-notifications";
import type { ApiContext, AuthenticatedRouteRequest, RouteResult } from "../api-context";

export async function handleNotificationRoutes(
  context: ApiContext,
  { request, url, actorId }: AuthenticatedRouteRequest,
): Promise<RouteResult> {
  const { db, config, vapid, http } = context;
  const { json, error, bodyJson } = http;

  if (url.pathname === "/api/v1/push/config" && request.method === "GET") {
    const deviceId = url.searchParams.get("deviceId")?.trim() ?? "";
    if (!deviceId || deviceId.length > 100) {
      return error(request, 400, "INVALID_DEVICE", "Reload Tallied to register this device, then try again.");
    }
    return json(request, { publicKey: vapid.publicKey, ...pushSubscriptionStatus(db, actorId, deviceId) });
  }

  if (url.pathname === "/api/v1/push/subscriptions" && request.method === "POST") {
    const body = await bodyJson<{ deviceId?: string; subscription?: BrowserPushSubscription }>(request, 8_000);
    const deviceId = body.deviceId?.trim() ?? "";
    if (!deviceId || deviceId.length > 100 || !body.subscription) {
      return error(request, 400, "INVALID_SUBSCRIPTION", "Reload Tallied, then turn on notifications again.");
    }
    registerPushSubscription(db, config.authSecret, actorId, deviceId, body.subscription);
    return json(request, { subscribed: true }, 201);
  }

  if (url.pathname === "/api/v1/push/subscriptions" && request.method === "DELETE") {
    const body = await bodyJson<{ deviceId?: string }>(request, 2_000);
    const deviceId = body.deviceId?.trim() ?? "";
    if (!deviceId || deviceId.length > 100) {
      return error(request, 400, "INVALID_DEVICE", "Reload Tallied to register this device, then try again.");
    }
    revokePushSubscription(db, actorId, deviceId);
    return json(request, { subscribed: false });
  }

  if (url.pathname === "/api/v1/push/subscriptions/refresh" && request.method === "POST") {
    const body = await bodyJson<{ oldEndpoint?: string; subscription?: BrowserPushSubscription }>(request, 8_000);
    const oldEndpoint = body.oldEndpoint?.trim() ?? "";
    if (!oldEndpoint || !body.subscription) {
      return error(
        request,
        400,
        "INVALID_SUBSCRIPTION",
        "Tallied could not refresh notifications. Turn them off, then on again.",
      );
    }
    refreshPushSubscription(db, config.authSecret, actorId, oldEndpoint, body.subscription);
    return json(request, { subscribed: true });
  }

  if (url.pathname === "/api/v1/notifications/read" && request.method === "POST") {
    return json(request, { read: markNotificationsRead(db, actorId) });
  }

  return null;
}
