import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Cloud,
  CloudOff,
  House,
  LockKeyhole,
  LogOut,
  Mail,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  UserPlus,
} from "lucide-solid";
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onMount } from "solid-js";
import { BrandMark } from "./components/BrandMark";
import { ExpenseComposer } from "./components/ExpenseComposer";
import { Avatar, Badge, Button, Card } from "./components/ui";
import { inviteGroupMember } from "./lib/api";
import { authClient, getOfflineActorId, signOutAndClearLocalLedger } from "./lib/auth";
import { appStore, initializeStore } from "./lib/store";

type Tab = "friends" | "groups" | "activity" | "account";

function money(amountMinor: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function signedMoney(amountMinor: number, currency = "USD"): string {
  if (amountMinor === 0) return money(0, currency);
  return (amountMinor > 0 ? "+" : "−") + money(Math.abs(amountMinor), currency);
}

function expenseDate(value: string): Date {
  return new Date(value + "T12:00:00");
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

function ExpenseList(props: { groupId?: string | undefined }) {
  const visibleExpenses = createMemo(() => appStore.expenses().filter((expense) => !props.groupId || expense.groupId === props.groupId));
  const activeCount = createMemo(() => visibleExpenses().filter((expense) => expense.status === "active").length);
  return (
    <Card class="overflow-hidden">
      <SectionHeading title="Recent expenses" detail={activeCount() + (activeCount() === 1 ? " expense" : " expenses")} />
      <Show
        when={visibleExpenses().length > 0}
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
          <For each={visibleExpenses()}>
            {(expense) => (
              <article class="flex items-center gap-3 px-5 py-4 sm:px-6" classList={{ "opacity-50": expense.status === "voided" }}>
                <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><ReceiptText size={17} /></span>
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm font-medium">{expense.description}</strong>
                  <span class="block truncate text-xs text-muted-foreground">
                    {expense.category} · {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(expenseDate(expense.expenseDate))}
                  </span>
                </div>
                <div class="shrink-0 text-right">
                  <strong class="block text-sm font-semibold tabular-nums">{money(expense.amountMinor, expense.currency)}</strong>
                  <span class="block text-xs text-muted-foreground" classList={{ "text-emerald-700": expense.yourNetMinor > 0, "text-rose-700": expense.yourNetMinor < 0 }}>
                    {expense.syncStatus === "pending" ? "Saved on device" : expense.yourNetMinor === 0 ? "Your share" : expense.yourNetMinor > 0 ? "You lent " + money(expense.yourNetMinor, expense.currency) : "You owe " + money(-expense.yourNetMinor, expense.currency)}
                  </span>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </Card>
  );
}

function GroupsCard(props: { activeGroupId?: string | undefined; onSelect(groupId: string): void }) {
  return (
    <Card class="overflow-hidden">
      <SectionHeading title="Your groups" detail={appStore.groups().length + " active"} />
      <div class="divide-y divide-border">
        <For each={appStore.groups()} fallback={<p class="px-5 py-8 text-sm text-muted-foreground">Preparing your first group…</p>}>
          {(group) => {
            const members = createMemo(() => appStore.members().filter((member) => member.groupId === group.id));
            const groupNet = createMemo(() => appStore.expenses().reduce((sum, expense) => expense.groupId === group.id && expense.status === "active" ? sum + expense.yourNetMinor : sum, 0));
            return (
              <button type="button" class="group-row flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/50" classList={{ "bg-primary/5": props.activeGroupId === group.id }} onClick={() => props.onSelect(group.id)}>
                <Avatar name={group.name} class="rounded-lg bg-emerald-50 text-emerald-700" />
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm font-medium">{group.name}</strong>
                  <span class="text-xs text-muted-foreground">{members().length} people · {group.settlementCurrency}</span>
                </div>
                <div class="shrink-0 text-right">
                  <strong class="block text-sm font-semibold tabular-nums" classList={{ "text-emerald-700": groupNet() > 0, "text-rose-700": groupNet() < 0 }}>
                    {groupNet() === 0 ? "Settled" : money(Math.abs(groupNet()), group.settlementCurrency)}
                  </strong>
                  <span class="text-xs text-muted-foreground">{groupNet() === 0 ? "No balance" : groupNet() > 0 ? "you get back" : "you owe"}</span>
                </div>
                <ChevronRight size={15} class="text-muted-foreground" />
              </button>
            );
          }}
        </For>
      </div>
    </Card>
  );
}

function GroupsView(props: { activeGroupId?: string | undefined; onSelectGroup(groupId: string): void; onAddExpense(groupId?: string): void }) {
  const group = createMemo(() => appStore.groups().find((item) => item.id === props.activeGroupId) ?? appStore.groups()[0]);
  const groupExpenses = createMemo(() => appStore.expenses().filter((expense) => !group() || expense.groupId === group()!.id));
  const groupMembers = createMemo(() => appStore.members().filter((member) => member.groupId === group()?.id));
  const net = createMemo(() => groupExpenses().reduce((sum, expense) => expense.status === "active" ? sum + expense.yourNetMinor : sum, 0));
  const owed = createMemo(() => groupExpenses().reduce((sum, expense) => expense.status === "active" && expense.yourNetMinor > 0 ? sum + expense.yourNetMinor : sum, 0));
  const owing = createMemo(() => groupExpenses().reduce((sum, expense) => expense.status === "active" && expense.yourNetMinor < 0 ? sum - expense.yourNetMinor : sum, 0));
  return (
    <div class="page-enter space-y-6">
      <header class="flex items-start justify-between gap-4">
        <div>
          <p class="mb-1 text-xs font-medium uppercase tracking-wider text-primary">Group</p>
          <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{group()?.name ?? "Your expenses"}</h1>
          <p class="mt-1 text-sm text-muted-foreground">{group() ? `${groupMembers().length} people · ${group()!.settlementCurrency}` : "Your balances and recent shared expenses."}</p>
        </div>
        <Button onClick={() => props.onAddExpense(group()?.id)}><Plus size={16} /> <span class="hidden sm:inline">Add expense</span><span class="sm:hidden">Add</span></Button>
      </header>

      <Card class="p-5 sm:p-6">
        <div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div>
            <p class="text-sm font-medium text-muted-foreground">Total balance</p>
            <strong class="mt-2 block text-3xl font-semibold tracking-tight tabular-nums" classList={{ "text-emerald-700": net() > 0, "text-rose-700": net() < 0 }}>{signedMoney(net())}</strong>
            <p class="mt-1 text-sm text-muted-foreground">{net() === 0 ? "You are all settled up." : net() > 0 ? "Overall, people owe you." : "Overall, you owe."}</p>
          </div>
          <div class="grid grid-cols-2 gap-3 md:min-w-72">
            <div class="rounded-lg border border-border bg-muted/40 p-3">
              <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowDownLeft size={14} class="text-emerald-700" /> Owed to you</div>
              <strong class="mt-1 block text-sm font-semibold tabular-nums">{money(owed())}</strong>
            </div>
            <div class="rounded-lg border border-border bg-muted/40 p-3">
              <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowUpRight size={14} class="text-rose-700" /> You owe</div>
              <strong class="mt-1 block text-sm font-semibold tabular-nums">{money(owing())}</strong>
            </div>
          </div>
        </div>
      </Card>

      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <ExpenseList groupId={group()?.id} />
        <GroupsCard activeGroupId={group()?.id} onSelect={props.onSelectGroup} />
      </div>
    </div>
  );
}

function FriendsView(props: { actorId: string; activeGroupId?: string | undefined }) {
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteMessage, setInviteMessage] = createSignal("");
  const activeGroup = createMemo(() => appStore.groups().find((group) => group.id === props.activeGroupId) ?? appStore.groups()[0]);
  const visibleMembers = createMemo(() => appStore.members().filter((member) => (
    member.groupId === activeGroup()?.id && member.userId !== props.actorId
  )));

  async function submitInvitation(event: SubmitEvent) {
    event.preventDefault();
    const group = activeGroup();
    if (!group) return setInviteMessage("Create or sync a group before inviting someone.");
    setInviteMessage("Sending invitation…");
    try {
      await inviteGroupMember(group.id, { email: inviteEmail() });
      setInviteMessage("Invite sent. One tap verifies their email and opens the group.");
      setInviteEmail("");
      await appStore.sync();
    } catch (error) {
      setInviteMessage(error instanceof Error ? error.message : "Invitation failed");
    }
  }

  return (
    <div class="page-enter space-y-6">
      <header class="flex items-start justify-between gap-4">
        <div><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">People</h1><p class="mt-1 text-sm text-muted-foreground">Members of {activeGroup()?.name ?? "your selected group"}.</p></div>
        <Button variant="secondary" onClick={() => setInviteOpen((open) => !open)}><UserPlus size={16} /> Invite</Button>
      </header>
      <Show when={inviteOpen()}>
        <Card class="disclosure-panel p-5">
          <div class="mb-4"><h2 class="text-sm font-semibold">Invite to {activeGroup()?.name ?? "your group"}</h2><p class="mt-1 text-sm text-muted-foreground">They’ll receive one secure link that verifies their email and signs them in.</p></div>
          <form class="grid gap-4 md:grid-cols-[1fr_auto] md:items-end" onSubmit={submitInvitation}>
            <label class="grid gap-2 text-sm font-medium">Email address<input class="form-control" required type="email" autocomplete="email" placeholder="friend@example.com" value={inviteEmail()} onInput={(event) => setInviteEmail(event.currentTarget.value)} /></label>
            <Button type="submit">Send invite</Button>
            <Show when={inviteMessage()}><p class="text-sm text-muted-foreground md:col-span-2">{inviteMessage()}</p></Show>
          </form>
        </Card>
      </Show>
      <Card class="overflow-hidden">
        <For each={visibleMembers()} fallback={<p class="px-6 py-12 text-center text-sm text-muted-foreground">No friends yet. Invite someone to begin a shared ledger.</p>}>
          {(member) => (
            <article class="flex items-center gap-3 border-b border-border px-5 py-4 last:border-0 sm:px-6">
              <Avatar name={member.displayName} />
              <div class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium">{member.displayName}</strong><span class="text-xs text-muted-foreground">{member.email ?? "Shared group member"}</span></div>
              <Show when={member.status === "active"} fallback={<Badge>Invited</Badge>}><Badge class="border-emerald-200 bg-emerald-50 text-emerald-700"><CheckCircle2 size={12} class="mr-1" /> Active</Badge></Show>
            </article>
          )}
        </For>
      </Card>
    </div>
  );
}

function ActivityView() {
  return (
    <div class="page-enter space-y-6">
      <header><h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Activity</h1><p class="mt-1 text-sm text-muted-foreground">A record of changes to your ledger.</p></header>
      <Card class="overflow-hidden">
        <For each={appStore.expenses()} fallback={<p class="px-6 py-12 text-center text-sm text-muted-foreground">Activity appears after your first expense.</p>}>
          {(expense) => (
            <article class="flex gap-3 border-b border-border px-5 py-4 last:border-0 sm:px-6">
              <span class="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
              <div class="min-w-0 flex-1"><strong class="block text-sm font-medium">{expense.description} was added</strong><p class="mt-0.5 text-xs text-muted-foreground">{money(expense.amountMinor, expense.currency)} · {expense.syncStatus === "pending" ? "Waiting to sync" : "Accepted by ledger"}</p></div>
              <time class="shrink-0 text-xs text-muted-foreground">{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(expenseDate(expense.expenseDate))}</time>
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
    { icon: ReceiptText, title: "Receipt scanning", detail: "Planned after the core ledger" },
  ];
  return (
    <div class="page-enter space-y-6">
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
  const [selectedGroupId, setSelectedGroupId] = createSignal<string>();
  const [toastVisible, setToastVisible] = createSignal(false);
  onMount(() => void initializeStore(props.actorId));
  createEffect(() => {
    if (!selectedGroupId() && appStore.groups()[0]) setSelectedGroupId(appStore.groups()[0]!.id);
  });
  const displayName = createMemo(() => appStore.members().find((member) => member.userId === props.actorId)?.displayName ?? "Your account");
  const tabs = [
    { id: "groups" as const, label: "Home", icon: House },
    { id: "friends" as const, label: "People", icon: UsersRound },
    { id: "activity" as const, label: "Activity", icon: Activity },
    { id: "account" as const, label: "Settings", icon: CircleUserRound },
  ];

  function showSavedToast(): void {
    setToastVisible(true);
    window.setTimeout(() => setToastVisible(false), 3200);
  }

  return (
    <div class="min-h-dvh bg-background text-foreground md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside class="hidden min-h-dvh border-r border-border bg-card md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div class="flex h-16 items-center gap-2.5 border-b border-border px-5"><BrandMark size={30} /><strong class="text-sm font-semibold">Expenses</strong></div>
        <nav class="grid gap-1 p-3" aria-label="Primary navigation">
          <For each={tabs}>{(item) => (
            <Button variant="ghost" class="nav-item w-full justify-start" classList={{ "bg-muted text-foreground": tab() === item.id }} onClick={() => setTab(item.id)}>
              <item.icon size={17} /> {item.label}
            </Button>
          )}</For>
        </nav>
        <div class="mt-auto border-t border-border p-3"><ConnectionBadge /><p class="px-2 pt-1 text-xs leading-5 text-muted-foreground">Expenses save on this device before syncing.</p></div>
      </aside>

      <div class="min-w-0">
        <header class="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur md:hidden">
          <div class="flex items-center gap-2"><BrandMark size={28} /><strong class="text-sm font-semibold">Expenses</strong></div>
          <ConnectionBadge />
        </header>
        <main class="mx-auto w-full max-w-6xl px-4 py-6 pb-24 sm:px-6 sm:py-8 md:px-8 md:pb-10 lg:px-10">
          <Switch>
            <Match when={tab() === "friends"}><FriendsView actorId={props.actorId} activeGroupId={selectedGroupId()} /></Match>
            <Match when={tab() === "groups"}><GroupsView activeGroupId={selectedGroupId()} onSelectGroup={setSelectedGroupId} onAddExpense={(groupId) => { if (groupId) setSelectedGroupId(groupId); setComposerOpen(true); }} /></Match>
            <Match when={tab() === "activity"}><ActivityView /></Match>
            <Match when={tab() === "account"}><AccountView displayName={displayName()} /></Match>
          </Switch>
        </main>
      </div>

      <nav class="fixed inset-x-0 bottom-0 z-30 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-4 border-t border-border bg-card px-2 pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Primary navigation">
        <For each={tabs}>{(item) => (
          <button class="nav-item grid place-items-center content-center gap-1 text-[11px] font-medium text-muted-foreground" classList={{ "text-primary": tab() === item.id }} onClick={() => setTab(item.id)}>
            <item.icon size={19} stroke-width={tab() === item.id ? 2.5 : 2} /><span>{item.label}</span>
          </button>
        )}</For>
      </nav>
      <Show when={toastVisible()}>
        <div class="toast-enter fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-4 py-2.5 text-sm font-medium text-background shadow-lg md:bottom-6">
          <CheckCircle2 size={16} /> Expense added
        </div>
      </Show>
      <ExpenseComposer open={composerOpen()} actorId={props.actorId} initialGroupId={selectedGroupId()} onOpenChange={setComposerOpen} onSaved={showSavedToast} />
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
          <div class="mb-6"><span class="mb-4 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><LockKeyhole size={18} /></span><h1 class="text-xl font-semibold tracking-tight">Sign in</h1><p class="mt-1.5 text-sm leading-6 text-muted-foreground">Enter your invited email and we’ll send you a secure sign-in link.</p></div>
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
