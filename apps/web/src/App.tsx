import Activity from "lucide-solid/icons/activity";
import CheckCircle2 from "lucide-solid/icons/check-circle-2";
import ChevronRight from "lucide-solid/icons/chevron-right";
import CircleUserRound from "lucide-solid/icons/circle-user-round";
import Cloud from "lucide-solid/icons/cloud";
import CloudOff from "lucide-solid/icons/cloud-off";
import House from "lucide-solid/icons/house";
import LockKeyhole from "lucide-solid/icons/lock-keyhole";
import LogOut from "lucide-solid/icons/log-out";
import Mail from "lucide-solid/icons/mail";
import Moon from "lucide-solid/icons/moon";
import Plus from "lucide-solid/icons/plus";
import ReceiptText from "lucide-solid/icons/receipt-text";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Scale from "lucide-solid/icons/scale";
import ShieldCheck from "lucide-solid/icons/shield-check";
import Sparkles from "lucide-solid/icons/sparkles";
import Sun from "lucide-solid/icons/sun";
import UsersRound from "lucide-solid/icons/users-round";
import UserPlus from "lucide-solid/icons/user-plus";
import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  onMount,
} from "solid-js";
import { BrandMark } from "./components/BrandMark";
import { ExpenseComposer } from "./components/ExpenseComposer";
import { ExpenseDetail } from "./components/ExpenseDetail";
import { ExpenseTargetPicker } from "./components/ExpenseTargetPicker";
import { FeedbackButton } from "./components/FeedbackDialog";
import { GroupComposer } from "./components/GroupComposer";
import { PaymentComposer } from "./components/PaymentComposer";
import { Avatar, Button, Card } from "./components/ui";
import { inviteGroupMember } from "./lib/api";
import {
  authClient,
  getOfflineActorId,
  signOutAndClearLocalLedger,
} from "./lib/auth";
import type { LocalExpense, LocalOperation } from "./lib/db";
import type { ExpenseTarget } from "./lib/expense-targets";
import {
  computeBalances,
  computeRelationshipBalances,
  type Settlement,
} from "./lib/ledger-view";
import { appStore, initializeStore, restoreExpense } from "./lib/store";

type Tab = "overview" | "groups" | "activity" | "account";
type Theme = "system" | "light" | "dark";
const SpendingChart = lazy(() =>
  import("./components/SpendingChart").then((module) => ({
    default: module.SpendingChart,
  })),
);

function applyTheme(value: Theme): void {
  const dark =
    value === "dark" ||
    (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function money(amountMinor: number, currency = "USD", compact = false): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    ...(compact ? { notation: "compact", maximumFractionDigits: 1 } : {}),
  }).format(amountMinor / 100);
}

function expenseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function memberName(groupId: string, userId: string, actorId: string): string {
  if (userId === actorId) return "You";
  return (
    appStore
      .members()
      .find((member) => member.groupId === groupId && member.userId === userId)
      ?.displayName ?? "Member"
  );
}

function currenciesFor(groupId: string): string[] {
  const group = appStore.groups().find((item) => item.id === groupId);
  const values = new Set(
    appStore
      .expenses()
      .filter((item) => item.groupId === groupId)
      .map((item) => item.currency),
  );
  values.add(group?.settlementCurrency ?? "USD");
  return [...values];
}

function ConnectionPill() {
  const pending = createMemo(
    () =>
      appStore
        .operations()
        .filter((operation) => operation.syncStatus === "pending").length,
  );
  return (
    <button
      type="button"
      class="connection-pill glass-control"
      onClick={() => void appStore.sync()}
      title={appStore.connectionMessage()}
    >
      <Switch>
        <Match when={appStore.connection() === "online"}>
          <Cloud class="text-foreground" size={14} />
          <span>{pending() ? `${pending()} syncing` : "Synced"}</span>
        </Match>
        <Match when={appStore.connection() === "connecting"}>
          <RefreshCw class="animate-spin" size={14} />
          <span>Checking</span>
        </Match>
        <Match when={true}>
          <CloudOff class="connection-warning" size={14} />
          <span>{pending() ? `${pending()} on device` : "Offline"}</span>
        </Match>
      </Switch>
    </button>
  );
}

function SectionHeading(props: {
  title: string;
  detail?: string;
  action?: unknown;
}) {
  return (
    <div class="flex min-h-14 items-center justify-between gap-4 border-b border-border/65 px-4 sm:px-5">
      <div>
        <h2 class="text-sm font-semibold tracking-tight">{props.title}</h2>
        <Show when={props.detail}>
          <p class="text-xs text-muted-foreground">{props.detail}</p>
        </Show>
      </div>
      {props.action as never}
    </div>
  );
}

function GroupRail(props: {
  activeGroupId?: string | undefined;
  onSelect(groupId: string): void;
  onCreate(): void;
}) {
  return (
    <div
      class="group-rail -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      aria-label="Expense groups"
    >
      <For each={appStore.groups()}>
        {(group) => (
          <button
            type="button"
            class="group-tab snap-start"
            classList={{ selected: props.activeGroupId === group.id }}
            aria-pressed={props.activeGroupId === group.id}
            onClick={() => props.onSelect(group.id)}
          >
            {group.name}
          </button>
        )}
      </For>
      <button
        type="button"
        class="group-tab group-tab-add snap-start"
        onClick={props.onCreate}
        aria-label="Create group"
      >
        <Plus size={15} /> New
      </button>
    </div>
  );
}

