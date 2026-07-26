import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  ChevronRight,
  CircleUserRound,
  Cloud,
  CloudOff,
  FolderHeart,
  House,
  LockKeyhole,
  LogOut,
  Mail,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UsersRound,
  UserPlus,
  WalletCards,
} from "lucide-solid";
import { For, Match, Show, Switch, createMemo, createResource, createSignal, onMount } from "solid-js";
import { BrandMark } from "./components/BrandMark";
import { ExpenseComposer } from "./components/ExpenseComposer";
import { inviteGroupMember } from "./lib/api";
import { authClient, getOfflineActorId, signOutAndClearLocalLedger } from "./lib/auth";
import { appStore, initializeStore } from "./lib/store";

type Tab = "friends" | "groups" | "activity" | "account";

function money(amountMinor: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function signedMoney(amountMinor: number, currency = "USD"): string {
  if (amountMinor === 0) return money(0, currency);
  return `${amountMinor > 0 ? "+" : "−"}${money(Math.abs(amountMinor), currency)}`;
}

function ConnectionBadge() {
  const pending = createMemo(() => appStore.expenses().filter((expense) => expense.syncStatus === "pending").length);
  return (
    <button class="connection-badge" onClick={() => void appStore.sync()} title={appStore.connectionMessage()}>
      <Switch>
        <Match when={appStore.connection() === "online"}>
          <Cloud size={15} /> <span>{pending() ? `${pending()} syncing` : "Synced"}</span>
        </Match>
        <Match when={appStore.connection() === "connecting"}>
          <RefreshCw class="spin" size={15} /> <span>Checking</span>
        </Match>
        <Match when={true}>
          <CloudOff size={15} /> <span>{pending() ? `${pending()} on device` : "Offline"}</span>
        </Match>
      </Switch>
    </button>
  );
}

function ExpenseList() {
  const activeCount = createMemo(() => appStore.expenses().filter((expense) => expense.status === "active").length);
  return (
    <section class="ledger-card expense-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Latest</p>
          <h2>Recent expenses</h2>
        </div>
        <span class="count-label">{activeCount()} {activeCount() === 1 ? "entry" : "entries"}</span>
      </div>
      <Show
        when={appStore.expenses().length > 0}
        fallback={
          <div class="empty-state">
            <ReceiptText size={30} />
            <h3>Your ledger is ready</h3>
            <p>Add the first shared expense—even if the server is offline.</p>
          </div>
        }
      >
        <div class="expense-list">
          <For each={appStore.expenses()}>
            {(expense) => (
              <article class="expense-row" classList={{ voided: expense.status === "voided" }}>
                <div class="date-tile">
                  <span>{new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(`${expense.expenseDate}T12:00:00`))}</span>
                  <strong>{new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(new Date(`${expense.expenseDate}T12:00:00`))}</strong>
                </div>
                <div class="expense-copy">
                  <span class="category-icon"><ReceiptText size={16} /></span>
                  <div><strong>{expense.description}</strong><span>{expense.category}</span></div>
                </div>
                <div class="expense-impact" classList={{ positive: expense.yourNetMinor > 0, negative: expense.yourNetMinor < 0 }}>
                  <strong>{money(expense.amountMinor, expense.currency)}</strong>
                  <span>
                    {expense.syncStatus === "pending" ? "on device" : expense.yourNetMinor === 0 ? "your share" : expense.yourNetMinor > 0 ? `you lent ${money(expense.yourNetMinor, expense.currency)}` : `you owe ${money(-expense.yourNetMinor, expense.currency)}`}
                  </span>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function GroupsView(props: { onAddExpense(): void }) {
  const net = createMemo(() => appStore.expenses().reduce((sum, expense) => expense.status === "active" ? sum + expense.yourNetMinor : sum, 0));
  const owed = createMemo(() => appStore.expenses().reduce((sum, expense) => expense.status === "active" && expense.yourNetMinor > 0 ? sum + expense.yourNetMinor : sum, 0));
  const owing = createMemo(() => appStore.expenses().reduce((sum, expense) => expense.status === "active" && expense.yourNetMinor < 0 ? sum - expense.yourNetMinor : sum, 0));
  return (
    <>
      <header class="page-heading">
        <div>
          <p class="eyebrow">Overview</p>
          <h1>Shared money, sorted.</h1>
          <p>A calm view of what is settled and what still needs attention.</p>
        </div>
        <button class="primary-action" onClick={props.onAddExpense}><Plus size={18} /> Add expense</button>
      </header>

      <section class="balance-overview">
        <div class="balance-primary">
          <div class="balance-label"><WalletCards size={18} /><span>Total balance</span></div>
          <strong classList={{ positive: net() > 0, negative: net() < 0 }}>{signedMoney(net())}</strong>
          <p>{net() === 0 ? "Everything is settled up." : net() > 0 ? "Overall, your friends owe you." : "Overall, you owe across your groups."}</p>
        </div>
        <div class="balance-breakdown">
          <article>
            <span class="metric-icon owed"><ArrowDownLeft size={18} /></span>
            <div><small>You are owed</small><strong>{money(owed())}</strong></div>
          </article>
          <article>
            <span class="metric-icon owe"><ArrowUpRight size={18} /></span>
            <div><small>You owe</small><strong>{money(owing())}</strong></div>
          </article>
        </div>
      </section>

      <section class="group-strip">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Spaces</p>
            <h2>Your groups</h2>
          </div>
          <span class="count-label">{appStore.groups().length} active</span>
        </div>
        <div class="group-grid">
          <For each={appStore.groups()} fallback={<div class="group-skeleton">Preparing your first group…</div>}>
            {(group) => {
              const members = createMemo(() => appStore.members().filter((member) => member.groupId === group.id));
              const groupNet = createMemo(() => appStore.expenses().reduce((sum, expense) => expense.groupId === group.id && expense.status === "active" ? sum + expense.yourNetMinor : sum, 0));
              return (
                <article class="group-card">
                  <div class="group-cover">
                    <span class="group-mark"><FolderHeart size={22} /></span>
                    <div class="avatar-stack">
                      <For each={members().slice(0, 3)}>{(member) => <span>{member.displayName.slice(0, 1).toUpperCase()}</span>}</For>
                    </div>
                  </div>
                  <div class="group-card-body">
                    <div class="group-copy"><strong>{group.name}</strong><span>{members().length} people · {group.settlementCurrency}</span></div>
                    <div class="group-balance" classList={{ positive: groupNet() > 0, negative: groupNet() < 0 }}>
                      <small>{groupNet() === 0 ? "settled" : groupNet() > 0 ? "you get back" : "you owe"}</small>
                      <strong>{money(Math.abs(groupNet()), group.settlementCurrency)}</strong>
                    </div>
                  </div>
                </article>
              );
            }}
          </For>
        </div>
      </section>
      <ExpenseList />
    </>
  );
}

function FriendsView(props: { actorId: string }) {
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [inviteName, setInviteName] = createSignal("");
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteMessage, setInviteMessage] = createSignal("");

  async function submitInvitation(event: SubmitEvent) {
    event.preventDefault();
    const group = appStore.groups()[0];
    if (!group) return setInviteMessage("Create or sync a group before inviting someone.");
    setInviteMessage("Sending invitation…");
    try {
      await inviteGroupMember(group.id, { displayName: inviteName(), email: inviteEmail() });
      setInviteMessage("Invitation queued. They can join through their verified email.");
      setInviteName("");
      setInviteEmail("");
      await appStore.sync();
    } catch (error) {
      setInviteMessage(error instanceof Error ? error.message : "Invitation failed");
    }
  }

  return (
    <section class="page-section">
      <header class="page-heading compact">
        <div><p class="eyebrow">People</p><h1>Friends</h1><p>Everyone sharing a ledger with you.</p></div>
        <button class="primary-action secondary" onClick={() => setInviteOpen((open) => !open)}><UserPlus size={17} /> Invite</button>
      </header>
      <Show when={inviteOpen()}>
        <form class="invite-form" onSubmit={submitInvitation}>
          <label><span>Name</span><input required maxlength="100" value={inviteName()} onInput={(event) => setInviteName(event.currentTarget.value)} /></label>
          <label><span>Email</span><input required type="email" value={inviteEmail()} onInput={(event) => setInviteEmail(event.currentTarget.value)} /></label>
          <button class="save-expense" type="submit">Queue invitation</button>
          <Show when={inviteMessage()}><p class="invite-message">{inviteMessage()}</p></Show>
        </form>
      </Show>
      <div class="ledger-card spacious friend-list">
        <For each={appStore.members().filter((member) => member.userId !== props.actorId)} fallback={<div class="empty-state"><UsersRound size={28} /><h3>No friends yet</h3><p>Invite someone to begin a shared ledger.</p></div>}>
          {(member) => (
            <article class="friend-row">
              <span class="avatar large">{member.displayName.slice(0, 1).toUpperCase()}</span>
              <div><strong>{member.displayName}</strong><span>Shared group member</span></div>
              <span class="friend-state"><BadgeCheck size={15} /> Active</span>
            </article>
          )}
        </For>
      </div>
    </section>
  );
}

function ActivityView() {
  return (
    <section class="page-section">
      <header class="page-heading compact"><div><p class="eyebrow">History</p><h1>Activity</h1><p>Every accepted change, in order.</p></div></header>
      <div class="ledger-card spacious timeline">
        <For each={appStore.expenses()} fallback={<p class="muted">Activity appears after your first expense.</p>}>
          {(expense) => (
            <article><span class="timeline-dot" /><div><strong>{expense.description} was added</strong><p>{money(expense.amountMinor, expense.currency)} · {expense.syncStatus === "pending" ? "waiting to sync" : "accepted by ledger"}</p></div><time>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${expense.expenseDate}T12:00:00`))}</time></article>
          )}
        </For>
      </div>
    </section>
  );
}

function AccountView(props: { displayName: string }) {
  return (
    <section class="page-section account-grid">
      <header class="page-heading compact"><div><p class="eyebrow">Settings</p><h1>Your account</h1><p>Privacy, device trust, and offline storage.</p></div></header>
      <section class="profile-card">
        <span class="profile-avatar">{props.displayName.slice(0, 1).toUpperCase()}</span>
        <div><p class="eyebrow light">Signed in</p><h2>{props.displayName}</h2><p>This device can keep recording entries while the Mac is unavailable.</p></div>
      </section>
      <section class="ledger-card settings-list">
        <article><span class="setting-icon"><ShieldCheck size={20} /></span><div><strong>Signed operations</strong><span>P-256 device key active</span></div><ChevronRight size={18} /></article>
        <article><span class="setting-icon"><Cloud size={20} /></span><div><strong>Local-first storage</strong><span>IndexedDB ledger retained on this device</span></div><ChevronRight size={18} /></article>
        <article><span class="setting-icon"><ReceiptText size={20} /></span><div><strong>Receipt scanning</strong><span>Planned after the core ledger</span></div><ChevronRight size={18} /></article>
        <Show when={!import.meta.env.DEV}>
          <button class="sign-out" onClick={() => void signOutAndClearLocalLedger()}><LogOut size={19} /> Sign out and clear this device</button>
        </Show>
      </section>
    </section>
  );
}

function AuthenticatedApp(props: { actorId: string }) {
  const [tab, setTab] = createSignal<Tab>("groups");
  const [composerOpen, setComposerOpen] = createSignal(false);
  onMount(() => void initializeStore(props.actorId));
  const displayName = createMemo(() => appStore.members().find((member) => member.userId === props.actorId)?.displayName ?? "Your account");

  const tabs = [
    { id: "groups" as const, label: "Home", icon: House },
    { id: "friends" as const, label: "People", icon: UsersRound },
    { id: "activity" as const, label: "Activity", icon: Activity },
    { id: "account" as const, label: "Settings", icon: CircleUserRound },
  ];

  return (
    <div class="app-shell">
      <aside class="side-rail">
        <a class="brand" href="/" aria-label="Expenses home"><BrandMark /><div><strong>Expenses</strong><span>Shared fairly</span></div></a>
        <div class="rail-intro"><span>Private shared ledger</span><strong>Money between friends, without the awkward.</strong></div>
        <nav class="side-nav" aria-label="Primary navigation">
          <For each={tabs}>
            {(item) => (
              <button classList={{ active: tab() === item.id }} onClick={() => setTab(item.id)}>
                <item.icon size={19} stroke-width={tab() === item.id ? 2.5 : 2} />
                <span>{item.label}</span>
              </button>
            )}
          </For>
        </nav>
        <div class="rail-status"><ConnectionBadge /><p>Entries save to this device first.</p></div>
      </aside>

      <header class="mobile-topbar">
        <a class="brand" href="/" aria-label="Expenses home"><BrandMark /><div><strong>Expenses</strong><span>Shared fairly</span></div></a>
        <ConnectionBadge />
      </header>
      <main class="app-content">
        <Switch>
          <Match when={tab() === "friends"}><FriendsView actorId={props.actorId} /></Match>
          <Match when={tab() === "groups"}><GroupsView onAddExpense={() => setComposerOpen(true)} /></Match>
          <Match when={tab() === "activity"}><ActivityView /></Match>
          <Match when={tab() === "account"}><AccountView displayName={displayName()} /></Match>
        </Switch>
      </main>

      <button class="fab" onClick={() => setComposerOpen(true)} aria-label="Add expense"><Plus size={23} /><span>Add expense</span></button>
      <nav class="bottom-nav" aria-label="Primary navigation">
        <For each={tabs}>
          {(item) => (
            <button classList={{ active: tab() === item.id }} onClick={() => setTab(item.id)}>
              <item.icon size={21} stroke-width={tab() === item.id ? 2.5 : 2} />
              <span>{item.label}</span>
            </button>
          )}
        </For>
      </nav>
      <ExpenseComposer open={composerOpen()} onOpenChange={setComposerOpen} />
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
        errorCallbackURL: `${window.location.origin}/?auth=failed`,
      });
      setMessage(result.error ? result.error.message ?? "Could not send the link." : "If this address is invited, a secure link is on its way and expires in 10 minutes.");
    } catch {
      setMessage("The server is unavailable. Previously signed-in devices can continue offline.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="auth-shell">
      <section class="auth-story">
        <a class="auth-brand" href="/" aria-label="Expenses home"><BrandMark size={48} /><strong>Expenses</strong></a>
        <div class="auth-pitch">
          <p class="eyebrow light">Shared spending, rethought</p>
          <h1>Money between friends should feel simple.</h1>
          <p>Log it in seconds, split it fairly, and carry on. Your ledger stays useful even when the server is offline.</p>
        </div>
        <div class="auth-proof">
          <span><LockKeyhole size={17} /> Invite-only</span>
          <span><Sparkles size={17} /> Fast by design</span>
          <span><CloudOff size={17} /> Works offline</span>
        </div>
      </section>
      <section class="auth-card">
        <span class="auth-lock"><LockKeyhole size={21} /></span>
        <p class="eyebrow">Welcome back</p>
        <h2>Open your ledger</h2>
        <p>Use your invited email. We’ll send one secure, single-use link.</p>
        <form onSubmit={requestLink}>
          <label><span>Email address</span><div class="auth-input"><Mail size={18} /><input required type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} /></div></label>
          <button class="save-expense" type="submit" disabled={busy()}>{busy() ? "Sending…" : "Send secure link"}</button>
        </form>
        <Show when={message()}><p class="auth-message">{message()}</p></Show>
        <small>No password. No ads. New accounts are invite-only.</small>
      </section>
    </main>
  );
}

export default function App() {
  const session = authClient.useSession();
  const [offlineActorId] = createResource(getOfflineActorId);
  const actorId = createMemo(() => import.meta.env.DEV ? "dev-user" : session().data?.user.id ?? offlineActorId());
  return (
    <Show when={(!session().isPending && !offlineActorId.loading) || import.meta.env.DEV} fallback={<main class="auth-shell"><BrandMark size={70} /></main>}>
      <Show when={actorId()} keyed fallback={<AuthScreen />}>
        {(id) => <AuthenticatedApp actorId={id} />}
      </Show>
    </Show>
  );
}
