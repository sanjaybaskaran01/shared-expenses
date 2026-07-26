import {
  Activity, ArrowDownLeft, ArrowUpRight, BarChart3, CheckCircle2, ChevronRight, CircleUserRound,
  Cloud, CloudOff, House, LockKeyhole, LogOut, Mail, Moon, Plus, ReceiptText, RefreshCw,
  Scale, ShieldCheck, Sparkles, Sun, UsersRound, UserPlus, WalletCards,
} from "lucide-solid";
import { For, Match, Show, Suspense, Switch, createEffect, createMemo, createResource, createSignal, lazy, onMount } from "solid-js";
import { BrandMark } from "./components/BrandMark";
import { ExpenseComposer } from "./components/ExpenseComposer";
import { ExpenseDetail } from "./components/ExpenseDetail";
import { GroupComposer } from "./components/GroupComposer";
import { PaymentComposer } from "./components/PaymentComposer";
import { Avatar, Badge, Button, Card } from "./components/ui";
import { inviteGroupMember } from "./lib/api";
import { authClient, getOfflineActorId, signOutAndClearLocalLedger } from "./lib/auth";
import type { LocalExpense, LocalOperation } from "./lib/db";
import { computeBalances, simplifyBalances, type Settlement } from "./lib/ledger-view";
import { appStore, initializeStore, restoreExpense } from "./lib/store";

type Tab = "friends" | "groups" | "activity" | "account";
type Theme = "system" | "light" | "dark";
const SpendingChart = lazy(() => import("./components/SpendingChart").then((module) => ({ default: module.SpendingChart })));

function applyTheme(value: Theme): void {
  const dark = value === "dark" || (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function money(amountMinor: number, currency = "USD", compact = false): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, ...(compact ? { notation: "compact", maximumFractionDigits: 1 } : {}) }).format(amountMinor / 100);
}

function expenseDate(value: string): Date { return new Date(`${value}T12:00:00`); }

function memberName(groupId: string, userId: string, actorId: string): string {
  if (userId === actorId) return "You";
  return appStore.members().find((member) => member.groupId === groupId && member.userId === userId)?.displayName ?? "Member";
}

function currenciesFor(groupId: string): string[] {
  const group = appStore.groups().find((item) => item.id === groupId);
  const values = new Set(appStore.expenses().filter((item) => item.groupId === groupId).map((item) => item.currency));
  values.add(group?.settlementCurrency ?? "USD");
  return [...values];
}

function ConnectionPill() {
  const pending = createMemo(() => appStore.operations().filter((operation) => operation.syncStatus === "pending").length);
  return <button type="button" class="connection-pill glass-control" onClick={() => void appStore.sync()} title={appStore.connectionMessage()}>
    <Switch><Match when={appStore.connection() === "online"}><Cloud class="text-emerald-600" size={14} /><span>{pending() ? `${pending()} syncing` : "Synced"}</span></Match><Match when={appStore.connection() === "connecting"}><RefreshCw class="animate-spin" size={14} /><span>Checking</span></Match><Match when={true}><CloudOff class="text-amber-600" size={14} /><span>{pending() ? `${pending()} on device` : "Offline"}</span></Match></Switch>
  </button>;
}

function SectionHeading(props: { title: string; detail?: string; action?: unknown }) {
  return <div class="flex min-h-14 items-center justify-between gap-4 border-b border-border/65 px-4 sm:px-5"><div><h2 class="text-sm font-semibold tracking-tight">{props.title}</h2><Show when={props.detail}><p class="text-xs text-muted-foreground">{props.detail}</p></Show></div>{props.action as never}</div>;
}

