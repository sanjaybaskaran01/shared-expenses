import { Dialog } from "@kobalte/core/dialog";
import CalendarDays from "lucide-solid/icons/calendar-days";
import Check from "lucide-solid/icons/check";
import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronRight from "lucide-solid/icons/chevron-right";
import ChevronUp from "lucide-solid/icons/chevron-up";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import Scale from "lucide-solid/icons/scale";
import Sparkles from "lucide-solid/icons/sparkles";
import SlidersHorizontal from "lucide-solid/icons/sliders-horizontal";
import UsersRound from "lucide-solid/icons/users-round";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { LocalExpense } from "../lib/db";
import { isLocalToday, localDateValue } from "../lib/dates";
import { initialExpenseEntryMode, initialExpenseFocusTarget, shouldDismissKeyboardForPanel, type ExpenseEntryMode } from "../lib/expense-composer-state";
import { validateExpenseForm, type ExpenseFormIssue } from "../lib/expense-form";
import { EXPENSE_CATEGORIES, suggestExpenseCategory } from "../lib/expense-categories";
import { parseExpenseLanguage, type ExpenseLanguageChip, type ExpenseLanguageIssue, type ParsedExpenseLanguage } from "../lib/expense-language";
import { describeExpenseOutcome } from "../lib/group-insights";
import { pendingExpenseMemberLabel } from "../lib/group-settings";
import { isVisibleGroupMember } from "../lib/member-label";
import { appStore, calculateExpenseAllocations, calculateExpensePayers, createExpense, updateExpense, type SplitMethod } from "../lib/store";
import { CategoryMark } from "./CategoryMark";
import { Avatar, Button } from "./ui";

interface ExpenseComposerProps {
  open: boolean;
  actorId: string;
  initialGroupId?: string | undefined;
  initialParticipantIds?: string[] | undefined;
  targetLabel?: string | undefined;
  expense?: LocalExpense | undefined;
  smartCategoriesEnabled?: boolean | undefined;
  onOpenChange(open: boolean): void;
  onChangeTarget?(): void;
  onSaved(mode: "created" | "updated"): void;
}

const splitMethods: Array<{ id: SplitMethod; label: string }> = [
  { id: "equal", label: "Equal" },
  { id: "shares", label: "Shares" },
  { id: "exact", label: "Amounts" },
  { id: "percentage", label: "Percent" },
  { id: "adjustment", label: "Adjust" },
];

const currencies = ["USD", "CAD", "EUR", "GBP", "INR", "AUD", "JPY", "SGD", "CHF", "CNY"];
type ComposerPanel = "none" | "payer" | "split" | "date" | "details";
type Recurrence = "none" | "weekly" | "fortnightly" | "monthly" | "yearly";

