import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isOperationType, type JsonValue, type OperationEnvelope } from "@expenses/protocol";
import * as webPush from "web-push";
import { decryptServerValue, encryptServerValue, keyedDigest } from "./security-keys";

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface VapidIdentity {
  publicKey: string;
  privateKey: string;
}

export interface DerivedNotification {
  actorId: string;
  kind: "expense-created" | "expense-updated" | "payment-recorded";
  title: string;
  body: string;
  targetUrl: string;
}

interface NotificationContext {
  groupName: string;
  actorName: string;
  memberName?(actorId: string): string;
}

interface ParticipantAmount {
  participantId: string;
  amountMinor: number;
}

interface DeliveryRow {
  id: string;
  subscription_id: string;
  device_id: string;
  encrypted_subscription: string;
  attempts: number;
  actor_id: string;
  group_id: string;
  notification_id: string;
  title: string;
  body: string;
  kind: string;
  target_url: string;
}

export interface PushDeliveryOptions {
  authSecret: string;
  vapid: VapidIdentity & { subject: string };
  send?: (subscription: BrowserPushSubscription, payload: string) => Promise<unknown>;
}

function participantAmounts(value: JsonValue | undefined): ParticipantAmount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const participantId = entry.participantId;
    const amountMinor = entry.amountMinor;
    return typeof participantId === "string" && Number.isSafeInteger(amountMinor) && Number(amountMinor) >= 0
      ? [{ participantId, amountMinor: Number(amountMinor) }]
      : [];
  });
}

function money(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return label || fallback;
}

export function deriveOperationNotifications(
  operation: OperationEnvelope,
  context: NotificationContext,
  previousOperation?: OperationEnvelope,
): DerivedNotification[] {
  const payload = operation.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const values = payload as Record<string, JsonValue>;
  const targetUrl = `/?view=activity&group=${encodeURIComponent(operation.groupId)}`;

  if (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended") {
    const payers = new Map(participantAmounts(values.payers).map((item) => [item.participantId, item.amountMinor]));
    const allocations = new Map(participantAmounts(values.allocations).map((item) => [item.participantId, item.amountMinor]));
    const previousValues = previousOperation?.payload && typeof previousOperation.payload === "object" &&
      !Array.isArray(previousOperation.payload)
      ? previousOperation.payload as Record<string, JsonValue>
      : undefined;
    const previousPayers = new Map(participantAmounts(previousValues?.payers).map((item) => [item.participantId, item.amountMinor]));
    const previousAllocations = new Map(participantAmounts(previousValues?.allocations).map((item) => [item.participantId, item.amountMinor]));
    const recipients = new Set([
      ...payers.keys(),
      ...allocations.keys(),
      ...previousPayers.keys(),
      ...previousAllocations.keys(),
    ]);
    const description = safeLabel(values.description, "an expense");
    const currency = safeLabel(values.currency, "USD").toUpperCase().slice(0, 3);
    const kind = operation.type === "ExpenseCreated" ? "expense-created" : "expense-updated";
    const action = operation.type === "ExpenseCreated" ? "added" : "updated";
    return [...recipients].flatMap((actorId): DerivedNotification[] => {
      if (actorId === operation.actorId) return [];
      const netMinor = (allocations.get(actorId) ?? 0) - (payers.get(actorId) ?? 0);
      const previousNetMinor = (previousAllocations.get(actorId) ?? 0) - (previousPayers.get(actorId) ?? 0);
      if (netMinor === 0 && previousNetMinor === 0) return [];
      return [{
        actorId,
        kind,
        title: `${context.actorName} ${action} ${description}`,
        body: netMinor > 0
          ? `You owe ${money(netMinor, currency)} in ${context.groupName}.`
          : netMinor < 0
            ? `You’re owed ${money(-netMinor, currency)} in ${context.groupName}.`
            : `You’re no longer included in ${description} in ${context.groupName}.`,
        targetUrl,
      }];
    });
  }

  if (operation.type === "PaymentRecorded") {
    const payerId = typeof values.payerId === "string" ? values.payerId : "";
    const recipientId = typeof values.recipientId === "string" ? values.recipientId : "";
    const amountMinor = Number(values.amountMinor);
    const currency = safeLabel(values.currency, "USD").toUpperCase().slice(0, 3);
    if (!payerId || !recipientId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return [];
    const payerName = context.memberName?.(payerId) ?? (payerId === operation.actorId ? context.actorName : "Someone");
    const recipientName = context.memberName?.(recipientId) ?? (recipientId === operation.actorId ? context.actorName : "someone");
    return [...new Set([payerId, recipientId])].flatMap((actorId): DerivedNotification[] => {
      if (actorId === operation.actorId) return [];
      const body = actorId === recipientId
        ? `${payerName} paid you ${money(amountMinor, currency)} in ${context.groupName}.`
        : `A ${money(amountMinor, currency)} payment to ${recipientName} was recorded in ${context.groupName}.`;
      return [{
        actorId,
        kind: "payment-recorded",
        title: `${context.actorName} recorded a payment`,
        body,
        targetUrl,
      }];
    });
  }

  return [];
}

export function ensureVapidKeys(
  db: Database,
  authSecret: string,
  generate: () => VapidIdentity = webPush.generateVAPIDKeys,
): VapidIdentity {
  const publicKey = db.query<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?")
    .get("push_vapid_public_key")?.value;
  const encryptedPrivateKey = db.query<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?")
    .get("push_vapid_private_key")?.value;
  if (publicKey && encryptedPrivateKey) {
    return {
      publicKey,
      privateKey: decryptServerValue(authSecret, "push-vapid-private", encryptedPrivateKey),
    };
  }
  const generated = generate();
  db.transaction(() => {
    db.query("INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)").run("push_vapid_public_key", generated.publicKey);
    db.query("INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)").run(
      "push_vapid_private_key",
      encryptServerValue(authSecret, "push-vapid-private", generated.privateKey),
    );
  })();
  return generated;
}

function validatePushEndpoint(value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new RangeError("The push subscription endpoint is invalid");
  }
  if (endpoint.protocol !== "https:" || value.length > 2_048) {
    throw new RangeError("The push subscription endpoint must use HTTPS");
  }
  const host = endpoint.hostname.toLowerCase();
  const trustedPushService = host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".notify.windows.com");
  if (endpoint.username || endpoint.password || endpoint.port || !trustedPushService) {
    throw new RangeError("The push subscription endpoint is not a recognized browser push service");
  }
}