function ExpenseList(props: {
  groupId: string;
  actorId: string;
  onOpen(expense: LocalExpense): void;
  onAdd?(): void;
}) {
  const expenses = createMemo(() => {
    const items = appStore
      .expenses()
      .filter((expense) => expense.groupId === props.groupId);
    return items.sort(
      (left, right) =>
        right.expenseDate.localeCompare(left.expenseDate) ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
  });
  const activeCount = createMemo(
    () => expenses().filter((item) => item.status === "active").length,
  );
  const expenseMonths = createMemo(() => {
    const months = new Map<string, { label: string; items: LocalExpense[] }>();
    for (const expense of expenses()) {
      const date = expenseDate(expense.expenseDate);
      const key = expense.expenseDate.slice(0, 7);
      const existing = months.get(key);
      if (existing) {
        existing.items.push(expense);
      } else {
        months.set(key, {
          label: new Intl.DateTimeFormat(undefined, {
            month: "long",
            year: "numeric",
          }).format(date),
          items: [expense],
        });
      }
    }
    return [...months.values()];
  });
  return (
    <Card class="expense-ledger">
      <SectionHeading
        title="Activity"
        detail={`${activeCount()} active ${activeCount() === 1 ? "expense" : "expenses"}`}
        action={
          <Show when={props.onAdd}>
            <button class="list-add-action" type="button" onClick={() => props.onAdd?.()}>
              <Plus size={14} /> Add
            </button>
          </Show>
        }
      />
      <Show
        when={expenses().length}
        fallback={
          <div class="grid min-h-56 place-items-center px-6 py-10 text-center">
            <div>
              <span class="mx-auto mb-3 grid size-11 place-items-center rounded-[4px] bg-muted text-muted-foreground">
                <ReceiptText size={19} />
              </span>
              <h3 class="text-sm font-semibold">Nothing here yet</h3>
              <p class="mt-1 text-sm text-muted-foreground">
                Your first shared expense will appear here.
              </p>
            </div>
          </div>
        }
      >
        <div>
          <For each={expenseMonths()}>
            {(month) => <section class="expense-month" aria-label={month.label}>
              <div class="expense-month-heading">{month.label}</div>
              <div class="divide-y divide-border/60">
                <For each={month.items}>
                  {(expense) => {
                    const date = expenseDate(expense.expenseDate);
                    const payer = memberName(
                      expense.groupId,
                      expense.payers[0]?.participantId ?? "",
                      props.actorId,
                    );
                    return <button
                      type="button"
                      class="expense-timeline-row group-row"
                      classList={{ "opacity-55": expense.status === "voided" }}
                      onClick={() => props.onOpen(expense)}
                    >
                      <time class="expense-date-rail" datetime={expense.expenseDate}>
                        <span>{new Intl.DateTimeFormat(undefined, { month: "short" }).format(date)}</span>
                        <strong>{new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date)}</strong>
                      </time>
                      <div class="min-w-0">
                        <strong class="expense-row-title">{expense.description}</strong>
                        <span class="expense-row-context">
                          {payer} paid · split {expense.allocations.length} {expense.allocations.length === 1 ? "way" : "ways"}
                          {expense.syncStatus === "pending" ? " · on device" : ""}
                          {expense.status === "voided" ? " · deleted" : ""}
                        </span>
                      </div>
                      <div class="expense-row-money">
                        <strong>{money(expense.amountMinor, expense.currency)}</strong>
                        <span classList={{
                          "money-in": expense.yourNetMinor > 0,
                          "money-out": expense.yourNetMinor < 0,
                        }}>
                          {expense.status === "voided"
                            ? "deleted"
                            : expense.yourNetMinor > 0
                              ? `you’re owed ${money(expense.yourNetMinor, expense.currency)}`
                              : expense.yourNetMinor < 0
                                ? `you owe ${money(-expense.yourNetMinor, expense.currency)}`
                                : "included"}
                        </span>
                      </div>
                      <ChevronRight size={15} class="expense-row-chevron" />
                    </button>;
                  }}
                </For>
              </div>
            </section>}
          </For>
        </div>
      </Show>
    </Card>
  );
}

