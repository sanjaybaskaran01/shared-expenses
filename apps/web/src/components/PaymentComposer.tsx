import { Dialog } from "@kobalte/core/dialog";
import ArrowRight from "lucide-solid/icons/arrow-right";
import Check from "lucide-solid/icons/check";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import X from "lucide-solid/icons/x";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { appStore, recordPayment } from "../lib/store";
import { localDateValue } from "../lib/dates";
import type { Settlement } from "../lib/ledger-view";
import { validatePaymentForm, type PaymentFormIssue } from "../lib/payment-form";
import { Button } from "./ui";

interface PaymentComposerProps {
  open: boolean;
  groupId?: string | undefined;
  currency: string;
  suggested?: Settlement | undefined;
  blocked?: boolean | undefined;
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
  const [formIssue, setFormIssue] = createSignal<PaymentFormIssue>();
  const members = createMemo(() => appStore.members().filter((member) => member.groupId === props.groupId && member.status === "active"));
  const payerName = createMemo(() => members().find((member) => member.userId === payerId())?.displayName ?? "Payer");
  const recipientName = createMemo(() => members().find((member) => member.userId === recipientId())?.displayName ?? "Recipient");
  const amountMinor = createMemo(() => Math.round((Number(amount()) || 0) * 100));
  const suggestedRemainingMinor = createMemo(() => {
    const suggested = props.suggested;
    if (!suggested || suggested.payerId !== payerId() || suggested.recipientId !== recipientId()) return undefined;
    return suggested.amountMinor - amountMinor();
  });
  const outcome = createMemo(() => {
    const remaining = suggestedRemainingMinor();
    if (remaining === 0) return `This settles the suggested balance between ${payerName()} and ${recipientName()}.`;
    if (remaining !== undefined && remaining > 0) return `${payerName()} will still owe ${recipientName()} ${new Intl.NumberFormat(undefined, { style: "currency", currency: props.currency }).format(remaining / 100)}.`;
    if (remaining !== undefined && remaining < 0) return `This is ${new Intl.NumberFormat(undefined, { style: "currency", currency: props.currency }).format(Math.abs(remaining) / 100)} more than the suggested balance.`;
    return `This records ${payerName()} paying ${recipientName()} ${new Intl.NumberFormat(undefined, { style: "currency", currency: props.currency }).format(amountMinor() / 100)}.`;
  });
  let wasOpen = false;
  let amountInputRef: HTMLInputElement | undefined;
  let payerSelectRef: HTMLSelectElement | undefined;
  createEffect(() => {
    if (props.open && !wasOpen) {
      setPayerId(props.suggested?.payerId ?? members()[0]?.userId ?? "");
      setRecipientId(props.suggested?.recipientId ?? members()[1]?.userId ?? "");
      setAmount(props.suggested ? (props.suggested.amountMinor / 100).toFixed(2) : "");
      setDate(localDateValue());
      setNote("");
      setError("");
      setFormIssue(undefined);
    }
    wasOpen = props.open;
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!props.groupId) return;
    setError("");
    setFormIssue(undefined);
    if (props.blocked) {
      setError("Review the expense before recording a payment.");
      return;
    }
    const issue = validatePaymentForm({ amount: amount(), payerId: payerId(), recipientId: recipientId() });
    if (issue) {
      setFormIssue(issue);
      setError(issue.message);
      queueMicrotask(() => issue.field === "amount" ? amountInputRef?.focus() : payerSelectRef?.focus());
      return;
    }
    setBusy(true);
    try {
      await recordPayment({ groupId: props.groupId, payerId: payerId(), recipientId: recipientId(), amount: amount(), currency: props.currency, paymentDate: date(), note: note() });
      props.onOpenChange(false);
      props.onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to record this payment. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content
            role="dialog"
            class="composer-dialog glass-sheet w-full border border-border bg-card shadow-2xl outline-none sm:max-w-md sm:rounded-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => amountInputRef?.focus());
            }}
          >
            <header class="flex min-h-16 items-center justify-between border-b border-border/70 px-5">
              <div>
                <Dialog.Title class="font-semibold">Record payment</Dialog.Title>
                <Dialog.Description class="text-xs text-muted-foreground">Tallied records this payment but does not move money.</Dialog.Description>
              </div>
              <Dialog.CloseButton class="icon-button" aria-label="Close payment form"><X size={18} /></Dialog.CloseButton>
            </header>
            <form class="grid gap-5 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]" onSubmit={(event) => void submit(event)}>
              <div class="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <label class="grid gap-2 text-sm font-medium">Paid by<select ref={payerSelectRef} class="form-control" value={payerId()} aria-invalid={formIssue()?.field === "participants"} aria-describedby={formIssue()?.field === "participants" ? "payment-form-error" : undefined} onInput={(event) => setPayerId(event.currentTarget.value)}><For each={members()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For></select></label>
                <ArrowRight class="mb-3 text-muted-foreground" size={17} />
                <label class="grid gap-2 text-sm font-medium">Paid to<select class="form-control" value={recipientId()} aria-invalid={formIssue()?.field === "participants"} aria-describedby={formIssue()?.field === "participants" ? "payment-form-error" : undefined} onInput={(event) => setRecipientId(event.currentTarget.value)}><For each={members()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For></select></label>
              </div>
              <label class="grid gap-2 text-sm font-medium">Amount<div class="relative"><span class="absolute left-3 top-3 text-xs font-semibold text-muted-foreground">{props.currency}</span><input ref={amountInputRef} class="form-control amount-control h-12 pl-14" inputmode="decimal" aria-label={`Payment amount in ${props.currency}`} aria-invalid={formIssue()?.field === "amount"} aria-describedby={formIssue()?.field === "amount" ? "payment-form-error" : undefined} value={amount()} onInput={(event) => setAmount(event.currentTarget.value)} placeholder="0.00" /></div></label>
              <label class="grid gap-2 text-sm font-medium">Date<input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} /></label>
              <label class="grid gap-2 text-sm font-medium">Note <span class="font-normal text-muted-foreground">(optional)</span><textarea class="form-control min-h-20 py-2" value={note()} onInput={(event) => setNote(event.currentTarget.value)} placeholder="e.g. Paid in cash" /></label>
              <Show when={amountMinor() > 0 && payerId() !== recipientId()}>
                <section class="payment-outcome"><span>After this payment</span><strong>{outcome()}</strong><p>Everyone in this group will see the payment after it syncs.</p></section>
              </Show>
              <Show when={props.blocked}><p class="error-callout" role="alert">Review the expense before recording a payment.</p></Show>
              <Show when={error()}><p id="payment-form-error" class="error-callout" role="alert">{error()}</p></Show>
              <Button class="h-12 w-full" type="submit" disabled={busy() || props.blocked}>
                <Show when={busy()} fallback={<><Check size={16} /> Record payment</>}><LoaderCircle class="animate-spin" size={16} /> Saving…</Show>
              </Button>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
