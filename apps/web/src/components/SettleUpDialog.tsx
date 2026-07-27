import { Dialog } from "@kobalte/core/dialog";
import { ArrowRight, Check, LoaderCircle, X } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { appStore, recordPayment } from "../lib/store";
import { Avatar, Button } from "./ui";

export interface SettlePrefill {
  groupId: string;
  payerId: string;
  recipientId: string;
  amountMinor: number;
  currency: string;
}

interface SettleUpDialogProps {
  open: boolean;
  prefill?: SettlePrefill | undefined;
  onOpenChange(open: boolean): void;
}

function minorToDecimal(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

export function SettleUpDialog(props: SettleUpDialogProps) {
  const [groupId, setGroupId] = createSignal("");
  const [payerId, setPayerId] = createSignal("");
  const [recipientId, setRecipientId] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [date, setDate] = createSignal(new Date().toISOString().slice(0, 10));
  const [note, setNote] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  createEffect(() => {
    if (!props.open) return;
    const prefill = props.prefill;
    if (prefill) {
      setGroupId(prefill.groupId);
      setPayerId(prefill.payerId);
      setRecipientId(prefill.recipientId);
      setAmount(minorToDecimal(prefill.amountMinor));
      return;
    }
    if (!groupId()) setGroupId(appStore.groups()[0]?.id ?? "");
  });

  const groupMembers = createMemo(() =>
    appStore.members().filter((member) => member.groupId === groupId() && member.status === "active"),
  );

  const currency = createMemo(
    () => appStore.groups().find((group) => group.id === groupId())?.settlementCurrency ?? "USD",
  );

  createEffect(() => {
    const ids = groupMembers().map(({ userId }) => userId);
    if (ids.length === 0) return;
    if (!ids.includes(payerId())) setPayerId(ids[0] ?? "");
    if (!ids.includes(recipientId())) setRecipientId(ids.find((id) => id !== payerId()) ?? "");
  });

  function nameFor(userId: string): string {
    return groupMembers().find((member) => member.userId === userId)?.displayName ?? "Someone";
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await recordPayment({
        groupId: groupId(),
        payerId: payerId(),
        recipientId: recipientId(),
        amount: amount(),
        currency: currency(),
        paymentDate: date(),
        note: note(),
      });
      setAmount("");
      setNote("");
      props.onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not record this payment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content class="max-h-[94dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-card shadow-xl outline-none sm:max-w-lg sm:rounded-xl">
            <header class="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-card px-5">
              <Dialog.Title class="text-base font-semibold">Settle up</Dialog.Title>
              <Dialog.CloseButton
                class="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close settle up form"
              >
                <X size={17} />
              </Dialog.CloseButton>
            </header>

            <form class="grid gap-5 p-5 sm:p-6" onSubmit={(event) => void submit(event)}>
              <label class="grid gap-2 text-sm font-medium">
                Group
                <select class="form-control" value={groupId()} onInput={(event) => setGroupId(event.currentTarget.value)}>
                  <For each={appStore.groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For>
                </select>
              </label>

              <div class="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
                <label class="grid gap-2 text-sm font-medium">
                  Who paid
                  <select class="form-control" value={payerId()} onInput={(event) => setPayerId(event.currentTarget.value)}>
                    <For each={groupMembers()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For>
                  </select>
                </label>
                <span class="hidden pb-2.5 text-muted-foreground sm:block"><ArrowRight size={16} /></span>
                <label class="grid gap-2 text-sm font-medium">
                  Who received it
                  <select
                    class="form-control"
                    value={recipientId()}
                    onInput={(event) => setRecipientId(event.currentTarget.value)}
                  >
                    <For each={groupMembers()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For>
                  </select>
                </label>
              </div>

              <div class="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <label class="grid gap-2 text-sm font-medium">
                  Amount ({currency()})
                  <input
                    class="form-control text-base font-semibold tabular-nums"
                    inputmode="decimal"
                    value={amount()}
                    onInput={(event) => setAmount(event.currentTarget.value)}
                    placeholder="0.00"
                  />
                </label>
                <label class="grid gap-2 text-sm font-medium">
                  Date
                  <input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} />
                </label>
              </div>

              <label class="grid gap-2 text-sm font-medium">
                Note <span class="sr-only">optional</span>
                <input
                  class="form-control"
                  value={note()}
                  onInput={(event) => setNote(event.currentTarget.value)}
                  placeholder="Bank transfer, cash…"
                  maxlength={500}
                />
              </label>

              <Show when={payerId() && recipientId() && payerId() !== recipientId()}>
                <div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
                  <Avatar name={nameFor(payerId())} class="size-6 text-xs" />
                  <span class="text-muted-foreground">paid</span>
                  <Avatar name={nameFor(recipientId())} class="size-6 text-xs" />
                  <span class="ml-auto text-xs text-muted-foreground">Recorded here only — no money moves.</span>
                </div>
              </Show>

              <Show when={error()}>
                <p class="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error()}</p>
              </Show>

              <footer class="grid gap-2 border-t border-border pt-5">
                <Button class="w-full" type="submit" disabled={saving() || payerId() === recipientId()}>
                  <Show when={saving()} fallback={<><Check size={16} /> Record payment</>}>
                    <LoaderCircle class="animate-spin" size={16} /> Saving…
                  </Show>
                </Button>
              </footer>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
