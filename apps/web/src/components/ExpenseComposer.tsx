import { Dialog } from "@kobalte/core/dialog";
import { Check, LoaderCircle, UsersRound, X } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { appStore, createExpense } from "../lib/store";
import { Avatar, Button } from "./ui";

interface ExpenseComposerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function ExpenseComposer(props: ExpenseComposerProps) {
  const [groupId, setGroupId] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [category, setCategory] = createSignal("Dining out");
  const [date, setDate] = createSignal(new Date().toISOString().slice(0, 10));
  const [payerId, setPayerId] = createSignal("dev-user");
  const [participants, setParticipants] = createSignal<string[]>([]);
  const [notes, setNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  createEffect(() => {
    if (!props.open) return;
    const firstGroup = appStore.groups()[0];
    if (firstGroup && !groupId()) setGroupId(firstGroup.id);
  });

  const groupMembers = createMemo(() => appStore.members().filter((member) => member.groupId === groupId() && member.status === "active"));

  createEffect(() => {
    const ids = groupMembers().map(({ userId }) => userId);
    setParticipants((selected) => selected.length === 0 ? ids : selected.filter((id) => ids.includes(id)));
    if (!ids.includes(payerId())) setPayerId(ids[0] ?? "dev-user");
  });

  function toggleParticipant(userId: string): void {
    setParticipants((current) => current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await createExpense({
        groupId: groupId(),
        description: description(),
        amount: amount(),
        currency: appStore.groups().find((group) => group.id === groupId())?.settlementCurrency ?? "USD",
        category: category(),
        expenseDate: date(),
        payerId: payerId(),
        participantIds: participants(),
        notes: notes(),
      });
      setDescription("");
      setAmount("");
      setNotes("");
      props.onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not save this expense");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/45 data-[expanded]:animate-in data-[closed]:animate-out" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content class="max-h-[94dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-card shadow-xl outline-none sm:max-w-xl sm:rounded-xl">
            <header class="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-card px-5">
              <Dialog.Title class="text-base font-semibold">Add expense</Dialog.Title>
              <Dialog.CloseButton class="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close expense form"><X size={17} /></Dialog.CloseButton>
            </header>

            <form class="grid gap-5 p-5 sm:p-6" onSubmit={(event) => void submit(event)}>
              <div class="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <label class="grid gap-2 text-sm font-medium">Amount<div class="relative"><span class="absolute left-3 top-2.5 text-sm text-muted-foreground">$</span><input class="form-control pl-7 text-base font-semibold tabular-nums" inputmode="decimal" value={amount()} onInput={(event) => setAmount(event.currentTarget.value)} placeholder="0.00" aria-label="Expense amount" /></div></label>
                <label class="grid gap-2 text-sm font-medium">Description<input class="form-control" autofocus value={description()} onInput={(event) => setDescription(event.currentTarget.value)} placeholder="Dinner, groceries, tickets…" maxlength={200} /></label>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <label class="grid gap-2 text-sm font-medium">Group<select class="form-control" value={groupId()} onInput={(event) => setGroupId(event.currentTarget.value)}><For each={appStore.groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For></select></label>
                <label class="grid gap-2 text-sm font-medium">Category<select class="form-control" value={category()} onInput={(event) => setCategory(event.currentTarget.value)}><option>Dining out</option><option>Groceries</option><option>Transportation</option><option>Hotel</option><option>Entertainment</option><option>General</option></select></label>
                <label class="grid gap-2 text-sm font-medium">Date<input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} /></label>
                <label class="grid gap-2 text-sm font-medium">Paid by<select class="form-control" value={payerId()} onInput={(event) => setPayerId(event.currentTarget.value)}><For each={groupMembers()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For></select></label>
              </div>

              <fieldset class="grid gap-3">
                <legend class="mb-3 flex w-full items-center justify-between text-sm font-medium"><span class="flex items-center gap-2"><UsersRound size={16} /> Split equally</span><span class="text-xs font-normal text-muted-foreground">{participants().length} selected</span></legend>
                <div class="grid gap-2 sm:grid-cols-2">
                  <For each={groupMembers()}>{(member) => (
                    <button type="button" class="flex h-12 items-center gap-2 rounded-md border border-border px-3 text-left text-sm transition-colors hover:bg-muted" classList={{ "border-primary bg-primary/5 ring-1 ring-primary": participants().includes(member.userId) }} onClick={() => toggleParticipant(member.userId)} aria-pressed={participants().includes(member.userId)}>
                      <Avatar name={member.displayName} class="size-7 text-xs" /><span class="min-w-0 flex-1 truncate font-medium">{member.displayName}</span><span class="grid size-5 place-items-center rounded border border-border" classList={{ "border-primary bg-primary text-primary-foreground": participants().includes(member.userId) }}><Show when={participants().includes(member.userId)}><Check size={13} /></Show></span>
                    </button>
                  )}</For>
                </div>
              </fieldset>

              <label class="grid gap-2 text-sm font-medium">Notes <span class="sr-only">optional</span><textarea class="form-control min-h-20 resize-y py-2" value={notes()} onInput={(event) => setNotes(event.currentTarget.value)} placeholder="Optional note" maxlength={5000} /></label>

              <Show when={error()}><p class="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error()}</p></Show>
              <footer class="grid gap-2 border-t border-border pt-5">
                <Button class="w-full" type="submit" disabled={saving()}>
                  <Show when={saving()} fallback={<><Check size={16} /> Add expense</>}><LoaderCircle class="animate-spin" size={16} /> Saving…</Show>
                </Button>
                <p class="text-center text-xs text-muted-foreground">Saved on this device first, then synced automatically.</p>
              </footer>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