function GroupRail(props: { activeGroupId?: string | undefined; onSelect(groupId: string): void; onCreate(): void }) {
  return <div class="group-rail -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
    <For each={appStore.groups()}>{(group, index) => {
      const expenses = createMemo(() => appStore.expenses().filter((expense) => expense.groupId === group.id && expense.status === "active"));
      const total = createMemo(() => expenses().filter((expense) => expense.currency === group.settlementCurrency).reduce((sum, expense) => sum + expense.amountMinor, 0));
      return <button type="button" class="group-tile relative min-w-[14rem] snap-start overflow-hidden rounded-3xl p-4 text-left text-white shadow-lg transition-transform active:scale-[.98]" classList={{ selected: props.activeGroupId === group.id }} style={{ "--group-hue": String(150 + (index() * 52) % 180) }} onClick={() => props.onSelect(group.id)}><div class="relative z-10"><div class="flex items-center justify-between"><Avatar name={group.name} class="border border-white/20 bg-white/15 text-white" /><Show when={props.activeGroupId === group.id}><span class="grid size-7 place-items-center rounded-full bg-white/20"><CheckCircle2 size={15} /></span></Show></div><strong class="mt-5 block truncate text-lg">{group.name}</strong><span class="mt-1 block text-xs text-white/70">{expenses().length} {expenses().length === 1 ? "expense" : "expenses"} · {money(total(), group.settlementCurrency, true)}</span></div></button>;
    }}</For>
    <button type="button" class="grid min-w-[8.5rem] snap-start place-items-center rounded-3xl border border-dashed border-border bg-card/70 p-4 text-center text-muted-foreground" onClick={props.onCreate}><span><Plus class="mx-auto" size={22} /><span class="mt-2 block text-xs font-semibold">New group</span></span></button>
  </div>;
}

function ExpenseList(props: { groupId: string; onOpen(expense: LocalExpense): void }) {
  const expenses = createMemo(() => appStore.expenses().filter((expense) => expense.groupId === props.groupId));
  const activeCount = createMemo(() => expenses().filter((item) => item.status === "active").length);
  return <Card class="overflow-hidden"><SectionHeading title="Ledger" detail={`${activeCount()} active ${activeCount() === 1 ? "expense" : "expenses"}`} /><Show when={expenses().length} fallback={<div class="grid min-h-56 place-items-center px-6 py-10 text-center"><div><span class="mx-auto mb-3 grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground"><ReceiptText size={19} /></span><h3 class="text-sm font-semibold">Nothing here yet</h3><p class="mt-1 text-sm text-muted-foreground">Your first shared expense will appear here.</p></div></div>}><div class="divide-y divide-border/60"><For each={expenses()}>{(expense) => <button type="button" class="group-row flex min-h-[4.75rem] w-full items-center gap-3 px-4 text-left hover:bg-muted/40 sm:px-5" classList={{ "opacity-55": expense.status === "voided" }} onClick={() => props.onOpen(expense)}><span class="category-icon"><ReceiptText size={17} /></span><div class="min-w-0 flex-1"><strong class="block truncate text-sm font-semibold">{expense.description}</strong><span class="mt-0.5 block truncate text-xs text-muted-foreground">{expense.category} · {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(expenseDate(expense.expenseDate))}{expense.status === "voided" ? " · Deleted" : ""}</span></div><div class="shrink-0 text-right"><strong class="block text-sm font-semibold tabular-nums">{money(expense.amountMinor, expense.currency)}</strong><span class="block text-[11px]" classList={{ "text-emerald-700 dark:text-emerald-400": expense.yourNetMinor > 0, "text-rose-700 dark:text-rose-400": expense.yourNetMinor < 0, "text-muted-foreground": expense.yourNetMinor === 0 }}>{expense.syncStatus === "pending" ? "On device" : expense.yourNetMinor > 0 ? `lent ${money(expense.yourNetMinor, expense.currency)}` : expense.yourNetMinor < 0 ? `owe ${money(-expense.yourNetMinor, expense.currency)}` : "included"}</span></div><ChevronRight size={15} class="text-muted-foreground" /></button>}</For></div></Show></Card>;
}