function GroupsView(props: {
  actorId: string;
  activeGroupId?: string | undefined;
  onSelectGroup(groupId: string): void;
  onAddExpense(groupId?: string): void;
  onOpenExpense(expense: LocalExpense): void;
  onCreateGroup(): void;
  onSettle(settlement: Settlement | undefined, currency: string): void;
}) {
  const group = createMemo(
    () =>
      appStore.groups().find((item) => item.id === props.activeGroupId) ??
      appStore.groups()[0],
  );
  const expenses = createMemo(() =>
    appStore.expenses().filter((expense) => expense.groupId === group()?.id),
  );
  const activeExpenses = createMemo(() =>
    expenses().filter((expense) => expense.status === "active"),
  );
  const [currency, setCurrency] = createSignal("USD");
  const [chartMode, setChartMode] = createSignal<"category" | "month">(
    "category",
  );
  const [groupSection, setGroupSection] = createSignal<"expenses" | "balances" | "insights">("expenses");
  let sectionGroupId = "";
  createEffect(() => {
    const nextGroupId = group()?.id ?? "";
    setCurrency(group()?.settlementCurrency ?? "USD");
    if (nextGroupId && nextGroupId !== sectionGroupId) {
      sectionGroupId = nextGroupId;
      setGroupSection("expenses");
    }
  });
  const balances = createMemo(() =>
    group()
      ? computeBalances(
          appStore.expenses(),
          appStore.operations(),
          group()!.id,
          currency(),
        )
      : {},
  );
  const yourBalance = createMemo(() => balances()[props.actorId] ?? 0);
  const incoming = createMemo(() =>
    Object.entries(balances())
      .filter(([id, value]) => id !== props.actorId && value < 0)
      .reduce((sum, [, value]) => sum - value, 0),
  );
  const outgoing = createMemo(() =>
    Object.entries(balances())
      .filter(([id, value]) => id !== props.actorId && value > 0)
      .reduce((sum, [, value]) => sum + value, 0),
  );
  const people = createMemo(() =>
    appStore
      .members()
      .filter(
        (member) =>
          member.groupId === group()?.id &&
          member.userId !== props.actorId &&
          member.status === "active",
      ),
  );
  const total = createMemo(() =>
    activeExpenses()
      .filter((expense) => expense.currency === currency())
      .reduce((sum, expense) => sum + expense.amountMinor, 0),
  );
  const yourShare = createMemo(() =>
    activeExpenses()
      .filter((expense) => expense.currency === currency())
      .reduce(
        (sum, expense) =>
          sum +
          (expense.allocations.find(
            (item) => item.participantId === props.actorId,
          )?.amountMinor ?? 0),
        0,
      ),
  );

  return (
    <div class="page-enter space-y-5 sm:space-y-6">
      <header>
        <p class="eyebrow">Group ledger</p>
        <h1 class="page-title">{group()?.name ?? "Groups"}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{people().length + 1} people · {activeExpenses().length} {activeExpenses().length === 1 ? "expense" : "expenses"}</p>
      </header>
      <Show when={appStore.groups().length > 0}>
        <GroupRail
          activeGroupId={group()?.id}
          onSelect={props.onSelectGroup}
          onCreate={props.onCreateGroup}
        />
      </Show>
      <Show
        when={group()}
        keyed
        fallback={
          <Card class="grid min-h-72 place-items-center p-8 text-center">
            <div>
              <UsersRound class="mx-auto text-muted-foreground" size={30} />
              <h2 class="mt-3 font-semibold">Create your first group</h2>
              <p class="mt-1 text-sm text-muted-foreground">
                Add people, then start logging shared expenses.
              </p>
              <Button class="mt-5" onClick={props.onCreateGroup}>
                <Plus size={16} /> New group
              </Button>
            </div>
          </Card>
        }
      >
        {(activeGroup) => (
          <>
            <div class="group-view-tabs" role="tablist" aria-label={`${activeGroup.name} views`}>
              <button type="button" role="tab" aria-selected={groupSection() === "expenses"} classList={{ active: groupSection() === "expenses" }} onClick={() => setGroupSection("expenses")}><ReceiptText size={16} /><span>Activity</span></button>
              <button type="button" role="tab" aria-selected={groupSection() === "balances"} classList={{ active: groupSection() === "balances" }} onClick={() => setGroupSection("balances")}><Scale size={16} /><span>Balances</span></button>
              <button type="button" role="tab" aria-selected={groupSection() === "insights"} classList={{ active: groupSection() === "insights" }} onClick={() => setGroupSection("insights")}><Activity size={16} /><span>Insights</span></button>
            </div>

            <Show when={groupSection() === "expenses"}>
              <ExpenseList
                groupId={activeGroup.id}
                actorId={props.actorId}
                onOpen={props.onOpenExpense}
                onAdd={() => props.onAddExpense(activeGroup.id)}
              />
            </Show>

            <Show when={groupSection() === "balances"}>
              <div class="page-enter space-y-3" role="tabpanel" aria-label="Group balances">
                <section class="balance-strip" aria-label={`${activeGroup.name} balance summary`}>
                  <div class="balance-cell balance-cell-in"><span class="micro-label">Coming in</span><strong class="money-type">{money(incoming(), currency())}</strong></div>
                  <div class="balance-cell balance-cell-out"><span class="micro-label">Going out</span><strong class="money-type">{money(outgoing(), currency())}</strong></div>
                  <div class="balance-cell balance-cell-net"><span class="micro-label">Net balance</span><strong class="money-type">{yourBalance() === 0 ? money(0, currency()) : `${yourBalance() > 0 ? "+" : "−"}${money(Math.abs(yourBalance()), currency())}`}</strong></div>
                  <select class="balance-currency" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)} aria-label="Balance currency"><For each={currenciesFor(activeGroup.id)}>{(item) => <option value={item}>{item}</option>}</For></select>
                </section>
                <section class="people-balance-list" aria-label={`Balances in ${activeGroup.name}`}>
                  <For each={people()} fallback={<Card class="p-6 text-sm text-muted-foreground">Invite someone to {activeGroup.name} to start splitting.</Card>}>
                    {(member) => {
                      const balance = createMemo(() => balances()[member.userId] ?? 0);
                      const settlement = createMemo<Settlement | undefined>(() => balance() < 0 ? { payerId: member.userId, recipientId: props.actorId, amountMinor: -balance() } : balance() > 0 ? { payerId: props.actorId, recipientId: member.userId, amountMinor: balance() } : undefined);
                      const related = createMemo(() => activeExpenses().filter((expense) => expense.allocations.some((allocation) => allocation.participantId === member.userId)).slice(0, 2).map((expense) => expense.description).join(", "));
                      return (
                        <article class="person-balance-block" classList={{ "tone-mint": balance() < 0, "tone-coral": balance() > 0, "tone-butter": balance() === 0 }}>
                          <Avatar name={member.displayName} class="person-avatar" />
                          <div class="min-w-0 flex-1"><strong class="block truncate">{member.displayName}</strong><span class="micro-label block truncate">{related() || activeGroup.name}</span></div>
                          <div class="shrink-0 text-right"><strong class="money-type block" classList={{ "money-in": balance() < 0, "money-out": balance() > 0 }}>{balance() === 0 ? money(0, currency()) : `${balance() < 0 ? "+" : "−"}${money(Math.abs(balance()), currency())}`}</strong><span class="micro-label">{balance() < 0 ? "owes you" : balance() > 0 ? "you owe" : "settled"}</span></div>
                          <button class="ink-action" type="button" disabled={!settlement()} onClick={() => props.onSettle(settlement(), currency())}>{balance() > 0 ? "Pay" : "Settle"}</button>
                        </article>
                      );
                    }}
                  </For>
                </section>
              </div>
            </Show>

            <Show when={groupSection() === "insights"}>
              <Card id="insights" class="page-enter overflow-hidden" role="tabpanel">
                <SectionHeading
                  title="Spending insights"
                  detail={`${money(total(), currency())} total`}
                  action={<div class="flex items-center gap-2"><select class="insight-currency" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)} aria-label="Insights currency"><For each={currenciesFor(activeGroup.id)}>{(item) => <option value={item}>{item}</option>}</For></select><div class="segmented-control"><button classList={{ active: chartMode() === "category" }} aria-pressed={chartMode() === "category"} onClick={() => setChartMode("category")}>Category</button><button classList={{ active: chartMode() === "month" }} aria-pressed={chartMode() === "month"} onClick={() => setChartMode("month")}>Months</button></div></div>}
                />
                <div class="p-4">
                  <div class="mb-1 grid grid-cols-2 gap-3"><div class="metric-tile"><span>Total spent</span><strong>{money(total(), currency(), true)}</strong></div><div class="metric-tile"><span>Your share</span><strong>{money(yourShare(), currency(), true)}</strong></div></div>
                  <Show when={total() > 0} fallback={<div class="grid h-48 place-items-center text-sm text-muted-foreground">Charts appear after your first expense.</div>}>
                    <Suspense fallback={<div class="grid h-52 place-items-center text-xs text-muted-foreground">Preparing chart…</div>}><SpendingChart expenses={expenses()} currency={currency()} mode={chartMode()} /></Suspense>
                  </Show>
                </div>
              </Card>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function OverviewView(props: {
  actorId: string;
  activeGroupId?: string | undefined;
  onAddExpense(): void;
  onCreateGroup(): void;
  onOpenGroup(groupId: string): void;
  onSettle(settlement: Settlement, currency: string, groupId: string): void;
}) {
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [inviteGroupId, setInviteGroupId] = createSignal(
    props.activeGroupId ?? appStore.groups()[0]?.id ?? "",
  );
  const [email, setEmail] = createSignal("");
  const [message, setMessage] = createSignal("");
  const inviteGroup = createMemo(
    () => appStore.groups().find((item) => item.id === inviteGroupId()) ?? appStore.groups()[0],
  );
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
  createEffect(() => {
    if (!inviteGroupId() && appStore.groups()[0]) setInviteGroupId(appStore.groups()[0]!.id);
  });
  async function invite(event: SubmitEvent) {
    event.preventDefault();
    if (!inviteGroup()) return;
    setMessage("Sending…");
    try {
      await inviteGroupMember(inviteGroup()!.id, { email: email() });
      setMessage("Invite sent — their link signs them in and opens the group.");
      setEmail("");
      await appStore.sync();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not send invite");
    }
  }
  return (
    <div class="page-enter space-y-5">
      <header class="flex items-start justify-between gap-4">
        <div>
          <p class="eyebrow">Across {appStore.groups().length} {appStore.groups().length === 1 ? "group" : "groups"}</p>
          <h1 class="page-title">Your balances</h1>
        </div>
        <Button class="hidden sm:inline-flex" onClick={props.onAddExpense}>
          <Plus size={16} /> Add expense
        </Button>
      </header>

      <div class="grid gap-3 lg:grid-cols-2">
        <For each={totals()}>
          {(total) => (
            <section class="overview-balance" aria-label={`${total.currency} balance across all groups`}>
              <div>
                <span class="micro-label">Summary · {total.currency}</span>
                <strong class="money-type">
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

      <div class="grid gap-3 sm:grid-cols-2">
        <button type="button" class="overview-action" onClick={() => setInviteOpen((value) => !value)} aria-expanded={inviteOpen()}>
          <span class="overview-action-icon"><UserPlus size={17} /></span>
          <span><strong>Invite someone</strong><small>Email is all you need</small></span>
          <ChevronRight size={17} />
        </button>
        <button type="button" class="overview-action" onClick={props.onCreateGroup}>
          <span class="overview-action-icon"><UsersRound size={17} /></span>
          <span><strong>New group</strong><small>For a trip, home, or event</small></span>
          <ChevronRight size={17} />
        </button>
      </div>

      <Show when={inviteOpen()}>
        <Card class="disclosure-panel p-5">
          <div class="flex items-start justify-between gap-3">
            <div><h2 class="text-sm font-semibold">Invite by email</h2><p class="mt-1 text-sm text-muted-foreground">One link signs them in and opens the right group.</p></div>
            <Show when={appStore.groups().length > 1}>
              <select class="form-control h-10 max-w-40" value={inviteGroup()?.id} onInput={(event) => setInviteGroupId(event.currentTarget.value)} aria-label="Group for invitation">
                <For each={appStore.groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For>
              </select>
            </Show>
          </div>
          <form class="mt-4 flex gap-2" onSubmit={invite}>
            <input class="form-control h-11" required type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} placeholder="friend@example.com" />
            <Button type="submit">Send</Button>
          </form>
          <Show when={message()}><p class="mt-3 text-xs text-muted-foreground">{message()}</p></Show>
        </Card>
      </Show>

      <Card class="overflow-hidden">
        <SectionHeading title="People" detail={relationships().length ? "Net across all shared groups" : "No open balances"} />
        <For
          each={relationships()}
          fallback={<div class="px-6 py-12 text-center"><ReceiptText class="mx-auto text-muted-foreground" size={25} /><p class="mt-3 text-sm text-muted-foreground">Add an expense and balances will appear here.</p></div>}
        >
          {(relationship, index) => {
            const personName = createMemo(() => nameFor(relationship.userId));
            const settlement = createMemo<Settlement>(() => relationship.amountMinor > 0
              ? { payerId: relationship.userId, recipientId: props.actorId, amountMinor: relationship.amountMinor }
              : { payerId: props.actorId, recipientId: relationship.userId, amountMinor: Math.abs(relationship.amountMinor) });
            const canSettleHere = relationship.groupIds.length === 1;
            return (
              <article class="relationship-row" style={{ "--row-index": index() }}>
                <Avatar name={personName()} class="size-9 text-xs" />
                <button type="button" class="min-w-0 flex-1 text-left" onClick={() => props.onOpenGroup(relationship.groupIds[0]!)}>
                  <strong class="block truncate text-sm">{personName()}</strong>
                  <span class="block truncate text-xs text-muted-foreground">{groupNames(relationship.groupIds)}</span>
                </button>
                <div class="text-right">
                  <strong class="block text-sm tabular-nums" classList={{ "money-in": relationship.amountMinor > 0, "money-out": relationship.amountMinor < 0 }}>{money(Math.abs(relationship.amountMinor), relationship.currency)}</strong>
                  <span class="text-[11px] text-muted-foreground">{relationship.amountMinor > 0 ? "owes you" : "you owe"}</span>
                </div>
                <button type="button" class="relationship-action" onClick={() => canSettleHere ? props.onSettle(settlement(), relationship.currency, relationship.groupIds[0]!) : props.onOpenGroup(relationship.groupIds[0]!)}>
                  {canSettleHere ? "Settle" : "View"}
                </button>
              </article>
            );
          }}
        </For>
      </Card>
    </div>
  );
}

const activityCopy: Partial<Record<LocalOperation["type"], string>> = {
  ExpenseCreated: "added an expense",
  ExpenseAmended: "updated an expense",
  ExpenseVoided: "deleted an expense",
  ExpenseRestored: "restored an expense",
  CommentAdded: "commented",
  PaymentRecorded: "recorded a payment",
  PaymentReversed: "reversed a payment",
  GroupCreated: "created a group",
  GroupMemberAdded: "added a member",
  GroupMemberRemoved: "removed a member",
};

function ActivityView(props: {
  actorId: string;
  onOpenExpense(expense: LocalExpense): void;
  onToast(message: string): void;
}) {
  async function restore(expense: LocalExpense) {
    await restoreExpense(expense);
    props.onToast("Expense restored");
  }
  return (
    <div class="page-enter space-y-5">
      <header>
        <h1 class="page-title">Activity</h1>
        <p class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span class="sync-dot" classList={{ pending: appStore.connection() !== "online" }} />
          {appStore.connection() === "online" ? "Synced" : "Saved on this device"} · every change remains auditable
        </p>
      </header>
      <Card class="overflow-hidden">
        <For
          each={appStore.operations()}
          fallback={
            <div class="px-6 py-12 text-center text-sm text-muted-foreground">
              Activity appears after your first ledger change.
            </div>
          }
        >
          {(operation) => {
            const expense = createMemo(() =>
              appStore
                .expenses()
                .find((item) => item.id === operation.targetId),
            );
            const group = createMemo(() =>
              appStore.groups().find((item) => item.id === operation.groupId),
            );
            return (
              <article class="activity-row flex gap-3 border-b border-border/60 px-4 py-4 last:border-0 sm:px-5">
                <span
                  class="activity-dot"
                  classList={{
                    pending: operation.syncStatus === "pending",
                    error:
                      operation.syncStatus === "conflicted" ||
                      operation.syncStatus === "rejected",
                  }}
                />
                <button
                  type="button"
                  class="min-w-0 flex-1 text-left"
                  disabled={!expense()}
                  onClick={() => expense() && props.onOpenExpense(expense()!)}
                >
                  <strong class="block text-sm font-semibold">
                    {operation.actorId === props.actorId
                      ? "You"
                      : memberName(
                          operation.groupId,
                          operation.actorId,
                          props.actorId,
                        )}{" "}
                    {activityCopy[operation.type] ?? "changed the ledger"}
                  </strong>
                  <p class="mt-0.5 truncate text-xs text-muted-foreground">
                    {expense()
                      ? `${expense()!.description} · ${group()?.name ?? "Shared group"}`
                      : group()?.name ?? "Shared ledger"}{" "}
                    ·{" "}
                    {operation.syncStatus === "pending"
                      ? "on this device"
                      : operation.syncStatus === "accepted"
                        ? "verified"
                        : "needs review"}
                  </p>
                </button>
                <div class="shrink-0 text-right">
                  <time class="block text-[11px] text-muted-foreground">
                    {new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                    }).format(new Date(operation.clientTimestamp))}
                  </time>
                  <Show
                    when={
                      operation.type === "ExpenseVoided" &&
                      expense()?.status === "voided"
                    }
                  >
                    <button
                      class="mt-1 text-xs font-semibold text-primary"
                      onClick={() => expense() && void restore(expense()!)}
                    >
                      Restore
                    </button>
                  </Show>
                </div>
              </article>
            );
          }}
        </For>
      </Card>
    </div>
  );
}

