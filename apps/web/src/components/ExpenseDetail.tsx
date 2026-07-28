import { AlertDialog } from "@kobalte/core/alert-dialog";
import { Dialog } from "@kobalte/core/dialog";
import { ArrowRight, CalendarDays, CheckCircle2, MessageCircle, PencilLine, RotateCcw, Trash2, X } from "lucide-solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { LocalExpense } from "../lib/db";
import { expenseComments } from "../lib/ledger-view";
import { addComment, appStore, restoreExpense, voidExpense } from "../lib/store";
import { Avatar, Badge, Button } from "./ui";

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

export function ExpenseDetail(props: ExpenseDetailProps) {
  const [comment, setComment] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const group = createMemo(() => appStore.groups().find((item) => item.id === props.expense?.groupId));
  const members = createMemo(() => appStore.members().filter((member) => member.groupId === props.expense?.groupId));
  const memberName = (id: string) => id === props.actorId ? "You" : members().find((member) => member.userId === id)?.displayName ?? "Member";
  const comments = createMemo(() => props.expense ? expenseComments(appStore.operations(), props.expense.id) : []);

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
      setError(caught instanceof Error ? caught.message : "Could not add comment");
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
        props.onChanged("Expense deleted · restore it from Activity");
      }
      setConfirmDelete(false);
      props.onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update expense");
    } finally {
      setBusy(false);
    }
  }

  function handleOpenChange(open: boolean): void {
    if (!open) setConfirmDelete(false);
    props.onOpenChange(open);
  }

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content class="composer-dialog glass-sheet max-h-[96dvh] w-full overflow-y-auto rounded-t-[1.75rem] border border-border bg-card shadow-2xl outline-none sm:max-w-xl sm:rounded-3xl">
            <header class="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-border/70 bg-card/85 px-5 backdrop-blur-2xl">
              <div class="min-w-0"><Dialog.Title class="truncate text-base font-semibold">Expense details</Dialog.Title><Dialog.Description class="truncate text-xs text-muted-foreground">{group()?.name ?? "Shared group"}</Dialog.Description></div>
              <Dialog.CloseButton class="icon-button" aria-label="Close expense details"><X size={18} /></Dialog.CloseButton>
            </header>
            <Show when={props.expense} keyed>{(expense) => <div class="grid gap-5 p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:p-6">
              <section class="expense-hero rounded-3xl p-5 text-white">
                <div class="flex items-start justify-between gap-4"><div><Badge class="border-white/20 bg-white/15 text-white">{expense.category}</Badge><h2 class="mt-4 text-2xl font-semibold tracking-tight">{expense.description}</h2><div class="mt-2 flex items-center gap-2 text-sm text-white/75"><CalendarDays size={15} />{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${expense.expenseDate}T12:00:00`))}</div></div><strong class="text-2xl font-semibold tabular-nums">{money(expense.amountMinor, expense.currency)}</strong></div>
              </section>

              <section class="surface-panel overflow-hidden rounded-2xl border border-border/70">
                <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border/70 p-4"><div><span class="text-xs text-muted-foreground">Paid by</span><strong class="mt-1 block text-sm">{expense.payers.map((payer) => memberName(payer.participantId)).join(", ")}</strong></div><ArrowRight size={16} class="text-muted-foreground" /><div class="text-right"><span class="text-xs text-muted-foreground">Split with</span><strong class="mt-1 block text-sm">{expense.allocations.length} {expense.allocations.length === 1 ? "person" : "people"}</strong></div></div>
                <For each={expense.allocations}>{(allocation) => <div class="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0"><Avatar name={memberName(allocation.participantId)} class="size-8 text-xs" /><span class="min-w-0 flex-1 truncate text-sm font-medium">{memberName(allocation.participantId)}</span><span class="text-sm tabular-nums text-muted-foreground">{money(allocation.amountMinor, expense.currency)}</span></div>}</For>
              </section>

              <Show when={expense.notes}><section class="surface-panel rounded-2xl border border-border/70 p-4"><p class="text-sm leading-6">{expense.notes}</p></section></Show>

              <section>
                <div class="mb-3 flex items-center justify-between"><h3 class="flex items-center gap-2 text-sm font-semibold"><MessageCircle size={16} /> Comments</h3><span class="text-xs text-muted-foreground">{comments().length}</span></div>
                <div class="grid gap-2"><For each={comments()} fallback={<p class="rounded-2xl bg-muted/55 px-4 py-5 text-center text-sm text-muted-foreground">No comments yet.</p>}>{(item) => <article class="rounded-2xl bg-muted/65 p-3"><div class="flex items-center justify-between gap-3"><strong class="text-xs">{memberName(item.actorId)}</strong><time class="text-[11px] text-muted-foreground">{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(item.clientTimestamp))}</time></div><p class="mt-1 text-sm leading-5">{String((item.payload as Record<string, unknown>).body ?? "")}</p></article>}</For></div>
                <form class="mt-3 flex gap-2" onSubmit={(event) => void submitComment(event)}><input class="form-control h-11" value={comment()} onInput={(event) => setComment(event.currentTarget.value)} placeholder="Add a comment" maxlength={2000} /><Button type="submit" size="icon" disabled={busy() || !comment().trim()} aria-label="Send comment"><ArrowRight size={17} /></Button></form>
              </section>

              <div class="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground"><CheckCircle2 size={14} class="text-primary" /> Version {expense.version} · {expense.syncStatus === "pending" ? "Saved on this device" : expense.syncStatus === "conflicted" ? "Needs conflict review" : "Verified by ledger"}</div>
              <Show when={error()}><p class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error()}</p></Show>
              <div class="grid grid-cols-2 gap-2"><Show when={expense.status === "active"} fallback={<Button class="col-span-2" onClick={() => void changeStatus()} disabled={busy()}><RotateCcw size={16} /> Restore expense</Button>}><Button variant="secondary" onClick={() => props.onEdit(expense)}><PencilLine size={16} /> Edit</Button><Button variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /> Delete</Button></Show></div>
            </div>}</Show>
          </Dialog.Content>
        </div>
      </Dialog.Portal>

      <AlertDialog open={confirmDelete()} onOpenChange={setConfirmDelete}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="confirm-overlay fixed inset-0 z-[60] bg-black/55 backdrop-blur-[2px]" />
          <div class="fixed inset-0 z-[70] grid place-items-center p-5">
            <AlertDialog.Content class="confirm-dialog w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl outline-none">
              <div class="confirm-danger-icon"><Trash2 size={19} /></div>
              <AlertDialog.Title class="mt-4 text-lg font-semibold tracking-tight">
                Delete “{props.expense?.description ?? "this expense"}”?
              </AlertDialog.Title>
              <AlertDialog.Description class="mt-2 text-sm leading-6 text-muted-foreground">
                This removes it from everyone’s balances in {group()?.name ?? "this group"}. The ledger keeps an audit record, so it can be restored later from Activity.
              </AlertDialog.Description>
              <div class="mt-5 grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                <Button variant="destructive" disabled={busy()} onClick={() => void changeStatus()}>
                  <Trash2 size={16} /> {busy() ? "Deleting…" : "Delete expense"}
                </Button>
              </div>
            </AlertDialog.Content>
          </div>
        </AlertDialog.Portal>
      </AlertDialog>
    </Dialog>
  );
}