function GroupsView(props: { actorId: string; activeGroupId?: string | undefined; onSelectGroup(groupId: string): void; onAddExpense(groupId?: string): void; onOpenExpense(expense: LocalExpense): void; onCreateGroup(): void; onSettle(settlement: Settlement | undefined, currency: string): void }) {
  const group = createMemo(() => appStore.groups().find((item) => item.id === props.activeGroupId) ?? appStore.groups()[0]);
  const expenses = createMemo(() => appStore.expenses().filter((expense) => expense.groupId === group()?.id));
  const activeExpenses = createMemo(() => expenses().filter((expense) => expense.status === "active"));
  const [currency, setCurrency] = createSignal("USD");
  const [chartMode, setChartMode] = createSignal<"category" | "month">("category");
  createEffect(() => setCurrency(group()?.settlementCurrency ?? "USD"));
  const balances = createMemo(() => group() ? computeBalances(appStore.expenses(), appStore.operations(), group()!.id, currency()) : {});
  const yourBalance = createMemo(() => balances()[props.actorId] ?? 0);
  const settlements = createMemo(() => simplifyBalances(balances()));
  const total = createMemo(() => activeExpenses().filter((expense) => expense.currency === currency()).reduce((sum, expense) => sum + expense.amountMinor, 0));
  const yourShare = createMemo(() => activeExpenses().filter((expense) => expense.currency === currency()).reduce((sum, expense) => sum + (expense.allocations.find((item) => item.participantId === props.actorId)?.amountMinor ?? 0), 0));

  return <div class="page-enter space-y-5 sm:space-y-6">
    <header class="flex items-start justify-between gap-4"><div><p class="eyebrow">Shared expenses</p><h1 class="page-title">Your groups</h1></div><Button variant="secondary" size="icon" class="rounded-full" onClick={props.onCreateGroup} aria-label="Create group"><Plus size={18} /></Button></header>
    <GroupRail activeGroupId={group()?.id} onSelect={props.onSelectGroup} onCreate={props.onCreateGroup} />
    <Show when={group()} keyed fallback={<Card class="grid min-h-72 place-items-center p-8 text-center"><div><UsersRound class="mx-auto text-muted-foreground" size={30} /><h2 class="mt-3 font-semibold">Create your first group</h2><p class="mt-1 text-sm text-muted-foreground">Add people, then start logging shared expenses.</p><Button class="mt-5" onClick={props.onCreateGroup}><Plus size={16} /> New group</Button></div></Card>}>{(activeGroup) => <>
      <section class="balance-hero relative overflow-hidden rounded-[2rem] p-5 text-white shadow-xl sm:p-6"><div class="hero-orb hero-orb-one" /><div class="hero-orb hero-orb-two" /><div class="relative z-10"><div class="flex items-start justify-between gap-4"><div><p class="text-xs font-medium text-white/65">{activeGroup.name} · your balance</p><strong class="mt-2 block text-4xl font-semibold tracking-[-.045em] tabular-nums">{yourBalance() === 0 ? money(0, currency()) : `${yourBalance() > 0 ? "+" : "−"}${money(Math.abs(yourBalance()), currency())}`}</strong><p class="mt-1 text-sm text-white/75">{yourBalance() === 0 ? "Everyone is settled up" : yourBalance() > 0 ? "You get back" : "You owe"}</p></div><select class="glass-select" value={currency()} onInput={(event) => setCurrency(event.currentTarget.value)} aria-label="Balance currency"><For each={currenciesFor(activeGroup.id)}>{(item) => <option value={item}>{item}</option>}</For></select></div><div class="mt-7 grid grid-cols-3 gap-2"><button class="hero-action" onClick={() => props.onAddExpense(activeGroup.id)}><Plus size={17} /><span>Add</span></button><button class="hero-action" onClick={() => props.onSettle(settlements()[0], currency())}><WalletCards size={17} /><span>Settle</span></button><button class="hero-action" onClick={() => document.getElementById("insights")?.scrollIntoView({ behavior: "smooth" })}><BarChart3 size={17} /><span>Totals</span></button></div></div></section>

      <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(19rem,.7fr)]">
        <ExpenseList groupId={activeGroup.id} onOpen={props.onOpenExpense} />
        <div class="space-y-5">
          <Card class="overflow-hidden"><SectionHeading title="Settle up" detail={`${settlements().length} suggested ${settlements().length === 1 ? "payment" : "payments"}`} /><Show when={settlements().length} fallback={<div class="grid min-h-32 place-items-center p-5 text-center"><div><CheckCircle2 class="mx-auto text-emerald-600" size={23} /><p class="mt-2 text-sm font-medium">All settled</p></div></div>}><div class="divide-y divide-border/60"><For each={settlements()}>{(settlement) => { const payer = createMemo(() => memberName(activeGroup.id, settlement.payerId, props.actorId)); return <button class="group-row flex w-full items-center gap-3 px-4 py-3.5 text-left" onClick={() => props.onSettle(settlement, currency())}><div class="flex -space-x-2"><Avatar name={payer()} class="size-8 border-2 border-card text-xs" /><Avatar name={memberName(activeGroup.id, settlement.recipientId, props.actorId)} class="size-8 border-2 border-card text-xs" /></div><div class="min-w-0 flex-1"><p class="truncate text-xs text-muted-foreground">{payer()} {payer() === "You" ? "pay" : "pays"} {memberName(activeGroup.id, settlement.recipientId, props.actorId)}</p><strong class="text-sm tabular-nums">{money(settlement.amountMinor, currency())}</strong></div><ChevronRight size={15} class="text-muted-foreground" /></button>; }}</For></div></Show></Card>
          <Card id="insights" class="overflow-hidden"><SectionHeading title="Spending insights" detail={`${money(total(), currency())} total`} action={<div class="segmented-control"><button classList={{ active: chartMode() === "category" }} onClick={() => setChartMode("category")}>Category</button><button classList={{ active: chartMode() === "month" }} onClick={() => setChartMode("month")}>Months</button></div>} /><div class="p-4"><div class="mb-1 grid grid-cols-2 gap-3"><div class="metric-tile"><span>Total spent</span><strong>{money(total(), currency(), true)}</strong></div><div class="metric-tile"><span>Your share</span><strong>{money(yourShare(), currency(), true)}</strong></div></div><Show when={total() > 0} fallback={<div class="grid h-48 place-items-center text-sm text-muted-foreground">Charts appear after your first expense.</div>}><Suspense fallback={<div class="grid h-52 place-items-center text-xs text-muted-foreground">Preparing chart…</div>}><SpendingChart expenses={expenses()} currency={currency()} mode={chartMode()} /></Suspense></Show></div></Card>
        </div>
      </div>
    </>}</Show>
  </div>;
}