function validateSubscription(subscription: BrowserPushSubscription): void {
  if (!subscription || typeof subscription !== "object" || typeof subscription.endpoint !== "string" ||
      !subscription.keys || typeof subscription.keys !== "object" ||
      typeof subscription.keys.p256dh !== "string" || typeof subscription.keys.auth !== "string") {
    throw new RangeError("The push subscription is incomplete");
  }
  validatePushEndpoint(subscription.endpoint);
  for (const key of [subscription.keys.p256dh, subscription.keys.auth]) {
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(key)) throw new RangeError("The push subscription keys are invalid");
  }
  if (subscription.expirationTime !== null && (!Number.isFinite(subscription.expirationTime) || subscription.expirationTime <= 0)) {
    throw new RangeError("The push subscription expiration is invalid");
  }
}

export function registerPushSubscription(
  db: Database,
  authSecret: string,
  actorId: string,
  deviceId: string,
  subscription: BrowserPushSubscription,
): void {
  validateSubscription(subscription);
  const device = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM devices WHERE id = ? AND user_id = ? AND status = 'active'",
  ).get(deviceId, actorId);
  if (!device) throw new RangeError("An active device registration is required");
  const endpointHash = keyedDigest(authSecret, "push-endpoint", subscription.endpoint);
  const existingId = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM push_subscriptions WHERE actor_id = ? AND device_id = ?",
  ).get(actorId, deviceId)?.id;
  const id = existingId ?? randomUUID();
  const now = new Date().toISOString();
  const encrypted = encryptServerValue(authSecret, `push-subscription:${id}`, JSON.stringify(subscription));
  db.transaction(() => {
    db.query("DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND id <> ?").run(endpointHash, id);
    db.query(
      `INSERT INTO push_subscriptions(
         id, actor_id, device_id, endpoint_hash, encrypted_subscription,
         status, created_at, updated_at, disabled_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(actor_id, device_id) DO UPDATE SET
         endpoint_hash = excluded.endpoint_hash,
         encrypted_subscription = excluded.encrypted_subscription,
         status = 'active', updated_at = excluded.updated_at, disabled_at = NULL`,
    ).run(id, actorId, deviceId, endpointHash, encrypted, now, now);
  })();
}

