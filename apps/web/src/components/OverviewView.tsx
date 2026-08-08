import CheckCircle2 from "lucide-solid/icons/check-circle-2";
import ChevronRight from "lucide-solid/icons/chevron-right";
import ReceiptText from "lucide-solid/icons/receipt-text";
import UserPlus from "lucide-solid/icons/user-plus";
import UsersRound from "lucide-solid/icons/users-round";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { getContacts } from "../lib/api";
import { activePayments, computeBalances, computeRelationshipBalances, type RelationshipBalance, type Settlement } from "../lib/ledger-view";
import { settlementBlockerCount } from "../lib/group-insights";
import { money } from "../lib/format-money";
import { isVisibleGroupMember } from "../lib/member-label";
import { appStore } from "../lib/store";
import { ContactInviteDialog } from "./ContactInviteDialog";
import { RelationshipDetail } from "./RelationshipDetail";
import { SectionHeading } from "./SectionHeading";
import { AccessibleTabs, Avatar, Card, tabId, tabPanelId } from "./ui";

export function OverviewView(props: {
  actorId: string;
  activeGroupId?: string | undefined;
  onCreateGroup(): void;
  onOpenGroup(groupId: string): void;
  onSettle(settlement: Settlement, currency: string, groupId: string): void;
}) {
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [selectedRelationship, setSelectedRelationship] = createSignal<RelationshipBalance>();
  const [homeSection, setHomeSection] = createSignal<"people" | "groups">("people");
  const [contactState, { refetch: refetchContacts }] = createResource(async () => {
    try {
      return await getContacts();
    } catch {
      return { creditsTotal: 5, creditsRemaining: 0, invitations: [], contacts: [] };
    }
  });
  const relationships = createMemo(() =>
    computeRelationshipBalances(
      appStore.expenses(),
      appStore.operations(),
      appStore.groups(),
      appStore.members(),
      props.actorId,
    ),
  );
  const totals = createMemo(() => {
    const values = new Map<string, { currency: string; incoming: number; outgoing: number; net: number }>();
    for (const relationship of relationships()) {
      const current = values.get(relationship.currency) ?? { currency: relationship.currency, incoming: 0, outgoing: 0, net: 0 };
      if (relationship.amountMinor > 0) current.incoming += relationship.amountMinor;
      else current.outgoing += Math.abs(relationship.amountMinor);
      current.net += relationship.amountMinor;
      values.set(relationship.currency, current);
    }
    if (values.size === 0) {
      const fallback = appStore.groups()[0]?.settlementCurrency ?? "USD";
      values.set(fallback, { currency: fallback, incoming: 0, outgoing: 0, net: 0 });
    }
    return [...values.values()];
  });
  const nameFor = (userId: string) =>
    appStore.members().find((member) => member.userId === userId)?.displayName ?? "Friend";
  const groupNames = (groupIds: string[]) =>
    groupIds
      .map((id) => appStore.groups().find((group) => group.id === id)?.name)
      .filter(Boolean)
      .join(" · ");
  const groupMemberCount = (groupId: string) =>
    appStore.members().filter((member) => member.groupId === groupId && isVisibleGroupMember(member.status)).length;
  const groupExpenseCount = (groupId: string) =>
    appStore.expenses().filter((expense) => expense.groupId === groupId && expense.status === "active").length;
  const groupPaymentCount = (groupId: string) => activePayments(appStore.operations(), groupId).length;
  const groupBalance = (groupId: string, currency: string) =>
    computeBalances(appStore.expenses(), appStore.operations(), groupId, currency)[props.actorId] ?? 0;
  const relationshipUserIds = createMemo(() => new Set(relationships().map((relationship) => relationship.userId)));
  const contactsWithoutBalance = createMemo(() =>
    (contactState()?.contacts ?? []).filter((contact) => !relationshipUserIds().has(contact.userId)),
  );
  return (
    <div class="page-enter home-page space-y-5">
      <header class="home-heading">
        <h1 class="page-title">Your balances</h1>
        <p class="home-summary-copy">
          {relationships().length} open {relationships().length === 1 ? "balance" : "balances"} · {appStore.groups().length} {appStore.groups().length === 1 ? "group" : "groups"}
        </p>
      </header>

      <div class="overview-currency-grid">
        <For each={totals()}>
          {(total) => (
            <section class="overview-balance" aria-label={`${total.currency} balance across all groups`}>
              <div class="overview-balance-primary">
                <span class="micro-label">Summary · {total.currency}</span>
                <strong class="money-type" classList={{ "money-in": total.net > 0, "money-out": total.net < 0 }}>
                  {total.net === 0 ? money(0, total.currency) : `${total.net > 0 ? "+" : "−"}${money(Math.abs(total.net), total.currency)}`}
                </strong>
                <p>{total.net > 0 ? "owed to you" : total.net < 0 ? "you owe overall" : "all settled"}</p>
              </div>
              <div class="overview-balance-details">
                <span><small>You’re owed</small><strong class="money-in">{money(total.incoming, total.currency)}</strong></span>
                <span><small>You owe</small><strong class="money-out">{money(total.outgoing, total.currency)}</strong></span>
              </div>
            </section>
          )}
        </For>
      </div>

      <AccessibleTabs
        class="home-list-tabs"
        items={[
          { id: "people", label: "By person" },
          { id: "groups", label: "By group" },
        ] as const}
        value={homeSection()}
        onChange={setHomeSection}
        ariaLabel="Home balance views"
        idPrefix="home-balance"
      />

      <Show when={homeSection() === "people"}>
        <Card id={tabPanelId("home-balance", "people")} class="home-list-card overflow-hidden" role="tabpanel" aria-labelledby={tabId("home-balance", "people")}>
          <SectionHeading
            title="People"
            detail={relationships().length ? "Net across all shared groups" : contactsWithoutBalance().length ? "Connected on Tallied" : "No open balances"}
            action={<button type="button" class="list-add-action" onClick={() => setInviteOpen(true)}><UserPlus size={14} /> Invite</button>}
          />
          <For
            each={relationships()}
            fallback={<Show when={!contactsWithoutBalance().length}><div class="px-6 py-12 text-center"><ReceiptText class="mx-auto text-muted-foreground" size={25} /><p class="mt-3 text-sm text-muted-foreground">Invite a friend or add an expense to get started.</p></div></Show>}
          >
            {(relationship, index) => {
              const personName = createMemo(() => nameFor(relationship.userId));
              const settlement = createMemo<Settlement>(() => relationship.amountMinor > 0
                ? { payerId: relationship.userId, recipientId: props.actorId, amountMinor: relationship.amountMinor }
                : { payerId: props.actorId, recipientId: relationship.userId, amountMinor: Math.abs(relationship.amountMinor) });
              const needsReview = createMemo(() => relationship.groupIds.length === 1 && settlementBlockerCount(appStore.expenses(), relationship.groupIds[0]!, relationship.currency) > 0);
              const canSettleHere = createMemo(() => relationship.groupIds.length === 1 && !needsReview());
              return (
                <article class="relationship-row" style={{ "--row-index": Math.min(index(), 7) }}>
                  <Avatar name={personName()} class="size-10 text-xs" />
                  <button type="button" class="min-h-11 min-w-0 flex-1 text-left" aria-label={`View balance details with ${personName()}`} onClick={() => setSelectedRelationship(relationship)}>
                    <strong class="block truncate text-sm">{personName()}</strong>
                    <span class="block truncate text-xs text-muted-foreground">{groupNames(relationship.groupIds)}</span>
                  </button>
                  <div class="text-right">
                    <span class="relationship-direction" classList={{ "money-in": relationship.amountMinor > 0, "money-out": relationship.amountMinor < 0 }}>{relationship.amountMinor > 0 ? "owes you" : "you owe"}</span>
                    <strong class="block text-sm tabular-nums" classList={{ "money-in": relationship.amountMinor > 0, "money-out": relationship.amountMinor < 0 }}>{money(Math.abs(relationship.amountMinor), relationship.currency)}</strong>
                  </div>
                  <button
                    type="button"
                    class="relationship-action"
                    classList={{ "relationship-action-settle": canSettleHere() }}
                    aria-label={canSettleHere() ? `Settle balance with ${personName()}` : needsReview() ? `Review balance with ${personName()}` : `View shared groups with ${personName()}`}
                    onClick={() => canSettleHere() ? props.onSettle(settlement(), relationship.currency, relationship.groupIds[0]!) : setSelectedRelationship(relationship)}
                  >
                    <span class="relationship-action-label">{canSettleHere() ? "Settle" : needsReview() ? "Review" : "View"}</span>
                    <Show when={!canSettleHere()}><ChevronRight class="relationship-action-chevron" size={16} /></Show>
                  </button>
                </article>
              );
            }}
          </For>
          <For each={contactsWithoutBalance()}>
            {(contact) => (
              <article class="relationship-row">
                <Avatar name={contact.displayName} class="size-10 text-xs" />
                <div class="min-w-0 flex-1 text-left">
                  <strong class="block truncate text-sm">{contact.displayName}</strong>
                  <span class="block truncate text-xs text-muted-foreground">Connected · no shared expenses yet</span>
                </div>
                <span class="inline-flex items-center gap-1 text-xs text-muted-foreground"><CheckCircle2 size={14} /> Joined</span>
              </article>
            )}
          </For>
        </Card>
      </Show>

      <Show when={homeSection() === "groups"}>
        <Card id={tabPanelId("home-balance", "groups")} class="home-list-card overflow-hidden" role="tabpanel" aria-labelledby={tabId("home-balance", "groups")}>
          <SectionHeading title="Groups" detail="Your groups" action={<button type="button" class="list-add-action" onClick={props.onCreateGroup}><UsersRound size={14} /> Create group</button>} />
          <For each={appStore.groups()} fallback={<div class="px-6 py-12 text-center text-sm text-muted-foreground">Create a group to start splitting.</div>}>
            {(group) => {
              const balance = createMemo(() => groupBalance(group.id, group.settlementCurrency));
              const paymentCount = createMemo(() => groupPaymentCount(group.id));
              return <button type="button" class="home-group-row" onClick={() => props.onOpenGroup(group.id)}>
                <Avatar name={group.name} class="size-10 text-xs" />
                <span class="min-w-0 flex-1 text-left"><strong>{group.name}</strong><small>{groupMemberCount(group.id)} {groupMemberCount(group.id) === 1 ? "person" : "people"} · {groupExpenseCount(group.id)} {groupExpenseCount(group.id) === 1 ? "expense" : "expenses"}{paymentCount() ? ` · ${paymentCount()} ${paymentCount() === 1 ? "payment" : "payments"}` : ""}</small></span>
                <span class="home-group-balance"><small classList={{ "money-in": balance() > 0, "money-out": balance() < 0 }}>{balance() > 0 ? "you’re owed" : balance() < 0 ? "you owe" : "settled"}</small><strong classList={{ "money-in": balance() > 0, "money-out": balance() < 0 }}>{money(Math.abs(balance()), group.settlementCurrency)}</strong></span>
                <ChevronRight size={16} />
              </button>;
            }}
          </For>
        </Card>
      </Show>

      <ContactInviteDialog
        open={inviteOpen()}
        onOpenChange={setInviteOpen}
        onChanged={() => void refetchContacts()}
      />
      <RelationshipDetail
        open={Boolean(selectedRelationship())}
        actorId={props.actorId}
        relationship={selectedRelationship()}
        onOpenChange={(open) => { if (!open) setSelectedRelationship(undefined); }}
        onOpenGroup={props.onOpenGroup}
        onSettle={props.onSettle}
      />
    </div>
  );
}
