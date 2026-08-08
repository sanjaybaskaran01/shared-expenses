import type { JsonValue, OperationEnvelope } from "@expenses/protocol";
import {
  getPushConfig,
  markNotificationsRead,
  registerPushSubscription,
  revokePushSubscription,
  type BrowserPushSubscriptionJson,
} from "./api";
import { ensureDevice } from "./device";

export type PushAvailability =
  | "unsupported"
  | "install-required"
  | "denied"
  | "available"
  | "enabled";

export function classifyPushAvailability(input: {
  supported: boolean;
  isIos: boolean;
  standalone: boolean;
  permission: NotificationPermission;
  subscribed?: boolean;
}): PushAvailability {
  if (!input.supported) return "unsupported";
  if (input.isIos && !input.standalone) return "install-required";
  if (input.permission === "denied") return "denied";
  return input.permission === "granted" && input.subscribed ? "enabled" : "available";
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return standaloneNavigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function runtimeAvailability(): Omit<Parameters<typeof classifyPushAvailability>[0], "subscribed"> {
  return {
    supported: pushSupported(),
    isIos: isIos(),
    standalone: isStandalone(),
    permission: "Notification" in window ? Notification.permission : "default",
  };
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function currentPushAvailability(): Promise<PushAvailability> {
  const base = runtimeAvailability();
  if (!base.supported) return "unsupported";
  if (classifyPushAvailability(base) === "install-required") return "install-required";
  if (Notification.permission !== "granted") return classifyPushAvailability(base);
  const device = await ensureDevice();
  const [browserSubscription, server] = await Promise.all([
    currentSubscription(),
    getPushConfig(device.deviceId),
  ]);
  let subscribed = server.subscribed;
  if (browserSubscription) {
    await registerPushSubscription(device.deviceId, subscriptionJson(browserSubscription));
    subscribed = true;
  }
  return classifyPushAvailability({ ...base, subscribed: Boolean(browserSubscription && subscribed) });
}

export async function hasActiveLocalPushSubscription(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const subscription = await currentSubscription();
  if (!subscription) return false;
  const device = await ensureDevice();
  return (await getPushConfig(device.deviceId)).subscribed;
}

function subscriptionJson(subscription: PushSubscription): BrowserPushSubscriptionJson {
  const serialized = subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!serialized.endpoint || !p256dh || !auth) throw new Error("The browser returned an incomplete push subscription");
  return {
    endpoint: serialized.endpoint,
    expirationTime: serialized.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

export async function enablePushNotifications(): Promise<void> {
  const base = runtimeAvailability();
  const availability = classifyPushAvailability(base);
  if (availability === "install-required") {
    throw new Error("Add Tallied to your Home Screen before turning on notifications");
  }
  if (availability === "unsupported") throw new Error("This browser does not support web notifications");
  if (availability === "denied") throw new Error("Allow Tallied notifications in your browser settings first");
  // Keep the permission prompt in the original click's user-activation task,
  // which iOS requires for Home Screen web apps.
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed");
  const device = await ensureDevice();
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error("Install or reload Tallied before turning on notifications");
  const config = await getPushConfig(device.deviceId);
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });
  await registerPushSubscription(device.deviceId, subscriptionJson(subscription));
}

export async function disablePushNotifications(): Promise<void> {
  const device = await ensureDevice();
  const subscription = await currentSubscription();
  if (subscription) await subscription.unsubscribe();
  await revokePushSubscription(device.deviceId).catch(() => undefined);
}

export async function acknowledgeNotifications(): Promise<void> {
  const badgeNavigator = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  await Promise.allSettled([
    markNotificationsRead(),
    badgeNavigator.clearAppBadge?.() ?? Promise.resolve(),
  ]);
}

export function foregroundActivityMessage(
  operations: readonly OperationEnvelope[],
  context: {
    currentActorId: string;
    actorNames: ReadonlyMap<string, string>;
    groupNames: ReadonlyMap<string, string>;
    previousExpenseNetMinor?: ReadonlyMap<string, number>;
  },
): string | undefined {
  const relevant = operations.filter((operation) => {
    if (operation.actorId === context.currentActorId) return false;
    const payload = operation.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const values = payload as Record<string, JsonValue>;
    if (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended") {
      const currentNetMinor = participantNetMinor(values, context.currentActorId);
      const previousNetMinor = context.previousExpenseNetMinor?.get(operation.id) ?? 0;
      return currentNetMinor !== 0 || (operation.type === "ExpenseAmended" && previousNetMinor !== 0);
    }
    if (operation.type === "PaymentRecorded") {
      return values.payerId === context.currentActorId || values.recipientId === context.currentActorId;
    }
    return false;
  });
  if (relevant.length === 0) return undefined;
  if (relevant.length > 1) return `${relevant.length} shared updates just arrived`;
  const operation = relevant[0]!;
  const actor = context.actorNames.get(operation.actorId) ?? "Someone";
  const group = context.groupNames.get(operation.groupId) ?? "Shared group";
  if (operation.type === "ExpenseCreated" || operation.type === "ExpenseAmended") {
    const payload = operation.payload;
    const description = payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.description === "string"
      ? payload.description.trim().slice(0, 80)
      : "an expense";
    return `${actor} ${operation.type === "ExpenseCreated" ? "added" : "updated"} ${description || "an expense"} · ${group}`;
  }
  if (operation.type === "PaymentRecorded") return `${actor} recorded a payment · ${group}`;
  return undefined;
}

export function queuedForegroundActivityMessage(messages: readonly string[]): string | undefined {
  if (messages.length === 0) return undefined;
  if (messages.length === 1) return messages[0];
  return `${messages.length} shared updates arrived while you were away`;
}

function participantAmounts(value: JsonValue | undefined): Array<{ participantId: string; amountMinor: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    return typeof entry.participantId === "string" && Number.isSafeInteger(entry.amountMinor)
      ? [{ participantId: entry.participantId, amountMinor: Number(entry.amountMinor) }]
      : [];
  });
}

function participantNetMinor(values: Record<string, JsonValue>, actorId: string): number {
  const paidMinor = participantAmounts(values.payers)
    .filter(({ participantId }) => participantId === actorId)
    .reduce((sum, { amountMinor }) => sum + amountMinor, 0);
  const allocatedMinor = participantAmounts(values.allocations)
    .filter(({ participantId }) => participantId === actorId)
    .reduce((sum, { amountMinor }) => sum + amountMinor, 0);
  return allocatedMinor - paidMinor;
}
