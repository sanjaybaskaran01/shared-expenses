import { Dialog } from "@kobalte/core/dialog";
import CalendarDays from "lucide-solid/icons/calendar-days";
import Check from "lucide-solid/icons/check";
import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronRight from "lucide-solid/icons/chevron-right";
import ChevronUp from "lucide-solid/icons/chevron-up";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import Scale from "lucide-solid/icons/scale";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import UsersRound from "lucide-solid/icons/users-round";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { LocalExpense } from "../lib/db";
import { isLocalToday, localDateValue } from "../lib/dates";
import { validateExpenseForm, type ExpenseFormIssue } from "../lib/expense-form";
import { EXPENSE_CATEGORIES } from "../lib/expense-categories";
import { describeExpenseOutcome } from "../lib/group-insights";
import { appStore, calculateExpenseAllocations, calculateExpensePayers, createExpense, updateExpense, type SplitMethod } from "../lib/store";
import { Avatar, Button } from "./ui";

interface ExpenseComposerProps {
  open: boolean;
  actorId: string;
  initialGroupId?: string | undefined;
  initialParticipantIds?: string[] | undefined;
  targetLabel?: string | undefined;
  expense?: LocalExpense | undefined;
  onOpenChange(open: boolean): void;
  onChangeTarget?(): void;
  onSaved(mode: "created" | "updated"): void;
}

const splitMethods: Array<{ id: SplitMethod; label: string }> = [
  { id: "equal", label: "Equal" },
  { id: "shares", label: "Shares" },
  { id: "exact", label: "Amounts" },
  { id: "percentage", label: "Percent" },
];

