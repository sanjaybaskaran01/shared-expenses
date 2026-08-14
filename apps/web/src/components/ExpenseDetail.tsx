import { AlertDialog } from "@kobalte/core/alert-dialog";
import { Dialog } from "@kobalte/core/dialog";
import ArrowRight from "lucide-solid/icons/arrow-right";
import CalendarDays from "lucide-solid/icons/calendar-days";
import CheckCircle2 from "lucide-solid/icons/check-circle-2";
import CircleAlert from "lucide-solid/icons/circle-alert";
import DatabaseBackup from "lucide-solid/icons/database-backup";
import MessageCircle from "lucide-solid/icons/message-circle";
import PencilLine from "lucide-solid/icons/pencil-line";
import RotateCcw from "lucide-solid/icons/rotate-ccw";
import Trash2 from "lucide-solid/icons/trash-2";
import X from "lucide-solid/icons/x";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { LocalExpense } from "../lib/db";
import { latestExpenseChange } from "../lib/expense-history";
import {
  expenseRecoveryState,
  failedExpenseContext,
  recoveryDescription,
  recoveryTitle,
} from "../lib/expense-recovery";
import { expenseComments } from "../lib/ledger-view";
import {
  addComment,
  appStore,
  discardFailedExpenseChanges,
  discardLocalOnlyExpense,
  restoreExpense,
  retryLocalOnlyExpense,
  voidExpense,
} from "../lib/store";
import { Avatar, Button } from "./ui";

interface ExpenseDetailProps {
  open: boolean;
  actorId: string;
  expense?: LocalExpense | undefined;
  onOpenChange(open: boolean): void;
  onEdit(expense: LocalExpense): void;
  onChanged(message: string): void;
}

function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function syncStatusLabel(status: LocalExpense["syncStatus"]): string {
  if (status === "pending") return "Saved on this device";
  if (status === "conflicted") return "Needs review";
  if (status === "rejected") return "Couldn’t sync";
  return "Synced";
}

