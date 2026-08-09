import type { ApiContext } from "./api-context";
import { handleAccountRoutes } from "./routes/account";
import { handleAuthRoutes } from "./routes/auth";
import { handleContactRoutes } from "./routes/contacts";
import { handleFeedbackRoutes } from "./routes/feedback";
import { handleGroupRoutes } from "./routes/groups";
import { handleImportRoutes } from "./routes/imports";
import { handleNotificationRoutes } from "./routes/notifications";
import { handlePublicRoutes } from "./routes/public";
import { handleSyncRoutes } from "./routes/sync";

export function createApiRouter(context: ApiContext) {
  return async (request: Request, url: URL, peerAddress: string | undefined): Promise<Response> => {
    const routeRequest = { request, url, peerAddress };
    // Security invariant: only OPTIONS, health/capabilities/claim previews,
    // OAuth callbacks, and Better Auth may run before the verified-actor gate.
    // Every other path fails closed through requireActor before any route handler.
    const publicResponse = await handlePublicRoutes(context, routeRequest);
    if (publicResponse) return publicResponse;
    const authResponse = await handleAuthRoutes(context, routeRequest);
    if (authResponse) return authResponse;

    const actorOrResponse = await context.http.requireActor(request);
    if (actorOrResponse instanceof Response) return actorOrResponse;
    const authenticatedRequest = { ...routeRequest, actorId: actorOrResponse };
    const handlers = [
      handleNotificationRoutes,
      handleImportRoutes,
      handleContactRoutes,
      handleGroupRoutes,
      handleAccountRoutes,
      handleFeedbackRoutes,
      handleSyncRoutes,
    ] as const;
    for (const handler of handlers) {
      const response = await handler(context, authenticatedRequest);
      if (response) return response;
    }
    return context.http.error(request, 404, "NOT_FOUND", "Not found");
  };
}
