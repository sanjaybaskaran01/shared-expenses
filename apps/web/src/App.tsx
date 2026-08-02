import Activity from "lucide-solid/icons/activity";
import BedSingle from "lucide-solid/icons/bed-single";
import CarFront from "lucide-solid/icons/car-front";
import CheckCircle2 from "lucide-solid/icons/check-circle-2";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import CircleUserRound from "lucide-solid/icons/circle-user-round";
import Cloud from "lucide-solid/icons/cloud";
import CloudOff from "lucide-solid/icons/cloud-off";
import Coffee from "lucide-solid/icons/coffee";
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
import ShoppingBasket from "lucide-solid/icons/shopping-basket";
import Sparkles from "lucide-solid/icons/sparkles";
import Sun from "lucide-solid/icons/sun";
import Ticket from "lucide-solid/icons/ticket";
import Utensils from "lucide-solid/icons/utensils";
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
import { ContactInviteDialog } from "./components/ContactInviteDialog";
import { ExpenseComposer } from "./components/ExpenseComposer";
import { ExpenseDetail } from "./components/ExpenseDetail";
import { ExpenseTargetPicker } from "./components/ExpenseTargetPicker";
import { FeedbackButton } from "./components/FeedbackDialog";
import { GroupComposer } from "./components/GroupComposer";
import { PaymentComposer } from "./components/PaymentComposer";
import {
  AccessibleTabs,
  Avatar,
  Button,
  Card,
  tabId,
  tabPanelId,
} from "./components/ui";
import {
  acceptCurrentContactInvitation,
  claimContactInvitation,
  getAuthCapabilities,
  getContacts,
} from "./lib/api";
import {
  authClient,
  getOfflineActorId,
  signOutAndClearLocalLedger,
} from "./lib/auth";
import { clearInviteToken, inviteTokenFromHash } from "./lib/contact-invites";
import { developmentIdentity } from "./lib/development-actor";
import type { LocalExpense, LocalOperation } from "./lib/db";
import {
  decideExpenseLaunch,
  decideGroupCreationDestination,
  dialogHandoffDelay,
  groupComposerOriginAfterOpenChange,
  type GroupComposerOrigin,
} from "./lib/expense-launch";
import { mostRecentExpenseGroupId, type ExpenseTarget } from "./lib/expense-targets";
import { buildGroupInsights, buildGroupReconciliation, settlementBlockerCount, summarizeOperationHealth } from "./lib/group-insights";
import {
  computeBalances,
  computeRelationshipBalances,
  simplifyBalances,
  type Settlement,
} from "./lib/ledger-view";
import { appStore, changeGroupCurrency, initializeStore, restoreExpense } from "./lib/store";

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

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(`${value}-15T12:00:00`));
}