function AccountView(props: { displayName: string }) {
  const [theme, setTheme] = createSignal<Theme>(
    (localStorage.getItem("expenses-theme") as Theme | null) ?? "system",
  );
  createEffect(() => {
    const value = theme();
    localStorage.setItem("expenses-theme", value);
    applyTheme(value);
  });
  return (
    <div class="page-enter space-y-5">
      <header>
        <p class="eyebrow">Preferences & security</p>
        <h1 class="page-title">Account</h1>
      </header>
      <Card class="p-5">
        <div class="flex items-center gap-4">
          <Avatar name={props.displayName} class="size-14 text-lg" />
          <div>
            <h2 class="font-semibold">{props.displayName}</h2>
            <p class="text-sm text-muted-foreground">Passwordless account</p>
          </div>
        </div>
      </Card>
      <Card class="overflow-hidden">
        <SectionHeading title="Appearance" detail="Optimized for iPhone" />
        <div class="grid grid-cols-3 gap-2 p-4">
          <For
            each={
              [
                { id: "system", label: "System", icon: Sparkles },
                { id: "light", label: "Light", icon: Sun },
                { id: "dark", label: "Dark", icon: Moon },
              ] as const
            }
          >
            {(item) => (
              <button
                class="appearance-choice"
                classList={{ active: theme() === item.id }}
                aria-pressed={theme() === item.id}
                onClick={() => setTheme(item.id)}
              >
                <item.icon size={17} />
                <span>{item.label}</span>
              </button>
            )}
          </For>
        </div>
      </Card>
      <Card class="overflow-hidden">
        <For
          each={[
            {
              icon: ShieldCheck,
              title: "Signed operations",
              detail: "P-256 device key active",
            },
            {
              icon: Cloud,
              title: "Offline-first",
              detail: "New entries queue safely on this device",
            },
            {
              icon: Scale,
              title: "Auditable balances",
              detail: "Every edit remains in the ledger",
            },
          ]}
        >
          {(item) => (
            <article class="flex items-center gap-3 border-b border-border/60 px-4 py-4 last:border-0">
              <span class="category-icon">
                <item.icon size={17} />
              </span>
              <div>
                <strong class="block text-sm">{item.title}</strong>
                <span class="text-xs text-muted-foreground">{item.detail}</span>
              </div>
            </article>
          )}
        </For>
        <Show when={!import.meta.env.DEV}>
          <div class="border-t border-border/60 p-3">
            <FeedbackButton />
          </div>
          <div class="border-t border-border/60 p-4">
            <Button
              variant="destructive"
              class="w-full"
              onClick={() => void signOutAndClearLocalLedger()}
            >
              <LogOut size={16} /> Sign out and clear this device
            </Button>
          </div>
        </Show>
      </Card>
    </div>
  );
}

