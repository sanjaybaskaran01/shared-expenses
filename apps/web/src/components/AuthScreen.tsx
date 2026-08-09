import LockKeyhole from "lucide-solid/icons/lock-keyhole";
import Mail from "lucide-solid/icons/mail";
import { Show, createResource, createSignal } from "solid-js";
import {
  claimContactInvitation,
  getAuthCapabilities,
  previewImportClaim,
  requestImportClaimMagicLink,
  reserveImportClaim,
} from "../lib/api";
import { authClient } from "../lib/auth";
import { inviteTokenFromHash } from "../lib/contact-invites";
import { migrationClaimFromHash } from "../lib/migration-claim-link";
import { BrandMark } from "./BrandMark";
import { Button, Card } from "./ui";

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

export function AuthScreen() {
  const search = new URLSearchParams(location.search);
  const invitationToken = inviteTokenFromHash();
  const migrationClaimToken = migrationClaimFromHash();
  const initialAuthFailed = search.get("auth") === "failed";
  const [email, setEmail] = createSignal(search.get("email") ?? "");
  const [message, setMessage] = createSignal(initialAuthFailed
    ? "Unable to sign in. Use the Google account or email address that received the invitation."
    : "");
  const [messageTone, setMessageTone] = createSignal<"status" | "error">(initialAuthFailed ? "error" : "status");
  const [busy, setBusy] = createSignal<"google" | "email" | null>(null);
  let emailInputRef: HTMLInputElement | undefined;
  const [capabilities] = createResource(async () => {
    try { return await getAuthCapabilities(); }
    catch { return { google: false, magicLink: true }; }
  });
  const [migrationPreview] = createResource(
    () => migrationClaimToken,
    async (token) => previewImportClaim(token),
  );

  async function signInWithGoogle() {
    setBusy("google");
    setMessage("");
    setMessageTone("status");
    try {
      if (migrationClaimToken) {
        if (!emailInputRef?.checkValidity()) {
          setMessageTone("error");
          setMessage("Enter the email address you’ll use with Google.");
          emailInputRef?.focus();
          return;
        }
        await reserveImportClaim(migrationClaimToken, email().trim());
      }
      const claimFailureUrl = migrationClaimToken
        ? `${location.origin}/?auth=failed#${new URLSearchParams({ migrationClaim: migrationClaimToken })}`
        : `${location.origin}/?auth=failed`;
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: migrationClaimToken ? location.href : location.origin,
        newUserCallbackURL: migrationClaimToken ? location.href : location.origin,
        errorCallbackURL: claimFailureUrl,
      });
      if (result.error) {
        setMessageTone("error");
        setMessage(result.error.message ?? "Unable to start Google sign-in. Try again or use an email link.");
      }
    } catch {
      setMessageTone("error");
      setMessage("Unable to reach Tallied. Try an email link, or continue on a device where you’re already signed in.");
    } finally {
      setBusy(null);
    }
  }

  async function requestLink(event: SubmitEvent) {
    event.preventDefault();
    if (migrationClaimToken && !emailInputRef?.checkValidity()) {
      setMessageTone("error");
      setMessage("Enter a valid email address first.");
      emailInputRef?.focus();
      return;
    }
    setBusy("email");
    setMessage("");
    setMessageTone("status");
    try {
      if (invitationToken) {
        await claimContactInvitation(invitationToken, email().trim());
        setMessage("Check your inbox. The link verifies your email, signs you in, and connects you to your inviter.");
        return;
      }
      if (migrationClaimToken) {
        await requestImportClaimMagicLink(migrationClaimToken, email().trim());
        setMessage("Check your inbox. The link verifies your email and returns you to the connection review.");
        return;
      }
      const result = await authClient.signIn.magicLink({
        email: email().trim(),
        callbackURL: location.origin,
        newUserCallbackURL: location.origin,
        errorCallbackURL: `${location.origin}/?auth=failed`,
      });
      setMessageTone(result.error ? "error" : "status");
      setMessage(result.error ? (result.error.message ?? "Unable to send the link. Try again.") : "Check your inbox. The secure link signs you in.");
    } catch {
      setMessageTone("error");
      setMessage("Unable to reach Tallied. Devices that are already signed in can continue offline.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main class="auth-shell grid min-h-dvh place-items-center px-4 py-10">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex items-center justify-center gap-2.5 text-white"><BrandMark size={38} /><strong class="brand-wordmark text-lg">Tallied</strong></div>
        <Card class="glass-auth rounded-xl p-6 sm:p-8">
          <span class="mb-5 grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary"><LockKeyhole size={19} /></span>
          <h1 class="text-2xl font-semibold tracking-tight">{invitationToken ? "Join Tallied" : migrationClaimToken ? "Connect your history" : "Sign in to Tallied"}</h1>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">
            {invitationToken
              ? "Choose the email you want to use. The link verifies it and signs you in."
              : migrationClaimToken
                ? migrationPreview()
                  ? "Someone imported shared Splitwise history. Sign in to connect it to your Tallied account."
                  : migrationPreview.error
                    ? "This secure link has expired or is no longer available. Ask the person who imported the history for a new link."
                    : "Checking this secure link…"
                : "Sign in with the Google account or email address that was invited."}
          </p>
          <Show when={migrationPreview()}><p class="mt-3 text-xs text-muted-foreground">Single-use link · expires {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(migrationPreview()!.expiresAt))}</p></Show>
          <Show when={migrationClaimToken}>
            <label class="mt-5 grid gap-2 text-sm font-medium">Email address<div class="relative"><Mail class="absolute left-3 top-3 text-muted-foreground" size={17} /><input ref={emailInputRef} class="form-control h-12 pl-9" required type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} placeholder="you@example.com" /></div><span class="text-xs font-normal leading-5 text-muted-foreground">Use the same email for Google or the email link. Connecting gives this account access to the imported groups. Tallied tracks balances; it never moves money.</span></label>
          </Show>
          <Show when={capabilities()?.google && !invitationToken}>
            <Button class="mt-6 h-12 w-full rounded-xl" type="button" variant="secondary" disabled={busy() !== null || Boolean(migrationClaimToken && !migrationPreview())} onClick={() => void signInWithGoogle()}><GoogleMark />{busy() === "google" ? "Signing in…" : "Continue with Google"}</Button>
            <div class="auth-divider" aria-hidden="true"><span>or use email</span></div>
          </Show>
          <Show when={capabilities()?.magicLink} fallback={<p class="mt-5 rounded-xl border border-border bg-muted/60 p-3 text-sm text-muted-foreground">Email sign-in is unavailable on this Tallied installation.</p>}>
            <form class="mt-6 grid gap-4" onSubmit={requestLink}>
              <Show when={!migrationClaimToken}><label class="grid gap-2 text-sm font-medium">Email address<div class="relative"><Mail class="absolute left-3 top-3 text-muted-foreground" size={17} /><input ref={emailInputRef} class="form-control h-12 pl-9" required type="email" autocomplete="email" value={email()} onInput={(event) => setEmail(event.currentTarget.value)} placeholder="you@example.com" /></div></label></Show>
              <Button class="h-12 w-full rounded-xl" type="submit" disabled={busy() !== null || Boolean(migrationClaimToken && !migrationPreview())}>{busy() === "email" ? "Sending…" : invitationToken ? "Send link to join" : migrationClaimToken ? "Send secure link" : "Send sign-in link"}</Button>
            </form>
          </Show>
          <Show when={message()}><p class="mt-4 rounded-xl border border-border bg-muted/60 p-3 text-sm text-muted-foreground" role={messageTone() === "error" ? "alert" : "status"} aria-live={messageTone() === "error" ? "assertive" : "polite"}>{message()}</p></Show>
          <p class="mt-5 text-center text-xs text-muted-foreground">No password · Secure sign-in · Works offline</p>
        </Card>
      </div>
    </main>
  );
}
