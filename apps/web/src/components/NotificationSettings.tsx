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
  enabled: "You’ll get alerts when someone adds an expense or records a payment.",
  available: "Get alerts when someone adds an expense or records a payment.",
  "install-required": "On iPhone, add Tallied to your Home Screen, then return here to turn on notifications.",
  denied: "Notifications are blocked. Allow Tallied in your browser or iPhone notification settings.",
  unsupported: "This browser cannot receive web notifications. Live updates still appear while Tallied is open.",
  error: "Unable to check notification settings. Your expenses and sync are unaffected.",
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
      setError(cause instanceof Error ? cause.message : "Notifications are temporarily unavailable. Try again.");
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
      setError(cause instanceof Error ? cause.message : "Unable to change notifications. Try again.");
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
        <span class="text-xs text-muted-foreground">Set separately on each device</span>
      </div>
      <div class="smart-category-setting">
        <span class="category-icon category-tone-transport"><Bell size={17} /></span>
        <span class="min-w-0 flex-1">
          <strong>Shared expense notifications</strong>
          <small>{descriptions[state()]}</small>
        </span>
        <button
          type="button"
          class="preference-switch"
          role="switch"
          aria-checked={state() === "enabled"}
          aria-label="Send shared expense notifications"
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