function FriendsView(props: { actorId: string; activeGroupId?: string | undefined; onSelectGroup(groupId: string): void; onSettle(settlement: Settlement, currency: string): void }) {
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [email, setEmail] = createSignal("");
  const [message, setMessage] = createSignal("");
  const group = createMemo(() => appStore.groups().find((item) => item.id === props.activeGroupId) ?? appStore.groups()[0]);
  const currency = createMemo(() => group()?.settlementCurrency ?? "USD");
  const balances = createMemo(() => group() ? computeBalances(appStore.expenses(), appStore.operations(), group()!.id, currency()) : {});
  const members = createMemo(() => appStore.members().filter((member) => member.groupId === group()?.id && member.userId !== props.actorId));
  async function invite(event: SubmitEvent) { event.preventDefault(); if (!group()) return; setMessage("Sending…"); try { await inviteGroupMember(group()!.id, { email: email() }); setMessage("Invite sent — their one link verifies and opens the group."); setEmail(""); await appStore.sync(); } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Could not send invite"); } }
  return <div class="page-enter space-y-5"><header class="flex items-start justify-between gap-4"><div><p class="eyebrow">People you share with</p><h1 class="page-title">Friends</h1></div><Button variant="secondary" class="rounded-full" onClick={() => setInviteOpen((value) => !value)}><UserPlus size={16} /> Invite</Button></header><Show when={appStore.groups().length > 1}><select class="form-control max-w-xs" value={group()?.id} onInput={(event) => props.onSelectGroup(event.currentTarget.value)} aria-label="View friends in group"><For each={appStore.groups()}>{(item) => <option value={item.id}>{item.name}</option>}</For></select></Show><Show when={inviteOpen()}><Card class="disclosure-panel p-5"><h2 class="text-sm font-semibold">Invite to {group()?.name}</h2><p class="mt-1 text-sm text-muted-foreground">Only an email is needed. The invite link signs them in directly.</p><form class="mt-4 flex gap-2" onSubmit={invite}><input class="form-control h-11" required type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} placeholder="friend@example.com" /><Button type="submit">Send</Button></form><Show when={message()}><p class="mt-3 text-xs text-muted-foreground">{message()}</p></Show></Card></Show><Card class="overflow-hidden"><For each={members()} fallback={<div class="px-6 py-12 text-center"><UsersRound class="mx-auto text-muted-foreground" size={26} /><p class="mt-3 text-sm text-muted-foreground">Invite someone to begin sharing expenses.</p></div>}>{(member) => { const balance = createMemo(() => balances()[member.userId] ?? 0); const settlement = createMemo<Settlement | undefined>(() => balance() < 0 ? { payerId: member.userId, recipientId: props.actorId, amountMinor: -balance() } : balance() > 0 ? { payerId: props.actorId, recipientId: member.userId, amountMinor: balance() } : undefined); return <article class="flex min-h-20 items-center gap-3 border-b border-border/60 px-4 last:border-0 sm:px-5"><Avatar name={member.displayName} class="size-11" /><div class="min-w-0 flex-1"><strong class="block truncate text-sm">{member.displayName}</strong><span class="text-xs text-muted-foreground">{member.status === "active" ? group()?.name : "Invitation pending"}</span></div><Show when={member.status === "active"} fallback={<Badge>Invited</Badge>}><button type="button" class="text-right" disabled={!settlement()} onClick={() => settlement() && props.onSettle(settlement()!, currency())}><strong class="block text-sm tabular-nums" classList={{ "text-emerald-700 dark:text-emerald-400": balance() < 0, "text-rose-700 dark:text-rose-400": balance() > 0 }}>{balance() === 0 ? "Settled" : money(Math.abs(balance()), currency())}</strong><span class="text-[11px] text-muted-foreground">{balance() < 0 ? "owes you" : balance() > 0 ? "you owe" : "all clear"}</span></button></Show></article>; }}</For></Card></div>;
}

