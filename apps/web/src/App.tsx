import Activity from "lucide-solid/icons/activity";
import CheckCircle2 from "lucide-solid/icons/check-circle-2";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import CircleUserRound from "lucide-solid/icons/circle-user-round";
import Cloud from "lucide-solid/icons/cloud";
import CloudOff from "lucide-solid/icons/cloud-off";
import House from "lucide-solid/icons/house";
import Plus from "lucide-solid/icons/plus";
import ReceiptText from "lucide-solid/icons/receipt-text";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Scale from "lucide-solid/icons/scale";
import Settings2 from "lucide-solid/icons/settings-2";
import ShieldCheck from "lucide-solid/icons/shield-check";
import UsersRound from "lucide-solid/icons/users-round";
import X from "lucide-solid/icons/x";
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
  onCleanup,
  onMount,
} from "solid-js";
import { BrandMark } from "./components/BrandMark";
import { AuthScreen } from "./components/AuthScreen";
import { AccountView } from "./components/AccountView";
import { ActivityView } from "./components/ActivityView";
import { OverviewView } from "./components/OverviewView";
import { SectionHeading } from "./components/SectionHeading";
import { CategoryMark } from "./components/CategoryMark";
import { ContactInviteDialog } from "./components/ContactInviteDialog";
import { ExpenseComposer } from "./components/ExpenseComposer";
import { ExpenseDetail } from "./components/ExpenseDetail";
import { ExpenseTargetPicker } from "./components/ExpenseTargetPicker";
import { FeedbackButton } from "./components/FeedbackDialog";
import { GroupComposer } from "./components/GroupComposer";
import { GroupSettingsDialog } from "./components/GroupSettingsDialog";
import { PaymentComposer } from "./components/PaymentComposer";
import { NotificationSettings } from "./components/NotificationSettings";
import { RelationshipDetail } from "./components/RelationshipDetail";
import { VersionBadge } from "./components/VersionBadge";
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
  claimImportedIdentity,
  getImportClaimStatus,
} from "./lib/api";
import {
  authClient,
  getOfflineActorId,
} from "./lib/auth";
import { clearInviteToken, inviteTokenFromHash } from "./lib/contact-invites";
import { money } from "./lib/format-money";
import { groupConnectionCallout, memberBalanceContextPrefix, memberConnectionActionLabel } from "./lib/group-settings";
import { isVisibleGroupMember, memberName } from "./lib/member-label";
import { accountSyncCopy } from "./lib/connection-status";
import { groupTimelineItems, type GroupTimelineItem } from "./lib/activity-view";
import { developmentIdentity } from "./lib/development-actor";
import { localDb, type LocalExpense, type LocalOperation } from "./lib/db";
import {
  decideExpenseLaunch,
  decideGroupCreationDestination,
  dialogHandoffDelay,
  groupComposerOriginAfterOpenChange,
  type GroupComposerOrigin,
} from "./lib/expense-launch";
import { mostRecentExpenseGroupId, type ExpenseTarget } from "./lib/expense-targets";
import { releaseWatch, reloadForUpdate } from "./lib/release-watch";
import { clearLocationHash, migrationClaimFromHash } from "./lib/migration-claim-link";
import { acknowledgeNotifications, queuedForegroundActivityMessage } from "./lib/push-notifications";
import { buildGroupInsights, buildGroupReconciliation, settlementBlockerCount, summarizeOperationHealth } from "./lib/group-insights";
import {
  computeBalances,
  simplifyBalances,
  activePayments,
  type Settlement,
} from "./lib/ledger-view";
import { appStore, initializeStore } from "./lib/store";
import { applyTheme, type Theme } from "./lib/theme";

const MigrationDialog = lazy(() =>
  import("./components/MigrationDialog").then((module) => ({ default: module.MigrationDialog })),
);

type Tab = "overview" | "groups" | "activity" | "account";

const smartCategoriesStorageKey = "tallied:smart-categories-preview";
const SpendingChart = lazy(() =>
  import("./components/SpendingChart").then((module) => ({
    default: module.SpendingChart,
  })),
);

function expenseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(`${value}-15T12:00:00`));
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
  const copy = createMemo(() => accountSyncCopy({
    connection: appStore.connection(),
    pendingCount: pending(),
    groupCount: appStore.groups().length,
  }));
  return (
    <>
      <button
        type="button"
        class="connection-pill glass-control"
        onClick={() => void appStore.sync()}
        aria-label={copy().detail}
        title={copy().detail}
      >
        <Switch>
          <Match when={appStore.connection() === "online"}>
            <Cloud class="text-foreground" size={14} />
            <span>{copy().short}</span>
          </Match>
          <Match when={appStore.connection() === "connecting"}>
            <RefreshCw class="animate-spin" size={14} />
            <span>{copy().short}</span>
          </Match>
          <Match when={true}>
            <CloudOff class="connection-warning" size={14} />
            <span>{copy().short}</span>
          </Match>
        </Switch>
      </button>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {appStore.connectionMessage()}
      </span>
    </>
  );
}

function ExpenseList(props: {
  groupId: string;
  actorId: string;
  onOpen(expense: LocalExpense): void;
}) {
  const timeline = createMemo(() => groupTimelineItems(appStore.expenses(), appStore.operations(), props.groupId));
  const activeCount = createMemo(
    () => timeline().filter((item) => item.kind === "expense" && item.expense.status === "active").length,
  );
  const paymentCount = createMemo(() => timeline().filter((item) => item.kind === "payment").length);
  const expenseMonths = createMemo(() => {
    const months = new Map<string, { label: string; items: GroupTimelineItem[] }>();
    for (const item of timeline()) {
      const date = expenseDate(item.date);
      const key = item.date.slice(0, 7);
      const existing = months.get(key);
      if (existing) {
        existing.items.push(item);
      } else {
        months.set(key, {
          label: new Intl.DateTimeFormat(undefined, {
            month: "long",
            year: "numeric",
          }).format(date),
          items: [item],
        });
      }
    }
    return [...months.values()];
  });
  return (
    <Card class="expense-ledger">
      <div class="expense-list-toolbar">
        <span>{activeCount()} {activeCount() === 1 ? "expense" : "expenses"}{paymentCount() ? ` · ${paymentCount()} ${paymentCount() === 1 ? "payment" : "payments"}` : ""}</span>
      </div>
      <Show
        when={timeline().length}
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
              <div class="expense-month-list">
                <For each={month.items}>
                  {(item) => <Switch>
                    <Match when={item.kind === "expense" ? item.expense : undefined}>{(expense) => {
                      const date = expenseDate(expense().expenseDate);
                      const payer = memberName(expense().groupId, expense().payers[0]?.participantId ?? "", props.actorId);
                      return <button type="button" class="expense-timeline-row group-row" classList={{ "opacity-55": expense().status === "voided" }} onClick={() => props.onOpen(expense())}>
                        <time class="expense-date-rail" datetime={expense().expenseDate}><span>{new Intl.DateTimeFormat(undefined, { month: "short" }).format(date)}</span><strong>{new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date)}</strong></time>
                        <CategoryMark category={expense().category} />
                        <div class="min-w-0"><strong class="expense-row-title">{expense().description}</strong><span class="expense-row-context">{payer} paid · split {expense().allocations.length} {expense().allocations.length === 1 ? "way" : "ways"}{expense().syncStatus === "pending" ? " · on device" : ""}{expense().status === "voided" ? " · deleted" : ""}</span></div>
                        <div class="expense-row-money"><strong classList={{ "money-in": expense().yourNetMinor > 0, "money-out": expense().yourNetMinor < 0, "sync-attention": expense().syncStatus === "conflicted" || expense().syncStatus === "rejected" }}>{expense().syncStatus === "conflicted" ? "needs review" : expense().syncStatus === "rejected" ? "not synced" : expense().status === "voided" ? "deleted" : expense().yourNetMinor > 0 ? `+${money(expense().yourNetMinor, expense().currency)}` : expense().yourNetMinor < 0 ? `−${money(-expense().yourNetMinor, expense().currency)}` : money(0, expense().currency)}</strong><span classList={{ "money-in": expense().yourNetMinor > 0, "money-out": expense().yourNetMinor < 0 }}>{expense().status === "voided" ? `deleted · ${money(expense().amountMinor, expense().currency)}` : expense().yourNetMinor > 0 ? "you lent" : expense().yourNetMinor < 0 ? "you owe" : "settled"}</span></div>
                        <ChevronRight size={15} class="expense-row-chevron" />
                      </button>;
                    }}</Match>
                    <Match when={item.kind === "payment" ? item : undefined}>{(entry) => {
                      const date = expenseDate(entry().date);
                      const details = entry().payment;
                      const payer = memberName(props.groupId, details.payerId, props.actorId);
                      const recipient = memberName(props.groupId, details.recipientId, props.actorId);
                      const direction = details.payerId === props.actorId ? "Payment sent" : details.recipientId === props.actorId ? "Payment received" : "Payment";
                      return <article class="expense-timeline-row group-payment-row" aria-label={`${payer} paid ${recipient} ${money(details.amountMinor, details.currency)}`}>
                        <time class="expense-date-rail" datetime={entry().date}><span>{new Intl.DateTimeFormat(undefined, { month: "short" }).format(date)}</span><strong>{new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date)}</strong></time>
                        <CategoryMark category="Payment" />
                        <div class="min-w-0"><strong class="expense-row-title">{payer} paid {recipient}</strong><span class="expense-row-context">{direction}{details.note ? ` · ${details.note}` : ""}</span></div>
                        <div class="expense-row-money"><strong>{money(details.amountMinor, details.currency)}</strong><span>payment</span></div>
                        <span aria-hidden="true" />
                      </article>;
                    }}</Match>
                  </Switch>}
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
    appStore.members().filter((member) => member.groupId === groupId && isVisibleGroupMember(member.status)).length;
  const groupExpenseCount = (groupId: string) =>
    appStore.expenses().filter((expense) => expense.groupId === groupId && expense.status === "active").length;
  const groupPaymentCount = (groupId: string) => activePayments(appStore.operations(), groupId).length;
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
              const payments = createMemo(() => groupPaymentCount(group.id));
              const people = createMemo(() => groupMemberCount(group.id));
              return (
                <button
                  type="button"
                  class="group-overview-card"
                  style={{ "--row-index": Math.min(index(), 7) }}
                  onClick={() => props.onOpenGroup(group.id)}
                >
                  <span class="group-overview-icon"><UsersRound size={18} /></span>
                  <span class="group-overview-main">
                    <strong>{group.name}</strong>
                    <small>{people()} {people() === 1 ? "person" : "people"} · {expenses()} {expenses() === 1 ? "expense" : "expenses"}{payments() ? ` · ${payments()} ${payments() === 1 ? "payment" : "payments"}` : ""}</small>
                  </span>
                  <span class="group-overview-balance">
                    <small classList={{ "money-in": balance() > 0, "money-out": balance() < 0 }}>{balance() > 0 ? "you’re owed" : balance() < 0 ? "you owe" : "settled"}</small>
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
  const payments = createMemo(() => activePayments(appStore.operations(), group()?.id));
  const [currency, setCurrency] = createSignal("USD");
  const [chartMode, setChartMode] = createSignal<"category" | "month">(
    "category",
  );
  const [groupSection, setGroupSection] = createSignal<"expenses" | "balances" | "insights">("expenses");
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  createEffect(() => {
    setCurrency(group()?.settlementCurrency ?? "USD");
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
          isVisibleGroupMember(member.status),
      ),
  );
  const claimablePeople = createMemo(() => people().filter((member) => member.importClaim));
  const connectionCallout = createMemo(() => groupConnectionCallout(claimablePeople()));
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
        <div class="group-heading-copy">
          <button class="group-back-action" type="button" onClick={props.onShowOverview}>
            <ChevronLeft size={15} /> All groups
          </button>
          <div class="group-title-line">
            <h1 class="page-title">{group()?.name ?? "Groups"}</h1>
            <div class="group-title-actions">
              <Show when={group()}><button class="group-settings-action" type="button" aria-label={`Open settings for ${group()?.name}`} onClick={() => setSettingsOpen(true)}><Settings2 size={18} aria-hidden="true" /></button></Show>
            </div>
          </div>
          <Show when={group()} fallback={<p class="mt-1 text-sm text-muted-foreground">No groups yet</p>}>
            <div class="group-meta-line">
              <button type="button" onClick={() => setSettingsOpen(true)}><UsersRound size={14} aria-hidden="true" /> {people().length + 1} {people().length === 0 ? "person" : "people"} <ChevronRight size={13} aria-hidden="true" /></button>
              <span aria-hidden="true">·</span>
              <span>{activeExpenses().length} {activeExpenses().length === 1 ? "expense" : "expenses"}{payments().length ? ` · ${payments().length} ${payments().length === 1 ? "payment" : "payments"}` : ""}</span>
            </div>
          </Show>
        </div>
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
            <Show when={connectionCallout()}>{(callout) => (
              <button class="group-connection-callout" type="button" onClick={() => setSettingsOpen(true)}>
                <span class="group-connection-icon"><ShieldCheck size={17} aria-hidden="true" /></span>
                <span><strong>{callout().title}</strong><small>{callout().detail}</small></span>
                <ChevronRight size={16} />
              </button>
            )}</Show>
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
                />
              </div>
            </Show>

            <Show when={groupSection() === "balances"}>
              <div id={tabPanelId("group-view", "balances")} class="page-enter space-y-3" role="tabpanel" aria-labelledby={tabId("group-view", "balances")}>
                <Show when={settlementBlockers() > 0}>
                  <section class="settlement-warning" role="status"><div><strong>Settlement paused</strong><span>{settlementBlockers()} provisional {settlementBlockers() === 1 ? "expense needs" : "expenses need"} review before anyone records a payment.</span></div><button type="button" onClick={() => setGroupSection("expenses")}>View activity</button></section>
                </Show>
                <section class="balance-strip" aria-label={`${activeGroup.name} balance summary`}>
                  <div class="balance-cell balance-cell-in"><span class="micro-label">Coming in</span><strong class="money-type money-in">{money(incoming(), currency())}</strong></div>
                  <div class="balance-cell balance-cell-out"><span class="micro-label">Going out</span><strong class="money-type money-out">{money(outgoing(), currency())}</strong></div>
                  <div class="balance-cell balance-cell-net"><span class="micro-label">Net balance</span><strong class="money-type" classList={{ "money-in": yourBalance() > 0, "money-out": yourBalance() < 0 }}>{yourBalance() === 0 ? money(0, currency()) : `${yourBalance() > 0 ? "+" : "−"}${money(Math.abs(yourBalance()), currency())}`}</strong></div>
                  <select class="balance-currency" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)} aria-label="Balance currency"><For each={currenciesFor(activeGroup.id)}>{(item) => <option value={item}>{item}</option>}</For></select>
                </section>
                <section class="people-balance-list" aria-label={`Balances in ${activeGroup.name}`}>
                  <For each={people()} fallback={<Card class="p-6 text-sm text-muted-foreground">Invite someone to {activeGroup.name} to start splitting.</Card>}>
                    {(member) => {
                      const balance = createMemo(() => balances()[member.userId] ?? 0);
                      const settlement = createMemo<Settlement | undefined>(() => member.status !== "active" ? undefined : balance() < 0 ? { payerId: member.userId, recipientId: props.actorId, amountMinor: -balance() } : balance() > 0 ? { payerId: props.actorId, recipientId: member.userId, amountMinor: balance() } : undefined);
                      const related = createMemo(() => activeExpenses().filter((expense) => expense.allocations.some((allocation) => allocation.participantId === member.userId)).slice(0, 2).map((expense) => expense.description).join(", "));
                      return (
                        <article class="person-balance-block" classList={{ "tone-mint": balance() < 0, "tone-coral": balance() > 0, "tone-butter": balance() === 0 }}>
                          <Avatar name={member.displayName} class="person-avatar" />
                          <div class="min-w-0 flex-1"><strong class="block truncate">{member.displayName}</strong><span class="micro-label block truncate">{memberBalanceContextPrefix(member)}{related() || activeGroup.name}</span></div>
                          <div class="shrink-0 text-right"><strong class="money-type block" classList={{ "money-in": balance() < 0, "money-out": balance() > 0 }}>{balance() === 0 ? money(0, currency()) : `${balance() < 0 ? "+" : "−"}${money(Math.abs(balance()), currency())}`}</strong><span class="micro-label" classList={{ "money-in": balance() < 0, "money-out": balance() > 0 }}>{balance() < 0 ? "owes you" : balance() > 0 ? "you owe" : "settled"}</span></div>
                          <Show when={member.status !== "placeholder"} fallback={<button class="member-link-status" type="button" onClick={() => setSettingsOpen(true)}>{memberConnectionActionLabel(member)}</button>}>
                            <button class="ink-action" type="button" disabled={!settlement() || settlementBlockers() > 0} onClick={() => props.onSettle(settlement(), currency())}>{balance() > 0 ? "Pay" : "Settle"}</button>
                          </Show>
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
                      <header><div><h3 id="reconciliation-title">{reconciliationTitle()}</h3><p>From {reconciliation().expenseCount} {reconciliation().expenseCount === 1 ? "expense" : "expenses"} and {reconciliation().paymentCount} recorded {reconciliation().paymentCount === 1 ? "payment" : "payments"}.</p></div><button type="button" onClick={() => setGroupSection("balances")}>See balances <ChevronRight size={14} /></button></header>
                      <dl>
                        <div><dt>You paid</dt><dd>+{money(reconciliation().paidByYouMinor, currency())}</dd></div>
                        <div><dt>Your share</dt><dd>−{money(reconciliation().yourShareMinor, currency())}</dd></div>
                        <Show when={reconciliation().paymentsSentMinor > 0}><div><dt>Payments you sent</dt><dd>+{money(reconciliation().paymentsSentMinor, currency())}</dd></div></Show>
                        <Show when={reconciliation().paymentsReceivedMinor > 0}><div><dt>Payments you received</dt><dd>−{money(reconciliation().paymentsReceivedMinor, currency())}</dd></div></Show>
                        <div class="insight-reconciliation-total"><dt>Current balance</dt><dd>{reconciliation().balanceMinor > 0 ? `+${money(reconciliation().balanceMinor, currency())}` : reconciliation().balanceMinor < 0 ? `−${money(Math.abs(reconciliation().balanceMinor), currency())}` : money(0, currency())}</dd></div>
                      </dl>
                    </section>

                    <section class="insight-settlement" aria-labelledby="settlement-plan-title">
                      <header><div><h3 id="settlement-plan-title">{settlementBlockers() > 0 ? "Settlement paused" : "Simplest way to settle"}</h3><p>{settlementBlockers() > 0 ? `${settlementBlockers()} provisional ${settlementBlockers() === 1 ? "expense needs" : "expenses need"} review` : settlementPlan().length ? `${settlementPlan().length} ${settlementPlan().length === 1 ? "transfer" : "transfers"} clears the group` : "No payments needed"}</p></div><button type="button" onClick={() => setGroupSection(settlementBlockers() > 0 ? "expenses" : "balances")}>{settlementBlockers() > 0 ? "View activity" : "See balances"} <ChevronRight size={14} /></button></header>
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

            <GroupSettingsDialog
              open={settingsOpen()}
              groupId={activeGroup.id}
              actorId={props.actorId}
              onOpenChange={setSettingsOpen}
              onNotify={props.onToast}
            />
          </>
        )}
      </Show>
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
  const [migrationOpen, setMigrationOpen] = createSignal(false);
  const [migrationLaunchMessage, setMigrationLaunchMessage] = createSignal<string>();
  const [splitwiseSession, setSplitwiseSession] = createSignal<string>();
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
  const [smartCategoriesEnabled, setSmartCategoriesEnabled] = createSignal(
    localStorage.getItem(smartCategoriesStorageKey) === "enabled",
  );
  const [inviteRecovery, setInviteRecovery] = createSignal<"idle" | "accepting" | "waiting">(
    inviteTokenFromHash() ? "accepting" : "idle",
  );
  const [inviteRecoveryMessage, setInviteRecoveryMessage] = createSignal("");
  const [migrationClaimMessage, setMigrationClaimMessage] = createSignal("");
  const [migrationClaimPending, setMigrationClaimPending] = createSignal(Boolean(migrationClaimFromHash()));
  const [migrationClaimBusy, setMigrationClaimBusy] = createSignal(false);
  const claimRequestStorageKey = `tallied:migration-claim-request:${props.actorId}`;
  const migrationOnboardingKey = `migration-onboarding-shown:${props.actorId}`;
  let migrationOnboardingChecked = false;
  let toastTimer = 0;
  function updateSmartCategories(enabled: boolean): void {
    setSmartCategoriesEnabled(enabled);
    localStorage.setItem(smartCategoriesStorageKey, enabled ? "enabled" : "disabled");
    notify(enabled ? "Smart category suggestions enabled" : "Smart category suggestions disabled");
  }
  async function acceptPendingInvitation(): Promise<void> {
    const invitationToken = inviteTokenFromHash();
    if (!invitationToken) {
      setInviteRecovery("idle");
      return;
    }
    setInviteRecovery("accepting");
    setInviteRecoveryMessage("");
    try {
      await acceptCurrentContactInvitation(invitationToken);
      clearInviteToken();
      setInviteRecovery("idle");
      notify("You’re connected on Tallied");
    } catch (error) {
      setInviteRecovery("waiting");
      setInviteRecoveryMessage(error instanceof Error ? error.message : "Could not verify this invitation");
    }
  }
  async function acceptPendingMigrationClaim(): Promise<void> {
    const token = migrationClaimFromHash();
    if (!token) return;
    setMigrationClaimBusy(true);
    setMigrationClaimMessage("Claiming your imported history…");
    try {
      const result = await claimImportedIdentity(token);
      clearLocationHash();
      setMigrationClaimPending(false);
      if (result.status === "claimed") {
        setMigrationClaimMessage(`${result.displayName}'s imported history is now connected to your account.`);
        await appStore.sync();
      } else {
        if (result.requestId) localStorage.setItem(claimRequestStorageKey, result.requestId);
        setMigrationClaimMessage(`Request sent. The migration owner must confirm that you are ${result.displayName}. No balances are visible yet.`);
      }
    } catch (error) {
      setMigrationClaimMessage(error instanceof Error ? error.message : "This migration claim could not be completed");
    } finally {
      setMigrationClaimBusy(false);
    }
  }
  async function refreshMigrationClaimRequest(): Promise<void> {
    const requestId = localStorage.getItem(claimRequestStorageKey);
    if (!requestId) return;
    try {
      const result = await getImportClaimStatus(requestId);
      if (result.status === "awaiting_owner") {
        setMigrationClaimMessage(`Your request to claim ${result.displayName}'s imported history is waiting for the migration owner. No balances are visible yet.`);
      } else if (result.status === "claimed") {
        localStorage.removeItem(claimRequestStorageKey);
        setMigrationClaimMessage(`${result.displayName}'s imported history is now connected to your account.`);
        await appStore.sync();
      } else {
        localStorage.removeItem(claimRequestStorageKey);
        setMigrationClaimMessage(result.status === "rejected" ? "The migration owner did not approve this claim." : "This claim request expired. Ask the migration owner for a new link.");
      }
    } catch {
      setMigrationClaimMessage("Your imported-history claim is saved on this device. Reconnect to check its status.");
    }
  }
  onMount(() => {
    applyTheme(
      (localStorage.getItem("expenses-theme") as Theme | null) ?? "system",
    );
    void initializeStore(props.actorId);
    if (inviteTokenFromHash()) void acceptPendingInvitation();
    if (migrationClaimFromHash()) {
      setMigrationClaimMessage(`Review this claim before continuing${props.email ? ` as ${props.email}` : ""}. It can join this account to imported groups; members will see your verified identity.`);
    }
    void refreshMigrationClaimRequest();
    const openNotification = (urlValue?: string) => {
      const url = new URL(urlValue ?? location.href, location.origin);
      if (url.searchParams.get("view") !== "activity") return;
      setTab("activity");
      const groupId = url.searchParams.get("group");
      if (groupId && appStore.groups().some(({ id }) => id === groupId)) setSelectedGroupId(groupId);
      url.searchParams.delete("view");
      url.searchParams.delete("group");
      history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    };
    openNotification();
    let pendingRemoteActivities: string[] = [];
    const onRemoteActivity = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      if (!message) return;
      if (document.visibilityState === "hidden") pendingRemoteActivities.push(message);
      else notify(message);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const message = queuedForegroundActivityMessage(pendingRemoteActivities);
      pendingRemoteActivities = [];
      if (message) notify(message);
    };
    const onServiceWorkerMessage = (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type === "tallied:notification-click") openNotification(event.data.url);
    };
    window.addEventListener("tallied:remote-activity", onRemoteActivity);
    document.addEventListener("visibilitychange", onVisibilityChange);
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    onCleanup(() => {
      window.removeEventListener("tallied:remote-activity", onRemoteActivity);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
    });
    const migrationHash = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
    const oauthSession = migrationHash.get("splitwiseSession")?.trim();
    if (oauthSession && /^[0-9a-f-]{36}$/.test(oauthSession)) {
      setSplitwiseSession(oauthSession);
      setMigrationOpen(true);
    } else if (migrationHash.get("migration")?.startsWith("splitwise-auth-")) {
      const outcome = migrationHash.get("migration");
      setMigrationLaunchMessage(outcome === "splitwise-auth-rate-limited"
        ? "Too many authorization callbacks arrived. Nothing was imported; wait a moment, then try again."
        : outcome === "splitwise-auth-cancelled"
          ? "Splitwise connection was cancelled. Nothing was imported; you can choose another route."
          : "Splitwise did not authorize this migration. Nothing was imported; you can try again or upload exports instead.");
      setMigrationOpen(true);
      clearLocationHash();
    }
  });
  const claimStatusTimer = window.setInterval(() => void refreshMigrationClaimRequest(), 30_000);
  onCleanup(() => window.clearInterval(claimStatusTimer));
  createEffect(() => {
    if (tab() === "activity" && appStore.connection() === "online") void acknowledgeNotifications();
  });
  createEffect(() => {
    if (!selectedGroupId() && appStore.groups()[0])
      setSelectedGroupId(appStore.groups()[0]!.id);
  });
  createEffect(() => {
    if (migrationOnboardingChecked || appStore.connection() === "connecting") return;
    migrationOnboardingChecked = true;
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("scenarioActor")) return;
    if (inviteTokenFromHash() || migrationClaimFromHash() || splitwiseSession()) return;
    void Promise.all([
      localDb.settings.get(migrationOnboardingKey),
      localDb.operations.count(),
    ]).then(async ([shown, operationCount]) => {
      if (shown || operationCount > 0) return;
      await localDb.settings.put({ key: migrationOnboardingKey, value: true });
      setMigrationOpen(true);
    });
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
  function addFromCurrentContext(): void {
    if (tab() === "groups" && groupsMode() === "detail" && selectedGroupId()) addExpense(selectedGroupId());
    else addExpense();
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
          <strong class="brand-wordmark">Tallied</strong>
        </div>
        <div class="px-3 pb-3">
          <Button
            class="h-11 w-full justify-start"
            onClick={addFromCurrentContext}
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
          <span class="flex items-center gap-2"><BrandMark size={28} /><strong class="mobile-wordmark">Tallied</strong></span>
          <span class="mobile-header-actions">
            <ConnectionPill />
            <button class="mobile-add-action" type="button" onClick={addFromCurrentContext}>
              <Plus size={16} /> Add expense
            </button>
          </span>
        </header>
        <main id="main-content" tabindex={-1} class="app-main mx-auto w-full max-w-5xl px-4 pb-28 pt-5 sm:px-6 sm:pt-8 md:px-8 md:pb-12 lg:px-10">
          <Show when={inviteRecovery() !== "idle"}>
            <section class="invite-recovery-banner" role={inviteRecovery() === "waiting" ? "alert" : "status"} aria-live={inviteRecovery() === "waiting" ? "assertive" : "polite"}>
              <div>
                <strong>{inviteRecovery() === "accepting" ? "Verifying your invitation…" : "Your invitation is saved"}</strong>
                <p>{inviteRecovery() === "accepting" ? "Tallied is connecting this account to your inviter." : "Reconnect to verify and join. Wait to add shared expenses until this finishes; offline drafts are not connected to the invitation yet."}</p>
                <Show when={inviteRecoveryMessage()}><small>{inviteRecoveryMessage()}</small></Show>
              </div>
              <Show when={inviteRecovery() === "waiting"}><Button variant="secondary" onClick={() => void acceptPendingInvitation()}>Retry</Button></Show>
            </section>
          </Show>
          <Show when={migrationClaimMessage()}>
            <section class="invite-recovery-banner" role="status" aria-live="polite">
              <div><strong>Imported history</strong><p>{migrationClaimMessage()}</p></div>
              <Show when={migrationClaimPending()} fallback={<button class="icon-button" aria-label="Dismiss imported history message" onClick={() => setMigrationClaimMessage("")}><X size={17} /></button>}>
                <div class="flex flex-wrap gap-2">
                  <Button disabled={migrationClaimBusy()} onClick={() => void acceptPendingMigrationClaim()}>{migrationClaimBusy() ? "Checking…" : "Continue claim"}</Button>
                  <Button variant="secondary" disabled={migrationClaimBusy()} onClick={() => {
                    clearLocationHash();
                    setMigrationClaimPending(false);
                    setMigrationClaimMessage("");
                  }}>Not now</Button>
                </div>
              </Show>
            </section>
          </Show>
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
              <AccountView displayName={displayName()} email={props.email} smartCategoriesEnabled={smartCategoriesEnabled()} onSmartCategoriesChange={updateSmartCategories} onOpenMigration={() => setMigrationOpen(true)} onNotify={notify} />
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
        smartCategoriesEnabled={smartCategoriesEnabled()}
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
      <Show when={migrationOpen()}>
        <MigrationDialog
          open={migrationOpen()}
          onOpenChange={(open) => {
            setMigrationOpen(open);
            if (!open) setMigrationLaunchMessage(undefined);
          }}
          actorId={props.actorId}
          displayName={displayName()}
          {...(migrationLaunchMessage() ? { launchMessage: migrationLaunchMessage()! } : {})}
          {...(splitwiseSession() ? { splitwiseSession: splitwiseSession()! } : {})}
          onSplitwiseSessionConsumed={() => {
            setSplitwiseSession(undefined);
            history.replaceState(history.state, "", `${location.pathname}${location.search}`);
          }}
          onComplete={notify}
        />
      </Show>
    </div>
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
    <>
      <Show when={releaseWatch.updateAvailable()}>
        <div class="update-banner" role="status" aria-live="polite">
          <span>A new version of Tallied is available</span>
          <Button size="sm" variant="secondary" onClick={reloadForUpdate}>Reload</Button>
        </div>
      </Show>
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
    </>
  );
}