const currencies = ["USD", "CAD", "EUR", "GBP", "INR", "AUD", "JPY", "SGD", "CHF", "CNY"];
type ComposerPanel = "none" | "payer" | "split" | "date" | "details";

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
  const [date, setDate] = createSignal(localDateValue());
  const [payerIds, setPayerIds] = createSignal<string[]>([props.actorId]);
  const [payerValues, setPayerValues] = createSignal<Record<string, string>>({});
  const [participants, setParticipants] = createSignal<string[]>([]);
  const [splitMethod, setSplitMethod] = createSignal<SplitMethod>("equal");
  const [splitValues, setSplitValues] = createSignal<Record<string, string>>({});
  const [notes, setNotes] = createSignal("");
  const [currency, setCurrency] = createSignal("USD");
  const [recurrence, setRecurrence] = createSignal<"none" | "weekly" | "fortnightly" | "monthly" | "yearly">("none");
  const [activePanel, setActivePanel] = createSignal<ComposerPanel>("none");
  const [activeSplitParticipantId, setActiveSplitParticipantId] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [formIssue, setFormIssue] = createSignal<ExpenseFormIssue>();
  let wasOpen = false;
  let initializedGroup = "";
  let dialogRef: HTMLDivElement | undefined;
  let amountInputRef: HTMLInputElement | undefined;
  let descriptionInputRef: HTMLInputElement | undefined;
  let payerControlRef: HTMLButtonElement | undefined;
  let splitControlRef: HTMLButtonElement | undefined;

  const currentGroup = createMemo(() => appStore.groups().find((group) => group.id === groupId()));
  const groupMembers = createMemo(() => appStore.members().filter((member) => member.groupId === groupId() && member.status === "active"));
  const payerSummary = createMemo(() => {
    if (payerIds().length > 1) return `${payerIds().length} people`;
    const payerId = payerIds()[0];
    return payerId === props.actorId ? "You" : groupMembers().find((member) => member.userId === payerId)?.displayName ?? "Someone";
  });

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
      setDate(editingExpense?.expenseDate ?? localDateValue());
      setNotes(editingExpense?.notes ?? "");
      setCurrency(editingExpense?.currency ?? appStore.groups().find((group) => group.id === nextGroupId)?.settlementCurrency ?? "USD");
      setRecurrence(editingExpense?.recurrence ?? "none");
      setActivePanel("none");
      setActiveSplitParticipantId(undefined);
      setError("");
      setFormIssue(undefined);
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
        setPayerIds(editingExpense.payers.map(({ participantId }) => participantId));
        setPayerValues(Object.fromEntries(editingExpense.payers.map(({ participantId, amountMinor }) => [participantId, minorInput(amountMinor)])));
        setSplitMethod(isEqual ? "equal" : "exact");
        setSplitValues(isEqual ? {} : Object.fromEntries(editingExpense.allocations.map(({ participantId, amountMinor }) => [participantId, minorInput(amountMinor)])));
        initializedGroup = nextGroupId;
      } else {
        setSplitMethod("equal");
        setSplitValues({});
        const memberIds = appStore.members().filter((member) => member.groupId === nextGroupId && member.status === "active").map((member) => member.userId);
        const requested = props.initialParticipantIds?.filter((id) => memberIds.includes(id));
        setParticipants(requested?.length ? requested : memberIds);
        setPayerIds([memberIds.includes(props.actorId) ? props.actorId : memberIds[0] ?? props.actorId]);
        setPayerValues({});
        initializedGroup = nextGroupId;
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
    setPayerIds([ids.includes(props.actorId) ? props.actorId : ids[0] ?? props.actorId]);
    setPayerValues({});
    setCurrency(currentGroup()?.settlementCurrency ?? "USD");
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

  const payers = createMemo(() => {
    try {
      return calculateExpensePayers({ amount: amount(), payerIds: payerIds(), payerValues: payerValues() });
    } catch {
      return [];
    }
  });

  const splitSummary = createMemo(() => {
    const count = participants().length;
    const people = `${count} ${count === 1 ? "person" : "people"}`;
    if (splitMethod() === "equal") return `Equal · ${people}`;
    if (splitMethod() === "exact") return `By amount · ${people}`;
    if (splitMethod() === "percentage") return `By percent · ${people}`;
    if (splitMethod() === "shares") return `Shares · ${people}`;
    return `Adjusted · ${people}`;
  });

  const outcome = createMemo(() => describeExpenseOutcome(
    payers().find((payer) => payer.participantId === props.actorId)?.amountMinor ?? 0,
    allocations().find((allocation) => allocation.participantId === props.actorId)?.amountMinor ?? 0,
  ));

  const outcomeHeadline = createMemo(() => {
    if (outcome().direction === "back") return `This expense changes your balance by +${formatMinor(outcome().differenceMinor, currency())}`;
    if (outcome().direction === "owe") return `This expense changes your balance by −${formatMinor(outcome().differenceMinor, currency())}`;
    return "This expense does not change your balance";
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
    if (method === "adjustment") {
      setSplitValues(Object.fromEntries(ids.map((id) => [id, "0.00"])));
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

  function enableMultiplePayers(): void {
    const ids = groupMembers().map(({ userId }) => userId);
    if (payerIds().length > 1) {
      setPayerIds([payerIds()[0] ?? props.actorId]);
      setPayerValues({});
      return;
    }
    setPayerIds(ids);
    try {
      const equal = calculateExpenseAllocations({ amount: amount(), participantIds: ids, splitMethod: "equal", splitValues: {} });
      setPayerValues(Object.fromEntries(equal.map((item) => [item.participantId, minorInput(item.amountMinor)])));
    } catch {
      setPayerValues(Object.fromEntries(ids.map((id) => [id, "0.00"])));
    }
  }

  function togglePayer(userId: string): void {
    setPayerIds((current) => current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  }

  function chooseSplitMethod(method: SplitMethod): void {
    setSplitMethod(method);
    initializeValues(method);
    setActiveSplitParticipantId(method === "exact" || method === "percentage" ? participants()[0] : undefined);
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

  function updateAmount(value: string): void {
    const normalized = value.replace(/,/g, ".").replace(/[^\d.]/g, "");
    const [whole = "", ...decimalParts] = normalized.split(".");
    const next = decimalParts.length ? `${whole.slice(0, 7)}.${decimalParts.join("").slice(0, 2)}` : whole.slice(0, 7);
    setAmount(next);
    if (splitMethod() !== "equal") initializeValues(splitMethod());
  }

  function togglePanel(panel: Exclude<ComposerPanel, "none">): void {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setActivePanel((current) => current === panel ? "none" : panel);
  }

  function changeShares(userId: string, delta: number): void {
    const current = Number(splitValues()[userId] ?? "1");
    setSplitValues((values) => ({ ...values, [userId]: String(Math.max(0, current + delta)) }));
  }

  const exactLeftoverMinor = createMemo(() => {
    if (splitMethod() !== "exact") return 0;
    const totalMinor = Math.round((Number(amount()) || 0) * 100);
    const assigned = participants().reduce((sum, id) => sum + Math.round((Number(splitValues()[id]) || 0) * 100), 0);
    return totalMinor - assigned;
  });

  function assignExactRemainder(): void {
    const target = activeSplitParticipantId() ?? participants().at(-1);
    if (!target || exactLeftoverMinor() <= 0) return;
    const next = (Number(splitValues()[target] ?? "0") * 100 + exactLeftoverMinor()) / 100;
    setSplitValues((values) => ({ ...values, [target]: next.toFixed(2) }));
    setActiveSplitParticipantId(target);
  }

  function keepSplitInputVisible(element: HTMLInputElement, participantId: string): void {
    setActiveSplitParticipantId(participantId);
    queueMicrotask(() => element.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    }));
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const editingExpense = props.expense;
    setError("");
    const issue = validateExpenseForm({
      amount: amount(),
      description: description(),
      payersValid: payers().length > 0,
      allocationsValid: allocations().length > 0,
    });
    setFormIssue(issue);
    if (issue) {
      setError(issue.message);
      if (issue.field === "amount") amountInputRef?.focus();
      else if (issue.field === "description") descriptionInputRef?.focus();
      else if (issue.field === "payer") {
        setActivePanel("payer");
        queueMicrotask(() => payerControlRef?.focus());
      } else {
        setActivePanel("split");
        queueMicrotask(() => splitControlRef?.focus());
      }
      return;
    }
    setSaving(true);
    try {
      const input = {
        groupId: groupId(),
        description: description(),
        amount: amount(),
        currency: currency(),
        category: category(),
        expenseDate: date(),
        payerIds: payerIds(),
        payerValues: payerValues(),
        participantIds: participants(),
        splitMethod: splitMethod(),
        splitValues: splitValues(),
        notes: notes(),
        recurrence: recurrence(),
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
          <Dialog.Content
            ref={dialogRef}
            role="dialog"
            class="composer-dialog max-h-[100dvh] w-full overflow-y-auto border border-border bg-card outline-none sm:max-h-[94dvh] sm:max-w-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => props.expense ? dialogRef?.focus() : amountInputRef?.focus());
            }}
          >
            <header class="composer-header sticky top-0 z-20 grid min-h-14 grid-cols-[1fr_auto_1fr] items-center border-b border-border bg-card px-4">
              <Dialog.CloseButton class="expense-cancel-action justify-self-start text-sm font-medium text-muted-foreground" aria-label="Cancel expense form">Cancel</Dialog.CloseButton>
              <div class="min-w-0 text-center">
                <Dialog.Title class="truncate text-base font-semibold">{props.expense ? "Edit expense" : "Add an expense"}</Dialog.Title>
                <Dialog.Description class="sr-only">{props.expense ? "Update this shared expense." : "Record a shared expense."}</Dialog.Description>
              </div>
              <span />
            </header>

            <form class="grid gap-4 p-4 pb-0 sm:p-6 sm:pb-0" onSubmit={(event) => void submit(event)}>
              <Show when={!props.expense && props.onChangeTarget} fallback={
                <div class="expense-context-row">
                  <span class="target-icon"><UsersRound size={17} /></span>
                  <span class="min-w-0 flex-1"><small>Group</small><strong>{currentGroup()?.name ?? "Choose a group"}</strong></span>
                </div>
              }>
                <button
                  type="button"
                  class="expense-context-row w-full text-left"
                  aria-label={`Change expense group, currently ${props.targetLabel ?? currentGroup()?.name ?? "not selected"}`}
                  onClick={props.onChangeTarget}
                >
                  <span class="target-icon"><UsersRound size={17} /></span>
                  <span class="min-w-0 flex-1"><small>With</small><strong>{props.targetLabel ?? currentGroup()?.name ?? "Choose a group"}</strong><Show when={props.targetLabel && props.targetLabel !== currentGroup()?.name}><em>in {currentGroup()?.name}</em></Show></span>
                  <span class="expense-context-change">Change <ChevronRight size={14} /></span>
                </button>
              </Show>

              <label class="amount-stage">
                <span class="micro-label">Total · {currency()}</span>
                <span class="amount-native-row">
                  <span aria-hidden="true">{new Intl.NumberFormat(undefined, { style: "currency", currency: currency(), currencyDisplay: "narrowSymbol" }).formatToParts(0).find((part) => part.type === "currency")?.value ?? currency()}</span>
                  <input
                    ref={amountInputRef}
                    class="money-type amount-native-input"
                    value={amount()}
                    onInput={(event) => {
                      updateAmount(event.currentTarget.value);
                      if (formIssue()?.field === "amount") { setFormIssue(undefined); setError(""); }
                    }}
                    inputmode="decimal"
                    enterkeyhint="next"
                    autocomplete="off"
                    placeholder="0.00"
                    aria-label={`Total in ${currency()}`}
                    aria-invalid={formIssue()?.field === "amount"}
                    aria-describedby={formIssue()?.field === "amount" ? "expense-form-error" : undefined}
                  />
                </span>
              </label>

              <label class="description-field"><span class="sr-only">What was it for?</span><input ref={descriptionInputRef} value={description()} onInput={(event) => { setDescription(event.currentTarget.value); if (formIssue()?.field === "description") { setFormIssue(undefined); setError(""); } }} placeholder="What was it for?" maxlength={200} autocomplete="off" aria-invalid={formIssue()?.field === "description"} aria-describedby={formIssue()?.field === "description" ? "expense-form-error" : undefined} /></label>

              <div class="expense-quick-controls" aria-label="Expense details">
                <button ref={payerControlRef} type="button" class="quick-control tone-payer" aria-expanded={activePanel() === "payer"} aria-controls="payer-panel" aria-invalid={formIssue()?.field === "payer"} aria-describedby={formIssue()?.field === "payer" ? "expense-form-error" : undefined} onClick={() => { if (formIssue()?.field === "payer") { setFormIssue(undefined); setError(""); } togglePanel("payer"); }}>
                  <span class="quick-control-icon"><UsersRound size={16} /></span><span class="quick-control-label">Paid by</span><strong>{payerSummary()}</strong><ChevronDown size={15} />
                </button>
                <button ref={splitControlRef} type="button" class="quick-control tone-split" aria-expanded={activePanel() === "split"} aria-controls="split-panel" aria-invalid={formIssue()?.field === "split"} aria-describedby={formIssue()?.field === "split" ? "expense-form-error" : undefined} onClick={() => { if (formIssue()?.field === "split") { setFormIssue(undefined); setError(""); } togglePanel("split"); }}>
                  <span class="quick-control-icon"><Scale size={16} /></span><span class="quick-control-label">Split</span><strong>{splitSummary()}</strong><ChevronDown size={15} />
                </button>
                <button type="button" class="quick-control tone-date" aria-expanded={activePanel() === "date"} aria-controls="date-panel" onClick={() => togglePanel("date")}>
                  <span class="quick-control-icon"><CalendarDays size={16} /></span><span class="quick-control-label">Date</span><strong>{isLocalToday(date()) ? "Today" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${date()}T12:00:00`))}</strong><ChevronDown size={15} />
                </button>
              </div>

              <Show when={Number(amount()) > 0 && payers().length > 0 && allocations().length > 0}>
                <section class="expense-outcome" aria-label="Effect of this expense">
                  <div><span>Your part of this expense</span><strong>{outcomeHeadline()}</strong></div>
                  <p>You paid {formatMinor(outcome().actorPaidMinor, currency())} · your share is {formatMinor(outcome().actorShareMinor, currency())}</p>
                </section>
              </Show>

              <Show when={activePanel() === "payer"}>
                <section id="payer-panel" class="disclosure-panel split-panel grid gap-3 border border-border p-4" aria-label="Choose who paid">
                  <div class="disclosure-heading"><div><p>Who paid?</p><small>Choose one person, or use multiple payers.</small></div><button type="button" onClick={() => setActivePanel("none")}>Done</button></div>
                  <div class="flex items-center justify-end"><Show when={groupMembers().length > 1}><button type="button" class="flex min-h-11 items-center gap-1.5 px-2 text-xs font-semibold text-primary" onClick={enableMultiplePayers}><UsersRound size={14} />{payerIds().length > 1 ? "Use one payer" : "Multiple payers"}</button></Show></div>
                  <Show when={payerIds().length > 1} fallback={<div class="payer-avatar-rail"><For each={groupMembers()}>{(member) => <button type="button" class="payer-avatar-choice" classList={{ active: payerIds()[0] === member.userId }} aria-pressed={payerIds()[0] === member.userId} onClick={() => { setPayerIds([member.userId]); setPayerValues({}); setActivePanel("none"); }}><Avatar name={member.displayName} class="size-9 text-xs" /><span>{member.userId === props.actorId ? "You" : member.displayName}</span></button>}</For></div>}>
                    <div class="divide-y divide-border rounded-xl border border-border bg-background/55">
                      <For each={groupMembers()}>{(member) => <div class="flex min-h-14 items-center gap-2 px-2"><button type="button" role="checkbox" class="participant-toggle grid size-11 place-items-center rounded-md border border-border" classList={{ "border-primary bg-primary text-primary-foreground": payerIds().includes(member.userId) }} onClick={() => togglePayer(member.userId)} aria-label={`${member.displayName} paid`} aria-checked={payerIds().includes(member.userId)}><Show when={payerIds().includes(member.userId)}><Check size={14} /></Show></button><Avatar name={member.displayName} class="size-7 text-xs" /><span class="min-w-0 flex-1 truncate text-sm font-medium">{member.userId === props.actorId ? "You" : member.displayName}</span><div class="relative w-24"><input class="form-control h-11 text-right text-sm tabular-nums" disabled={!payerIds().includes(member.userId)} inputmode="decimal" value={payerValues()[member.userId] ?? ""} onInput={(event) => setPayerValues((values) => ({ ...values, [member.userId]: event.currentTarget.value }))} aria-label={`Amount paid by ${member.displayName}`} /></div></div>}</For>
                    </div>
                  </Show>
                </section>
              </Show>

              <Show when={activePanel() === "split"}>
                <section id="split-panel" class="disclosure-panel split-panel grid gap-4 border border-border p-4" aria-label="Choose how to split">
                  <div class="disclosure-heading"><div><p>Who owes what?</p><small>{splitMethod() === "equal" ? "The total is divided equally among everyone selected." : splitMethod() === "shares" ? "Give someone more shares when they should cover more of the total." : splitMethod() === "exact" ? "Enter the exact amount each person should cover." : "Enter the percentage each person should cover."}</small></div><button type="button" onClick={() => setActivePanel("none")}>Done</button></div>
                  <div>
                    <p class="mb-2 text-sm font-medium">Split method</p>
                    <div class="split-mode-tabs grid grid-cols-4">
                      <For each={splitMethods}>{(method) => <button type="button" class="h-11 rounded-md text-xs font-medium text-muted-foreground transition-[color,background-color,border-color,box-shadow,transform]" classList={{ "bg-card text-foreground shadow-sm": splitMethod() === method.id }} aria-pressed={splitMethod() === method.id} onClick={() => chooseSplitMethod(method.id)}>{method.label}</button>}</For>
                    </div>
                  </div>
                  <div class="split-people-list divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    <For each={groupMembers()}>{(member) => {
                      const selected = createMemo(() => participants().includes(member.userId));
                      const allocation = createMemo(() => allocations().find((item) => item.participantId === member.userId));
                      return (
                        <div class="split-person-row flex min-h-14 items-center gap-3 px-3" classList={{ active: activeSplitParticipantId() === member.userId }} onClick={() => selected() && (splitMethod() === "exact" || splitMethod() === "percentage") && setActiveSplitParticipantId(member.userId)}>
                          <button type="button" role="checkbox" class="participant-toggle grid size-11 shrink-0 place-items-center rounded-md border border-border transition-colors" classList={{ "border-primary bg-primary text-primary-foreground": selected() }} disabled={selected() && participants().length === 1} onClick={() => toggleParticipant(member.userId)} aria-label={`Include ${member.displayName}`} aria-checked={selected()}><Show when={selected()}><Check size={14} /></Show></button>
                          <Avatar name={member.displayName} class="size-7 text-xs" />
                          <span class="min-w-0 flex-1 truncate text-sm font-medium">{member.userId === props.actorId ? "You" : member.displayName}</span>
                          <Show when={splitMethod() === "equal"} fallback={<Show when={splitMethod() === "shares"} fallback={
                            <div class="relative w-24">
                              <Show when={splitMethod() === "exact" || splitMethod() === "adjustment"}><span class="absolute left-2.5 top-2 text-xs text-muted-foreground">{splitMethod() === "adjustment" ? "±" : currency()}</span></Show>
                              <input class="form-control h-11 text-right text-sm tabular-nums" classList={{ "pl-6": splitMethod() === "exact" || splitMethod() === "adjustment", "pr-7": splitMethod() === "percentage" }} disabled={!selected()} inputmode="decimal" value={splitValues()[member.userId] ?? ""} onFocus={(event) => keepSplitInputVisible(event.currentTarget, member.userId)} onInput={(event) => setSplitValues((values) => ({ ...values, [member.userId]: event.currentTarget.value }))} aria-label={(splitMethod() === "percentage" ? "Percentage for " : splitMethod() === "adjustment" ? "Adjustment for " : "Amount for ") + member.displayName} />
                              <Show when={splitMethod() === "percentage"}><span class="absolute right-2.5 top-2 text-xs text-muted-foreground">%</span></Show>
                            </div>
                          }><div class="share-stepper"><button type="button" onClick={() => changeShares(member.userId, -1)} aria-label={`Remove a share from ${member.displayName}`}>−</button><strong>{splitValues()[member.userId] ?? "1"}×</strong><button type="button" onClick={() => changeShares(member.userId, 1)} aria-label={`Add a share to ${member.displayName}`}>+</button></div></Show>}>
                            <span class="text-sm tabular-nums text-muted-foreground">{allocation() ? formatMinor(allocation()!.amountMinor, currency()) : "—"}</span>
                          </Show>
                        </div>
                      );
                    }}</For>
                  </div>
                  <div class="split-status"><span class="micro-label"><Show when={splitMethod() === "exact" && exactLeftoverMinor() !== 0} fallback={<Show when={allocations().length > 0} fallback="The split must assign the full amount.">Fully split · {formatMinor(allocations().reduce((sum, item) => sum + item.amountMinor, 0), currency())}</Show>}>{formatMinor(Math.abs(exactLeftoverMinor()), currency())} {exactLeftoverMinor() > 0 ? "left over" : "over assigned"}</Show></span><Show when={splitMethod() === "exact" && exactLeftoverMinor() > 0}><button type="button" onClick={assignExactRemainder}>Give it to {groupMembers().find((member) => member.userId === (activeSplitParticipantId() ?? participants().at(-1)))?.displayName ?? "last person"}</button></Show></div>
                </section>
              </Show>

              <Show when={activePanel() === "date"}>
                <section id="date-panel" class="disclosure-panel split-panel grid gap-3 border border-border p-4" aria-label="Choose expense date">
                  <div class="disclosure-heading"><div><p>When was it?</p><small>Today is selected by default.</small></div><button type="button" onClick={() => setActivePanel("none")}>Done</button></div>
                  <div class="date-choice-row">
                    <button type="button" classList={{ active: isLocalToday(date()) }} onClick={() => { setDate(localDateValue()); setActivePanel("none"); }}>Today</button>
                    <label><span class="sr-only">Expense date</span><input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} onChange={() => setActivePanel("none")} /></label>
                  </div>
                </section>
              </Show>

              <button type="button" class="details-disclosure" aria-expanded={activePanel() === "details"} onClick={() => togglePanel("details")}><span class="flex items-center gap-2"><SlidersHorizontal size={15} /> {activePanel() === "details" ? "Hide details" : "More details"}</span>{activePanel() === "details" ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
              <Show when={activePanel() === "details"}>
                <section class="disclosure-panel grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2" aria-label="More expense details">
                  <div class="disclosure-heading sm:col-span-2"><div><p>More details</p><small>Optional fields for bookkeeping.</small></div><button type="button" onClick={() => setActivePanel("none")}>Done</button></div>
                  <label class="grid gap-2 text-sm font-medium">Category<select class="form-control" value={category()} onInput={(event) => setCategory(event.currentTarget.value)}><For each={EXPENSE_CATEGORIES}>{(item) => <option>{item}</option>}</For></select></label>
                  <label class="grid gap-2 text-sm font-medium">Currency<select class="form-control" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)}><For each={currencies}>{(item) => <option value={item}>{item}</option>}</For></select></label>
                  <label class="grid gap-2 text-sm font-medium sm:col-span-2">Note <span class="sr-only">optional</span><textarea class="form-control min-h-20 resize-y py-2" value={notes()} onInput={(event) => setNotes(event.currentTarget.value)} placeholder="Optional note" maxlength={5000} /></label>
                </section>
              </Show>

              <Show when={error()}><p id="expense-form-error" class="error-callout" role="alert">{error()}</p></Show>
              <footer class="sticky bottom-0 z-10 -mx-4 mt-1 grid gap-2 border-t border-border bg-card/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6">
                <Button class="h-11 w-full" type="submit" disabled={saving()}>
                  <Show when={saving()} fallback={<><Check size={16} /> {props.expense ? "Save changes" : `Add ${formatMinor(Math.round((Number(amount()) || 0) * 100), currency())}`}</>}><LoaderCircle class="animate-spin" size={16} /> Saving…</Show>
                </Button>
                <p class="micro-label text-center">Saved on this device first · syncs automatically</p>
              </footer>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