const activityCopy: Partial<Record<LocalOperation["type"], string>> = { ExpenseCreated: "added an expense", ExpenseAmended: "updated an expense", ExpenseVoided: "deleted an expense", ExpenseRestored: "restored an expense", CommentAdded: "commented", PaymentRecorded: "recorded a payment", PaymentReversed: "reversed a payment", GroupCreated: "created a group", GroupMemberAdded: "added a member", GroupMemberRemoved: "removed a member" };

function ActivityView(props: { actorId: string; onOpenExpense(expense: LocalExpense): void; onToast(message: string): void }) {
  async function restore(expense: LocalExpense) { await restoreExpense(expense); props.onToast("Expense restored"); }
  return <div class="page-enter space-y-5"><header><p class="eyebrow">Immutable ledger</p><h1 class="page-title">Activity</h1><p class="mt-1 text-sm text-muted-foreground">Every change is signed and remains auditable.</p></header><Card class="overflow-hidden"><For each={appStore.operations()} fallback={<div class="px-6 py-12 text-center text-sm text-muted-foreground">Activity appears after your first ledger change.</div>}>{(operation) => { const expense = createMemo(() => appStore.expenses().find((item) => item.id === operation.targetId)); const group = createMemo(() => appStore.groups().find((item) => item.id === operation.groupId)); return <article class="flex gap-3 border-b border-border/60 px-4 py-4 last:border-0 sm:px-5"><span class="activity-dot" classList={{ pending: operation.syncStatus === "pending", error: operation.syncStatus === "conflicted" || operation.syncStatus === "rejected" }} /><button type="button" class="min-w-0 flex-1 text-left" disabled={!expense()} onClick={() => expense() && props.onOpenExpense(expense()!)}><strong class="block text-sm font-semibold">{operation.actorId === props.actorId ? "You" : memberName(operation.groupId, operation.actorId, props.actorId)} {activityCopy[operation.type] ?? "changed the ledger"}</strong><p class="mt-0.5 truncate text-xs text-muted-foreground">{expense()?.description ?? group()?.name ?? "Shared ledger"} · {operation.syncStatus === "pending" ? "on this device" : operation.syncStatus === "accepted" ? "verified" : "needs review"}</p></button><div class="shrink-0 text-right"><time class="block text-[11px] text-muted-foreground">{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(operation.clientTimestamp))}</time><Show when={operation.type === "ExpenseVoided" && expense()?.status === "voided"}><button class="mt-1 text-xs font-semibold text-primary" onClick={() => expense() && void restore(expense()!)}>Restore</button></Show></div></article>; }}</For></Card></div>;
}