export function refreshPushSubscription(
  db: Database,
  authSecret: string,
  actorId: string,
  oldEndpoint: string,
  subscription: BrowserPushSubscription,
): void {
  validatePushEndpoint(oldEndpoint);
  validateSubscription(subscription);
  const oldEndpointHash = keyedDigest(authSecret, "push-endpoint", oldEndpoint);
  const existing = db.query<{ device_id: string }, [string, string]>(
    `SELECT device_id FROM push_subscriptions
     WHERE actor_id = ? AND endpoint_hash = ? AND status = 'active'`,
  ).get(actorId, oldEndpointHash);
  if (!existing) throw new RangeError("An active push subscription is required");
  registerPushSubscription(db, authSecret, actorId, existing.device_id, subscription);
}

export function revokePushSubscription(db: Database, actorId: string, deviceId: string): boolean {
  const result = db.query(
    `UPDATE push_subscriptions SET status = 'revoked', disabled_at = ?, updated_at = ?
     WHERE actor_id = ? AND device_id = ? AND status = 'active'`,
  ).run(new Date().toISOString(), new Date().toISOString(), actorId, deviceId);
  if (result.changes > 0) redactUnreadIfNoActiveSubscriptions(db, actorId);
  return result.changes > 0;
}

export function pushSubscriptionStatus(
  db: Database,
  actorId: string,
  deviceId: string,
): { subscribed: boolean } {
  const row = db.query<{ status: string }, [string, string]>(
    `SELECT s.status FROM push_subscriptions s
     JOIN devices d ON d.id = s.device_id AND d.user_id = s.actor_id AND d.status = 'active'
     WHERE s.actor_id = ? AND s.device_id = ?`,
  ).get(actorId, deviceId);
  return { subscribed: row?.status === "active" };
}

export function enqueueOperationNotifications(
  db: Database,
  operations: readonly OperationEnvelope[],
): number {
  let inserted = 0;
  db.transaction(() => {
    for (const operation of operations) {
      const group = db.query<{ name: string }, [string]>("SELECT name FROM groups WHERE id = ? AND deleted_at IS NULL")
        .get(operation.groupId);
      const members = db.query<{ user_id: string; display_name: string }, [string]>(
        "SELECT user_id, display_name FROM group_members WHERE group_id = ? AND status = 'active'",
      ).all(operation.groupId);
      const memberNames = new Map(members.map((member) => [member.user_id, member.display_name]));
      const actorName = memberNames.get(operation.actorId);
      if (!group || !actorName) continue;
      const previousOperation = operation.type === "ExpenseAmended" && Number.isSafeInteger(operation.serverSequence)
        ? (() => {
            const previous = db.query<{ id: string }, [string, string, number]>(
              `SELECT id FROM operations
               WHERE group_id = ? AND target_id = ? AND status = 'accepted'
                 AND type IN ('ExpenseCreated', 'ExpenseAmended') AND server_sequence < ?
               ORDER BY server_sequence DESC LIMIT 1`,
            ).get(operation.groupId, operation.targetId, Number(operation.serverSequence));
            return previous ? loadAcceptedOperations(db, [previous.id])[0] : undefined;
          })()
        : undefined;
      for (const notification of deriveOperationNotifications(operation, {
        groupName: safeLabel(group.name, "your group"),
        actorName: safeLabel(actorName, "Someone"),
        memberName: (actorId) => safeLabel(memberNames.get(actorId), "Someone"),
      }, previousOperation)) {
        if (!memberNames.has(notification.actorId)) continue;
        const subscriptions = db.query<{ id: string }, [string]>(
          "SELECT id FROM push_subscriptions WHERE actor_id = ? AND status = 'active'",
        ).all(notification.actorId);
        if (subscriptions.length === 0) continue;
        const id = randomUUID();
        const now = new Date().toISOString();
        const result = db.query(
          `INSERT OR IGNORE INTO notifications(
             id, actor_id, source_operation_id, kind, group_id, title, body, target_url, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          notification.actorId,
          operation.id,
          notification.kind,
          operation.groupId,
          notification.title,
          notification.body,
          notification.targetUrl,
          now,
        );
        if (result.changes === 0) continue;
        inserted += 1;
        for (const subscription of subscriptions) {
          db.query(
            `INSERT OR IGNORE INTO push_deliveries(
               id, notification_id, subscription_id, status, attempts, next_attempt_at, created_at
             ) VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
          ).run(randomUUID(), id, subscription.id, now, now);
        }
      }
    }
  })();
  return inserted;
}

