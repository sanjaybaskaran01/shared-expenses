import { Dialog } from "@kobalte/core/dialog";
import { Check, ChevronDown, ChevronUp, LoaderCircle, SlidersHorizontal, X } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { LocalExpense } from "../lib/db";
import { appStore, calculateExpenseAllocations, createExpense, updateExpense, type SplitMethod } from "../lib/store";
import { Avatar, Button } from "./ui";

interface ExpenseComposerProps {
  open: boolean;
  actorId: string;
  initialGroupId?: string | undefined;
  expense?: LocalExpense | undefined;
  onOpenChange(open: boolean): void;
  onSaved(mode: "created" | "updated"): void;
}

const splitMethods: Array<{ id: SplitMethod; label: string }> = [
  { id: "equal", label: "Equal" },
  { id: "exact", label: "Amounts" },
  { id: "percentage", label: "%" },
  { id: "shares", label: "Shares" },
];

function formatMinor(amountMinor: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function minorInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

export function ExpenseComposer(props: ExpenseComposerProps) {
  const [groupId, setGroupId] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [category, setCategory] = createSignal("General");
  const [date, setDate] = createSignal(new Date().toISOString().slice(0, 10));
  const [payerId, setPayerId] = createSignal(props.actorId);
  const [participants, setParticipants] = createSignal<string[]>([]);
  const [splitMethod, setSplitMethod] = createSignal<SplitMethod>("equal");
  const [splitValues, setSplitValues] = createSignal<Record<string, string>>({});
  const [notes, setNotes] = createSignal("");
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [splitOpen, setSplitOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let wasOpen = false;
  let initializedGroup = "";

  const currentGroup = createMemo(() => appStore.groups().find((group) => group.id === groupId()));
  const groupMembers = createMemo(() => appStore.members().filter((member) => member.groupId === groupId() && member.status === "active"));
  const payerName = createMemo(() => groupMembers().find((member) => member.userId === payerId())?.displayName ?? "you");
  const currency = createMemo(() => currentGroup()?.settlementCurrency ?? "USD");

  createEffect(() => {
    const open = props.open;
    if (open && !wasOpen) {
      const editingExpense = props.expense;
      const preferredGroupId = editingExpense?.groupId ?? props.initialGroupId;
      const nextGroupId = preferredGroupId && appStore.groups().some((group) => group.id === preferredGroupId)
        ? preferredGroupId
        : appStore.groups()[0]?.id ?? "";
      setGroupId(nextGroupId);
      setDescription(editingExpense?.description ?? "");
      setAmount(editingExpense ? minorInput(editingExpense.amountMinor) : "");
      setCategory(editingExpense?.category ?? "General");
      setDate(editingExpense?.expenseDate ?? new Date().toISOString().slice(0, 10));
      setNotes(editingExpense?.notes ?? "");
      setDetailsOpen(false);
      setSplitOpen(false);
      setError("");
      if (editingExpense) {
        const participantIds = editingExpense.allocations.map(({ participantId }) => participantId);
        const equalAllocations = calculateExpenseAllocations({
          amount: minorInput(editingExpense.amountMinor),
          participantIds,
          splitMethod: "equal",
          splitValues: {},
        });
        const isEqual = equalAllocations.every((allocation) => (
          editingExpense.allocations.find(({ participantId }) => participantId === allocation.participantId)?.amountMinor === allocation.amountMinor
        ));
        setParticipants(participantIds);
        setPayerId(editingExpense.payers[0]?.participantId ?? props.actorId);
        setSplitMethod(isEqual ? "equal" : "exact");
        setSplitValues(isEqual ? {} : Object.fromEntries(editingExpense.allocations.map(({ participantId, amountMinor }) => [participantId, minorInput(amountMinor)])));
        initializedGroup = nextGroupId;
      } else {
        setSplitMethod("equal");
        setSplitValues({});
        initializedGroup = "";
      }
    }
    if (!open) initializedGroup = "";
    wasOpen = open;
  });

  createEffect(() => {
    if (!props.open) return;
    const activeGroupId = groupId();
    const ids = groupMembers().map(({ userId }) => userId);
    if (!activeGroupId || initializedGroup === activeGroupId) return;
    initializedGroup = activeGroupId;
    setParticipants(ids);
    setPayerId(ids.includes(props.actorId) ? props.actorId : ids[0] ?? props.actorId);
    setSplitMethod("equal");
    setSplitValues({});
  });

  const allocations = createMemo(() => {
    try {
      return calculateExpenseAllocations({ amount: amount(), participantIds: participants(), splitMethod: splitMethod(), splitValues: splitValues() });
    } catch {
      return [];
    }
  });

  const canSave = createMemo(() => description().trim().length > 0 && allocations().length > 0 && !saving());
  const splitSummary = createMemo(() => {
    const count = participants().length;
    if (splitMethod() === "equal") return `Equally · ${count} ${count === 1 ? "person" : "people"}`;
    if (splitMethod() === "exact") return `By amount · ${count} people`;
    if (splitMethod() === "percentage") return `By percentage · ${count} people`;
    return `By shares · ${count} people`;
  });

  function initializeValues(method: SplitMethod): void {
    const ids = participants();
    if (method === "equal") {
      setSplitValues({});
      return;
    }
    if (method === "shares") {
      setSplitValues(Object.fromEntries(ids.map((id) => [id, "1"])));
      return;
    }
    if (method === "percentage") {
      if (ids.length === 0) {
        setSplitValues({});
        return;
      }
      const base = Math.floor(10_000 / ids.length);
      let remainder = 10_000 % ids.length;
      setSplitValues(Object.fromEntries(ids.map((id) => {
        const basisPoints = base + (remainder-- > 0 ? 1 : 0);
        return [id, (basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)];
      })));
      return;
    }
    try {
      const equal = calculateExpenseAllocations({ amount: amount(), participantIds: ids, splitMethod: "equal", splitValues: {} });
      setSplitValues(Object.fromEntries(equal.map((item) => [item.participantId, (item.amountMinor / 100).toFixed(2)])));
    } catch {
      setSplitValues(Object.fromEntries(ids.map((id) => [id, "0.00"])));
    }
  }

  function chooseSplitMethod(method: SplitMethod): void {
    setSplitMethod(method);
    initializeValues(method);
  }

  function toggleParticipant(userId: string): void {
    setParticipants((current) => {
      if (current.includes(userId)) return current.filter((id) => id !== userId);
      if (splitMethod() !== "equal") {
        setSplitValues((values) => ({ ...values, [userId]: splitMethod() === "shares" ? "1" : "0" }));
      }
      return [...current, userId];
    });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const editingExpense = props.expense;
    setSaving(true);
    setError("");
    try {
      const input = {
        groupId: groupId(),
        description: description(),
        amount: amount(),
        currency: currency(),
        category: category(),
        expenseDate: date(),
        payerId: payerId(),
        participantIds: participants(),
        splitMethod: splitMethod(),
        splitValues: splitValues(),
        notes: notes(),
      };
      if (editingExpense) await updateExpense(editingExpense, input);
      else await createExpense(input);
      props.onOpenChange(false);
      props.onSaved(editingExpense ? "updated" : "created");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not save this expense");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content class="composer-dialog max-h-[96dvh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card shadow-2xl outline-none sm:max-w-xl sm:rounded-xl">
            <header class="sticky top-0 z-20 flex min-h-14 items-center justify-between border-b border-border bg-card/95 px-5 backdrop-blur">
              <div class="min-w-0">
                <Dialog.Title class="truncate text-base font-semibold">{props.expense ? "Edit in " : "Add to "}{currentGroup()?.name ?? "a group"}</Dialog.Title>
                <Dialog.Description class="sr-only">{props.expense ? "Update this shared expense." : "Record a shared expense."}</Dialog.Description>
              </div>
              <Dialog.CloseButton class="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Close expense form"><X size={17} /></Dialog.CloseButton>
            </header>

            <form class="grid gap-5 p-5 pb-0 sm:p-6 sm:pb-0" onSubmit={(event) => void submit(event)}>
              <Show when={!props.expense && appStore.groups().length > 1}>
                <label class="grid gap-2 text-sm font-medium">Group<select class="form-control" value={groupId()} onInput={(event) => setGroupId(event.currentTarget.value)}><For each={appStore.groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For></select></label>
              </Show>

              <label class="grid gap-2 text-sm font-medium">What was it for?<input class="form-control h-12 text-base" autofocus value={description()} onInput={(event) => setDescription(event.currentTarget.value)} placeholder="Dinner, groceries, tickets…" maxlength={200} /></label>
              <label class="grid gap-2 text-sm font-medium">Amount<div class="relative"><span class="absolute left-3 top-3 text-base text-muted-foreground">$</span><input class="form-control amount-control h-12 pl-7 font-semibold tabular-nums" inputmode="decimal" value={amount()} onInput={(event) => { setAmount(event.currentTarget.value); if (splitMethod() !== "equal") initializeValues(splitMethod()); }} placeholder="0.00" aria-label="Expense amount" /></div></label>

              <button type="button" class="summary-row group grid min-h-16 w-full grid-cols-[1fr_auto] items-center gap-3 rounded-lg border border-border bg-muted/35 px-4 text-left transition-colors hover:bg-muted/60" onClick={() => setSplitOpen((open) => !open)}>
                <div class="min-w-0"><span class="block text-xs text-muted-foreground">Paid by {payerId() === props.actorId ? "you" : payerName()}</span><strong class="block truncate text-sm font-medium">{splitSummary()}</strong></div>
                <span class="flex items-center gap-1 text-xs font-medium text-primary">Change {splitOpen() ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
              </button>

              <Show when={splitOpen()}>
                <section class="disclosure-panel grid gap-4 rounded-lg border border-border p-4" aria-label="Payer and split options">
                  <label class="grid gap-2 text-sm font-medium">Paid by<select class="form-control" value={payerId()} onInput={(event) => setPayerId(event.currentTarget.value)}><For each={groupMembers()}>{(member) => <option value={member.userId}>{member.userId === props.actorId ? "You" : member.displayName}</option>}</For></select></label>
                  <div>
                    <p class="mb-2 text-sm font-medium">Split method</p>
                    <div class="grid grid-cols-4 rounded-lg bg-muted p-1">
                      <For each={splitMethods}>{(method) => <button type="button" class="h-9 rounded-md text-xs font-medium text-muted-foreground transition-all" classList={{ "bg-card text-foreground shadow-sm": splitMethod() === method.id }} onClick={() => chooseSplitMethod(method.id)}>{method.label}</button>}</For>
                    </div>
                  </div>
                  <div class="divide-y divide-border rounded-lg border border-border">
                    <For each={groupMembers()}>{(member) => {
                      const selected = createMemo(() => participants().includes(member.userId));
                      const allocation = createMemo(() => allocations().find((item) => item.participantId === member.userId));
                      return (
                        <div class="flex min-h-14 items-center gap-3 px-3">
                          <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md border border-border transition-colors" classList={{ "border-primary bg-primary text-primary-foreground": selected() }} onClick={() => toggleParticipant(member.userId)} aria-label={(selected() ? "Exclude " : "Include ") + member.displayName} aria-pressed={selected()}><Show when={selected()}><Check size={14} /></Show></button>
                          <Avatar name={member.displayName} class="size-7 text-xs" />
                          <span class="min-w-0 flex-1 truncate text-sm font-medium">{member.userId === props.actorId ? "You" : member.displayName}</span>
                          <Show when={splitMethod() === "equal"} fallback={
                            <div class="relative w-24">
                              <Show when={splitMethod() === "exact"}><span class="absolute left-2.5 top-2 text-xs text-muted-foreground">$</span></Show>
                              <input class="form-control h-9 text-right text-sm tabular-nums" classList={{ "pl-6": splitMethod() === "exact", "pr-7": splitMethod() === "percentage" }} disabled={!selected()} inputmode="decimal" value={splitValues()[member.userId] ?? ""} onInput={(event) => setSplitValues((values) => ({ ...values, [member.userId]: event.currentTarget.value }))} aria-label={(splitMethod() === "percentage" ? "Percentage for " : splitMethod() === "shares" ? "Shares for " : "Amount for ") + member.displayName} />
                              <Show when={splitMethod() === "percentage"}><span class="absolute right-2.5 top-2 text-xs text-muted-foreground">%</span></Show>
                            </div>
                          }>
                            <span class="text-sm tabular-nums text-muted-foreground">{allocation() ? formatMinor(allocation()!.amountMinor, currency()) : "—"}</span>
                          </Show>
                        </div>
                      );
                    }}</For>
                  </div>
                  <p class="text-xs text-muted-foreground">
                    <Show when={allocations().length > 0} fallback="The split must assign the full amount.">Ready · {formatMinor(allocations().reduce((sum, item) => sum + item.amountMinor, 0), currency())} assigned</Show>
                  </p>
                </section>
              </Show>

              <button type="button" class="flex h-10 items-center justify-between text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" onClick={() => setDetailsOpen((open) => !open)}><span class="flex items-center gap-2"><SlidersHorizontal size={15} /> More details</span>{detailsOpen() ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
              <Show when={detailsOpen()}>
                <section class="disclosure-panel grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
                  <label class="grid gap-2 text-sm font-medium">Category<select class="form-control" value={category()} onInput={(event) => setCategory(event.currentTarget.value)}><option>General</option><option>Dining out</option><option>Groceries</option><option>Transportation</option><option>Hotel</option><option>Entertainment</option></select></label>
                  <label class="grid gap-2 text-sm font-medium">Date<input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} /></label>
                  <label class="grid gap-2 text-sm font-medium sm:col-span-2">Note <span class="sr-only">optional</span><textarea class="form-control min-h-20 resize-y py-2" value={notes()} onInput={(event) => setNotes(event.currentTarget.value)} placeholder="Optional note" maxlength={5000} /></label>
                </section>
              </Show>

              <Show when={error()}><p class="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error()}</p></Show>
              <footer class="sticky bottom-0 z-10 -mx-5 mt-1 grid gap-2 border-t border-border bg-card/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6">
                <Button class="h-11 w-full" type="submit" disabled={!canSave()}>
                  <Show when={saving()} fallback={<><Check size={16} /> {props.expense ? "Save changes" : "Save expense"}</>}><LoaderCircle class="animate-spin" size={16} /> Saving…</Show>
                </Button>
                <p class="text-center text-xs text-muted-foreground">Saves on this device first, then syncs automatically.</p>
              </footer>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
