import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  CircleUserRound,
  Cloud,
  CloudOff,
  FolderHeart,
  LogOut,
  Mail,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  UserPlus,
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
    <div class="ledger-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Ledger</p>
          <h2>Recent expenses</h2>
        </div>
        <span>{activeCount()} {activeCount() === 1 ? "entry" : "entries"}</span>
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
                <div class="category-icon"><ReceiptText size={19} /></div>
                <div class="expense-copy">
                  <div><strong>{expense.description}</strong><span>{expense.category}</span></div>
                  <small>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(`${expense.expenseDate}T12:00:00`))}</small>
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
    </div>
  );
}

function GroupsView() {
  const net = createMemo(() => appStore.expenses().reduce((sum, expense) => expense.status === "active" ? sum + expense.yourNetMinor : sum, 0));
  return (
    <>
      <section class="balance-hero">
        <p class="eyebrow light">Across your groups</p>
        <div class="balance-main">
          <div>
            <span>{net() >= 0 ? "You are owed" : "You owe"}</span>
            <strong>{money(Math.abs(net()))}</strong>
          </div>
          <div class="balance-symbol" classList={{ owed: net() >= 0 }}>
            {net() >= 0 ? <ArrowDownLeft size={28} /> : <ArrowUpRight size={28} />}
          </div>
        </div>
        <p>Each currency stays separate until you explicitly convert it.</p>
      </section>

      <section class="group-strip">
        <div class="section-heading">
          <div><p class="eyebrow">Your spaces</p><h2>Groups</h2></div>
        </div>
        <div class="group-grid">
          <For each={appStore.groups()} fallback={<div class="group-skeleton">Preparing your first group…</div>}>
            {(group) => (
              <article class="group-card">
                <span class="group-mark"><FolderHeart size={22} /></span>
                <div><strong>{group.name}</strong><span>{appStore.members().filter((member) => member.groupId === group.id).length} people</span></div>
                <b>{group.settlementCurrency}</b>
              </article>
            )}
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
    <div class="ledger-card spacious">
      <div class="section-heading">
        <div><p class="eyebrow">People</p><h2>Friends</h2></div>
        <button class="small-action" onClick={() => setInviteOpen((open) => !open)}><UserPlus size={16} /> Invite</button>
      </div>
      <Show when={inviteOpen()}>
        <form class="invite-form" onSubmit={submitInvitation}>
          <label><span>Name</span><input required maxlength="100" value={inviteName()} onInput={(event) => setInviteName(event.currentTarget.value)} /></label>
          <label><span>Email</span><input required type="email" value={inviteEmail()} onInput={(event) => setInviteEmail(event.currentTarget.value)} /></label>
          <button class="save-expense" type="submit">Queue invitation</button>
          <Show when={inviteMessage()}><p class="invite-message">{inviteMessage()}</p></Show>
        </form>
      </Show>
      <div class="friend-list">
        <For each={appStore.members().filter((member) => member.userId !== props.actorId)} fallback={<p>No friends yet.</p>}>
          {(member) => (
            <article class="friend-row">
              <span class="avatar large">{member.displayName.slice(0, 1)}</span>
              <div><strong>{member.displayName}</strong><span>Shared group member</span></div>
              <span class="settled">Review ledger</span>
            </article>
          )}
        </For>
      </div>
    </div>
  );
}

function ActivityView() {
  return (
    <div class="ledger-card spacious">
      <div class="section-heading"><div><p class="eyebrow">Immutable history</p><h2>Activity</h2></div></div>
      <div class="timeline">
        <For each={appStore.expenses()} fallback={<p class="muted">Activity appears after your first expense.</p>}>
          {(expense) => (
            <article><span class="timeline-dot" /><div><strong>{expense.description} was added</strong><p>{money(expense.amountMinor, expense.currency)} · {expense.syncStatus === "pending" ? "waiting to sync" : "accepted by ledger"}</p></div></article>
          )}
        </For>
      </div>
    </div>
  );
}

function AccountView() {
  return (
    <div class="account-grid">
      <section class="profile-card">
        <BrandMark size={64} />
        <div><p class="eyebrow light">Trusted device</p><h2>Your Expenses account</h2><p>This phone can keep recording entries while the Mac is unavailable.</p></div>
      </section>
      <section class="ledger-card settings-list">
        <article><ShieldCheck size={21} /><div><strong>Signed operations</strong><span>P-256 device key active</span></div></article>
        <article><Cloud size={21} /><div><strong>Local-first storage</strong><span>IndexedDB ledger retained on this device</span></div></article>
        <article><ReceiptText size={21} /><div><strong>Receipt OCR</strong><span>Deferred for v1</span></div></article>
        <Show when={!import.meta.env.DEV}>
          <button class="sign-out" onClick={() => void signOutAndClearLocalLedger()}><LogOut size={19} /> Sign out and clear this device</button>
        </Show>
      </section>
    </div>
  );
}

function AuthenticatedApp(props: { actorId: string }) {
  const [tab, setTab] = createSignal<Tab>("groups");
  const [composerOpen, setComposerOpen] = createSignal(false);
  onMount(() => void initializeStore(props.actorId));

  const tabs = [
    { id: "friends" as const, label: "Friends", icon: UsersRound },
    { id: "groups" as const, label: "Groups", icon: FolderHeart },
    { id: "activity" as const, label: "Activity", icon: Activity },
    { id: "account" as const, label: "Account", icon: CircleUserRound },
  ];

  return (
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="Expenses home"><BrandMark /><div><strong>Expenses</strong><span>Shared fairly</span></div></a>
        <ConnectionBadge />
      </header>
      <main>
        <Switch>
          <Match when={tab() === "friends"}><FriendsView actorId={props.actorId} /></Match>
          <Match when={tab() === "groups"}><GroupsView /></Match>
          <Match when={tab() === "activity"}><ActivityView /></Match>
          <Match when={tab() === "account"}><AccountView /></Match>
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
      <section class="auth-card">
        <BrandMark size={70} />
        <p class="eyebrow">Private shared ledger</p>
        <h1>Sign in to Expenses</h1>
        <p>Enter the invited email address. We’ll send one secure, single-use link—no password to remember.</p>
        <form onSubmit={requestLink}>
          <label><span>Email address</span><div class="auth-input"><Mail size={18} /><input required type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} /></div></label>
          <button class="save-expense" type="submit" disabled={busy()}>{busy() ? "Sending…" : "Email me a secure link"}</button>
        </form>
        <Show when={message()}><p class="auth-message">{message()}</p></Show>
        <small>New accounts are invite-only. Previously signed-in devices can keep logging expenses while the server is offline.</small>
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