interface StoredOperationRow {
  server_sequence: number;
  id: string;
  group_id: string;
  actor_id: string;
  device_id: string;
  type: string;
  target_id: string;
  base_version: number;
  client_timestamp: string;
  payload_json: string;
  content_hash: string;
  signature: string;
  received_at: string;
}

export function loadAcceptedOperations(db: Database, ids: readonly string[]): OperationEnvelope[] {
  const query = db.query<StoredOperationRow, [string]>(
    `SELECT server_sequence, id, group_id, actor_id, device_id, type, target_id,
            base_version, client_timestamp, payload_json, content_hash, signature, received_at
     FROM operations WHERE id = ? AND status = 'accepted'`,
  );
  return ids.flatMap((id): OperationEnvelope[] => {
    const row = query.get(id);
    if (!row || !isOperationType(row.type)) return [];
    return [{
      id: row.id,
      groupId: row.group_id,
      actorId: row.actor_id,
      deviceId: row.device_id,
      type: row.type,
      targetId: row.target_id,
      baseVersion: row.base_version,
      clientTimestamp: row.client_timestamp,
      payload: JSON.parse(row.payload_json) as JsonValue,
      contentHash: row.content_hash,
      signature: row.signature,
      serverSequence: row.server_sequence,
      receivedAt: row.received_at,
    }];
  });
}

