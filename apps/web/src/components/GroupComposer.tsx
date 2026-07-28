import { Dialog } from "@kobalte/core/dialog";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import Plus from "lucide-solid/icons/plus";
import X from "lucide-solid/icons/x";
import { Show, createEffect, createSignal } from "solid-js";
import { Button } from "./ui";
import { createGroup } from "../lib/store";

interface GroupComposerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(groupId: string): void;
}

export function GroupComposer(props: GroupComposerProps) {
  const [name, setName] = createSignal("");
  const [currency, setCurrency] = createSignal("USD");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let wasOpen = false;

  createEffect(() => {
    if (props.open && !wasOpen) {
      setName("");
      setCurrency("USD");
      setError("");
    }
    wasOpen = props.open;
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const groupId = await createGroup({ name: name(), settlementCurrency: currency() });
      props.onOpenChange(false);
      props.onCreated(groupId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not create this group");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content class="composer-dialog w-full rounded-t-2xl border border-border bg-card shadow-2xl outline-none sm:max-w-md sm:rounded-xl">
            <header class="flex min-h-14 items-center justify-between border-b border-border px-5">
              <div><Dialog.Title class="text-base font-semibold">New group</Dialog.Title><Dialog.Description class="sr-only">Create another expense group.</Dialog.Description></div>
              <Dialog.CloseButton class="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Close group form"><X size={17} /></Dialog.CloseButton>
            </header>
            <form class="grid gap-5 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:p-6" onSubmit={(event) => void submit(event)}>
              <label class="grid gap-2 text-sm font-medium">Group name<input class="form-control h-12" autofocus required maxlength={100} placeholder="Apartment, Japan trip…" value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label>
              <label class="grid gap-2 text-sm font-medium">Default currency<select class="form-control" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)}><option value="USD">USD — US dollar</option><option value="CAD">CAD — Canadian dollar</option><option value="EUR">EUR — Euro</option><option value="GBP">GBP — British pound</option><option value="INR">INR — Indian rupee</option></select></label>
              <Show when={error()}><p class="error-callout" role="alert">{error()}</p></Show>
              <Button class="h-11 w-full" type="submit" disabled={!name().trim() || saving()}>
                <Show when={saving()} fallback={<><Plus size={16} /> Create group</>}><LoaderCircle class="animate-spin" size={16} /> Creating…</Show>
              </Button>
              <p class="text-center text-xs text-muted-foreground">Available on this device immediately; syncs when online.</p>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