export function ExpenseDetail(props: ExpenseDetailProps) {
  const [comment, setComment] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [recoveryAction, setRecoveryAction] = createSignal<"discard-local" | "discard-change">();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let detailRef: HTMLDivElement | undefined;
  let deleteButtonRef: HTMLButtonElement | undefined;
  let recoveryButtonRef: HTMLButtonElement | undefined;
  const group = createMemo(() => appStore.groups().find((item) => item.id === props.expense?.groupId));
  const members = createMemo(() => appStore.members().filter((member) => member.groupId === props.expense?.groupId));
  const memberName = (id: string) => id === props.actorId ? "You" : members().find((member) => member.userId === id)?.displayName ?? "Member";
  const comments = createMemo(() => props.expense ? expenseComments(appStore.operations(), props.expense.id) : []);
  const latestChange = createMemo(() => props.expense ? latestExpenseChange(appStore.operations(), props.expense.id) : undefined);
  const recovery = createMemo(() =>
    props.expense ? expenseRecoveryState(props.expense, appStore.operations()) : { kind: "none" as const, failedOperations: [] },
  );
  const activeRecovery = createMemo(() => {
    const state = recovery();
    return state.kind === "none" ? undefined : state;
  });

  async function submitComment(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!props.expense || !comment().trim()) return;
    setBusy(true);
    setError("");
    try {
      await addComment(props.expense, comment());
      setComment("");
      props.onChanged("Comment added");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add this comment. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(): Promise<void> {
    const expense = props.expense;
    if (!expense) return;
    setBusy(true);
    setError("");
    try {
      if (expense.status === "voided") {
        await restoreExpense(expense);
        props.onChanged("Expense restored");
      } else {
        await voidExpense(expense, "Deleted from expense details");
        props.onChanged("Expense deleted. Restore it from Activity.");
      }
      setConfirmDelete(false);
      props.onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update this expense. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function retryAsNew(): Promise<void> {
    const expense = props.expense;
    if (!expense) return;
    setBusy(true);
    setError("");
    try {
      await retryLocalOnlyExpense(expense);
      props.onChanged("Expense retry saved on this device");
      props.onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to retry this expense. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function discardRecovery(): Promise<void> {
    const expense = props.expense;
    const action = recoveryAction();
    if (!expense || !action) return;
    setBusy(true);
    setError("");
    try {
      if (action === "discard-local") {
        await discardLocalOnlyExpense(expense);
        props.onChanged("Local expense discarded");
      } else {
        await discardFailedExpenseChanges(expense);
        props.onChanged("Failed local change discarded");
      }
      setRecoveryAction(undefined);
      props.onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to discard this local change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleOpenChange(open: boolean): void {
    if (!open) {
      setConfirmDelete(false);
      setRecoveryAction(undefined);
    }
    props.onOpenChange(open);
  }

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content
            ref={detailRef}
            role="dialog"
            class="composer-dialog glass-sheet max-h-[96dvh] w-full overflow-y-auto border border-border bg-card shadow-2xl outline-none sm:max-w-xl sm:rounded-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => detailRef?.focus());
            }}
          >
            <header class="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-border/70 bg-card/85 px-5 backdrop-blur-2xl">
              <div class="min-w-0"><Dialog.Title class="truncate text-base font-semibold">Expense details</Dialog.Title><Dialog.Description class="truncate text-xs text-muted-foreground">{group()?.name ?? "Shared group"}</Dialog.Description></div>
              <Dialog.CloseButton class="icon-button" aria-label="Close expense details"><X size={18} /></Dialog.CloseButton>
            </header>
            <Show when={props.expense} keyed>{(expense) => <div class="grid gap-5 p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:p-6">
              <section class="expense-hero rounded-lg p-5">
                <div class="flex items-start justify-between gap-4"><div><span class="expense-category">{expense.category}</span><h2 class="mt-3 text-2xl font-semibold tracking-tight">{expense.description}</h2><div class="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><CalendarDays size={15} />{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${expense.expenseDate}T12:00:00`))}</div></div><strong class="text-2xl font-semibold tabular-nums">{money(expense.amountMinor, expense.currency)}</strong></div>
              </section>

              <section class="surface-panel overflow-hidden rounded-lg border border-border/70">
                <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border/70 p-4"><div><span class="text-xs text-muted-foreground">Paid by</span><strong class="mt-1 block text-sm">{expense.payers.map((payer) => memberName(payer.participantId)).join(", ")}</strong></div><ArrowRight size={16} class="text-muted-foreground" /><div class="text-right"><span class="text-xs text-muted-foreground">Split with</span><strong class="mt-1 block text-sm">{expense.allocations.length} {expense.allocations.length === 1 ? "person" : "people"}</strong></div></div>
                <For each={expense.allocations}>{(allocation) => <div class="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0"><Avatar name={memberName(allocation.participantId)} class="size-8 text-xs" /><span class="min-w-0 flex-1 truncate text-sm font-medium">{memberName(allocation.participantId)}</span><span class="text-sm tabular-nums text-muted-foreground">{money(allocation.amountMinor, expense.currency)}</span></div>}</For>
              </section>

              <Show when={expense.notes}><section class="surface-panel rounded-lg border border-border/70 p-4"><p class="text-sm leading-6">{expense.notes}</p></section></Show>

              <Show when={activeRecovery()} keyed>{(state) => <section class="rounded-lg border border-destructive/30 bg-destructive/5 p-4" role="alert" aria-live="assertive">
                  <div class="flex items-start gap-3">
                    <CircleAlert size={18} class="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                    <div class="min-w-0 flex-1">
                      <h3 class="text-sm font-semibold text-foreground">{recoveryTitle(state)}</h3>
                      <p class="mt-1 text-sm leading-5 text-muted-foreground">{recoveryDescription(state)}</p>
                      <p class="mt-2 text-sm leading-5 text-destructive">{failedExpenseContext(state.failure)}</p>
                      <div class="mt-3 flex flex-wrap gap-2">
                        <Show when={state.kind === "local-only" && state.canRetryAsNew}>
                          <Button disabled={busy()} onClick={() => void retryAsNew()}>
                            {busy() ? "Retrying…" : "Retry as new expense"}
                          </Button>
                        </Show>
                        <Button
                          ref={recoveryButtonRef}
                          variant="destructive"
                          disabled={busy()}
                          onClick={() => setRecoveryAction(state.kind === "local-only" ? "discard-local" : "discard-change")}
                        >
                          {state.kind === "local-only" ? "Discard local expense" : "Discard failed change"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </section>}</Show>

              <section>
                <div class="mb-3 flex items-center justify-between"><h3 class="flex items-center gap-2 text-sm font-semibold"><MessageCircle size={16} /> Comments</h3><span class="text-xs text-muted-foreground">{comments().length}</span></div>
                <div class="grid gap-2"><For each={comments()} fallback={<p class="rounded-lg bg-muted/55 px-4 py-5 text-center text-sm text-muted-foreground">No comments yet. Add the first one below.</p>}>{(item) => <article class="rounded-lg bg-muted/65 p-3"><div class="flex items-center justify-between gap-3"><strong class="text-xs">{memberName(item.actorId)}</strong><time class="text-xs text-muted-foreground">{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(item.clientTimestamp))}</time></div><p class="mt-1 text-sm leading-5">{String((item.payload as Record<string, unknown>).body ?? "")}</p></article>}</For></div>
                <Show when={recovery().kind !== "local-only"} fallback={<p class="mt-3 text-sm leading-5 text-muted-foreground">Resolve the failed expense before adding a comment.</p>}>
                  <form class="mt-3 grid gap-2" onSubmit={(event) => void submitComment(event)}><label for="expense-comment" class="text-sm font-medium">Add a comment</label><div class="flex gap-2"><input id="expense-comment" class="form-control h-11" value={comment()} onInput={(event) => setComment(event.currentTarget.value)} placeholder="e.g. I paid in cash" maxlength={2000} /><Button type="submit" size="icon" disabled={busy() || !comment().trim()} aria-label="Send comment"><ArrowRight size={17} /></Button></div></form>
                </Show>
              </section>

              <section class="expense-provenance" aria-label="Expense history and sync status">
                <Show when={expense.readOnly} fallback={<CheckCircle2 size={15} class="text-primary" />}><DatabaseBackup size={15} class="text-primary" /></Show>
                <div><strong>{expense.readOnly ? "Imported from Splitwise" : expense.version === 1 ? `Added by ${memberName(expense.createdBy)}` : `Last changed by ${memberName(latestChange()?.actorId ?? expense.createdBy)}`}</strong><span>{expense.readOnly ? `${expense.importedByDisplayName ? `Imported by ${expense.importedByDisplayName}` : "Imported to Tallied"}${expense.importedAt ? ` on ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(expense.importedAt))}` : ""}. This expense can’t be edited. Undo the import to remove or replace it.` : `${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(latestChange()?.clientTimestamp ?? expense.updatedAt))} · ${syncStatusLabel(expense.syncStatus)}`}</span></div>
              </section>
              <Show when={error()}><p class="error-callout" role="alert">{error()}</p></Show>
              <Show when={!expense.readOnly && recovery().kind !== "local-only"}><div class="grid grid-cols-2 gap-2"><Show when={expense.status === "active"} fallback={<Button class="col-span-2" onClick={() => void changeStatus()} disabled={busy()}><RotateCcw size={16} /> Restore expense</Button>}><Button variant="secondary" onClick={() => props.onEdit(expense)}><PencilLine size={16} /> Edit expense</Button><Button ref={deleteButtonRef} variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /> Delete expense</Button></Show></div></Show>
            </div>}</Show>
          </Dialog.Content>
        </div>
      </Dialog.Portal>

      <AlertDialog open={confirmDelete()} onOpenChange={setConfirmDelete}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="confirm-overlay fixed inset-0 z-[60] bg-black/55 backdrop-blur-[2px]" />
          <div class="fixed inset-0 z-[70] grid place-items-center p-5">
            <AlertDialog.Content
              class="confirm-dialog w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl outline-none"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                queueMicrotask(() => deleteButtonRef?.focus());
              }}
            >
              <div class="confirm-danger-icon"><Trash2 size={19} /></div>
              <AlertDialog.Title class="mt-4 text-lg font-semibold tracking-tight">
                Delete “{props.expense?.description ?? "this expense"}”?
              </AlertDialog.Title>
              <AlertDialog.Description class="mt-2 text-sm leading-6 text-muted-foreground">
                This removes it from everyone’s balances in {group()?.name ?? "this group"}. A record stays in Activity, so you can restore it later.
              </AlertDialog.Description>
              <div class="mt-5 grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                <Button variant="destructive" disabled={busy()} onClick={() => void changeStatus()}>
                  <Trash2 size={16} /> {busy() ? "Deleting…" : "Delete expense"}
                </Button>
              </div>
            </AlertDialog.Content>
          </div>
        </AlertDialog.Portal>
      </AlertDialog>
      <AlertDialog open={Boolean(recoveryAction())} onOpenChange={(open) => { if (!open && !busy()) setRecoveryAction(undefined); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="confirm-overlay fixed inset-0 z-[60] bg-black/55 backdrop-blur-[2px]" />
          <div class="fixed inset-0 z-[70] grid place-items-center p-5">
            <AlertDialog.Content
              class="confirm-dialog w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl outline-none"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                queueMicrotask(() => recoveryButtonRef?.focus());
              }}
            >
              <div class="confirm-danger-icon"><Trash2 size={19} /></div>
              <AlertDialog.Title class="mt-4 text-lg font-semibold tracking-tight">
                {recoveryAction() === "discard-local" ? "Discard this local expense?" : "Discard this failed change?"}
              </AlertDialog.Title>
              <AlertDialog.Description class="mt-2 text-sm leading-6 text-muted-foreground">
                {recoveryAction() === "discard-local"
                  ? "This removes the failed expense and every unsynced comment or change tied to it from this device. It was not added to the group."
                  : "This removes the failed change and any later unsynced edits from this device. The last synced version stays in the group."}
              </AlertDialog.Description>
              <div class="mt-5 grid grid-cols-2 gap-2">
                <Button variant="secondary" disabled={busy()} onClick={() => setRecoveryAction(undefined)}>Cancel</Button>
                <Button variant="destructive" disabled={busy()} onClick={() => void discardRecovery()}>
                  <Trash2 size={16} /> {busy() ? "Discarding…" : recoveryAction() === "discard-local" ? "Discard expense" : "Discard change"}
                </Button>
              </div>
            </AlertDialog.Content>
          </div>
        </AlertDialog.Portal>
      </AlertDialog>
    </Dialog>
  );
}