export function markNotificationsRead(db: Database, actorId: string): number {
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE notifications
     SET read_at = ?, title = '[read]', body = '[read]', target_url = '/'
     WHERE actor_id = ? AND read_at IS NULL`,
  ).run(now, actorId);
  db.query(
    `UPDATE push_deliveries SET status = 'skipped', last_error_code = 'READ_IN_APP'
     WHERE status IN ('pending', 'sending', 'failed') AND notification_id IN (
       SELECT id FROM notifications WHERE actor_id = ? AND read_at IS NOT NULL
     )`,
  ).run(actorId);
  return result.changes;
}

function redactUnreadIfNoActiveSubscriptions(db: Database, actorId: string): void {
  const active = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM push_subscriptions WHERE actor_id = ? AND status = 'active'",
  ).get(actorId)?.count ?? 0;
  if (active === 0) markNotificationsRead(db, actorId);
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

export async function runPushDeliveryPass(db: Database, options: PushDeliveryOptions): Promise<boolean> {
  const row = db.query<DeliveryRow, [string]>(
    `SELECT d.id, d.subscription_id, d.attempts, s.device_id, s.encrypted_subscription,
            n.actor_id, n.group_id, n.id AS notification_id, n.title, n.body, n.kind, n.target_url
     FROM push_deliveries d
     JOIN push_subscriptions s ON s.id = d.subscription_id AND s.status = 'active'
     JOIN notifications n ON n.id = d.notification_id AND n.read_at IS NULL
     WHERE d.status IN ('pending', 'sending', 'failed') AND d.next_attempt_at <= ? AND d.attempts < 8
     ORDER BY d.created_at LIMIT 1`,
  ).get(new Date().toISOString());
  if (!row) return false;
  const activeDevice = db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM devices WHERE id = ? AND user_id = ? AND status = 'active'",
  ).get(row.device_id, row.actor_id);
  if (!activeDevice) {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.query("UPDATE push_subscriptions SET status = 'revoked', disabled_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, row.subscription_id);
      db.query("UPDATE push_deliveries SET status = 'skipped', last_error_code = 'DEVICE_REVOKED' WHERE id = ?")
        .run(row.id);
    })();
    redactUnreadIfNoActiveSubscriptions(db, row.actor_id);
    return true;
  }
  const activeMembership = db.query<{ one: number }, [string, string]>(
    `SELECT 1 AS one FROM group_members
     WHERE group_id = ? AND user_id = ? AND status = 'active'`,
  ).get(row.group_id, row.actor_id);
  if (!activeMembership) {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.query(
        "UPDATE push_deliveries SET status = 'skipped', last_error_code = 'MEMBERSHIP_REMOVED' WHERE id = ?",
      ).run(row.id);
      db.query(
        `UPDATE notifications
         SET read_at = ?, title = '[read]', body = '[read]', target_url = '/'
         WHERE id = ?`,
      ).run(now, row.notification_id);
    })();
    return true;
  }
  let subscription: BrowserPushSubscription;
  try {
    subscription = JSON.parse(
      decryptServerValue(options.authSecret, `push-subscription:${row.subscription_id}`, row.encrypted_subscription),
    ) as BrowserPushSubscription;
    validateSubscription(subscription);
  } catch {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.query("UPDATE push_subscriptions SET status = 'expired', disabled_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, row.subscription_id);
      db.query("UPDATE push_deliveries SET status = 'skipped', last_error_code = 'INVALID_SUBSCRIPTION' WHERE id = ?")
        .run(row.id);
    })();
    redactUnreadIfNoActiveSubscriptions(db, row.actor_id);
    return true;
  }
  const badgeCount = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM notifications WHERE actor_id = ? AND read_at IS NULL",
  ).get(row.actor_id)?.count ?? 1;
  const payload = JSON.stringify({
    title: row.title,
    body: row.body,
    url: row.target_url,
    tag: `${row.kind}:${row.notification_id}`,
    badgeCount,
  });
  db.query(
    "UPDATE push_deliveries SET status = 'sending', attempts = attempts + 1, next_attempt_at = ? WHERE id = ?",
  ).run(new Date(Date.now() + 5 * 60_000).toISOString(), row.id);
  try {
    if (options.send) {
      await options.send(subscription, payload);
    } else {
      await webPush.sendNotification(subscription, payload, {
        TTL: 86_400,
        urgency: "normal",
        vapidDetails: options.vapid,
      });
    }
    db.query(
      "UPDATE push_deliveries SET status = 'sent', sent_at = ?, last_error_code = NULL WHERE id = ?",
    ).run(new Date().toISOString(), row.id);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 404 || status === 410) {
      const now = new Date().toISOString();
      db.transaction(() => {
        db.query("UPDATE push_subscriptions SET status = 'expired', disabled_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, row.subscription_id);
        db.query("UPDATE push_deliveries SET status = 'skipped', last_error_code = ? WHERE id = ?")
          .run(`PUSH_${status}`, row.id);
      })();
      redactUnreadIfNoActiveSubscriptions(db, row.actor_id);
    } else {
      const attempts = row.attempts + 1;
      const delayMinutes = Math.min(2 ** attempts, 360);
      db.query(
        "UPDATE push_deliveries SET status = 'failed', next_attempt_at = ?, last_error_code = ? WHERE id = ?",
      ).run(
        new Date(Date.now() + delayMinutes * 60_000).toISOString(),
        status ? `PUSH_${status}` : error instanceof Error ? error.name.slice(0, 100) : "PUSH_ERROR",
        row.id,
      );
    }
  }
  return true;
}

export function startPushWorker(db: Database, options: PushDeliveryOptions): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (await runPushDeliveryPass(db, options)) {
        // Drain ready deliveries while keeping only one sender active per process.
      }
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void tick(), 5_000);
  void tick();
  return () => clearInterval(interval);
}
