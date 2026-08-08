import Bell from "lucide-solid/icons/bell";
import { Show, createSignal, onMount } from "solid-js";
import {
  currentPushAvailability,
  disablePushNotifications,
  enablePushNotifications,
  type PushAvailability,
} from "../lib/push-notifications";
import { Card } from "./ui";

type ViewState = PushAvailability | "loading" | "error";

const descriptions: Record<ViewState, string> = {
  loading: "Checking this device…",
  enabled: "Alerts arrive when a friend adds an expense or records a repayment.",
  available: "Get an alert when a friend adds an expense or records a repayment.",
  "install-required": "On iPhone, use Share → Add to Home Screen first, then turn notifications on in Tallied.",
  denied: "Notifications are blocked. Allow Tallied in your browser or iPhone notification settings.",
  unsupported: "This browser cannot receive web notifications. Live updates still appear while Tallied is open.",
  error: "Tallied could not check notifications. Your expenses and sync are unaffected.",
};

export function NotificationSettings(props: { onNotify(message: string): void }) {
  const [state, setState] = createSignal<ViewState>("loading");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function refresh(): Promise<void> {
    try {
      setState(await currentPushAvailability());
      setError("");
    } catch (cause) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "Notifications are temporarily unavailable");
    }
  }

  async function toggle(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      if (state() === "enabled") {
        await disablePushNotifications();
        setState("available");
        props.onNotify("Notifications turned off on this device");
      } else {
        await enablePushNotifications();
        setState("enabled");
        props.onNotify("Notifications turned on for this device");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notifications could not be changed");
      try {
        setState(await currentPushAvailability());
      } catch {
        setState("error");
      }
    } finally {
      setBusy(false);
    }
  }

  onMount(() => void refresh());
  const canToggle = () => state() === "available" || state() === "enabled" || state() === "error";

  return (
    <Card class="overflow-hidden">
      <div class="border-b border-border/60 px-4 py-3">
        <strong class="block text-sm">Notifications</strong>
        <span class="text-xs text-muted-foreground">Per device · no notification service account</span>
      </div>
      <div class="smart-category-setting">
        <span class="category-icon category-tone-transport"><Bell size={17} /></span>
        <span class="min-w-0 flex-1">
          <strong>{state() === "enabled" ? "Shared updates are on" : "Shared expense alerts"}</strong>
          <small>{descriptions[state()]}</small>
        </span>
        <button
          type="button"
          class="preference-switch"
          role="switch"
          aria-checked={state() === "enabled"}
          aria-label={state() === "enabled" ? "Turn off shared expense notifications" : "Turn on shared expense notifications"}
          disabled={!canToggle() || busy()}
          onClick={() => void toggle()}
        ><span /></button>
      </div>
      <Show when={error()}>
        <p class="border-t border-border/60 px-4 py-3 text-xs text-negative" role="alert">{error()}</p>
      </Show>
    </Card>
  );
}