function AccountView(props: { displayName: string }) {
  const [theme, setTheme] = createSignal<Theme>((localStorage.getItem("expenses-theme") as Theme | null) ?? "system");
  createEffect(() => { const value = theme(); localStorage.setItem("expenses-theme", value); applyTheme(value); });
  return <div class="page-enter space-y-5"><header><p class="eyebrow">Preferences & security</p><h1 class="page-title">Account</h1></header><Card class="p-5"><div class="flex items-center gap-4"><Avatar name={props.displayName} class="size-14 text-lg" /><div><h2 class="font-semibold">{props.displayName}</h2><p class="text-sm text-muted-foreground">Passwordless account</p></div></div></Card><Card class="overflow-hidden"><SectionHeading title="Appearance" detail="Optimized for iPhone" /><div class="grid grid-cols-3 gap-2 p-4"><For each={[{ id: "system", label: "System", icon: Sparkles }, { id: "light", label: "Light", icon: Sun }, { id: "dark", label: "Dark", icon: Moon }] as const}>{(item) => <button class="appearance-choice" classList={{ active: theme() === item.id }} onClick={() => setTheme(item.id)}><item.icon size={17} /><span>{item.label}</span></button>}</For></div></Card><Card class="overflow-hidden"><For each={[{ icon: ShieldCheck, title: "Signed operations", detail: "P-256 device key active" }, { icon: Cloud, title: "Offline-first", detail: "New entries queue safely on this device" }, { icon: Scale, title: "Auditable balances", detail: "Every edit remains in the ledger" }]}>{(item) => <article class="flex items-center gap-3 border-b border-border/60 px-4 py-4 last:border-0"><span class="category-icon"><item.icon size={17} /></span><div><strong class="block text-sm">{item.title}</strong><span class="text-xs text-muted-foreground">{item.detail}</span></div></article>}</For><Show when={!import.meta.env.DEV}><div class="border-t border-border/60 p-4"><Button variant="destructive" class="w-full" onClick={() => void signOutAndClearLocalLedger()}><LogOut size={16} /> Sign out and clear this device</Button></div></Show></Card></div>;
}