function AuthenticatedApp(props: { actorId: string }) {
  const [tab, setTab] = createSignal<Tab>("overview");
  const [expenseOpen, setExpenseOpen] = createSignal(false);
  const [targetPickerOpen, setTargetPickerOpen] = createSignal(false);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [groupOpen, setGroupOpen] = createSignal(false);
  const [paymentOpen, setPaymentOpen] = createSignal(false);
  const [selectedGroupId, setSelectedGroupId] = createSignal<string>();
  const [selectedExpense, setSelectedExpense] = createSignal<LocalExpense>();
  const [editingExpense, setEditingExpense] = createSignal<LocalExpense>();
  const [expenseTarget, setExpenseTarget] = createSignal<ExpenseTarget>();
  const [preferredTargetGroupId, setPreferredTargetGroupId] =
    createSignal<string>();
  const [suggestedSettlement, setSuggestedSettlement] =
    createSignal<Settlement>();
  const [paymentCurrency, setPaymentCurrency] = createSignal("USD");
  const [toast, setToast] = createSignal("");
  let toastTimer = 0;
  onMount(() => {
    applyTheme(
      (localStorage.getItem("expenses-theme") as Theme | null) ?? "system",
    );
    void initializeStore(props.actorId);
  });
  createEffect(() => {
    if (!selectedGroupId() && appStore.groups()[0])
      setSelectedGroupId(appStore.groups()[0]!.id);
  });
  createEffect(() => {
    const selected = selectedExpense();
    if (selected) {
      const latest = appStore
        .expenses()
        .find((item) => item.id === selected.id);
      if (latest && latest !== selected) setSelectedExpense(latest);
    }
  });
  const displayName = createMemo(
    () =>
      appStore.members().find((member) => member.userId === props.actorId)
        ?.displayName ?? "Your account",
  );
  const activeGroup = createMemo(
    () =>
      appStore.groups().find((group) => group.id === selectedGroupId()) ??
      appStore.groups()[0],
  );
  const tabs = [
    { id: "overview" as const, label: "Home", icon: House },
    { id: "groups" as const, label: "Groups", icon: UsersRound },
    { id: "activity" as const, label: "Activity", icon: Activity },
    { id: "account" as const, label: "Account", icon: CircleUserRound },
  ];
  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(""), 3500);
  }
  function selectGroup(id: string) {
    setSelectedGroupId(id);
    setTab("groups");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function addExpense(id?: string) {
    setPreferredTargetGroupId(id);
    setEditingExpense(undefined);
    window.setTimeout(() => setTargetPickerOpen(true), 0);
  }
  function openGroupComposer() {
    window.setTimeout(() => setGroupOpen(true), 0);
  }
  function chooseExpenseTarget(target: ExpenseTarget) {
    setExpenseTarget(target);
    setSelectedGroupId(target.groupId);
    setTargetPickerOpen(false);
    window.setTimeout(() => setExpenseOpen(true), 0);
  }
  function openDetail(expense: LocalExpense) {
    setSelectedGroupId(expense.groupId);
    setSelectedExpense(expense);
    window.setTimeout(() => setDetailOpen(true), 0);
  }
  function edit(expense: LocalExpense) {
    setDetailOpen(false);
    setEditingExpense(expense);
    window.setTimeout(() => setExpenseOpen(true), 0);
  }
  function settle(
    settlement?: Settlement,
    currency = activeGroup()?.settlementCurrency ?? "USD",
    groupId?: string,
  ) {
    if (groupId) setSelectedGroupId(groupId);
    setSuggestedSettlement(settlement);
    setPaymentCurrency(currency);
    window.setTimeout(() => setPaymentOpen(true), 0);
  }
  return (
    <div class="app-shell min-h-dvh text-foreground md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside class="desktop-sidebar hidden md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div class="flex h-18 items-center gap-2.5 px-5">
          <BrandMark size={32} />
          <strong>Tally</strong>
        </div>
        <div class="px-3 pb-3">
          <Button
            class="h-11 w-full justify-start"
            onClick={() => addExpense()}
          >
            <Plus size={17} /> Add expense
          </Button>
        </div>
        <nav class="grid gap-1 px-3">
          <For each={tabs}>
            {(item) => (
              <button
                class="desktop-nav-item"
                classList={{ active: tab() === item.id }}
                aria-current={tab() === item.id ? "page" : undefined}
                onClick={() => setTab(item.id)}
              >
                <item.icon size={18} />
                {item.label}
              </button>
            )}
          </For>
        </nav>
        <div class="mt-5 border-t border-border/60 px-3 pt-4">
          <div class="mb-2 flex items-center justify-between px-2">
            <span class="eyebrow">Groups</span>
            <button
              class="icon-button"
              onClick={openGroupComposer}
              aria-label="New group"
            >
              <Plus size={15} />
            </button>
          </div>
          <For each={appStore.groups()}>
            {(group) => (
              <button
                class="desktop-group"
                classList={{ active: selectedGroupId() === group.id }}
                aria-pressed={selectedGroupId() === group.id}
                onClick={() => selectGroup(group.id)}
              >
                <span class="size-2 rounded-full bg-primary" />
                <span class="truncate">{group.name}</span>
              </button>
            )}
          </For>
        </div>
        <div class="mt-auto p-4">
          <FeedbackButton class="mb-2" />
          <ConnectionPill />
          <p class="mt-2 text-xs leading-5 text-muted-foreground">
            Ledger changes save locally before syncing.
          </p>
        </div>
      </aside>
      <div class="min-w-0">
        <header class="mobile-header md:hidden">
          <strong class="mobile-wordmark">Tally</strong>
          <button class="mobile-add-action" type="button" onClick={() => addExpense()}>
            <Plus size={15} /> Add expense
          </button>
        </header>
        <main class="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 sm:px-6 sm:pt-8 md:px-8 md:pb-12 lg:px-10">
          <Switch>
            <Match when={tab() === "overview"}>
              <OverviewView
                actorId={props.actorId}
                activeGroupId={selectedGroupId()}
                onAddExpense={() => addExpense()}
                onCreateGroup={openGroupComposer}
                onOpenGroup={selectGroup}
                onSettle={settle}
              />
            </Match>
            <Match when={tab() === "groups"}>
              <GroupsView
                actorId={props.actorId}
                activeGroupId={selectedGroupId()}
                onSelectGroup={selectGroup}
                onAddExpense={addExpense}
                onOpenExpense={openDetail}
                onCreateGroup={openGroupComposer}
                onSettle={settle}
              />
            </Match>
            <Match when={tab() === "activity"}>
              <ActivityView
                actorId={props.actorId}
                onOpenExpense={openDetail}
                onToast={notify}
              />
            </Match>
            <Match when={tab() === "account"}>
              <AccountView displayName={displayName()} />
            </Match>
          </Switch>
        </main>
      </div>
      <nav
        class="mobile-tabbar glass-nav md:hidden"
        aria-label="Primary navigation"
      >
        <For each={tabs}>
          {(item) => (
            <button
              class="nav-item"
              classList={{ active: tab() === item.id }}
              aria-current={tab() === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={20} stroke-width={tab() === item.id ? 2.6 : 2} />
              <span>{item.label}</span>
            </button>
          )}
        </For>
      </nav>
      <Show when={toast()}>
        <div class="toast-enter toast-pill">
          <CheckCircle2 size={16} />
          {toast()}
        </div>
      </Show>
      <ExpenseTargetPicker
        open={targetPickerOpen()}
        actorId={props.actorId}
        preferredGroupId={preferredTargetGroupId()}
        onOpenChange={setTargetPickerOpen}
        onSelect={chooseExpenseTarget}
        onCreateGroup={openGroupComposer}
      />
      <ExpenseComposer
        open={expenseOpen()}
        actorId={props.actorId}
        initialGroupId={
          editingExpense()?.groupId ??
          expenseTarget()?.groupId ??
          selectedGroupId()
        }
        initialParticipantIds={
          editingExpense() ? undefined : expenseTarget()?.participantIds
        }
        targetLabel={editingExpense() ? undefined : expenseTarget()?.label}
        expense={editingExpense()}
        onOpenChange={(open) => {
          setExpenseOpen(open);
          if (!open) setEditingExpense(undefined);
        }}
        onChangeTarget={() => {
          setExpenseOpen(false);
          window.setTimeout(() => setTargetPickerOpen(true), 0);
        }}
        onSaved={(mode) =>
          notify(mode === "updated" ? "Expense updated" : "Expense added")
        }
      />
      <ExpenseDetail
        open={detailOpen()}
        actorId={props.actorId}
        expense={selectedExpense()}
        onOpenChange={setDetailOpen}
        onEdit={edit}
        onChanged={notify}
      />
      <PaymentComposer
        open={paymentOpen()}
        groupId={selectedGroupId()}
        currency={paymentCurrency()}
        suggested={suggestedSettlement()}
        onOpenChange={setPaymentOpen}
        onSaved={() => notify("Payment recorded")}
      />
      <GroupComposer
        open={groupOpen()}
        onOpenChange={setGroupOpen}
        onCreated={(id) => {
          selectGroup(id);
          notify("Group created");
        }}
      />
    </div>
  );
}

function AuthScreen() {
  const [email, setEmail] = createSignal(
    new URLSearchParams(location.search).get("email") ?? "",
  );
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function requestLink(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await authClient.signIn.magicLink({
        email: email().trim(),
        callbackURL: location.origin,
        newUserCallbackURL: location.origin,
        errorCallbackURL: `${location.origin}/?auth=failed`,
      });
      setMessage(
        result.error
          ? (result.error.message ?? "Could not send the link.")
          : "Check your inbox — the secure link signs you in directly.",
      );
    } catch {
      setMessage(
        "The server is unavailable. Previously signed-in devices can continue offline.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main class="auth-shell grid min-h-dvh place-items-center px-4 py-10">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex items-center justify-center gap-2.5 text-white">
          <BrandMark size={38} />
          <strong class="text-lg">Tally</strong>
        </div>
        <Card class="glass-auth rounded-xl p-6 sm:p-8">
          <span class="mb-5 grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary">
            <LockKeyhole size={19} />
          </span>
          <h1 class="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">
            Enter your invited email. No password, no second verification step.
          </p>
          <form class="mt-6 grid gap-4" onSubmit={requestLink}>
            <label class="grid gap-2 text-sm font-medium">
              Email address
              <div class="relative">
                <Mail
                  class="absolute left-3 top-3 text-muted-foreground"
                  size={17}
                />
                <input
                  class="form-control h-12 pl-9"
                  required
                  type="email"
                  autocomplete="email"
                  value={email()}
                  onInput={(event) => setEmail(event.currentTarget.value)}
                  placeholder="you@example.com"
                />
              </div>
            </label>
            <Button
              class="h-12 w-full rounded-xl"
              type="submit"
              disabled={busy()}
            >
              {busy() ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </form>
          <Show when={message()}>
            <p class="mt-4 rounded-xl border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
              {message()}
            </p>
          </Show>
          <p class="mt-5 text-center text-xs text-muted-foreground">
            Private · Passwordless · Offline-ready
          </p>
        </Card>
      </div>
    </main>
  );
}

export default function App() {
  const session = authClient.useSession();
  const [offlineActorId] = createResource(getOfflineActorId);
  const actorId = createMemo(() =>
    import.meta.env.DEV
      ? "dev-user"
      : (session().data?.user.id ?? offlineActorId()),
  );
  return (
    <Show
      when={
        (!session().isPending && !offlineActorId.loading) || import.meta.env.DEV
      }
      fallback={
        <main class="grid min-h-dvh place-items-center bg-background">
          <BrandMark size={44} />
        </main>
      }
    >
      <Show when={actorId()} keyed fallback={<AuthScreen />}>
        {(id) => <AuthenticatedApp actorId={id} />}
      </Show>
    </Show>
  );
}
