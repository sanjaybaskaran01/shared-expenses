import { Dialog } from "@kobalte/core/dialog";
import { Check, LoaderCircle, Pencil, Trash2, TriangleAlert, UsersRound, X } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { LocalExpense } from "../lib/db";
import { amendExpense, appStore, voidExpense } from "../lib/store";
import { Avatar, Badge, Button } from "./ui";

interface ExpenseDetailDialogProps {
  expenseId: string | undefined;
  onOpenChange(open: boolean): void;
}

function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

export function ExpenseDetailDialog(props: ExpenseDetailDialogProps) {
  const [editing, setEditing] = createSignal(false);
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const [description, setDescription] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [category, setCategory] = createSignal("General");
  const [date, setDate] = createSignal("");
  const [payerId, setPayerId] = createSignal("");
  const [participants, setParticipants] = createSignal<string[]>([]);
  const [notes, setNotes] = createSignal("");

  const expense = createMemo<LocalExpense | undefined>(() =>
    appStore.expenses().find((entry) => entry.id === props.expenseId),
  );

  const groupMembers = createMemo(() => {
    const groupId = expense()?.groupId;
    return appStore.members().filter((member) => member.groupId === groupId && member.status === "active");
  });

  function nameFor(userId: string): string {
    return appStore.members().find((member) => member.userId === userId)?.displayName ?? "Someone";
  }

  // Reset the form whenever a different expense is opened.
  createEffect(() => {
    const current = expense();
    if (!current) return;
    setEditing(false);
    setConfirmingDelete(false);
    setError("");
    setDescription(current.description);
    setAmount((current.amountMinor / 100).toFixed(2));
    setCategory(current.category);
    setDate(current.expenseDate);
    setPayerId(current.payers[0]?.participantId ?? "");
    setParticipants(current.allocations.map(({ participantId }) => participantId));
    setNotes(current.notes);
  });

  function toggleParticipant(userId: string): void {
    setParticipants((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  }

  async function saveEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const current = expense();
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await amendExpense(current.id, {
        description: description(),
        amount: amount(),
        category: category(),
        expenseDate: date(),
        payerId: payerId(),
        participantIds: participants(),
        notes: notes(),
      });
      setEditing(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not save this change");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    const current = expense();
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await voidExpense(current.id);
      props.onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not delete this expense");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(props.expenseId)} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content class="max-h-[94dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-card shadow-xl outline-none sm:max-w-lg sm:rounded-xl">
            <Show when={expense()} keyed fallback={<p class="p-6 text-sm text-muted-foreground">This expense is no longer available.</p>}>
              {(current) => (
                <>
                  <header class="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-card px-5">
                    <Dialog.Title class="text-base font-semibold">{editing() ? "Edit expense" : "Expense"}</Dialog.Title>
                    <Dialog.CloseButton
                      class="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="Close expense"
                    >
                      <X size={17} />
                    </Dialog.CloseButton>
                  </header>

                  <Show when={current.syncStatus === "conflicted"}>
                    <div class="flex items-start gap-2.5 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">
                      <TriangleAlert size={16} class="mt-0.5 shrink-0" />
                      <p>
                        Someone else changed this expense while your edit was offline, so your version was not applied.
                        The details below are theirs — reapply your change if it still makes sense.
                      </p>
                    </div>
                  </Show>
                  <Show when={current.status === "voided"}>
                    <div class="border-b border-border bg-muted/60 px-5 py-3 text-sm text-muted-foreground">
                      This expense was deleted. It stays in the activity log.
                    </div>
                  </Show>

                  <Show
                    when={editing()}
                    fallback={
                      <div class="grid gap-5 p-5 sm:p-6">
                        <div>
                          <strong class="block text-2xl font-semibold tracking-tight tabular-nums">
                            {money(current.amountMinor, current.currency)}
                          </strong>
                          <p class="mt-1 text-sm text-muted-foreground">
                            {current.description} · {current.category} ·{" "}
                            {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                              new Date(current.expenseDate + "T12:00:00"),
                            )}
                          </p>
                        </div>

                        <div class="grid gap-3">
                          <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Paid by</h3>
                          <For each={current.payers}>
                            {(payer) => (
                              <div class="flex items-center gap-2.5 text-sm">
                                <Avatar name={nameFor(payer.participantId)} class="size-7 text-xs" />
                                <span class="flex-1 truncate">{nameFor(payer.participantId)}</span>
                                <span class="tabular-nums">{money(payer.amountMinor, current.currency)}</span>
                              </div>
                            )}
                          </For>
                        </div>

                        <div class="grid gap-3">
                          <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Split between</h3>
                          <For each={current.allocations}>
                            {(allocation) => (
                              <div class="flex items-center gap-2.5 text-sm">
                                <Avatar name={nameFor(allocation.participantId)} class="size-7 text-xs" />
                                <span class="flex-1 truncate">{nameFor(allocation.participantId)}</span>
                                <span class="tabular-nums text-muted-foreground">
                                  {money(allocation.amountMinor, current.currency)}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>

                        <Show when={current.notes}>
                          <p class="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">{current.notes}</p>
                        </Show>

                        <div class="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge>v{current.version}</Badge>
                          <span>Added by {nameFor(current.createdBy)}</span>
                          <Show when={current.syncStatus === "pending"}>
                            <Badge class="border-amber-200 bg-amber-50 text-amber-700">Saved on device</Badge>
                          </Show>
                        </div>

                        <Show when={error()}>
                          <p class="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error()}</p>
                        </Show>

                        <Show when={current.status === "active"}>
                          <footer class="grid gap-2 border-t border-border pt-5 sm:grid-cols-2">
                            <Button variant="secondary" onClick={() => setEditing(true)}>
                              <Pencil size={16} /> Edit
                            </Button>
                            <Show
                              when={confirmingDelete()}
                              fallback={
                                <Button variant="destructive" onClick={() => setConfirmingDelete(true)}>
                                  <Trash2 size={16} /> Delete
                                </Button>
                              }
                            >
                              <Button variant="destructive" disabled={busy()} onClick={() => void remove()}>
                                <Show when={busy()} fallback={<><Trash2 size={16} /> Tap again to confirm</>}>
                                  <LoaderCircle class="animate-spin" size={16} /> Deleting…
                                </Show>
                              </Button>
                            </Show>
                            <p class="text-xs text-muted-foreground sm:col-span-2">
                              Anyone in this group can edit or delete this. Every change is recorded in Activity.
                            </p>
                          </footer>
                        </Show>
                      </div>
                    }
                  >
                    <form class="grid gap-5 p-5 sm:p-6" onSubmit={(event) => void saveEdit(event)}>
                      <div class="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
                        <label class="grid gap-2 text-sm font-medium">
                          Amount ({current.currency})
                          <input
                            class="form-control text-base font-semibold tabular-nums"
                            inputmode="decimal"
                            value={amount()}
                            onInput={(event) => setAmount(event.currentTarget.value)}
                          />
                        </label>
                        <label class="grid gap-2 text-sm font-medium">
                          Description
                          <input
                            class="form-control"
                            value={description()}
                            onInput={(event) => setDescription(event.currentTarget.value)}
                            maxlength={200}
                          />
                        </label>
                      </div>

                      <div class="grid gap-4 sm:grid-cols-2">
                        <label class="grid gap-2 text-sm font-medium">
                          Category
                          <select class="form-control" value={category()} onInput={(event) => setCategory(event.currentTarget.value)}>
                            <option>Dining out</option>
                            <option>Groceries</option>
                            <option>Transportation</option>
                            <option>Hotel</option>
                            <option>Entertainment</option>
                            <option>General</option>
                          </select>
                        </label>
                        <label class="grid gap-2 text-sm font-medium">
                          Date
                          <input class="form-control" type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} />
                        </label>
                      </div>

                      <label class="grid gap-2 text-sm font-medium">
                        Paid by
                        <select class="form-control" value={payerId()} onInput={(event) => setPayerId(event.currentTarget.value)}>
                          <For each={groupMembers()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For>
                        </select>
                      </label>

                      <fieldset class="grid gap-3">
                        <legend class="mb-3 flex w-full items-center justify-between text-sm font-medium">
                          <span class="flex items-center gap-2"><UsersRound size={16} /> Split equally</span>
                          <span class="text-xs font-normal text-muted-foreground">{participants().length} selected</span>
                        </legend>
                        <div class="grid gap-2 sm:grid-cols-2">
                          <For each={groupMembers()}>
                            {(member) => (
                              <button
                                type="button"
                                class="flex h-12 items-center gap-2 rounded-md border border-border px-3 text-left text-sm transition-colors hover:bg-muted"
                                classList={{ "border-primary bg-primary/5 ring-1 ring-primary": participants().includes(member.userId) }}
                                onClick={() => toggleParticipant(member.userId)}
                                aria-pressed={participants().includes(member.userId)}
                              >
                                <Avatar name={member.displayName} class="size-7 text-xs" />
                                <span class="min-w-0 flex-1 truncate font-medium">{member.displayName}</span>
                                <Show when={participants().includes(member.userId)}><Check size={14} class="text-primary" /></Show>
                              </button>
                            )}
                          </For>
                        </div>
                      </fieldset>

                      <label class="grid gap-2 text-sm font-medium">
                        Notes <span class="sr-only">optional</span>
                        <textarea
                          class="form-control min-h-20 resize-y py-2"
                          value={notes()}
                          onInput={(event) => setNotes(event.currentTarget.value)}
                          maxlength={5000}
                        />
                      </label>

                      <Show when={error()}>
                        <p class="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error()}</p>
                      </Show>

                      <footer class="grid gap-2 border-t border-border pt-5 sm:grid-cols-2">
                        <Button variant="secondary" type="button" onClick={() => setEditing(false)}>Cancel</Button>
                        <Button type="submit" disabled={busy()}>
                          <Show when={busy()} fallback={<><Check size={16} /> Save changes</>}>
                            <LoaderCircle class="animate-spin" size={16} /> Saving…
                          </Show>
                        </Button>
                      </footer>
                    </form>
                  </Show>
                </>
              )}
            </Show>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