function AuthenticatedApp(props: { actorId: string }) {
  const [tab, setTab] = createSignal<Tab>("groups");
  const [expenseOpen, setExpenseOpen] = createSignal(false);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [groupOpen, setGroupOpen] = createSignal(false);
  const [paymentOpen, setPaymentOpen] = createSignal(false);
  const [selectedGroupId, setSelectedGroupId] = createSignal<string>();
  const [selectedExpense, setSelectedExpense] = createSignal<LocalExpense>();
  const [editingExpense, setEditingExpense] = createSignal<LocalExpense>();
  const [suggestedSettlement, setSuggestedSettlement] = createSignal<Settlement>();
  const [paymentCurrency, setPaymentCurrency] = createSignal("USD");
  const [toast, setToast] = createSignal("");
  let toastTimer = 0;
  onMount(() => { applyTheme((localStorage.getItem("expenses-theme") as Theme | null) ?? "system"); void initializeStore(props.actorId); });
  createEffect(() => { if (!selectedGroupId() && appStore.groups()[0]) setSelectedGroupId(appStore.groups()[0]!.id); });
  createEffect(() => { const selected = selectedExpense(); if (selected) { const latest = appStore.expenses().find((item) => item.id === selected.id); if (latest && latest !== selected) setSelectedExpense(latest); } });
  const displayName = createMemo(() => appStore.members().find((member) => member.userId === props.actorId)?.displayName ?? "Your account");
  const activeGroup = createMemo(() => appStore.groups().find((group) => group.id === selectedGroupId()) ?? appStore.groups()[0]);
  const tabs = [{ id: "friends" as const, label: "Friends", icon: UsersRound }, { id: "groups" as const, label: "Groups", icon: House }, { id: "activity" as const, label: "Activity", icon: Activity }, { id: "account" as const, label: "Account", icon: CircleUserRound }];
  function notify(message: string) { setToast(message); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => setToast(""), 3500); }
  function selectGroup(id: string) { setSelectedGroupId(id); setTab("groups"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function addExpense(id?: string) { if (id) setSelectedGroupId(id); setEditingExpense(undefined); setExpenseOpen(true); }
  function openDetail(expense: LocalExpense) { setSelectedGroupId(expense.groupId); setSelectedExpense(expense); setDetailOpen(true); }
  function edit(expense: LocalExpense) { setDetailOpen(false); setEditingExpense(expense); setExpenseOpen(true); }
  function settle(settlement?: Settlement, currency = activeGroup()?.settlementCurrency ?? "USD") { setSuggestedSettlement(settlement); setPaymentCurrency(currency); setPaymentOpen(true); }
  return <div class="app-shell min-h-dvh text-foreground md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
    <aside class="desktop-sidebar hidden md:sticky md:top-0 md:flex md:h-dvh md:flex-col"><div class="flex h-18 items-center gap-2.5 px-5"><BrandMark size={32} /><strong>Expenses</strong></div><nav class="grid gap-1 px-3"><For each={tabs}>{(item) => <button class="desktop-nav-item" classList={{ active: tab() === item.id }} onClick={() => setTab(item.id)}><item.icon size={18} />{item.label}</button>}</For></nav><div class="mt-5 border-t border-border/60 px-3 pt-4"><div class="mb-2 flex items-center justify-between px-2"><span class="eyebrow">Groups</span><button class="icon-button" onClick={() => setGroupOpen(true)} aria-label="New group"><Plus size={15} /></button></div><For each={appStore.groups()}>{(group) => <button class="desktop-group" classList={{ active: selectedGroupId() === group.id }} onClick={() => selectGroup(group.id)}><span class="size-2 rounded-full bg-primary" /><span class="truncate">{group.name}</span></button>}</For></div><div class="mt-auto p-4"><ConnectionPill /><p class="mt-2 text-xs leading-5 text-muted-foreground">Ledger changes save locally before syncing.</p></div></aside>
    <div class="min-w-0"><header class="mobile-header md:hidden"><div class="flex items-center gap-2"><BrandMark size={29} /><strong class="text-sm">Expenses</strong></div><ConnectionPill /></header><main class="mx-auto w-full max-w-6xl px-4 pb-36 pt-6 sm:px-6 sm:pt-8 md:px-8 md:pb-12 lg:px-10"><Switch><Match when={tab() === "friends"}><FriendsView actorId={props.actorId} activeGroupId={selectedGroupId()} onSelectGroup={setSelectedGroupId} onSettle={settle} /></Match><Match when={tab() === "groups"}><GroupsView actorId={props.actorId} activeGroupId={selectedGroupId()} onSelectGroup={selectGroup} onAddExpense={addExpense} onOpenExpense={openDetail} onCreateGroup={() => setGroupOpen(true)} onSettle={settle} /></Match><Match when={tab() === "activity"}><ActivityView actorId={props.actorId} onOpenExpense={openDetail} onToast={notify} /></Match><Match when={tab() === "account"}><AccountView displayName={displayName()} /></Match></Switch></main></div>
    <Show when={tab() !== "account" && activeGroup()}><button class="floating-add md:hidden" onClick={() => addExpense(activeGroup()?.id)} aria-label={`Add expense to ${activeGroup()?.name}`}><Plus size={24} /></button></Show>
    <nav class="mobile-tabbar glass-nav md:hidden" aria-label="Primary navigation"><For each={tabs}>{(item) => <button class="nav-item" classList={{ active: tab() === item.id }} onClick={() => setTab(item.id)}><item.icon size={20} stroke-width={tab() === item.id ? 2.6 : 2} /><span>{item.label}</span></button>}</For></nav>
    <Show when={toast()}><div class="toast-enter toast-pill"><CheckCircle2 size={16} />{toast()}</div></Show>
    <ExpenseComposer open={expenseOpen()} actorId={props.actorId} initialGroupId={selectedGroupId()} expense={editingExpense()} onOpenChange={(open) => { setExpenseOpen(open); if (!open) setEditingExpense(undefined); }} onSaved={(mode) => notify(mode === "updated" ? "Expense updated" : "Expense added")} />
    <ExpenseDetail open={detailOpen()} actorId={props.actorId} expense={selectedExpense()} onOpenChange={setDetailOpen} onEdit={edit} onChanged={notify} />
    <PaymentComposer open={paymentOpen()} groupId={selectedGroupId()} currency={paymentCurrency()} suggested={suggestedSettlement()} onOpenChange={setPaymentOpen} onSaved={() => notify("Payment recorded")} />
    <GroupComposer open={groupOpen()} onOpenChange={setGroupOpen} onCreated={(id) => { selectGroup(id); notify("Group created"); }} />
  </div>;
}

function AuthScreen() {
  const [email, setEmail] = createSignal(new URLSearchParams(location.search).get("email") ?? "");
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function requestLink(event: SubmitEvent) { event.preventDefault(); setBusy(true); setMessage(""); try { const result = await authClient.signIn.magicLink({ email: email().trim(), callbackURL: location.origin, newUserCallbackURL: location.origin, errorCallbackURL: `${location.origin}/?auth=failed` }); setMessage(result.error ? result.error.message ?? "Could not send the link." : "Check your inbox — the secure link signs you in directly."); } catch { setMessage("The server is unavailable. Previously signed-in devices can continue offline."); } finally { setBusy(false); } }
  return <main class="auth-shell grid min-h-dvh place-items-center px-4 py-10"><div class="w-full max-w-sm"><div class="mb-6 flex items-center justify-center gap-2.5 text-white"><BrandMark size={38} /><strong class="text-lg">Expenses</strong></div><Card class="glass-auth rounded-[2rem] p-6 sm:p-8"><span class="mb-5 grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary"><LockKeyhole size={19} /></span><h1 class="text-2xl font-semibold tracking-tight">Welcome back</h1><p class="mt-2 text-sm leading-6 text-muted-foreground">Enter your invited email. No password, no second verification step.</p><form class="mt-6 grid gap-4" onSubmit={requestLink}><label class="grid gap-2 text-sm font-medium">Email address<div class="relative"><Mail class="absolute left-3 top-3 text-muted-foreground" size={17} /><input class="form-control h-12 pl-9" required type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} placeholder="you@example.com" /></div></label><Button class="h-12 w-full rounded-xl" type="submit" disabled={busy()}>{busy() ? "Sending…" : "Email me a sign-in link"}</Button></form><Show when={message()}><p class="mt-4 rounded-xl border border-border bg-muted/60 p-3 text-sm text-muted-foreground">{message()}</p></Show><p class="mt-5 text-center text-xs text-muted-foreground">Private · Passwordless · Offline-ready</p></Card></div></main>;
}

export default function App() {
  const session = authClient.useSession();
  const [offlineActorId] = createResource(getOfflineActorId);
  const actorId = createMemo(() => import.meta.env.DEV ? "dev-user" : session().data?.user.id ?? offlineActorId());
  return <Show when={(!session().isPending && !offlineActorId.loading) || import.meta.env.DEV} fallback={<main class="grid min-h-dvh place-items-center bg-background"><BrandMark size={44} /></main>}><Show when={actorId()} keyed fallback={<AuthScreen />}>{(id) => <AuthenticatedApp actorId={id} />}</Show></Show>;
}
