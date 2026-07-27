import { Dialog } from "@kobalte/core/dialog";
import { ArrowRight, Check, LoaderCircle, X } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { appStore, recordPayment } from "../lib/store";
import { localDateValue } from "../lib/dates";
import type { Settlement } from "../lib/ledger-view";
import { Button } from "./ui";

interface PaymentComposerProps {
  open: boolean;
  groupId?: string | undefined;
  currency: string;
  suggested?: Settlement | undefined;
  onOpenChange(open: boolean): void;
  onSaved(): void;
}

export function PaymentComposer(props: PaymentComposerProps) {
  const [payerId, setPayerId] = createSignal("");
  const [recipientId, setRecipientId] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [date, setDate] = createSignal(localDateValue());
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const members = createMemo(() => appStore.members().filter((member) => member.groupId === props.groupId && member.status === "active"));
  let wasOpen = false;
  createEffect(() => {
    if (props.open && !wasOpen) {
      setPayerId(props.suggested?.payerId ?? members()[0]?.userId ?? "");
      setRecipientId(props.suggested?.recipientId ?? members()[1]?.userId ?? "");
      setAmount(props.suggested ? (props.suggested.amountMinor / 100).toFixed(2) : "");
      setDate(localDateValue());
      setNote("");
      setError("");
    }
    wasOpen = props.open;
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!props.groupId) return;
    setBusy(true);
    setError("");
    try {
      await recordPayment({ groupId: props.groupId, payerId: payerId(), recipientId: recipientId(), amount: amount(), currency: props.currency, paymentDate: date(), note: note() });
      props.onOpenChange(false);
      props.onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record payment");
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={props.open} onOpenChange={props.onOpenChange}><Dialog.Portal><Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" /><div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6"><Dialog.Content class="composer-dialog glass-sheet w-full rounded-t-[1.75rem] border border-border bg-card shadow-2xl outline-none sm:max-w-md sm:rounded-3xl"><header class="flex min-h-16 items-center justify-between border-b border-border/70 px-5"><div><Dialog.Title class="font-semibold">Record payment</Dialog.Title><Dialog.Description class="text-xs text-muted-foreground">No money moves through the app.</Dialog.Description></div><Dialog.CloseButton class="icon-button" aria-label="Close payment form"><X size={18} /></Dialog.CloseButton></header><form class="grid gap-5 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]" onSubmit={(event) => void submit(event)}><div class="grid grid-cols-[1fr_auto_1fr] items-end gap-2"><label class="grid gap-2 text-sm font-medium">Payer<select class="form-control" value={payerId()} onInput={(event) => setPayerId(event.currentTarget.value)}><For each={members()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For></select></label><ArrowRight class="mb-3 text-muted-foreground" size={17} /><label class="grid gap-2 text-sm font-medium">Recipient<select class="form-control" value={recipientId()} onInput={(event) => setRecipientId(event.currentTarget.value)}><For each={members()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For></select></label></div><label class="grid gap-2 text-sm font-medium">Amount<div class="relative"><span class="absolute left-3 top-3 text-xs font-semibold text-muted-foreground">{props.currency}</span><input class="form-control amount-control h-12 pl-14" inputmode="decimal" value={amount()} onInput={(event) => setAmount(event.currentTarget.value)} placeholder="0.00" /></div></label><label class="grid gap-2 text-sm font-medium">Date<input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} /></label><label class="grid gap-2 text-sm font-medium">Note<textarea class="form-control min-h-20 py-2" value={note()} onInput={(event) => setNote(event.currentTarget.value)} placeholder="Optional note" /></label><Show when={error()}><p class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error()}</p></Show><Button class="h-12 w-full" type="submit" disabled={busy() || !amount() || payerId() === recipientId()}><Show when={busy()} fallback={<><Check size={16} /> Record payment</>}><LoaderCircle class="animate-spin" size={16} /> Saving…</Show></Button></form></Dialog.Content></div></Dialog.Portal></Dialog>;
}