function CategoryMark(props: { category: string }) {
  const value = props.category.toLocaleLowerCase();
  const Icon = value.includes("food") || value.includes("dinner") || value.includes("restaurant")
    ? Utensils
    : value.includes("coffee") || value.includes("drink")
      ? Coffee
      : value.includes("car") || value.includes("taxi") || value.includes("transport")
        ? CarFront
        : value.includes("grocery") || value.includes("shop")
          ? ShoppingBasket
          : value.includes("hotel") || value.includes("stay")
            ? BedSingle
            : value.includes("ticket") || value.includes("event")
              ? Ticket
              : ReceiptText;
  const tone = [...value].reduce((total, character) => total + character.charCodeAt(0), 0) % 4;
  return <span class={`category-icon category-tone-${tone}`}><Icon size={17} /></span>;
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
    <>
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
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {appStore.connectionMessage()}
      </span>
    </>
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
                      <CategoryMark category={expense.category} />
                      <div class="min-w-0">
                        <strong class="expense-row-title">{expense.description}</strong>
                        <span class="expense-row-context">
                          {payer} paid · split {expense.allocations.length} {expense.allocations.length === 1 ? "way" : "ways"}
                          {expense.syncStatus === "pending" ? " · on device" : ""}
                          {expense.status === "voided" ? " · deleted" : ""}
                        </span>
                      </div>
                      <div class="expense-row-money">
                        <strong classList={{
                          "money-in": expense.yourNetMinor > 0,
                          "money-out": expense.yourNetMinor < 0,
                          "sync-attention": expense.syncStatus === "conflicted" || expense.syncStatus === "rejected",
                        }}>
                          {expense.syncStatus === "conflicted"
                            ? "needs review"
                            : expense.syncStatus === "rejected"
                              ? "not synced"
                              : expense.status === "voided"
                            ? "deleted"
                            : expense.yourNetMinor > 0
                              ? `+${money(expense.yourNetMinor, expense.currency)}`
                              : expense.yourNetMinor < 0
                                ? `−${money(-expense.yourNetMinor, expense.currency)}`
                                : money(0, expense.currency)}
                        </strong>
                        <span>{expense.status === "voided" ? money(expense.amountMinor, expense.currency) : `${money(expense.amountMinor, expense.currency)} total`}</span>
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

function GroupsOverview(props: {
  actorId: string;
  onOpenGroup(groupId: string): void;
  onCreateGroup(): void;
}) {
  const groupMemberCount = (groupId: string) =>
    appStore.members().filter((member) => member.groupId === groupId && member.status === "active").length;
  const groupExpenseCount = (groupId: string) =>
    appStore.expenses().filter((expense) => expense.groupId === groupId && expense.status === "active").length;
  const groupBalance = (groupId: string, currency: string) =>
    computeBalances(appStore.expenses(), appStore.operations(), groupId, currency)[props.actorId] ?? 0;

  return (
    <div class="page-enter space-y-5 sm:space-y-6">
      <header class="groups-overview-heading">
        <div>
          <p class="eyebrow">Your groups</p>
          <h1 class="page-title">Groups</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            See what each group owes you—or what you owe.
          </p>
        </div>
        <Button class="create-group-action" onClick={props.onCreateGroup}>
          <UsersRound size={17} /> Create group
        </Button>
      </header>
      <Show
        when={appStore.groups().length}
        fallback={
          <Card class="group-empty-state">
            <UsersRound size={28} />
            <h2>Create your first group</h2>
            <p>Groups keep a trip, home, or event separate and easy to settle.</p>
            <Button onClick={props.onCreateGroup}><UsersRound size={16} /> Create group</Button>
          </Card>
        }
      >
        <div class="group-overview-grid" aria-label="Your groups">
          <For each={appStore.groups()}>
            {(group, index) => {
              const balance = createMemo(() => groupBalance(group.id, group.settlementCurrency));
              const expenses = createMemo(() => groupExpenseCount(group.id));
              const people = createMemo(() => groupMemberCount(group.id));
              return (
                <button
                  type="button"
                  class="group-overview-card"
                  style={{ "--row-index": index() }}
                  onClick={() => props.onOpenGroup(group.id)}
                >
                  <span class="group-overview-icon"><UsersRound size={18} /></span>
                  <span class="group-overview-main">
                    <strong>{group.name}</strong>
                    <small>{people()} {people() === 1 ? "person" : "people"} · {expenses()} active {expenses() === 1 ? "expense" : "expenses"}</small>
                  </span>
                  <span class="group-overview-balance">
                    <small>{balance() > 0 ? "you’re owed" : balance() < 0 ? "you owe" : "settled"}</small>
                    <strong classList={{ "money-in": balance() > 0, "money-out": balance() < 0 }}>
                      {money(Math.abs(balance()), group.settlementCurrency)}
                    </strong>
                  </span>
                  <ChevronRight size={16} />
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

function GroupsView(props: {
  actorId: string;
  activeGroupId?: string | undefined;
  onShowOverview(): void;
  onAddExpense(groupId?: string): void;
  onOpenExpense(expense: LocalExpense): void;
  onCreateGroup(): void;
  onSettle(settlement: Settlement | undefined, currency: string): void;
  onToast(message: string): void;
}) {
  const group = createMemo(
    () => appStore.groups().find((item) => item.id === props.activeGroupId),
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
  const [changingCurrency, setChangingCurrency] = createSignal(false);
  createEffect(() => {
    setCurrency(group()?.settlementCurrency ?? "USD");
  });
  const hasLedgerEntries = createMemo(() => {
    const groupId = group()?.id;
    if (!groupId) return false;
    return appStore.expenses().some((expense) => expense.groupId === groupId) ||
      appStore.operations().some((operation) =>
        operation.groupId === groupId &&
        operation.type === "PaymentRecorded" &&
        operation.syncStatus !== "rejected" &&
        operation.syncStatus !== "conflicted",
      );
  });
  async function updateCurrency(value: string): Promise<void> {
    const activeGroup = group();
    if (!activeGroup || value === activeGroup.settlementCurrency) return;
    setChangingCurrency(true);
    try {
      await changeGroupCurrency(activeGroup.id, value);
      setCurrency(value);
      props.onToast(`Group currency changed to ${value}`);
    } catch (error) {
      setCurrency(activeGroup.settlementCurrency);
      props.onToast(error instanceof Error ? error.message : "Could not change currency");
    } finally {
      setChangingCurrency(false);
    }
  }
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
  const insights = createMemo(() => buildGroupInsights(activeExpenses(), currency(), props.actorId));
  const reconciliation = createMemo(() => buildGroupReconciliation(
    activeExpenses(),
    appStore.operations(),
    group()?.id ?? "",
    currency(),
    props.actorId,
  ));
  const reconciliationTitle = createMemo(() => {
    const balanceMinor = reconciliation().balanceMinor;
    if (balanceMinor > 0) return `Why are you owed ${money(balanceMinor, currency())}?`;
    if (balanceMinor < 0) return `Why do you owe ${money(Math.abs(balanceMinor), currency())}?`;
    return "Why is your balance settled?";
  });
  const settlementBlockers = createMemo(() => settlementBlockerCount(appStore.expenses(), group()?.id ?? "", currency()));
  const settlementPlan = createMemo(() => settlementBlockers() > 0 ? [] : simplifyBalances(balances()));
  const syncHealth = createMemo(() => summarizeOperationHealth(appStore.operations(), group()?.id ?? ""));

  return (
    <div class="page-enter space-y-5 sm:space-y-6">
      <header class="group-page-heading">
        <div>
          <button class="group-back-action" type="button" onClick={props.onShowOverview}>
            <ChevronLeft size={15} /> All groups
          </button>
          <h1 class="page-title">{group()?.name ?? "Groups"}</h1>
          <Show when={group()} fallback={<p class="mt-1 text-sm text-muted-foreground">No groups yet</p>}>
            <p class="mt-1 text-sm text-muted-foreground">
              {people().length + 1} {people().length === 0 ? "person" : "people"} · {activeExpenses().length} active {activeExpenses().length === 1 ? "expense" : "expenses"}
            </p>
          </Show>
        </div>
        <Show when={group()}>
          <Show when={hasLedgerEntries()} fallback={<label class="group-currency-setting"><span>Group currency</span><select value={group()?.settlementCurrency} disabled={changingCurrency()} onChange={(event) => void updateCurrency(event.currentTarget.value)} aria-describedby="group-currency-note"><option value="USD">USD</option><option value="CAD">CAD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="INR">INR</option></select><small id="group-currency-note">Editable until the first entry</small></label>}>
            <span class="group-currency-badge" aria-label={`Group currency ${group()?.settlementCurrency}, locked after the first entry`} title="Group currency is locked after the first entry">{group()?.settlementCurrency}</span>
          </Show>
        </Show>
      </header>
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
                <UsersRound size={16} /> Create group
              </Button>
            </div>
          </Card>
        }
      >
        {(activeGroup) => (
          <>
            <AccessibleTabs
              class="group-view-tabs"
              items={[
                { id: "expenses", label: "Activity", icon: () => <ReceiptText size={16} /> },
                { id: "balances", label: "Balances", icon: () => <Scale size={16} /> },
                { id: "insights", label: "Insights", icon: () => <Activity size={16} /> },
              ] as const}
              value={groupSection()}
              onChange={setGroupSection}
              ariaLabel={`${activeGroup.name} views`}
              idPrefix="group-view"
            />

            <Show when={groupSection() === "expenses"}>
              <div id={tabPanelId("group-view", "expenses")} role="tabpanel" aria-labelledby={tabId("group-view", "expenses")}>
                <ExpenseList
                  groupId={activeGroup.id}
                  actorId={props.actorId}
                  onOpen={props.onOpenExpense}
                  onAdd={() => props.onAddExpense(activeGroup.id)}
                />
              </div>
            </Show>

            <Show when={groupSection() === "balances"}>
              <div id={tabPanelId("group-view", "balances")} class="page-enter space-y-3" role="tabpanel" aria-labelledby={tabId("group-view", "balances")}>
                <Show when={settlementBlockers() > 0}>
                  <section class="settlement-warning" role="status"><div><strong>Settlement paused</strong><span>{settlementBlockers()} provisional {settlementBlockers() === 1 ? "expense needs" : "expenses need"} review before anyone records a payment.</span></div><button type="button" onClick={() => setGroupSection("expenses")}>View activity</button></section>
                </Show>
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
                          <button class="ink-action" type="button" disabled={!settlement() || settlementBlockers() > 0} onClick={() => props.onSettle(settlement(), currency())}>{balance() > 0 ? "Pay" : "Settle"}</button>
                        </article>
                      );
                    }}
                  </For>
                </section>
              </div>
            </Show>

            <Show when={groupSection() === "insights"}>
              <Card id={tabPanelId("group-view", "insights")} class="page-enter overflow-hidden" role="tabpanel" aria-labelledby={tabId("group-view", "insights")}>
                <SectionHeading
                  title="Group insights"
                  detail={`${insights().expenseCount} ${insights().expenseCount === 1 ? "expense" : "expenses"} · all time`}
                  action={<select class="insight-currency" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)} aria-label="Insights currency"><For each={currenciesFor(activeGroup.id)}>{(item) => <option value={item}>{item}</option>}</For></select>}
                />
                <div class="grid gap-5 p-4 sm:p-5">
                  <Show when={insights().totalMinor > 0} fallback={<div class="grid min-h-48 place-items-center px-6 text-center"><div><ReceiptText class="mx-auto text-muted-foreground" size={26} /><h3 class="mt-3 text-sm font-semibold">Insights start with an expense</h3><p class="mt-1 text-xs leading-5 text-muted-foreground">Add a shared expense to see your share, trends, and what drove the total.</p></div></div>}>
                    <section class="insight-hero" aria-label="Your share of group spending">
                      <div>
                        <span>Your share</span>
                        <strong class="money-type">{money(insights().yourShareMinor, currency())}</strong>
                        <p>of {money(insights().totalMinor, currency())} across {insights().expenseCount} {insights().expenseCount === 1 ? "expense" : "expenses"}</p>
                      </div>
                      <div class="insight-paid"><span>You paid</span><strong>{money(insights().paidByYouMinor, currency())}</strong></div>
                    </section>

                    <section class="insight-reconciliation" aria-labelledby="reconciliation-title">
                      <header><div><h3 id="reconciliation-title">{reconciliationTitle()}</h3><p>From {reconciliation().expenseCount} {reconciliation().expenseCount === 1 ? "expense" : "expenses"} and {reconciliation().paymentCount} recorded {reconciliation().paymentCount === 1 ? "payment" : "payments"}.</p></div><button type="button" onClick={() => setGroupSection("balances")}>Sources <ChevronRight size={14} /></button></header>
                      <dl>
                        <div><dt>You paid</dt><dd>+{money(reconciliation().paidByYouMinor, currency())}</dd></div>
                        <div><dt>Your share</dt><dd>−{money(reconciliation().yourShareMinor, currency())}</dd></div>
                        <Show when={reconciliation().paymentsSentMinor > 0}><div><dt>Payments you sent</dt><dd>+{money(reconciliation().paymentsSentMinor, currency())}</dd></div></Show>
                        <Show when={reconciliation().paymentsReceivedMinor > 0}><div><dt>Payments you received</dt><dd>−{money(reconciliation().paymentsReceivedMinor, currency())}</dd></div></Show>
                        <div class="insight-reconciliation-total"><dt>Current balance</dt><dd>{reconciliation().balanceMinor > 0 ? `+${money(reconciliation().balanceMinor, currency())}` : reconciliation().balanceMinor < 0 ? `−${money(Math.abs(reconciliation().balanceMinor), currency())}` : money(0, currency())}</dd></div>
                      </dl>
                    </section>

                    <section class="insight-settlement" aria-labelledby="settlement-plan-title">
                      <header><div><h3 id="settlement-plan-title">{settlementBlockers() > 0 ? "Settlement paused" : "Simplest way to settle"}</h3><p>{settlementBlockers() > 0 ? `${settlementBlockers()} provisional ${settlementBlockers() === 1 ? "expense needs" : "expenses need"} review` : settlementPlan().length ? `${settlementPlan().length} ${settlementPlan().length === 1 ? "transfer" : "transfers"} clears the group` : "No payments needed"}</p></div><button type="button" onClick={() => setGroupSection(settlementBlockers() > 0 ? "expenses" : "balances")}>{settlementBlockers() > 0 ? "View activity" : "Review"} <ChevronRight size={14} /></button></header>
                      <Show when={settlementBlockers() === 0 && settlementPlan().length} fallback={<p class="insight-settled-copy">{settlementBlockers() > 0 ? "Resolve the flagged change before recording a settlement." : `Everyone is settled in ${currency()}.`}</p>}>
                        <div class="insight-transfer-list"><For each={settlementPlan()}>{(settlement) => <div><span>{memberName(activeGroup.id, settlement.payerId, props.actorId)} pays {memberName(activeGroup.id, settlement.recipientId, props.actorId)}</span><strong>{money(settlement.amountMinor, currency())}</strong></div>}</For></div>
                      </Show>
                    </section>

                    <div class="insight-story-grid">
                      <Show when={insights().topCategory}>{(top) => <article class="insight-story"><span>Top category</span><strong>{top().name}</strong><p>{money(top().amountMinor, currency())} · {top().percentage}% of group spending</p></article>}</Show>
                      <Show when={insights().monthTrend} fallback={<article class="insight-story"><span>Typical expense</span><strong>{money(insights().averageMinor, currency())}</strong><p>Average across this group</p></article>}>
                        {(trend) => <article class="insight-story"><span>Latest month</span><strong>{trend().differenceMinor === 0 ? "No change" : `${money(Math.abs(trend().differenceMinor), currency())} ${trend().differenceMinor > 0 ? "higher" : "lower"}`}</strong><p>{monthLabel(trend().currentMonth)} vs {monthLabel(trend().previousMonth)} · {Math.abs(trend().percentageChange)}%</p></article>}
                      </Show>
                      <article class="insight-story" classList={{ "insight-story-attention": syncHealth().attention > 0 || syncHealth().pending > 0 }} role="status"><span>Ledger health</span><strong>{syncHealth().attention > 0 ? `${syncHealth().attention} ${syncHealth().attention === 1 ? "change needs" : "changes need"} review` : syncHealth().pending > 0 ? `${syncHealth().pending} ${syncHealth().pending === 1 ? "change" : "changes"} waiting` : "No sync problems"}</strong><p>{syncHealth().attention > 0 ? "Conflicted or rejected changes" : syncHealth().pending > 0 ? "Safe on this device until sync" : "No queued or rejected group changes"}</p></article>
                    </div>

                    <section class="insight-chart-shell" aria-labelledby="insight-chart-title">
                      <header><div><h3 id="insight-chart-title">Where the money went</h3><p>Compare categories or monthly totals.</p></div><div class="segmented-control"><button classList={{ active: chartMode() === "category" }} aria-pressed={chartMode() === "category"} onClick={() => setChartMode("category")}>Category</button><button classList={{ active: chartMode() === "month" }} aria-pressed={chartMode() === "month"} onClick={() => setChartMode("month")}>Months</button></div></header>
                      <Suspense fallback={<div class="grid h-52 place-items-center text-xs text-muted-foreground">Preparing chart…</div>}><SpendingChart expenses={expenses()} currency={currency()} mode={chartMode()} /></Suspense>
                    </section>
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
  onCreateGroup(): void;
  onOpenGroup(groupId: string): void;
  onSettle(settlement: Settlement, currency: string, groupId: string): void;
}) {
  const [inviteOpen, setInviteOpen] = createSignal(false);
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
    appStore.members().filter((member) => member.groupId === groupId && member.status === "active").length;
  const groupExpenseCount = (groupId: string) =>
    appStore.expenses().filter((expense) => expense.groupId === groupId && expense.status === "active").length;
  const relationshipUserIds = createMemo(() => new Set(relationships().map((relationship) => relationship.userId)));
  const contactsWithoutBalance = createMemo(() =>
    (contactState()?.contacts ?? []).filter((contact) => !relationshipUserIds().has(contact.userId)),
  );
  return (
    <div class="page-enter home-page space-y-5">
      <header class="home-heading">
        <h1 class="page-title">Your balances</h1>
        <p class="home-summary-copy">
          Across {relationships().length} {relationships().length === 1 ? "person" : "people"} · {appStore.groups().length} {appStore.groups().length === 1 ? "group" : "groups"}
        </p>
      </header>

      <div class="overview-currency-grid">
        <For each={totals()}>
          {(total) => (
            <section class="overview-balance" aria-label={`${total.currency} balance across all groups`}>
              <div class="overview-balance-primary">
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

      <AccessibleTabs
        class="home-list-tabs"
        items={[
          { id: "people", label: "People" },
          { id: "groups", label: "Groups" },
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
            detail={relationships().length ? "Net across all shared groups" : contactsWithoutBalance().length ? "Connected on Tally" : "No open balances"}
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
                <article class="relationship-row" style={{ "--row-index": index() }}>
                  <Avatar name={personName()} class="size-10 text-xs" />
                  <button type="button" class="min-h-11 min-w-0 flex-1 text-left" onClick={() => props.onOpenGroup(relationship.groupIds[0]!)}>
                    <strong class="block truncate text-sm">{personName()}</strong>
                    <span class="block truncate text-xs text-muted-foreground">{groupNames(relationship.groupIds)}</span>
                  </button>
                  <div class="text-right">
                    <span class="relationship-direction">{relationship.amountMinor > 0 ? "owes you" : "you owe"}</span>
                    <strong class="block text-sm tabular-nums" classList={{ "money-in": relationship.amountMinor > 0, "money-out": relationship.amountMinor < 0 }}>{money(Math.abs(relationship.amountMinor), relationship.currency)}</strong>
                  </div>
                  <button type="button" class="relationship-action" onClick={() => canSettleHere() ? props.onSettle(settlement(), relationship.currency, relationship.groupIds[0]!) : props.onOpenGroup(relationship.groupIds[0]!)}>
                    <span class="relationship-action-label">{canSettleHere() ? "Settle" : needsReview() ? "Review" : "View"}</span>
                    <ChevronRight class="relationship-action-chevron" size={16} />
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
            {(group) => (
              <button type="button" class="home-group-row" onClick={() => props.onOpenGroup(group.id)}>
                <Avatar name={group.name} class="size-10 text-xs" />
                <span class="min-w-0 flex-1 text-left"><strong>{group.name}</strong><small>{groupMemberCount(group.id)} {groupMemberCount(group.id) === 1 ? "person" : "people"} · {groupExpenseCount(group.id)} active {groupExpenseCount(group.id) === 1 ? "expense" : "expenses"}</small></span>
                <ChevronRight size={16} />
              </button>
            )}
          </For>
        </Card>
      </Show>

      <ContactInviteDialog
        open={inviteOpen()}
        onOpenChange={setInviteOpen}
        onChanged={() => void refetchContacts()}
      />
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
  GroupCurrencyChanged: "changed the group currency",
  GroupMemberAdded: "added a member",
  GroupMemberRemoved: "removed a member",
};

function ActivityView(props: {
  actorId: string;
  onOpenExpense(expense: LocalExpense): void;
  onToast(message: string): void;
}) {
  const activityDays = createMemo(() => {
    const groups = new Map<string, { label: string; operations: LocalOperation[] }>();
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
    for (const operation of [...appStore.operations()].sort((left, right) => right.clientTimestamp.localeCompare(left.clientTimestamp))) {
      const date = new Date(operation.clientTimestamp);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const label = key === todayKey
        ? "Today"
        : key === yesterdayKey
          ? "Yesterday"
          : new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" }).format(date);
      const existing = groups.get(key);
      if (existing) existing.operations.push(operation);
      else groups.set(key, { label, operations: [operation] });
    }
    return [...groups.values()];
  });
  async function restore(expense: LocalExpense) {
    await restoreExpense(expense);
    props.onToast("Expense restored");
  }
  return (
    <div class="page-enter space-y-5">
      <header>
        <h1 class="page-title">Activity</h1>
        <p class="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          <span class="sync-dot" classList={{ pending: appStore.connection() !== "online" }} />
          {appStore.connection() === "online" ? "Synced" : "Saved on this device"} · just now
        </p>
      </header>
      <div>
        <h2 class="activity-feed-title">Everything that changed</h2>
        <For
          each={activityDays()}
          fallback={
            <Card class="mt-4 px-6 py-12 text-center text-sm text-muted-foreground">
              Activity appears after your first change.
            </Card>
          }
        >
          {(day) => <section class="activity-day" aria-label={day.label}>
            <h3>{day.label}</h3>
            <Card class="activity-day-card overflow-hidden">
              <For each={day.operations}>{(operation) => {
                const expense = createMemo(() => appStore.expenses().find((item) => item.id === operation.targetId));
                const group = createMemo(() => appStore.groups().find((item) => item.id === operation.groupId));
                const actor = createMemo(() => operation.actorId === props.actorId ? "You" : memberName(operation.groupId, operation.actorId, props.actorId));
                return <article class="activity-row">
                  <Avatar name={actor()} class="size-10 text-xs" />
                  <button type="button" class="activity-row-main min-h-11" disabled={!expense()} onClick={() => expense() && props.onOpenExpense(expense()!)}>
                    <strong>{actor()} {activityCopy[operation.type] ?? "updated the group"}</strong>
                    <span>{expense() ? `${expense()!.description} · ${group()?.name ?? "Shared group"}` : group()?.name ?? "Shared group"}</span>
                    <time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(operation.clientTimestamp))}</time>
                  </button>
                  <div class="activity-row-value">
                    <Show when={expense()}>{(item) => <strong>{money(item().amountMinor, item().currency)}</strong>}</Show>
                    <Show when={operation.type === "ExpenseVoided" && expense()?.status === "voided"}>
                      <button class="min-h-11 px-2" onClick={() => expense() && void restore(expense()!)}>Restore</button>
                    </Show>
                  </div>
                  <Show when={expense()}><ChevronRight size={15} class="activity-row-chevron" /></Show>
                </article>;
              }}</For>
            </Card>
          </section>}
        </For>
      </div>
    </div>
  );
}

function AccountView(props: { displayName: string; email: string | undefined }) {
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
          <div class="min-w-0 flex-1">
            <h2 class="font-semibold">{props.displayName}</h2>
            <p class="truncate text-sm text-muted-foreground">{props.email ?? "Offline account on this device"}</p>
          </div>
          <Show when={!import.meta.env.DEV}>
            <Button
              variant="secondary"
              size="sm"
              class="shrink-0"
              onClick={() => void signOutAndClearLocalLedger()}
            >
              <LogOut size={15} /> Log out
            </Button>
          </Show>
        </div>
        <Show when={!import.meta.env.DEV}>
          <p class="mt-4 border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground">
            Logging out removes this account's cached ledger from this device.
          </p>
        </Show>
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
              title: "Protected on this device",
              detail: "This device signs changes so edits can be attributed",
            },
            {
              icon: Cloud,
              title: "Works offline",
              detail: "New entries stay safe here until sync resumes",
            },
            {
              icon: Scale,
              title: "Reviewable history",
              detail: "Edits and deletions remain visible in Activity",
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
        </Show>
      </Card>
    </div>
  );
}

function AuthenticatedApp(props: { actorId: string; email: string | undefined }) {
  const [tab, setTab] = createSignal<Tab>("overview");
  const [groupsMode, setGroupsMode] = createSignal<"overview" | "detail">("overview");
  const [expenseOpen, setExpenseOpen] = createSignal(false);
  const [targetPickerOpen, setTargetPickerOpen] = createSignal(false);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [groupOpen, setGroupOpen] = createSignal(false);
  const [groupComposerOrigin, setGroupComposerOrigin] =
    createSignal<GroupComposerOrigin>("groups");
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
    const invitationToken = inviteTokenFromHash();
    if (invitationToken) {
      void acceptCurrentContactInvitation(invitationToken)
        .then(() => {
          clearInviteToken();
          notify("You’re connected on Tally");
        })
        .catch((error) => notify(error instanceof Error ? error.message : "Could not accept the invitation"));
    }
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
    { id: "account" as const, label: "You", icon: CircleUserRound },
  ];
  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(""), 3500);
  }
  function selectGroup(id: string) {
    setSelectedGroupId(id);
    setGroupsMode("detail");
    setTab("groups");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function afterDialogClose(callback: () => void): void {
    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    window.setTimeout(callback, dialogHandoffDelay(coarsePointer));
  }
  function showGroupsOverview() {
    setGroupsMode("overview");
    setTab("groups");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function addExpense(id?: string) {
    setEditingExpense(undefined);
    const decision = decideExpenseLaunch({
      groups: appStore.groups(),
      members: appStore.members(),
      ...(id ? { groupId: id } : {}),
    });
    if (decision.kind === "compose") {
      setPreferredTargetGroupId(id);
      chooseExpenseTarget(decision.target);
      return;
    }
    setExpenseTarget(undefined);
    const rememberedGroupId = localStorage.getItem(`tally:last-expense-group:${props.actorId}`) ?? undefined;
    setPreferredTargetGroupId(
      rememberedGroupId && appStore.groups().some((group) => group.id === rememberedGroupId)
        ? rememberedGroupId
        : mostRecentExpenseGroupId(appStore.expenses(), appStore.operations(), props.actorId),
    );
    window.setTimeout(() => setTargetPickerOpen(true), 0);
  }
  function openGroupComposer(origin: GroupComposerOrigin = "groups") {
    setGroupComposerOrigin(origin);
    if (origin === "expense") afterDialogClose(() => setGroupOpen(true));
    else window.setTimeout(() => setGroupOpen(true), 0);
  }
  function chooseExpenseTarget(target: ExpenseTarget) {
    localStorage.setItem(`tally:last-expense-group:${props.actorId}`, target.groupId);
    setExpenseTarget(target);
    setSelectedGroupId(target.groupId);
    setTargetPickerOpen(false);
    afterDialogClose(() => setExpenseOpen(true));
  }
  function openDetail(expense: LocalExpense) {
    setSelectedGroupId(expense.groupId);
    setSelectedExpense(expense);
    window.setTimeout(() => setDetailOpen(true), 0);
  }
  function edit(expense: LocalExpense) {
    setDetailOpen(false);
    setEditingExpense(expense);
    afterDialogClose(() => setExpenseOpen(true));
  }
  function settle(
    settlement?: Settlement,
    currency = activeGroup()?.settlementCurrency ?? "USD",
    groupId?: string,
  ) {
    const targetGroupId = groupId ?? activeGroup()?.id;
    if (targetGroupId && settlementBlockerCount(appStore.expenses(), targetGroupId, currency) > 0) {
      setSelectedGroupId(targetGroupId);
      setGroupsMode("detail");
      setTab("groups");
      notify("Settlement paused · review the provisional expense first");
      return;
    }
    if (targetGroupId) setSelectedGroupId(targetGroupId);
    setSuggestedSettlement(settlement);
    setPaymentCurrency(currency);
    window.setTimeout(() => setPaymentOpen(true), 0);
  }
  return (
    <div class="app-shell min-h-dvh text-foreground md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
      <a class="skip-link" href="#main-content">Skip to content</a>
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
                onClick={() => item.id === "groups" ? showGroupsOverview() : setTab(item.id)}
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
              class="sidebar-create-group"
              onClick={() => openGroupComposer("groups")}
              aria-label="Create group"
            >
              <Plus size={14} /> Create
            </button>
          </div>
          <For each={appStore.groups()}>
            {(group) => (
              <button
                class="desktop-group"
                classList={{ active: groupsMode() === "detail" && selectedGroupId() === group.id }}
                aria-pressed={groupsMode() === "detail" && selectedGroupId() === group.id}
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
            Changes save locally before syncing.
          </p>
        </div>
      </aside>
      <div class="min-w-0">
        <header class="mobile-header md:hidden">
          <span class="flex items-center gap-2"><BrandMark size={28} /><strong class="mobile-wordmark">Tally</strong></span>
          <button class="mobile-add-action" type="button" onClick={() => addExpense()}>
            <Plus size={16} /> Add expense
          </button>
        </header>
        <main id="main-content" tabindex={-1} class="app-main mx-auto w-full max-w-5xl px-4 pb-28 pt-5 sm:px-6 sm:pt-8 md:px-8 md:pb-12 lg:px-10">
          <Switch>
            <Match when={tab() === "overview"}>
              <OverviewView
                actorId={props.actorId}
                activeGroupId={selectedGroupId()}
                onCreateGroup={() => openGroupComposer("groups")}
                onOpenGroup={selectGroup}
                onSettle={settle}
              />
            </Match>
            <Match when={tab() === "groups"}>
              <Show
                when={groupsMode() === "overview"}
                fallback={
                  <GroupsView
                    actorId={props.actorId}
                    activeGroupId={selectedGroupId()}
                    onShowOverview={showGroupsOverview}
                    onAddExpense={addExpense}
                    onOpenExpense={openDetail}
                    onCreateGroup={() => openGroupComposer("groups")}
                    onSettle={settle}
                    onToast={notify}
                  />
                }
              >
                <GroupsOverview
                  actorId={props.actorId}
                  onOpenGroup={selectGroup}
                  onCreateGroup={() => openGroupComposer("groups")}
                />
              </Show>
            </Match>
            <Match when={tab() === "activity"}>
              <ActivityView
                actorId={props.actorId}
                onOpenExpense={openDetail}
                onToast={notify}
              />
            </Match>
            <Match when={tab() === "account"}>
              <AccountView displayName={displayName()} email={props.email} />
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
              onClick={() => item.id === "groups" ? showGroupsOverview() : setTab(item.id)}
            >
              <item.icon size={20} stroke-width={tab() === item.id ? 2.6 : 2} />
              <span>{item.label}</span>
            </button>
          )}
        </For>
      </nav>
      <Show when={toast()}>
        <div class="toast-enter toast-pill" role="status" aria-live="polite" aria-atomic="true">
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
        onCreateGroup={() => openGroupComposer("expense")}
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
          if (!open) {
            setEditingExpense(undefined);
            setExpenseTarget(undefined);
          }
        }}
        onChangeTarget={() => {
          setPreferredTargetGroupId(expenseTarget()?.groupId ?? selectedGroupId());
          setExpenseOpen(false);
          afterDialogClose(() => setTargetPickerOpen(true));
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
        blocked={settlementBlockerCount(appStore.expenses(), selectedGroupId() ?? "", paymentCurrency()) > 0}
        onOpenChange={setPaymentOpen}
        onSaved={() => notify("Payment recorded")}
      />
      <GroupComposer
        open={groupOpen()}
        onOpenChange={(open) => {
          setGroupOpen(open);
          setGroupComposerOrigin((origin) => groupComposerOriginAfterOpenChange(open, origin));
        }}
        onCreated={(id, groupName) => {
          const destination = decideGroupCreationDestination(
            groupComposerOrigin(),
            appStore.groups(),
            appStore.members(),
            id,
            groupName,
          );
          setGroupComposerOrigin("groups");
          if (destination.kind === "compose") chooseExpenseTarget(destination.target);
          else selectGroup(destination.groupId);
          notify("Group created");
        }}
      />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" width="18" height="18">
      <path fill="#4285F4" d="M17.64 9.2c0-.63-.06-1.22-.16-1.8H9v3.4h4.84a4.15 4.15 0 0 1-1.8 2.72l2.91 2.26c1.7-1.57 2.69-3.89 2.69-6.58Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.95-2.22l-2.91-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71L.95 13c1.47 2.96 4.53 5 8.05 5Z" />
      <path fill="#FBBC05" d="M3.96 10.67A5.41 5.41 0 0 1 3.68 9c0-.58.1-1.14.28-1.67L.95 5A9 9 0 0 0 0 9c0 1.45.35 2.82.95 4l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.62c1.32 0 2.51.45 3.44 1.34l2.58-2.52C13.46.98 11.43 0 9 0 5.48 0 2.42 2.04.95 5l3.01 2.33C4.67 5.2 6.66 3.62 9 3.62Z" />
    </svg>
  );
}

function AuthScreen() {
  const search = new URLSearchParams(location.search);
  const invitationToken = inviteTokenFromHash();
  const initialAuthFailed = search.get("auth") === "failed";
  const [email, setEmail] = createSignal(
    search.get("email") ?? "",
  );
  const [message, setMessage] = createSignal(
    initialAuthFailed
      ? "Sign-in could not be completed. Use the Google account or email address that was invited."
      : "",
  );
  const [messageTone, setMessageTone] = createSignal<"status" | "error">(
    initialAuthFailed ? "error" : "status",
  );
  const [busy, setBusy] = createSignal<"google" | "email" | null>(null);
  const [capabilities] = createResource(async () => {
    try {
      return await getAuthCapabilities();
    } catch {
      return { google: false, magicLink: true };
    }
  });

  async function signInWithGoogle() {
    setBusy("google");
    setMessage("");
    setMessageTone("status");
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: location.origin,
        newUserCallbackURL: location.origin,
        errorCallbackURL: `${location.origin}/?auth=failed`,
      });
      if (result.error) {
        setMessageTone("error");
        setMessage(result.error.message ?? "Google sign-in could not be started.");
      }
    } catch {
      setMessageTone("error");
      setMessage("The server is unavailable. Try the email link or continue on a previously signed-in device.");
    } finally {
      setBusy(null);
    }
  }

  async function requestLink(event: SubmitEvent) {
    event.preventDefault();
    setBusy("email");
    setMessage("");
    setMessageTone("status");
    try {
      if (invitationToken) {
        await claimContactInvitation(invitationToken, email().trim());
        setMessage("Check your inbox — the verification link signs you in and connects you to your inviter.");
        return;
      }
      const result = await authClient.signIn.magicLink({
        email: email().trim(),
        callbackURL: location.origin,
        newUserCallbackURL: location.origin,
        errorCallbackURL: `${location.origin}/?auth=failed`,
      });
      setMessageTone(result.error ? "error" : "status");
      setMessage(
        result.error
          ? (result.error.message ?? "Could not send the link.")
          : "Check your inbox — the secure link signs you in directly.",
      );
    } catch {
      setMessageTone("error");
      setMessage(
        "The server is unavailable. Previously signed-in devices can continue offline.",
      );
    } finally {
      setBusy(null);
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
          <h1 class="text-2xl font-semibold tracking-tight">{invitationToken ? "You’re invited" : "Welcome back"}</h1>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">
            {invitationToken
              ? "Verify the email you want to use. The invitation is bound to that identity before anyone is shown as joined."
              : "Sign in with the Google account or email address that was invited."}
          </p>
          <Show when={capabilities()?.google && !invitationToken}>
            <Button
              class="mt-6 h-12 w-full rounded-xl"
              type="button"
              variant="secondary"
              disabled={busy() !== null}
              onClick={() => void signInWithGoogle()}
            >
              <GoogleMark />
              {busy() === "google" ? "Connecting…" : "Continue with Google"}
            </Button>
            <div class="auth-divider" aria-hidden="true"><span>or use email</span></div>
          </Show>
          <Show when={capabilities()?.magicLink} fallback={
            <p class="mt-5 rounded-xl border border-border bg-muted/60 p-3 text-sm text-muted-foreground">
              Email links are not configured on this Tally server.
            </p>
          }>
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
              disabled={busy() !== null}
            >
              {busy() === "email" ? "Sending…" : invitationToken ? "Verify email and join" : "Email me a sign-in link"}
            </Button>
          </form>
          </Show>
          <Show when={message()}>
            <p
              class="mt-4 rounded-xl border border-border bg-muted/60 p-3 text-sm text-muted-foreground"
              role={messageTone() === "error" ? "alert" : "status"}
              aria-live={messageTone() === "error" ? "assertive" : "polite"}
            >
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
      ? developmentIdentity(location.search, true).actorId
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
        {(id) => <AuthenticatedApp actorId={id} email={session().data?.user.email} />}
      </Show>
    </Show>
  );
}
