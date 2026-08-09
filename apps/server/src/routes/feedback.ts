import { createHash } from "node:crypto";
import type { ApiContext, AuthenticatedRouteRequest, RouteResult } from "../api-context";
import { enqueueEmail } from "../email";

function safeSubjectLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "a Tallied user";
}

export async function handleFeedbackRoutes(
  context: ApiContext,
  { request, url, actorId }: AuthenticatedRouteRequest,
): Promise<RouteResult> {
  if (url.pathname !== "/api/v1/feedback" || request.method !== "POST") return null;
  const { config, db, http } = context;
  const { json, error, bodyJson } = http;
  const body = await bodyJson<{ category?: string; message?: string; pageUrl?: string }>(request);
  const category = body.category === "bug" || body.category === "idea" ? body.category : null;
  const message = body.message?.trim() ?? "";
  if (!category) return error(request, 400, "INVALID_CATEGORY", "Choose Bug or Idea.");
  if (!message || message.length > 4_000) {
    return error(request, 400, "INVALID_MESSAGE", "Enter a message with no more than 4,000 characters.");
  }
  const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 300) : "";
  if (config.ownerEmail) {
    const actorKey = createHash("sha256").update(actorId).digest("hex").slice(0, 24);
    const recentCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    const recentCount = db
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) AS count FROM email_outbox WHERE idempotency_key LIKE ? AND created_at >= ?",
      )
      .get(`feedback:${actorKey}:%`, recentCutoff)?.count ?? 0;
    if (recentCount >= 5) {
      return error(request, 429, "FEEDBACK_RATE_LIMITED", "Too many feedback messages. Try again shortly.");
    }
    const reporter = db
      .query<{ email: string | null; name: string | null }, [string]>('SELECT email, name FROM "user" WHERE id = ?')
      .get(actorId);
    const reporterLabel = safeSubjectLabel(reporter?.name || reporter?.email || actorId);
    const label = category === "bug" ? "Bug report" : "Feature request";
    const contentKey = createHash("sha256").update(JSON.stringify({ actorId, category, message, pageUrl })).digest("hex");
    enqueueEmail(db, {
      idempotencyKey: `feedback:${actorKey}:${contentKey}`,
      recipient: config.ownerEmail,
      subject: `${label} from ${reporterLabel}`,
      text: [
        message,
        "",
        `— ${reporterLabel}${reporter?.email ? ` (${reporter.email})` : ""}`,
        pageUrl ? `Page: ${pageUrl}` : "",
      ].filter(Boolean).join("\n"),
    });
  }
  return json(request, { status: "received" }, 201);
}
