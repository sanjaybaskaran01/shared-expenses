import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OperationEnvelope } from "@expenses/protocol";
import {
  deriveOperationNotifications,
  enqueueOperationNotifications,
  ensureVapidKeys,
  markNotificationsRead,
  pushSubscriptionStatus,
  refreshPushSubscription,
  registerPushSubscription,
  revokePushSubscription,
  runPushDeliveryPass,
} from "../src/push-notifications";

const secret = "a-test-secret-that-is-long-enough-for-encryption";
const browserSubscription = {
  endpoint: "https://web.push.apple.com/subscription/device-2",
  expirationTime: null,
  keys: { p256dh: "p256dh-key-material", auth: "auth-key-material" },
};

function expenseOperation(): OperationEnvelope {
  return {
    id: "operation-1",
    groupId: "group-1",
    actorId: "user-1",
    deviceId: "device-1",
    type: "ExpenseCreated",
    targetId: "expense-1",
    baseVersion: 0,
    clientTimestamp: "2026-08-07T10:00:00.000Z",
    payload: {
      description: "Dinner",
      category: "Dining out",
      amountMinor: 1000,
      currency: "USD",
      expenseDate: "2026-08-07",
      notes: "",
      payers: [{ participantId: "user-1", amountMinor: 1000 }],
      allocations: [
        { participantId: "user-1", amountMinor: 500 },
        { participantId: "user-2", amountMinor: 500 },
      ],
    },
    contentHash: "hash",
    signature: "signature",
  };
}

