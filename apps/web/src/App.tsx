import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Cloud,
  CloudOff,
  HandCoins,
  House,
  LockKeyhole,
  LogOut,
  Mail,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  UsersRound,
  UserPlus,
} from "lucide-solid";
import { For, Match, Show, Switch, createMemo, createResource, createSignal, onMount } from "solid-js";
import { BrandMark } from "./components/BrandMark";
import { ExpenseComposer } from "./components/ExpenseComposer";
import { ExpenseDetailDialog } from "./components/ExpenseDetailDialog";
import { FeedbackButton } from "./components/FeedbackDialog";
import { SettleUpDialog, type SettlePrefill } from "./components/SettleUpDialog";
import { Avatar, Badge, Button, Card } from "./components/ui";
import { inviteGroupMember } from "./lib/api";
import { authClient, getOfflineActorId, signOutAndClearLocalLedger } from "./lib/auth";
import { appStore, initializeStore } from "./lib/store";
import type { LocalOperation } from "./lib/db";

type Tab = "friends" | "groups" | "activity" | "account";

function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function signedMoney(amountMinor: number, currency: string): string {
  if (amountMinor === 0) return money(0, currency);
  return (amountMinor > 0 ? "+" : "−") + money(Math.abs(amountMinor), currency);
}

function expenseDate(value: string): Date {
  return new Date(value + "T12:00:00");
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

/**
 * Balances only mean something inside one group and one currency. These helpers
 * keep those scopes apart; only same-currency positions are ever added together.
 */
function currencyTotals(actorId: string): Array<{ currency: string; net: number; owed: number; owing: number }> {
  const byCurrency = new Map<string, { net: number; owed: number; owing: number }>();
  for (const scope of appStore.balances()) {
    const net = scope.net.find(({ participantId }) => participantId === actorId)?.amountMinor ?? 0;
    if (net === 0 && !byCurrency.has(scope.currency)) byCurrency.set(scope.currency, { net: 0, owed: 0, owing: 0 });
    const entry = byCurrency.get(scope.currency) ?? { net: 0, owed: 0, owing: 0 };
    entry.net += net;
    if (net > 0) entry.owed += net;
    else entry.owing += -net;
    byCurrency.set(scope.currency, entry);
  }
  return [...byCurrency.entries()]
    .map(([currency, totals]) => ({ currency, ...totals }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

function groupNet(actorId: string, groupId: string): Array<{ currency: string; amountMinor: number }> {
  return appStore
    .balances()
    .filter((scope) => scope.groupId === groupId)
    .map((scope) => ({
      currency: scope.currency,
      amountMinor: scope.net.find(({ participantId }) => participantId === actorId)?.amountMinor ?? 0,
    }));
}

interface PersonDebt {
  groupId: string;
  groupName: string;
  currency: string;
  /** Positive means they owe the current user. */
  amountMinor: number;
}

function debtsWith(actorId: string, otherId: string): PersonDebt[] {
  const debts: PersonDebt[] = [];
  for (const scope of appStore.balances()) {
    const groupName = appStore.groups().find((group) => group.id === scope.groupId)?.name ?? "Group";
    for (const debt of scope.pairwise) {
      const theyOwe = debt.debtorId === otherId && debt.creditorId === actorId;
      const youOwe = debt.debtorId === actorId && debt.creditorId === otherId;
      if (!theyOwe && !youOwe) continue;
      debts.push({
        groupId: scope.groupId,
        groupName,
        currency: scope.currency,
        amountMinor: theyOwe ? debt.amountMinor : -debt.amountMinor,
      });
    }
  }
  return debts;
}

function ConnectionBadge() {
  const pending = createMemo(() => appStore.expenses().filter((expense) => expense.syncStatus === "pending").length);
  return (
    <Button variant="ghost" size="sm" class="h-8 gap-1.5 px-2 text-xs" onClick={() => void appStore.sync()} title={appStore.connectionMessage()}>
      <Switch>
        <Match when={appStore.connection() === "online"}>
          <Cloud class="text-emerald-600" size={14} /> <span>{pending() ? pending() + " syncing" : "Synced"}</span>
        </Match>
        <Match when={appStore.connection() === "connecting"}>
          <RefreshCw class="animate-spin" size={14} /> <span>Checking</span>
        </Match>
        <Match when={true}>
          <CloudOff class="text-amber-600" size={14} /> <span>{pending() ? pending() + " on device" : "Offline"}</span>
        </Match>
      </Switch>
    </Button>
  );
}

function SectionHeading(props: { title: string; detail?: string }) {
  return (
    <div class="flex items-center justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
      <h2 class="text-base font-semibold tracking-tight">{props.title}</h2>
      <Show when={props.detail}><span class="text-xs text-muted-foreground">{props.detail}</span></Show>
    </div>
  );
}

function ExpenseList(props: { onOpen(expenseId: string): void }) {
  const activeCount = createMemo(() => appStore.expenses().filter((expense) => expense.status === "active").length);
  return (
    <Card class="overflow-hidden">
      <SectionHeading title="Recent expenses" detail={activeCount() + (activeCount() === 1 ? " expense" : " expenses")} />
      <Show
        when={appStore.expenses().length > 0}
        fallback={
          <div class="grid min-h-56 place-items-center px-6 py-10 text-center">
            <div>
              <span class="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground"><ReceiptText size={18} /></span>
              <h3 class="text-sm font-medium">No expenses yet</h3>
              <p class="mt-1 text-sm text-muted-foreground">Add an expense to start this ledger.</p>
            </div>
          </div>
        }
      >
        <div class="divide-y divide-border">
          <For each={appStore.expenses()}>
            {(expense) => (
              <button
                type="button"
                class="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/50 sm:px-6"
                classList={{ "opacity-50": expense.status === "voided" }}
                onClick={() => props.onOpen(expense.id)}
              >
                <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><ReceiptText size={17} /></span>
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm font-medium">{expense.description}</strong>
                  <span class="block truncate text-xs text-muted-foreground">
                    {expense.category} · {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(expenseDate(expense.expenseDate))}
                  </span>
                </div>
                <div class="shrink-0 text-right">
                  <strong class="block text-sm font-semibold tabular-nums">{money(expense.amountMinor, expense.currency)}</strong>
                  <span
                    class="block text-xs text-muted-foreground"
                    classList={{ "text-emerald-700": expense.yourNetMinor > 0, "text-rose-700": expense.yourNetMinor < 0 }}
                  >
                    <Switch>
                      <Match when={expense.syncStatus === "conflicted"}>
                        <span class="inline-flex items-center gap-1 text-amber-700"><TriangleAlert size={12} /> Needs attention</span>
                      </Match>
                      <Match when={expense.syncStatus === "pending"}>Saved on device</Match>
                      <Match when={expense.yourNetMinor === 0}>Your share</Match>
                      <Match when={expense.yourNetMinor > 0}>You lent {money(expense.yourNetMinor, expense.currency)}</Match>
                      <Match when={true}>You owe {money(-expense.yourNetMinor, expense.currency)}</Match>
                    </Switch>
                  </span>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
    </Card>
  );
}

function GroupsCard(props: { actorId: string }) {
  return (
    <Card class="overflow-hidden">
      <SectionHeading title="Groups" detail={appStore.groups().length + " active"} />
      <div class="divide-y divide-border">
        <For each={appStore.groups()} fallback={<p class="px-5 py-8 text-sm text-muted-foreground">Preparing your first group…</p>}>
          {(group) => {
            const members = createMemo(() => appStore.members().filter((member) => member.groupId === group.id));
            const nets = createMemo(() => groupNet(props.actorId, group.id).filter(({ amountMinor }) => amountMinor !== 0));
            return (
              <article class="flex items-center gap-3 px-5 py-4">
                <Avatar name={group.name} class="rounded-lg bg-emerald-50 text-emerald-700" />
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm font-medium">{group.name}</strong>
                  <span class="text-xs text-muted-foreground">{members().length} people · {group.settlementCurrency}</span>
                </div>
                <div class="shrink-0 text-right">
                  <Show
                    when={nets().length > 0}
                    fallback={<><strong class="block text-sm font-semibold">Settled</strong><span class="text-xs text-muted-foreground">No balance</span></>}
                  >
                    <For each={nets()}>
                      {(entry) => (
                        <div>
                          <strong
                            class="block text-sm font-semibold tabular-nums"
                            classList={{ "text-emerald-700": entry.amountMinor > 0, "text-rose-700": entry.amountMinor < 0 }}
                          >
                            {money(Math.abs(entry.amountMinor), entry.currency)}
                          </strong>
                          <span class="text-xs text-muted-foreground">{entry.amountMinor > 0 ? "you get back" : "you owe"}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </article>
            );
          }}
        </For>
      </div>
    </Card>
  );
}

function GroupsView(props: { actorId: string; onAddExpense(): void; onSettleUp(): void; onOpenExpense(id: string): void }) {
  const totals = createMemo(() => currencyTotals(props.actorId));
  return (
    <div class="space-y-6">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Overview</h1>
          <p class="mt-1 text-sm text-muted-foreground">Your balances and recent shared expenses.</p>
        </div>
        <div class="flex gap-2">
          <Button variant="secondary" onClick={props.onSettleUp}><HandCoins size={16} /> <span class="hidden sm:inline">Settle up</span></Button>
          <Button onClick={props.onAddExpense}><Plus size={16} /> <span class="hidden sm:inline">Add expense</span><span class="sm:hidden">Add</span></Button>
        </div>
      </header>

      <Card class="p-5 sm:p-6">
        <Show
          when={totals().length > 0}
          fallback={<p class="text-sm text-muted-foreground">No balances yet. Add an expense to get started.</p>}
        >
          <div class="grid gap-6">
            <For each={totals()}>
              {(total) => (
                <div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div>
                    <p class="text-sm font-medium text-muted-foreground">Total balance · {total.currency}</p>
                    <strong
                      class="mt-2 block text-3xl font-semibold tracking-tight tabular-nums"
                      classList={{ "text-emerald-700": total.net > 0, "text-rose-700": total.net < 0 }}
                    >
                      {signedMoney(total.net, total.currency)}
                    </strong>
                    <p class="mt-1 text-sm text-muted-foreground">
                      {total.net === 0 ? "You are all settled up." : total.net > 0 ? "Overall, people owe you." : "Overall, you owe."}
                    </p>
                  </div>
                  <div class="grid grid-cols-2 gap-3 md:min-w-72">
                    <div class="rounded-lg border border-border bg-muted/40 p-3">
                      <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowDownLeft size={14} class="text-emerald-700" /> Owed to you</div>
                      <strong class="mt-1 block text-sm font-semibold tabular-nums">{money(total.owed, total.currency)}</strong>
                    </div>
                    <div class="rounded-lg border border-border bg-muted/40 p-3">
                      <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowUpRight size={14} class="text-rose-700" /> You owe</div>
                      <strong class="mt-1 block text-sm font-semibold tabular-nums">{money(total.owing, total.currency)}</strong>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Card>

      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <ExpenseList onOpen={props.onOpenExpense} />
        <GroupsCard actorId={props.actorId} />
      </div>
    </div>
  );
}

function FriendsView(props: { actorId: string; onSettle(prefill: SettlePrefill): void }) {
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [inviteGroupId, setInviteGroupId] = createSignal("");
  const [inviteName, setInviteName] = createSignal("");
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteMessage, setInviteMessage] = createSignal("");

  const people = createMemo(() => {
    const seen = new Map<string, { userId: string; displayName: string; status: string }>();
    for (const member of appStore.members()) {
      if (member.userId === props.actorId) continue;
      if (!seen.has(member.userId)) {
        seen.set(member.userId, { userId: member.userId, displayName: member.displayName, status: member.status });
      }
    }
    return [...seen.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
  });

  async function submitInvitation(event: SubmitEvent) {
    event.preventDefault();
    const groupId = inviteGroupId() || appStore.groups()[0]?.id;
    if (!groupId) return setInviteMessage("Create or sync a group before inviting someone.");
    setInviteMessage("Sending invitation…");
    try {
      await inviteGroupMember(groupId, { displayName: inviteName(), email: inviteEmail() });
      setInviteMessage("Invitation queued. They can join through their verified email.");
      setInviteName("");
      setInviteEmail("");
      await appStore.sync();
    } catch (error) {
      setInviteMessage(error instanceof Error ? error.message : "Invitation failed");
    }
  }

  return (
    <div class="space-y-6">
      <header class="flex items-start justify-between gap-4">
        <div><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">People</h1><p class="mt-1 text-sm text-muted-foreground">Who owes whom, group by group.</p></div>
        <Button variant="secondary" onClick={() => setInviteOpen((open) => !open)}><UserPlus size={16} /> Invite</Button>
      </header>
      <Show when={inviteOpen()}>
        <Card class="p-5">
          <form class="grid gap-4 md:grid-cols-[1fr_1fr_1.35fr_auto] md:items-end" onSubmit={submitInvitation}>
            <label class="grid gap-2 text-sm font-medium">Group
              <select class="form-control" value={inviteGroupId()} onInput={(event) => setInviteGroupId(event.currentTarget.value)}>
                <For each={appStore.groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For>
              </select>
            </label>
            <label class="grid gap-2 text-sm font-medium">Name<input class="form-control" required maxlength="100" value={inviteName()} onInput={(event) => setInviteName(event.currentTarget.value)} /></label>
            <label class="grid gap-2 text-sm font-medium">Email<input class="form-control" required type="email" value={inviteEmail()} onInput={(event) => setInviteEmail(event.currentTarget.value)} /></label>
            <Button type="submit">Send invite</Button>
            <Show when={inviteMessage()}><p class="text-sm text-muted-foreground md:col-span-4">{inviteMessage()}</p></Show>
          </form>
        </Card>
      </Show>
      <Card class="overflow-hidden">
        <For each={people()} fallback={<p class="px-6 py-12 text-center text-sm text-muted-foreground">No one else yet. Invite someone to begin a shared ledger.</p>}>
          {(person) => {
            const debts = createMemo(() => debtsWith(props.actorId, person.userId).filter(({ amountMinor }) => amountMinor !== 0));
            return (
              <article class="border-b border-border px-5 py-4 last:border-0 sm:px-6">
                <div class="flex items-center gap-3">
                  <Avatar name={person.displayName} />
                  <div class="min-w-0 flex-1">
                    <strong class="block truncate text-sm font-medium">{person.displayName}</strong>
                    <span class="text-xs text-muted-foreground">
                      {debts().length === 0 ? "Settled up" : debts().length + (debts().length === 1 ? " open balance" : " open balances")}
                    </span>
                  </div>
                  <Show when={person.status === "placeholder"} fallback={<Badge class="border-emerald-200 bg-emerald-50 text-emerald-700"><CheckCircle2 size={12} class="mr-1" /> Active</Badge>}>
                    <Badge class="border-amber-200 bg-amber-50 text-amber-700">Invited</Badge>
                  </Show>
                </div>
                <Show when={debts().length > 0}>
                  <div class="mt-3 grid gap-2 pl-12">
                    <For each={debts()}>
                      {(debt) => (
                        <div class="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
                          <div class="min-w-0 flex-1">
                            <span class="block truncate text-xs text-muted-foreground">{debt.groupName}</span>
                            <strong
                              class="text-sm font-medium tabular-nums"
                              classList={{ "text-emerald-700": debt.amountMinor > 0, "text-rose-700": debt.amountMinor < 0 }}
                            >
                              {debt.amountMinor > 0
                                ? `owes you ${money(debt.amountMinor, debt.currency)}`
                                : `you owe ${money(-debt.amountMinor, debt.currency)}`}
                            </strong>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              props.onSettle({
                                groupId: debt.groupId,
                                currency: debt.currency,
                                amountMinor: Math.abs(debt.amountMinor),
                                payerId: debt.amountMinor > 0 ? person.userId : props.actorId,
                                recipientId: debt.amountMinor > 0 ? props.actorId : person.userId,
                              })
                            }
                          >
                            <HandCoins size={14} /> Settle
                          </Button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </article>
            );
          }}
        </For>
      </Card>
    </div>
  );
}

function describeOperation(operation: LocalOperation): { title: string; detail: string } | null {
  const payload = (operation.payload ?? {}) as Record<string, unknown>;
  const actor = (userId: string): string =>
    appStore.members().find((member) => member.userId === userId)?.displayName ?? "Someone";
  const expenseLabel = (): string => {
    const fromPayload = typeof payload.description === "string" ? payload.description : "";
    if (fromPayload) return fromPayload;
    return appStore.expenses().find((expense) => expense.id === operation.targetId)?.description ?? "an expense";
  };

  switch (operation.type) {
    case "ExpenseCreated":
      return { title: `${actor(operation.actorId)} added ${expenseLabel()}`, detail: "Expense created" };
    case "ExpenseAmended":
      return { title: `${actor(operation.actorId)} edited ${expenseLabel()}`, detail: `Version ${operation.baseVersion + 1}` };
    case "ExpenseVoided":
      return { title: `${actor(operation.actorId)} deleted ${expenseLabel()}`, detail: "Expense removed from balances" };
    case "PaymentRecorded": {
      const payerId = typeof payload.payerId === "string" ? payload.payerId : "";
      const recipientId = typeof payload.recipientId === "string" ? payload.recipientId : "";
      return { title: `${actor(payerId)} paid ${actor(recipientId)}`, detail: "Settlement recorded" };
    }
    case "PaymentReversed":
      return { title: `${actor(operation.actorId)} reversed a payment`, detail: "Settlement undone" };
    case "CommentAdded":
      return { title: `${actor(operation.actorId)} commented`, detail: "Comment added" };
    default:
      return null;
  }
}

function ActivityView() {
  const entries = createMemo(() =>
    appStore
      .operations()
      .map((operation) => ({ operation, described: describeOperation(operation) }))
      .filter((entry): entry is { operation: LocalOperation; described: { title: string; detail: string } } =>
        entry.described !== null,
      ),
  );
  return (
    <div class="space-y-6">
      <header>
        <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Activity</h1>
        <p class="mt-1 text-sm text-muted-foreground">Every change to this ledger, in the order it was made.</p>
      </header>
      <Card class="overflow-hidden">
        <For each={entries()} fallback={<p class="px-6 py-12 text-center text-sm text-muted-foreground">Activity appears after your first expense.</p>}>
          {(entry) => (
            <article class="flex gap-3 border-b border-border px-5 py-4 last:border-0 sm:px-6">
              <span
                class="mt-1.5 size-2 shrink-0 rounded-full"
                classList={{
                  "bg-primary": entry.operation.syncStatus === "accepted",
                  "bg-amber-500": entry.operation.syncStatus === "pending" || entry.operation.syncStatus === "conflicted",
                  "bg-rose-500": entry.operation.syncStatus === "rejected",
                }}
              />
              <div class="min-w-0 flex-1">
                <strong class="block text-sm font-medium">{entry.described.title}</strong>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  {entry.described.detail}
                  <Switch>
                    <Match when={entry.operation.syncStatus === "pending"}> · waiting to sync</Match>
                    <Match when={entry.operation.syncStatus === "conflicted"}> · not applied, someone edited first</Match>
                    <Match when={entry.operation.syncStatus === "rejected"}> · rejected by the ledger</Match>
                  </Switch>
                </p>
              </div>
              <time class="shrink-0 text-xs text-muted-foreground">{shortDate(entry.operation.clientTimestamp)}</time>
            </article>
          )}
        </For>
      </Card>
    </div>
  );
}

function AccountView(props: { displayName: string }) {
  const settings = [
    { icon: ShieldCheck, title: "Signed operations", detail: "P-256 device key active" },
    { icon: Cloud, title: "Local-first storage", detail: "Ledger retained on this device" },
    { icon: ReceiptText, title: "Receipt capture", detail: "Planned after the core ledger" },
  ];
  return (
    <div class="space-y-6">
      <header><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1><p class="mt-1 text-sm text-muted-foreground">Account, privacy and offline storage.</p></header>
      <Card class="p-5 sm:p-6">
        <div class="flex items-center gap-4"><Avatar name={props.displayName} class="size-12 text-base" /><div><h2 class="font-semibold">{props.displayName}</h2><p class="text-sm text-muted-foreground">Signed in on this device</p></div></div>
      </Card>
      <Card class="overflow-hidden">
        <For each={settings}>{(item) => (
          <article class="flex items-center gap-3 border-b border-border px-5 py-4 last:border-0 sm:px-6">
            <span class="grid size-9 place-items-center rounded-md bg-muted text-muted-foreground"><item.icon size={17} /></span>
            <div class="min-w-0 flex-1"><strong class="block text-sm font-medium">{item.title}</strong><span class="text-xs text-muted-foreground">{item.detail}</span></div>
            <ChevronRight size={16} class="text-muted-foreground" />
          </article>
        )}</For>
        <Show when={!import.meta.env.DEV}>
          <div class="border-t border-border p-4"><Button variant="destructive" class="w-full" onClick={() => void signOutAndClearLocalLedger()}><LogOut size={16} /> Sign out and clear this device</Button></div>
        </Show>
      </Card>
    </div>
  );
}

function AuthenticatedApp(props: { actorId: string }) {
  const [tab, setTab] = createSignal<Tab>("groups");
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [settleOpen, setSettleOpen] = createSignal(false);
  const [settlePrefill, setSettlePrefill] = createSignal<SettlePrefill | undefined>(undefined);
  const [openExpenseId, setOpenExpenseId] = createSignal<string | undefined>(undefined);
  onMount(() => void initializeStore(props.actorId));
  const displayName = createMemo(() => appStore.members().find((member) => member.userId === props.actorId)?.displayName ?? "Your account");
  const tabs = [
    { id: "groups" as const, label: "Home", icon: House },
    { id: "friends" as const, label: "People", icon: UsersRound },
    { id: "activity" as const, label: "Activity", icon: Activity },
    { id: "account" as const, label: "Settings", icon: CircleUserRound },
  ];

  function openSettle(prefill?: SettlePrefill): void {
    setSettlePrefill(prefill);
    setSettleOpen(true);
  }

  return (
    <div class="min-h-dvh bg-background text-foreground md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside class="hidden min-h-dvh border-r border-border bg-card md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div class="flex h-16 items-center gap-2.5 border-b border-border px-5"><BrandMark size={30} /><strong class="text-sm font-semibold">Expenses</strong></div>
        <nav class="grid gap-1 p-3" aria-label="Primary navigation">
          <For each={tabs}>{(item) => (
            <Button variant="ghost" class="w-full justify-start" classList={{ "bg-muted text-foreground": tab() === item.id }} onClick={() => setTab(item.id)}>
              <item.icon size={17} /> {item.label}
            </Button>
          )}</For>
        </nav>
        <div class="mt-auto border-t border-border p-3"><ConnectionBadge /><FeedbackButton class="mt-1" /><p class="px-2 pt-1 text-xs leading-5 text-muted-foreground">Expenses save on this device before syncing.</p></div>
      </aside>

      <div class="min-w-0">
        <header class="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur md:hidden">
          <div class="flex items-center gap-2"><BrandMark size={28} /><strong class="text-sm font-semibold">Expenses</strong></div>
          <div class="flex items-center gap-1"><FeedbackButton compact /><ConnectionBadge /></div>
        </header>
        <main class="mx-auto w-full max-w-6xl px-4 py-6 pb-24 sm:px-6 sm:py-8 md:px-8 md:pb-10 lg:px-10">
          <Switch>
            <Match when={tab() === "friends"}><FriendsView actorId={props.actorId} onSettle={openSettle} /></Match>
            <Match when={tab() === "groups"}>
              <GroupsView
                actorId={props.actorId}
                onAddExpense={() => setComposerOpen(true)}
                onSettleUp={() => openSettle(undefined)}
                onOpenExpense={setOpenExpenseId}
              />
            </Match>
            <Match when={tab() === "activity"}><ActivityView /></Match>
            <Match when={tab() === "account"}><AccountView displayName={displayName()} /></Match>
          </Switch>
        </main>
      </div>

      <nav class="fixed inset-x-0 bottom-0 z-30 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-4 border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Primary navigation">
        <For each={tabs}>{(item) => (
          <button class="grid place-items-center content-center gap-1 text-[11px] font-medium text-muted-foreground" classList={{ "text-primary": tab() === item.id }} onClick={() => setTab(item.id)}>
            <item.icon size={19} stroke-width={tab() === item.id ? 2.5 : 2} /><span>{item.label}</span>
          </button>
        )}</For>
      </nav>
      <ExpenseComposer open={composerOpen()} onOpenChange={setComposerOpen} />
      <SettleUpDialog
        open={settleOpen()}
        prefill={settlePrefill()}
        onOpenChange={(open) => {
          setSettleOpen(open);
          if (!open) setSettlePrefill(undefined);
        }}
      />
      <ExpenseDetailDialog expenseId={openExpenseId()} onOpenChange={(open) => !open && setOpenExpenseId(undefined)} />
    </div>
  );
}

function AuthScreen() {
  const emailFromUrl = new URLSearchParams(window.location.search).get("email") ?? "";
  const [email, setEmail] = createSignal(emailFromUrl);
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function requestLink(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await authClient.signIn.magicLink({
        email: email().trim(),
        callbackURL: window.location.origin,
        newUserCallbackURL: window.location.origin,
        errorCallbackURL: window.location.origin + "/?auth=failed",
      });
      setMessage(result.error ? result.error.message ?? "Could not send the link." : "If this address is invited, a secure link is on its way and expires in 10 minutes.");
    } catch {
      setMessage("The server is unavailable. Previously signed-in devices can continue offline.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="grid min-h-dvh place-items-center bg-muted/50 px-4 py-10">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex items-center justify-center gap-2.5"><BrandMark size={36} /><strong class="text-base font-semibold">Expenses</strong></div>
        <Card class="p-6 sm:p-8">
          <div class="mb-6"><span class="mb-4 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><LockKeyhole size={18} /></span><h1 class="text-xl font-semibold tracking-tight">Sign in</h1><p class="mt-1.5 text-sm leading-6 text-muted-foreground">Enter your invited email and we'll send you a secure sign-in link.</p></div>
          <form class="grid gap-4" onSubmit={requestLink}>
            <label class="grid gap-2 text-sm font-medium">Email address<div class="relative"><Mail class="absolute left-3 top-3 text-muted-foreground" size={16} /><input class="form-control pl-9" required type="email" autocomplete="email" placeholder="you@example.com" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} /></div></label>
            <Button class="w-full" type="submit" disabled={busy()}>{busy() ? "Sending…" : "Send sign-in link"}</Button>
          </form>
          <Show when={message()}><p class="mt-4 rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground">{message()}</p></Show>
          <p class="mt-5 text-center text-xs text-muted-foreground">No password · Invite-only · Works offline</p>
        </Card>
      </div>
    </main>
  );
}

export default function App() {
  const session = authClient.useSession();
  const [offlineActorId] = createResource(getOfflineActorId);
  const actorId = createMemo(() => import.meta.env.DEV ? "dev-user" : session().data?.user.id ?? offlineActorId());
  return (
    <Show when={(!session().isPending && !offlineActorId.loading) || import.meta.env.DEV} fallback={<main class="grid min-h-dvh place-items-center bg-background"><BrandMark size={44} /></main>}>
      <Show when={actorId()} keyed fallback={<AuthScreen />}>
        {(id) => <AuthenticatedApp actorId={id} />}
      </Show>
    </Show>
  );
}