function formatMinor(amountMinor: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function minorInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

const languageSafetyIssueCodes = new Set<ExpenseLanguageIssue["code"]>([
  "ambiguous-fact",
  "hedged-split",
  "refund-or-transfer",
  "untrusted-instruction",
]);

function languageFormIssue(draft: ParsedExpenseLanguage): ExpenseFormIssue | undefined {
  if (!draft.amount) return { field: "amount", message: "Enter the expense amount." };
  if (!draft.description) return { field: "description", message: "Add what this expense was for." };
  const payerIssue = draft.issues.find((issue) => issue.code === "payer-unspecified" || issue.code === "invalid-payers");
  if (payerIssue) return { field: "payer", message: payerIssue.message };
  const splitIssue = draft.issues.find((issue) => issue.code === "invalid-split" || issue.code === "hedged-split" || issue.code === "unknown-member" || issue.code === "ambiguous-member");
  return splitIssue ? { field: "split", message: splitIssue.message } : undefined;
}

export function ExpenseComposer(props: ExpenseComposerProps) {
  const [entryMode, setEntryMode] = createSignal<ExpenseEntryMode>(initialExpenseEntryMode(false));
  const [languageText, setLanguageText] = createSignal("");
  const [groupId, setGroupId] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [category, setCategory] = createSignal("General");
  const [categoryEdited, setCategoryEdited] = createSignal(false);
  const [date, setDate] = createSignal(localDateValue());
  const [payerIds, setPayerIds] = createSignal<string[]>([props.actorId]);
  const [payerValues, setPayerValues] = createSignal<Record<string, string>>({});
  const [participants, setParticipants] = createSignal<string[]>([]);
  const [splitMethod, setSplitMethod] = createSignal<SplitMethod>("equal");
  const [splitValues, setSplitValues] = createSignal<Record<string, string>>({});
  const [notes, setNotes] = createSignal("");
  const [currency, setCurrency] = createSignal("USD");
  const [recurrence, setRecurrence] = createSignal<Recurrence>("none");
  const [activePanel, setActivePanel] = createSignal<ComposerPanel>("none");
  const [activeSplitParticipantId, setActiveSplitParticipantId] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [formIssue, setFormIssue] = createSignal<ExpenseFormIssue>();
  const [announcedLanguageStatus, setAnnouncedLanguageStatus] = createSignal("");
  const [languageSafetyIssues, setLanguageSafetyIssues] = createSignal<ExpenseLanguageIssue[]>([]);
  const [languageSafetyConfirmed, setLanguageSafetyConfirmed] = createSignal(false);
  let wasOpen = false;
  let initializedGroup = "";
  let dialogRef: HTMLDivElement | undefined;
  let languageInputRef: HTMLTextAreaElement | undefined;
  let amountInputRef: HTMLInputElement | undefined;
  let descriptionInputRef: HTMLInputElement | undefined;
  let payerControlRef: HTMLButtonElement | undefined;
  let splitControlRef: HTMLButtonElement | undefined;
  let dateControlRef: HTMLButtonElement | undefined;
  let detailsControlRef: HTMLButtonElement | undefined;
  let languageSafetyConfirmationRef: HTMLInputElement | undefined;
  let categorySelectRef: HTMLSelectElement | undefined;

  const currentGroup = createMemo(() => appStore.groups().find((group) => group.id === groupId()));
  const groupMembers = createMemo(() => appStore.members().filter((member) => member.groupId === groupId() && isVisibleGroupMember(member.status)));
  const languageDraft = createMemo(() => {
    const text = languageText().trim();
    if (!text) return undefined;
    return parseExpenseLanguage(text, {
      members: groupMembers().map((member) => ({ userId: member.userId, displayName: member.displayName, isActor: member.userId === props.actorId })),
      defaultCurrency: currency(),
      defaultParticipantIds: participants(),
    });
  });
  const languageStatusText = createMemo(() => {
    const draft = languageDraft();
    if (!draft) return "";
    if (draft.status === "ready") return "Expense details are ready to add.";
    const details = `${draft.issues.length} ${draft.issues.length === 1 ? "detail" : "details"}`;
    return draft.status === "incomplete"
      ? `Complete ${details} in the form before adding this expense.`
      : `Review ${details} before adding this expense.`;
  });
  const categorySuggestion = createMemo(() => props.smartCategoriesEnabled && !props.expense
    ? suggestExpenseCategory(description(), appStore.expenses().filter((expense) => expense.status === "active"))
    : undefined);
  const pendingCategorySuggestion = createMemo(() => categorySuggestion()?.action === "suggest" && category() === "General" && !categoryEdited());
  const visibleCategory = createMemo(() => pendingCategorySuggestion() ? categorySuggestion()?.category ?? "General" : category());
  const payerSummary = createMemo(() => {
    if (payerIds().length > 1) return `${payerIds().length} people`;
    const payerId = payerIds()[0];
    return payerId === props.actorId ? "You" : groupMembers().find((member) => member.userId === payerId)?.displayName ?? "Choose payer";
  });

  createEffect(() => {
    const message = languageStatusText();
    if (!message) {
      setAnnouncedLanguageStatus("");
      return;
    }
    const timeout = setTimeout(() => setAnnouncedLanguageStatus(message), 350);
    onCleanup(() => clearTimeout(timeout));
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
      setCategoryEdited(Boolean(editingExpense));
      setDate(editingExpense?.expenseDate ?? localDateValue());
      setNotes(editingExpense?.notes ?? "");
      setCurrency(editingExpense?.currency ?? appStore.groups().find((group) => group.id === nextGroupId)?.settlementCurrency ?? "USD");
      setRecurrence(editingExpense?.recurrence ?? "none");
      setEntryMode(initialExpenseEntryMode(Boolean(editingExpense)));
      setLanguageText("");
      setActivePanel("none");
      setActiveSplitParticipantId(undefined);
      setError("");
      setFormIssue(undefined);
      setLanguageSafetyIssues([]);
      setLanguageSafetyConfirmed(false);
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
        const memberIds = appStore.members().filter((member) => member.groupId === nextGroupId && isVisibleGroupMember(member.status)).map((member) => member.userId);
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
    if (!props.open || props.expense || categoryEdited()) return;
    const suggestion = categorySuggestion();
    setCategory(suggestion?.action === "apply" ? suggestion.category : "General");
  });

  function useOrEditCategory(): void {
    const suggestion = categorySuggestion();
    if (pendingCategorySuggestion() && suggestion) {
      setCategory(suggestion.category);
      setCategoryEdited(true);
      return;
    }
    setActivePanel("details");
    queueMicrotask(() => categorySelectRef?.focus());
  }

  function applyLanguageDraft(): boolean {
    const draft = languageDraft();
    if (!draft) return false;
    setAmount(draft.amount ?? "");
    setDescription(draft.description ?? "");
    setCurrency(draft.currency);
    setDate(draft.expenseDate);
    setPayerIds(draft.payerIds);
    setPayerValues(draft.payerValues);
    setParticipants(draft.participantIds);
    setSplitMethod(draft.splitMethod);
    setSplitValues(draft.splitValues);
    setRecurrence(draft.recurrence);
    setLanguageSafetyIssues(draft.issues.filter((issue) => languageSafetyIssueCodes.has(issue.code)));
    setLanguageSafetyConfirmed(false);
    setFormIssue(undefined);
    setError("");
    return true;
  }

  function editLanguageField(field?: ExpenseLanguageChip["field"]): void {
    const draft = languageDraft();
    if (!applyLanguageDraft()) return;
    const reviewIssue = !field && draft ? languageFormIssue(draft) : undefined;
    if (reviewIssue) {
      setFormIssue(reviewIssue);
      setError(reviewIssue.message);
    } else if (!field && draft?.status !== "ready") {
      setError(draft?.issues[0]?.message ?? "Review the expense details before adding.");
    }
    setEntryMode("form");
    queueMicrotask(() => {
      const focusField = field ?? reviewIssue?.field;
      if (focusField === "amount") amountInputRef?.focus();
      else if (focusField === "description") descriptionInputRef?.focus();
      else if (focusField === "payer") {
        setActivePanel("payer");
        payerControlRef?.focus();
      } else if (focusField === "split" || focusField === "participants") {
        setActivePanel("split");
        splitControlRef?.focus();
      } else if (focusField === "date") {
        setActivePanel("date");
        dateControlRef?.focus();
      } else if (focusField === "recurrence") {
        setActivePanel("details");
        detailsControlRef?.focus();
      } else descriptionInputRef?.focus();
    });
  }

  async function submitLanguageDraft(): Promise<void> {
    const draft = languageDraft();
    if (!draft || draft.status !== "ready" || !draft.amount || !draft.description) return;
    setSaving(true);
    setError("");
    try {
      const suggestion = props.smartCategoriesEnabled
        ? suggestExpenseCategory(draft.description, appStore.expenses().filter((expense) => expense.status === "active"))
        : undefined;
      await createExpense({
        groupId: groupId(),
        description: draft.description,
        amount: draft.amount,
        currency: draft.currency,
        category: suggestion?.action === "apply" ? suggestion.category : "General",
        expenseDate: draft.expenseDate,
        payerIds: draft.payerIds,
        payerValues: draft.payerValues,
        participantIds: draft.participantIds,
        splitMethod: draft.splitMethod,
        splitValues: draft.splitValues,
        notes: "",
        recurrence: draft.recurrence,
      });
      props.onOpenChange(false);
      props.onSaved("created");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to save this expense. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

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

  function panelTrigger(panel: Exclude<ComposerPanel, "none">): HTMLButtonElement | undefined {
    if (panel === "payer") return payerControlRef;
    if (panel === "split") return splitControlRef;
    if (panel === "date") return dateControlRef;
    return detailsControlRef;
  }

  function closePanel(): void {
    const panel = activePanel();
    setActivePanel("none");
    if (panel !== "none") queueMicrotask(() => panelTrigger(panel)?.focus());
  }

  function togglePanel(panel: Exclude<ComposerPanel, "none">): void {
    if (activePanel() !== panel) {
      const activeElement = document.activeElement as HTMLElement | null;
      const dismissKeyboard = shouldDismissKeyboardForPanel(panel, activeElement?.tagName);
      if (dismissKeyboard) activeElement?.blur();
      if (dismissKeyboard) {
        window.setTimeout(() => setActivePanel(panel), 120);
      } else {
        setActivePanel(panel);
      }
      return;
    }
    closePanel();
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
    if (languageSafetyIssues().length > 0 && !languageSafetyConfirmed()) {
      setError("Review the warning and confirm that this is a new expense.");
      queueMicrotask(() => languageSafetyConfirmationRef?.focus());
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
      setError(submitError instanceof Error ? submitError.message : "Unable to save this expense. Check your connection and try again.");
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
            tabindex={-1}
            class="composer-dialog max-h-[100dvh] w-full overflow-y-auto border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:max-h-[94dvh] sm:max-w-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => {
                if (initialExpenseFocusTarget(Boolean(props.expense)) === "amount") amountInputRef?.focus();
                else dialogRef?.focus();
              });
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

            <form class="expense-form grid gap-4 p-4 pb-0 sm:p-6 sm:pb-0" onSubmit={(event) => void submit(event)}>
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

              <Show when={!props.expense && entryMode() === "natural"}>
                <section
                  class="language-entry"
                  classList={{
                    "has-draft": Boolean(languageDraft()),
                    "is-ready": languageDraft()?.status === "ready",
                    "is-review": languageDraft()?.status === "needs-review",
                    "is-incomplete": languageDraft()?.status === "incomplete",
                  }}
                  aria-labelledby="language-entry-title"
                >
                  <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcedLanguageStatus()}</p>
                  <div class="language-entry-heading">
                    <span class="language-entry-mark" aria-hidden="true"><Sparkles size={17} stroke-width={2} /></span>
                    <div class="min-w-0 flex-1">
                      <strong id="language-entry-title">Describe the expense</strong>
                      <small>Include the total, payer, and split in one sentence.</small>
                    </div>
                    <button type="button" onClick={() => { setEntryMode("form"); queueMicrotask(() => amountInputRef?.focus()); }}>Open form</button>
                  </div>
                  <label class="language-entry-input">
                    <span class="sr-only">Describe the expense in plain English</span>
                    <textarea
                      ref={languageInputRef}
                      value={languageText()}
                      onInput={(event) => { setLanguageText(event.currentTarget.value); setError(""); }}
                      name="expense-language"
                      placeholder="I paid $35 for lunch with Maya and Rishi, split equally"
                      autocomplete="off"
                      autocapitalize="sentences"
                      enterkeyhint="done"
                      maxlength={500}
                    />
                  </label>
                  <Show when={languageDraft()}>{(draft) => (
                    <div
                      class="language-understanding"
                      classList={{
                        "is-ready": draft().status === "ready",
                        "is-review": draft().status === "needs-review",
                        "is-incomplete": draft().status === "incomplete",
                      }}
                    >
                      <div class="language-understanding-meta">
                        <span>
                          <i aria-hidden="true" />
                          <strong>{draft().status === "ready" ? "Ready to add" : draft().status === "needs-review" ? "Review details" : "Complete details"}</strong>
                          <small>{draft().status === "ready" ? "Details found" : `${draft().issues.length} ${draft().issues.length === 1 ? "detail needs" : "details need"} confirmation`}</small>
                        </span>
                        <small class="language-understanding-local">On this device</small>
                      </div>
                      <div class="language-chip-list" aria-label="Recognized expense details. Select a detail to edit it.">
                        <For each={draft().chips}>{(chip) => (
                          <button type="button" onClick={() => editLanguageField(chip.field)}>
                            <span>{chip.label}</span><strong>{chip.value}</strong>
                          </button>
                        )}</For>
                      </div>
                      <Show when={draft().issues.length}>
                        <ul class="language-issues">
                          <For each={draft().issues}>{(issue) => <li>{issue.message}</li>}</For>
                        </ul>
                      </Show>
                    </div>
                  )}</Show>
                  <p class="language-privacy"><span aria-hidden="true">●</span> Private on this device. Your text is never uploaded.</p>
                </section>

                <Show when={error()}><p id="expense-language-error" class="error-callout" role="alert">{error()}</p></Show>
                <footer class="language-entry-footer sticky bottom-0 z-10 -mx-4 mt-1 grid gap-2 border-t border-border bg-card/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6">
                  <Button
                    class="h-11 w-full"
                    type="button"
                    disabled={!languageDraft() || saving()}
                    onClick={() => languageDraft()?.status === "ready" ? void submitLanguageDraft() : editLanguageField()}
                  >
                    <Show when={saving()} fallback={<><Check size={16} /> {languageDraft()?.status === "ready" && languageDraft()?.amount ? `Add ${formatMinor(Math.round(Number(languageDraft()!.amount) * 100), languageDraft()!.currency)}` : languageDraft()?.status === "incomplete" ? "Complete expense" : "Review details"}</>}><LoaderCircle class="animate-spin" size={16} /> Saving…</Show>
                  </Button>
                  <p class="micro-label text-center">Select a detail to change it before adding.</p>
                </footer>
              </Show>

              <Show when={props.expense || entryMode() === "form"}>
              <Show when={!props.expense}>
                <button type="button" class="language-mode-return" onClick={() => { setEntryMode("natural"); queueMicrotask(() => languageInputRef?.focus()); }}><Sparkles size={15} /> Use one-sentence entry</button>
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
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      descriptionInputRef?.focus();
                    }}
                  />
                </span>
              </label>

              <label class="description-field"><span class="micro-label">Description</span><input ref={descriptionInputRef} value={description()} onInput={(event) => { setDescription(event.currentTarget.value); if (formIssue()?.field === "description") { setFormIssue(undefined); setError(""); } }} placeholder="e.g. Dinner" maxlength={200} autocomplete="off" enterkeyhint="done" aria-invalid={formIssue()?.field === "description"} aria-describedby={formIssue()?.field === "description" ? "expense-form-error" : undefined} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>

              <Show when={props.smartCategoriesEnabled && description().trim()}>
                <button type="button" class="expense-category-control" onClick={useOrEditCategory} aria-label={`${pendingCategorySuggestion() ? "Suggested" : "Category"} ${visibleCategory()}. ${pendingCategorySuggestion() ? "Use suggestion" : "Change category"}`}>
                  <CategoryMark category={visibleCategory()} compact />
                  <span><small>{pendingCategorySuggestion() ? "Suggested category" : "Category"}</small><strong>{visibleCategory()}</strong></span>
                  <span class="expense-category-source">
                    {pendingCategorySuggestion()
                      ? "Use category"
                      : categorySuggestion()?.category === category()
                        ? categorySuggestion()?.source.startsWith("personal") ? "Remembered" : "Suggested"
                        : "Change category"}
                    <ChevronRight size={15} />
                  </span>
                </button>
              </Show>

              <div class="expense-quick-controls" aria-label="Expense details">
                <button ref={payerControlRef} type="button" class="quick-control tone-payer" aria-expanded={activePanel() === "payer"} aria-controls="payer-panel" aria-invalid={formIssue()?.field === "payer"} aria-describedby={formIssue()?.field === "payer" ? "expense-form-error" : undefined} onClick={() => { if (formIssue()?.field === "payer") { setFormIssue(undefined); setError(""); } togglePanel("payer"); }}>
                  <span class="quick-control-icon"><UsersRound size={16} /></span><span class="quick-control-label">Paid by</span><strong>{payerSummary()}</strong><ChevronDown size={15} />
                </button>
                <button ref={splitControlRef} type="button" class="quick-control tone-split" aria-expanded={activePanel() === "split"} aria-controls="split-panel" aria-invalid={formIssue()?.field === "split"} aria-describedby={formIssue()?.field === "split" ? "expense-form-error" : undefined} onClick={() => { if (formIssue()?.field === "split") { setFormIssue(undefined); setError(""); } togglePanel("split"); }}>
                  <span class="quick-control-icon"><Scale size={16} /></span><span class="quick-control-label">Split</span><strong>{splitSummary()}</strong><ChevronDown size={15} />
                </button>
                <button ref={dateControlRef} type="button" class="quick-control tone-date" aria-expanded={activePanel() === "date"} aria-controls="date-panel" onClick={() => togglePanel("date")}>
                  <span class="quick-control-icon"><CalendarDays size={16} /></span><span class="quick-control-label">Date</span><strong>{isLocalToday(date()) ? "Today" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${date()}T12:00:00`))}</strong><ChevronDown size={15} />
                </button>
              </div>

              <Show when={languageSafetyIssues().length > 0}>
                <section class="language-review-callout" aria-labelledby="language-review-title">
                  <div>
                    <strong id="language-review-title">Confirm this is a new expense</strong>
                    <p>This may describe a payment or instruction rather than a new expense.</p>
                  </div>
                  <ul>
                    <For each={languageSafetyIssues()}>{(issue) => <li>{issue.message}</li>}</For>
                  </ul>
                  <label class="language-review-confirmation">
                    <input
                      ref={languageSafetyConfirmationRef}
                      type="checkbox"
                      checked={languageSafetyConfirmed()}
                      onInput={(event) => {
                        setLanguageSafetyConfirmed(event.currentTarget.checked);
                        if (event.currentTarget.checked) setError("");
                      }}
                    />
                    <span>I checked these details and want to add a new expense.</span>
                  </label>
                </section>
              </Show>

              <Show when={Number(amount()) > 0 && payers().length > 0 && allocations().length > 0}>
                <section class="expense-outcome" aria-label="Effect of this expense">
                  <div><span>Your balance change</span><strong>{outcomeHeadline()}</strong></div>
                  <p>You paid {formatMinor(outcome().actorPaidMinor, currency())} · your share is {formatMinor(outcome().actorShareMinor, currency())}</p>
                </section>
              </Show>

              <Show when={activePanel() === "payer"}>
                <section id="payer-panel" class="composer-option-panel disclosure-panel split-panel grid gap-3 border border-border p-4" aria-label="Choose who paid">
                  <div class="disclosure-heading"><div><p>Who paid?</p><small>Choose one person, or use multiple payers.</small></div><button type="button" onClick={closePanel}>Done</button></div>
                  <div class="flex items-center justify-end"><Show when={groupMembers().length > 1}><button type="button" class="flex min-h-11 items-center gap-1.5 px-2 text-xs font-semibold text-primary" onClick={enableMultiplePayers}><UsersRound size={14} />{payerIds().length > 1 ? "Use one payer" : "Multiple payers"}</button></Show></div>
                  <Show when={payerIds().length > 1} fallback={<div class="payer-avatar-rail"><For each={groupMembers()}>{(member) => <button type="button" class="payer-avatar-choice" classList={{ active: payerIds()[0] === member.userId }} aria-pressed={payerIds()[0] === member.userId} onClick={() => { setPayerIds([member.userId]); setPayerValues({}); closePanel(); }}><Avatar name={member.displayName} class="size-9 text-xs" /><span>{member.userId === props.actorId ? "You" : member.displayName}</span><Show when={pendingExpenseMemberLabel(member)}>{(label) => <small class="expense-member-state">{label()}</small>}</Show></button>}</For></div>}>
                    <div class="divide-y divide-border rounded-xl border border-border bg-background/55">
                      <For each={groupMembers()}>{(member) => <div class="flex min-h-14 items-center gap-2 px-2"><button type="button" role="checkbox" class="participant-toggle grid size-11 place-items-center rounded-md border border-border" classList={{ "border-primary bg-primary text-primary-foreground": payerIds().includes(member.userId) }} onClick={() => togglePayer(member.userId)} aria-label={`${member.displayName} paid`} aria-checked={payerIds().includes(member.userId)}><Show when={payerIds().includes(member.userId)}><Check size={14} /></Show></button><Avatar name={member.displayName} class="size-7 text-xs" /><span class="expense-member-copy min-w-0 flex-1"><strong>{member.userId === props.actorId ? "You" : member.displayName}</strong><Show when={pendingExpenseMemberLabel(member)}>{(label) => <small>{label()}</small>}</Show></span><div class="relative w-24"><input class="form-control h-11 text-right text-sm tabular-nums" disabled={!payerIds().includes(member.userId)} inputmode="decimal" value={payerValues()[member.userId] ?? ""} onInput={(event) => setPayerValues((values) => ({ ...values, [member.userId]: event.currentTarget.value }))} aria-label={`Amount paid by ${member.displayName}`} /></div></div>}</For>
                    </div>
                  </Show>
                </section>
              </Show>

              <Show when={activePanel() === "split"}>
                <section id="split-panel" class="composer-option-panel disclosure-panel split-panel grid gap-4 border border-border p-4" aria-label="Choose how to split">
                  <div class="disclosure-heading"><div><p>Who owes what?</p><small>{splitMethod() === "equal" ? "The total is divided equally among everyone selected." : splitMethod() === "shares" ? "Give someone more shares when they should cover more of the total." : splitMethod() === "exact" ? "Enter the exact amount each person should cover." : splitMethod() === "adjustment" ? "Add or subtract from an equal split. Adjustments must balance to zero." : "Enter the percentage each person should cover."}</small></div><button type="button" onClick={closePanel}>Done</button></div>
                  <div>
                    <p class="mb-2 text-sm font-medium">Split method</p>
                    <div class="split-mode-tabs grid grid-cols-5">
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
                          <span class="expense-member-copy min-w-0 flex-1"><strong>{member.userId === props.actorId ? "You" : member.displayName}</strong><Show when={pendingExpenseMemberLabel(member)}>{(label) => <small>{label()}</small>}</Show></span>
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
                  <div class="split-status"><span class="micro-label"><Show when={splitMethod() === "exact" && exactLeftoverMinor() !== 0} fallback={<Show when={allocations().length > 0} fallback="The split must assign the full amount.">Full amount assigned · {formatMinor(allocations().reduce((sum, item) => sum + item.amountMinor, 0), currency())}</Show>}>{formatMinor(Math.abs(exactLeftoverMinor()), currency())} {exactLeftoverMinor() > 0 ? "left over" : "too much assigned"}</Show></span><Show when={splitMethod() === "exact" && exactLeftoverMinor() > 0}><button type="button" onClick={assignExactRemainder}>Assign remainder to {groupMembers().find((member) => member.userId === (activeSplitParticipantId() ?? participants().at(-1)))?.displayName ?? "last person"}</button></Show></div>
                </section>
              </Show>

              <Show when={activePanel() === "date"}>
                <section id="date-panel" class="composer-option-panel disclosure-panel split-panel grid gap-3 border border-border p-4" aria-label="Choose expense date">
                  <div class="disclosure-heading"><div><p>When was it?</p><small>Today is selected by default.</small></div><button type="button" onClick={closePanel}>Done</button></div>
                  <div class="date-choice-row">
                    <button type="button" classList={{ active: isLocalToday(date()) }} onClick={() => { setDate(localDateValue()); closePanel(); }}>Today</button>
                    <label><span class="sr-only">Expense date</span><input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} onChange={closePanel} /></label>
                  </div>
                </section>
              </Show>

              <button ref={detailsControlRef} type="button" class="details-disclosure" aria-expanded={activePanel() === "details"} onClick={() => togglePanel("details")}><span class="flex items-center gap-2"><SlidersHorizontal size={15} /> {activePanel() === "details" ? "Hide details" : "More details"}</span>{activePanel() === "details" ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
              <Show when={activePanel() === "details"}>
                <section class="disclosure-panel grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2" aria-label="More expense details">
                  <div class="disclosure-heading sm:col-span-2"><div><p>More details</p><small>Add a category, currency, schedule, or note.</small></div><button type="button" onClick={closePanel}>Done</button></div>
                  <label class="grid gap-2 text-sm font-medium">Category<select ref={categorySelectRef} class="form-control" value={category()} onInput={(event) => { setCategory(event.currentTarget.value); setCategoryEdited(true); }}><For each={EXPENSE_CATEGORIES}>{(item) => <option>{item}</option>}</For></select></label>
                  <label class="grid gap-2 text-sm font-medium">Currency<select class="form-control" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)}><For each={currencies}>{(item) => <option value={item}>{item}</option>}</For></select></label>
                  <label class="grid gap-2 text-sm font-medium">Repeats<select class="form-control" value={recurrence()} onInput={(event) => setRecurrence(event.currentTarget.value as Recurrence)}><option value="none">Does not repeat</option><option value="weekly">Weekly</option><option value="fortnightly">Every two weeks</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
                  <label class="grid gap-2 text-sm font-medium sm:col-span-2">Note <span class="font-normal text-muted-foreground">(optional)</span><textarea class="form-control min-h-20 resize-y py-2" value={notes()} onInput={(event) => setNotes(event.currentTarget.value)} placeholder="e.g. Paid in cash" maxlength={5000} /></label>
                </section>
              </Show>

              <Show when={error()}><p id="expense-form-error" class="error-callout" role="alert">{error()}</p></Show>
              <footer class="sticky bottom-0 z-10 -mx-4 mt-1 grid gap-2 border-t border-border bg-card/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6">
                <Button class="h-11 w-full" type="submit" disabled={saving()}>
                  <Show when={saving()} fallback={<><Check size={16} /> {props.expense ? "Save changes" : `Add ${formatMinor(Math.round((Number(amount()) || 0) * 100), currency())}`}</>}><LoaderCircle class="animate-spin" size={16} /> Saving…</Show>
                </Button>
                <p class="micro-label text-center">Saves on this device, then syncs automatically.</p>
              </footer>
              </Show>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