describe("push notifications", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/001_domain.sql"), "utf8"));
    db.exec(readFileSync(resolve(import.meta.dir, "../migrations/008_push_notifications.sql"), "utf8"));
    db.query("INSERT INTO groups(id, name, settlement_currency, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("group-1", "Trip", "USD", "user-1", "2026-08-07T09:00:00.000Z");
    db.query("INSERT INTO group_members(group_id, user_id, display_name, status, joined_at) VALUES (?, ?, ?, 'active', ?)")
      .run("group-1", "user-1", "Sam", "2026-08-07T09:00:00.000Z");
    db.query("INSERT INTO group_members(group_id, user_id, display_name, status, joined_at) VALUES (?, ?, ?, 'active', ?)")
      .run("group-1", "user-2", "Ananya", "2026-08-07T09:00:00.000Z");
    db.query("INSERT INTO devices(id, user_id, public_key_jwk, name, status, created_at) VALUES (?, ?, '{}', ?, 'active', ?)")
      .run("device-2", "user-2", "iPhone", "2026-08-07T09:00:00.000Z");
  });

  afterEach(() => db.close());

  test("keeps one stable VAPID identity and encrypts its private key", () => {
    let calls = 0;
    const generate = () => {
      calls += 1;
      return { publicKey: "public-vapid-key", privateKey: "private-vapid-key" };
    };
    expect(ensureVapidKeys(db, secret, generate)).toEqual({
      publicKey: "public-vapid-key",
      privateKey: "private-vapid-key",
    });
    expect(ensureVapidKeys(db, secret, generate).publicKey).toBe("public-vapid-key");
    expect(calls).toBe(1);
    const stored = db.query<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?")
      .get("push_vapid_private_key")?.value;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("private-vapid-key");
  });

  test("derives only the affected recipient and explains their share", () => {
    expect(deriveOperationNotifications(expenseOperation(), {
      groupName: "Trip",
      actorName: "Sam",
    })).toEqual([{
      actorId: "user-2",
      kind: "expense-created",
      title: "Sam added Dinner",
      body: "You owe $5.00 in Trip.",
      targetUrl: "/?view=activity&group=group-1",
    }]);
  });

  test("alerts a participant removed by an amended expense", () => {
    const amended: OperationEnvelope = {
      ...expenseOperation(),
      id: "operation-2",
      type: "ExpenseAmended",
      baseVersion: 1,
      payload: {
        ...(expenseOperation().payload as Record<string, unknown>),
        payers: [{ participantId: "user-1", amountMinor: 1000 }],
        allocations: [{ participantId: "user-1", amountMinor: 1000 }],
      },
    } as OperationEnvelope;
    expect(deriveOperationNotifications(amended, {
      groupName: "Trip",
      actorName: "Sam",
    }, expenseOperation())).toContainEqual({
      actorId: "user-2",
      kind: "expense-updated",
      title: "Sam updated Dinner",
      body: "You’re no longer included in Dinner in Trip.",
      targetUrl: "/?view=activity&group=group-1",
    });
  });

  test("does not duplicate ledger content when the recipient has no push-enabled device", () => {
    expect(enqueueOperationNotifications(db, [expenseOperation()])).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM notifications").get()?.count).toBe(0);
  });

  test("encrypts a device subscription, exposes status, and queues idempotently", () => {
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    const stored = db.query<{ encrypted_subscription: string }, []>("SELECT encrypted_subscription FROM push_subscriptions").get();
    expect(stored?.encrypted_subscription).not.toContain(browserSubscription.endpoint);
    expect(pushSubscriptionStatus(db, "user-2", "device-2")).toEqual({ subscribed: true });

    enqueueOperationNotifications(db, [expenseOperation()]);
    enqueueOperationNotifications(db, [expenseOperation()]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM notifications").get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM push_deliveries").get()?.count).toBe(1);
  });

  test("rejects arbitrary HTTPS endpoints instead of turning the home server into a request proxy", () => {
    expect(() => registerPushSubscription(db, secret, "user-2", "device-2", {
      ...browserSubscription,
      endpoint: "https://example.com/internal-callback",
    })).toThrow("recognized browser push service");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM push_subscriptions").get()?.count).toBe(0);
  });

  test("does not let another actor register or revoke a device subscription", () => {
    expect(() => registerPushSubscription(db, secret, "user-1", "device-2", browserSubscription))
      .toThrow("active device registration");
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    expect(revokePushSubscription(db, "user-1", "device-2")).toBe(false);
    expect(pushSubscriptionStatus(db, "user-2", "device-2")).toEqual({ subscribed: true });
  });

  test("replaces a rotated browser subscription only for its authenticated owner", () => {
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    const replacement = {
      ...browserSubscription,
      endpoint: "https://web.push.apple.com/subscription/device-2-rotated",
    };
    expect(() => refreshPushSubscription(db, secret, "user-1", browserSubscription.endpoint, replacement))
      .toThrow("active push subscription");
    refreshPushSubscription(db, secret, "user-2", browserSubscription.endpoint, replacement);
    const encrypted = db.query<{ encrypted_subscription: string }, []>(
      "SELECT encrypted_subscription FROM push_subscriptions",
    ).get()?.encrypted_subscription ?? "";
    expect(encrypted).not.toContain(replacement.endpoint);
    expect(pushSubscriptionStatus(db, "user-2", "device-2")).toEqual({ subscribed: true });
  });

  test("delivers a queued alert and marks it read when the app becomes visible", async () => {
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    enqueueOperationNotifications(db, [expenseOperation()]);
    const sent: unknown[] = [];
    expect(await runPushDeliveryPass(db, {
      authSecret: secret,
      vapid: { publicKey: "public", privateKey: "private", subject: "mailto:test@example.com" },
      send: async (subscription, payload) => {
        sent.push({ subscription, payload: JSON.parse(payload) });
      },
    })).toBe(true);
    expect(sent).toEqual([expect.objectContaining({
      subscription: browserSubscription,
      payload: expect.objectContaining({ title: "Sam added Dinner", badgeCount: 1 }),
    })]);
    expect(db.query<{ status: string }, []>("SELECT status FROM push_deliveries").get()?.status).toBe("sent");

    expect(markNotificationsRead(db, "user-2")).toBe(1);
    expect(db.query<{ read_at: string | null }, []>("SELECT read_at FROM notifications").get()?.read_at).toBeTruthy();
  });

  test("expires a subscription when its push service says it is gone", async () => {
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    enqueueOperationNotifications(db, [expenseOperation()]);
    await runPushDeliveryPass(db, {
      authSecret: secret,
      vapid: { publicKey: "public", privateKey: "private", subject: "mailto:test@example.com" },
      send: async () => {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      },
    });
    expect(pushSubscriptionStatus(db, "user-2", "device-2")).toEqual({ subscribed: false });
    expect(db.query<{ status: string }, []>("SELECT status FROM push_deliveries").get()?.status).toBe("skipped");
  });

  test("reclaims a delivery left sending by a stopped worker", async () => {
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    enqueueOperationNotifications(db, [expenseOperation()]);
    db.query(
      "UPDATE push_deliveries SET status = 'sending', attempts = 1, next_attempt_at = ?",
    ).run("2026-08-07T00:00:00.000Z");
    let sent = 0;
    expect(await runPushDeliveryPass(db, {
      authSecret: secret,
      vapid: { publicKey: "public", privateKey: "private", subject: "mailto:test@example.com" },
      send: async () => { sent += 1; },
    })).toBe(true);
    expect(sent).toBe(1);
    expect(db.query<{ status: string; attempts: number }, []>(
      "SELECT status, attempts FROM push_deliveries",
    ).get()).toEqual({ status: "sent", attempts: 2 });
  });

  test("rechecks active group membership immediately before disclosing a queued alert", async () => {
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    enqueueOperationNotifications(db, [expenseOperation()]);
    db.query("UPDATE group_members SET status = 'removed', removed_at = ? WHERE group_id = ? AND user_id = ?")
      .run("2026-08-07T11:00:00.000Z", "group-1", "user-2");
    let sent = false;
    expect(await runPushDeliveryPass(db, {
      authSecret: secret,
      vapid: { publicKey: "public", privateKey: "private", subject: "mailto:test@example.com" },
      send: async () => { sent = true; },
    })).toBe(true);
    expect(sent).toBe(false);
    expect(db.query<{ status: string; last_error_code: string }, []>(
      "SELECT status, last_error_code FROM push_deliveries",
    ).get()).toEqual({ status: "skipped", last_error_code: "MEMBERSHIP_REMOVED" });
    expect(db.query<{ title: string; read_at: string | null }, []>("SELECT title, read_at FROM notifications").get())
      .toEqual({ title: "[read]", read_at: expect.any(String) });
  });

  test("does not disclose a queued alert after the destination device is revoked", async () => {
    registerPushSubscription(db, secret, "user-2", "device-2", browserSubscription);
    enqueueOperationNotifications(db, [expenseOperation()]);
    db.query("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE id = ?")
      .run("2026-08-07T11:00:00.000Z", "device-2");
    let sent = false;
    expect(await runPushDeliveryPass(db, {
      authSecret: secret,
      vapid: { publicKey: "public", privateKey: "private", subject: "mailto:test@example.com" },
      send: async () => { sent = true; },
    })).toBe(true);
    expect(sent).toBe(false);
    expect(db.query<{ status: string }, []>("SELECT status FROM push_subscriptions").get()?.status).toBe("revoked");
    expect(db.query<{ status: string; last_error_code: string }, []>(
      "SELECT status, last_error_code FROM push_deliveries",
    ).get()).toEqual({ status: "skipped", last_error_code: "DEVICE_REVOKED" });
  });
});
