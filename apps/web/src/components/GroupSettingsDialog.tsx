import { Dialog } from "@kobalte/core/dialog";
import ChevronRight from "lucide-solid/icons/chevron-right";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import Mail from "lucide-solid/icons/mail";
import Settings2 from "lucide-solid/icons/settings-2";
import UserPlus from "lucide-solid/icons/user-plus";
import UsersRound from "lucide-solid/icons/users-round";
import X from "lucide-solid/icons/x";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { inviteGroupMember } from "../lib/api";
import { money } from "../lib/format-money";
import { groupMemberStatus, IMPORT_IDENTITY_LINK_EXPLANATION } from "../lib/group-settings";
import { computeBalances } from "../lib/ledger-view";
import { isVisibleGroupMember } from "../lib/member-label";
import { appStore, changeGroupCurrency } from "../lib/store";
import { ImportedMemberClaim } from "./ImportedMemberClaim";
import { Avatar, Button } from "./ui";

const currencies = [
  ["USD", "US dollar"],
  ["CAD", "Canadian dollar"],
  ["EUR", "Euro"],
  ["GBP", "British pound"],
  ["INR", "Indian rupee"],
] as const;

export function GroupSettingsDialog(props: {
  open: boolean;
  groupId: string | undefined;
  actorId: string;
  onOpenChange(open: boolean): void;
  onNotify(message: string): void;
}) {
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [currencyBusy, setCurrencyBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [messageTone, setMessageTone] = createSignal<"status" | "error">("status");
  let contentRef: HTMLDivElement | undefined;
  let emailRef: HTMLInputElement | undefined;

  const group = createMemo(() => appStore.groups().find((item) => item.id === props.groupId));
  const members = createMemo(() => appStore.members()
    .filter((member) => member.groupId === props.groupId && isVisibleGroupMember(member.status))
    .sort((left, right) => {
      if (left.userId === props.actorId) return -1;
      if (right.userId === props.actorId) return 1;
      if (left.status !== right.status) return left.status === "active" ? -1 : 1;
      return left.displayName.localeCompare(right.displayName);
    }));
  const claimableMembers = createMemo(() => members().filter((member) => member.importClaim));
  const hasLedgerEntries = createMemo(() => Boolean(props.groupId) && (
    appStore.expenses().some((expense) => expense.groupId === props.groupId) ||
    appStore.operations().some((operation) =>
      operation.groupId === props.groupId &&
      operation.type === "PaymentRecorded" &&
      operation.syncStatus !== "rejected" &&
      operation.syncStatus !== "conflicted"
    )
  ));
  const balances = createMemo(() => group()
    ? computeBalances(appStore.expenses(), appStore.operations(), group()!.id, group()!.settlementCurrency)
    : {});

  createEffect(() => {
    if (!props.open) return;
    setEmail("");
    setMessage("");
    setMessageTone("status");
  });

  async function invite(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const address = email().trim().toLowerCase();
    if (!address || !emailRef?.checkValidity()) {
      emailRef?.reportValidity();
      emailRef?.focus();
      return;
    }
    const activeGroup = group();
    if (!activeGroup) return;

    setBusy(true);
    setMessage("");
    setMessageTone("status");
    try {
      await inviteGroupMember(activeGroup.id, { email: address });
      setEmail("");
      setMessage(`Invitation sent to ${address}. The link verifies their email and adds them to ${activeGroup.name}.`);
      props.onNotify("Group invitation sent");
      void appStore.sync();
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "Unable to send this invitation. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function updateCurrency(value: string): Promise<void> {
    const activeGroup = group();
    if (!activeGroup || value === activeGroup.settlementCurrency || hasLedgerEntries()) return;
    setCurrencyBusy(true);
    setMessage("");
    try {
      await changeGroupCurrency(activeGroup.id, value);
      setMessageTone("status");
      setMessage(`Default currency changed to ${value}.`);
      props.onNotify(`Group currency changed to ${value}`);
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "Unable to change the group currency. Try again.");
    } finally {
      setCurrencyBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="composer-overlay fixed inset-0 z-40 bg-black/45" />
        <div class="fixed inset-0 z-50 grid items-end sm:place-items-center sm:p-6">
          <Dialog.Content
            ref={contentRef}
            role="dialog"
            tabindex={-1}
            class="composer-dialog group-settings-dialog w-full overflow-hidden border border-border bg-card shadow-2xl outline-none sm:max-w-lg sm:rounded-xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => contentRef?.focus());
            }}
          >
            <header class="group-settings-header">
              <Dialog.CloseButton class="icon-button" aria-label="Close group settings"><X size={18} /></Dialog.CloseButton>
              <div>
                <Dialog.Title>Group settings</Dialog.Title>
                <Dialog.Description>{group()?.name ?? "Manage this group"}</Dialog.Description>
              </div>
              <span class="group-settings-header-icon" aria-hidden="true" />
            </header>

            <div class="group-settings-scroll">
              <section class="group-settings-section" aria-labelledby="add-group-member-title">
                <div class="group-settings-section-heading">
                  <span class="group-settings-section-icon" aria-hidden="true"><UserPlus size={17} /></span>
                  <div><h3 id="add-group-member-title">Add someone</h3><p>They can join with one email link.</p></div>
                </div>
                <form class="group-invite-form" onSubmit={(event) => void invite(event)}>
                  <label for="group-invite-email">Email address</label>
                  <div>
                    <span aria-hidden="true"><Mail size={16} /></span>
                    <input
                      ref={emailRef}
                      id="group-invite-email"
                      name="group-invite-email"
                      type="email"
                      inputmode="email"
                      autocomplete="email"
                      spellcheck={false}
                      required
                      value={email()}
                      onInput={(event) => setEmail(event.currentTarget.value)}
                      placeholder="friend@example.com"
                    />
                    <Button type="submit" disabled={busy()}>
                      <Show when={busy()} fallback="Send invite"><LoaderCircle class="animate-spin" size={16} /> Sending…</Show>
                    </Button>
                  </div>
                  <p>The link verifies their email, signs them in, and adds them to this group.</p>
                </form>
                <Show when={message()}><p class="group-settings-message" role={messageTone() === "error" ? "alert" : "status"} aria-live={messageTone() === "error" ? "assertive" : "polite"} classList={{ error: messageTone() === "error" }}>{message()}</p></Show>
              </section>

              <Show when={claimableMembers().length}>
                <section class="group-settings-section" aria-labelledby="imported-history-title">
                  <div class="group-settings-section-heading">
                    <span class="group-settings-section-icon" aria-hidden="true"><ChevronRight size={17} /></span>
                    <div><h3 id="imported-history-title">Connect imported history</h3><p>Send each person a secure link to connect their Tallied account.</p></div>
                  </div>
                  <div class="group-settings-claims">
                    <For each={claimableMembers()}>{(member) => <ImportedMemberClaim member={member} onNotify={props.onNotify} />}</For>
                  </div>
                  <p class="group-settings-identity-note">{IMPORT_IDENTITY_LINK_EXPLANATION}</p>
                </section>
              </Show>

              <section class="group-settings-section" aria-labelledby="group-members-title">
                <div class="group-settings-section-heading">
                  <span class="group-settings-section-icon" aria-hidden="true"><UsersRound size={17} /></span>
                  <div><h3 id="group-members-title">People</h3><p>{members().length} {members().length === 1 ? "person" : "people"} in this group</p></div>
                </div>
                <div class="group-settings-members">
                  <For each={members()}>{(member) => {
                    const balance = createMemo(() => balances()[member.userId] ?? 0);
                    const current = () => member.userId === props.actorId;
                    return <div class="group-settings-member">
                      <Avatar name={member.displayName} />
                      <span class="min-w-0"><strong>{member.displayName}</strong><small>{groupMemberStatus(member, current())}</small></span>
                      <Show when={!current()}>
                        <span class="group-settings-member-balance" classList={{ "money-in": balance() < 0, "money-out": balance() > 0 }}>
                          <strong>{money(Math.abs(balance()), group()?.settlementCurrency ?? "USD")}</strong>
                          <small>{balance() < 0 ? "owes you" : balance() > 0 ? "you owe" : "settled"}</small>
                        </span>
                      </Show>
                    </div>;
                  }}</For>
                </div>
              </section>

              <section class="group-settings-section" aria-labelledby="group-currency-title">
                <div class="group-settings-section-heading">
                  <span class="group-settings-section-icon" aria-hidden="true"><Settings2 size={17} /></span>
                  <div><h3 id="group-currency-title">Default currency</h3><p>Used for this group’s balances.</p></div>
                </div>
                <label class="group-settings-currency">
                  <span>Currency</span>
                  <select value={group()?.settlementCurrency} disabled={hasLedgerEntries() || currencyBusy()} onChange={(event) => void updateCurrency(event.currentTarget.value)}>
                    <For each={currencies}>{([code, label]) => <option value={code}>{code} — {label}</option>}</For>
                  </select>
                  <small>{hasLedgerEntries() ? "Locked after the first expense or payment so earlier balances stay accurate." : "You can change this until the first expense or payment."}</small>
                </label>
              </section>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
