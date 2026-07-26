import { Dialog } from "@kobalte/core/dialog";
import { Check, ChevronDown, LoaderCircle, UsersRound } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { appStore, createExpense } from "../lib/store";

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
    setParticipants((selected) => (selected.length === 0 ? ids : selected.filter((id) => ids.includes(id))));
    if (!ids.includes(payerId())) setPayerId(ids[0] ?? "dev-user");
  });

  function toggleParticipant(userId: string): void {
    setParticipants((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
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
        <Dialog.Overlay class="composer-overlay" />
        <div class="composer-positioner">
          <Dialog.Content class="composer-panel">
            <span class="sheet-grabber" aria-hidden="true" />
            <header class="composer-header">
              <Dialog.CloseButton class="composer-cancel" aria-label="Close expense form">
                Cancel
              </Dialog.CloseButton>
              <Dialog.Title class="composer-title">New expense</Dialog.Title>
              <span class="composer-header-spacer" />
            </header>

            <form class="composer-form" onSubmit={(event) => void submit(event)}>
              <section class="composer-primary-fields">
                <label class="amount-field">
                  <span class="field-label">How much?</span>
                  <span class="money-input">
                    <b>$</b>
                    <input
                      inputmode="decimal"
                      value={amount()}
                      onInput={(event) => setAmount(event.currentTarget.value)}
                      placeholder="0.00"
                      aria-label="Expense amount"
                    />
                  </span>
                </label>
                <label class="description-field">
                  <span class="field-label">What was it for?</span>
                  <input
                    autofocus
                    value={description()}
                    onInput={(event) => setDescription(event.currentTarget.value)}
                    placeholder="Dinner, groceries, tickets…"
                    maxlength={200}
                  />
                </label>
              </section>

              <label class="form-row" for="expense-group">
                <span><small>Group</small><strong>{appStore.groups().find((group) => group.id === groupId())?.name ?? "Choose a group"}</strong></span>
                <span class="select-wrap inline-select">
                  <select id="expense-group" aria-label="Group" value={groupId()} onInput={(event) => setGroupId(event.currentTarget.value)}>
                    <For each={appStore.groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For>
                  </select>
                  <ChevronDown size={17} aria-hidden="true" />
                </span>
              </label>

              <section class="form-surface two-column-fields">
                <label>
                  <span class="field-label">Category</span>
                  <div class="select-wrap">
                    <select value={category()} onInput={(event) => setCategory(event.currentTarget.value)}>
                      <option>Dining out</option>
                      <option>Groceries</option>
                      <option>Transportation</option>
                      <option>Hotel</option>
                      <option>Entertainment</option>
                      <option>General</option>
                    </select>
                    <ChevronDown size={17} aria-hidden="true" />
                  </div>
                </label>
                <label>
                  <span class="field-label">Date</span>
                  <input type="date" value={date()} onInput={(event) => setDate(event.currentTarget.value)} />
                </label>
              </section>

              <fieldset class="people-fieldset form-surface">
                <legend>
                  <span><UsersRound size={17} /> Split equally</span>
                  <small>{participants().length} selected</small>
                </legend>
                <div class="people-grid">
                  <For each={groupMembers()}>
                    {(member) => (
                      <button
                        type="button"
                        class="person-choice"
                        classList={{ selected: participants().includes(member.userId) }}
                        onClick={() => toggleParticipant(member.userId)}
                        aria-pressed={participants().includes(member.userId)}
                      >
                        <span class="avatar">{member.displayName.slice(0, 1).toUpperCase()}</span>
                        <span>{member.displayName}</span>
                        <span class="choice-check"><Check size={14} /></span>
                      </button>
                    )}
                  </For>
                </div>
              </fieldset>

              <section class="form-surface composer-details">
                <label>
                  <span class="field-label">Paid by</span>
                  <div class="select-wrap">
                    <select value={payerId()} onInput={(event) => setPayerId(event.currentTarget.value)}>
                      <For each={groupMembers()}>{(member) => <option value={member.userId}>{member.displayName}</option>}</For>
                    </select>
                    <ChevronDown size={17} aria-hidden="true" />
                  </div>
                </label>

                <label>
                  <span class="field-label">Notes <em>optional</em></span>
                  <textarea
                    value={notes()}
                    onInput={(event) => setNotes(event.currentTarget.value)}
                    placeholder="Add a note"
                    maxlength={5000}
                  />
                </label>
              </section>

              <Show when={error()}><p class="form-error" role="alert">{error()}</p></Show>
              <footer class="composer-actions">
                <button class="save-expense" type="submit" disabled={saving()}>
                  <Show when={saving()} fallback={<><Check size={19} /> Add expense</>}>
                    <LoaderCircle class="spin" size={19} /> Saving locally…
                  </Show>
                </button>
                <p class="offline-note">Saves to this device first, then syncs automatically.</p>
              </footer>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
