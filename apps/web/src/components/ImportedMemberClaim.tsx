import Check from "lucide-solid/icons/check";
import Link2 from "lucide-solid/icons/link-2";
import LoaderCircle from "lucide-solid/icons/loader-circle";
import ShieldCheck from "lucide-solid/icons/shield-check";
import X from "lucide-solid/icons/x";
import { Show, createSignal } from "solid-js";
import {
  approveImportIdentityClaim,
  createImportClaimLink,
  getImportIdentities,
  rejectImportIdentityClaim,
} from "../lib/api";
import type { LocalMember } from "../lib/db";
import { appStore } from "../lib/store";

interface ImportedMemberClaimProps {
  member: LocalMember;
  onNotify(message: string): void;
}

export function ImportedMemberClaim(props: ImportedMemberClaimProps) {
  const [busy, setBusy] = createSignal(false);
  const [review, setReview] = createSignal<{ displayName: string; email: string }>();
  const claim = () => props.member.importClaim;

  async function sendLink(): Promise<void> {
    const current = claim();
    if (!current) return;
    setBusy(true);
    try {
      const link = await createImportClaimLink(current.batchId, current.identityId);
      const share = {
        title: `Connect ${props.member.displayName} on Tallied`,
        text: `Open this secure Tallied link to connect your imported Splitwise history.`,
        url: link.url,
      };
      if (navigator.share) {
        await navigator.share(share);
        props.onNotify("Secure account link shared");
      } else {
        await navigator.clipboard.writeText(`${share.text} ${share.url}`);
        props.onNotify("Secure account link copied");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      props.onNotify(error instanceof Error ? error.message : "Could not create the secure link");
    } finally {
      setBusy(false);
    }
  }

  async function loadReview(): Promise<void> {
    const current = claim();
    if (!current) return;
    setBusy(true);
    try {
      const { identities } = await getImportIdentities(current.batchId);
      const identity = identities.find(({ id }) => id === current.identityId);
      if (!identity?.claimant) throw new Error("The claim is no longer waiting for review");
      setReview({ displayName: identity.claimant.displayName, email: identity.claimant.email });
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : "Could not load the claim");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(approved: boolean): Promise<void> {
    const current = claim();
    if (!current) return;
    setBusy(true);
    try {
      if (approved) await approveImportIdentityClaim(current.identityId);
      else await rejectImportIdentityClaim(current.identityId);
      setReview(undefined);
      await appStore.sync();
      props.onNotify(approved ? `${props.member.displayName} is now connected` : "Claim rejected; the imported history remains private");
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : "Could not resolve the claim");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="import-member-claim" aria-labelledby={`claim-${props.member.userId}`}>
      <span class="import-member-claim-icon"><ShieldCheck size={18} /></span>
      <div class="min-w-0 flex-1">
        <strong id={`claim-${props.member.userId}`}>Connect {props.member.displayName}</strong>
        <p>
          <Show when={claim()?.status === "awaiting_owner"} fallback="Their imported history is safe, but it is not linked to their Tallied account yet.">
            A signed-in account asked to claim this imported history. Confirm it is the right person.
          </Show>
        </p>
        <Show when={review()}>{(claimant) => (
          <div class="import-claim-review" role="status">
            <span><b>{claimant().displayName || "Signed-in user"}</b><small>{claimant().email}</small></span>
            <button type="button" disabled={busy()} onClick={() => void resolve(false)}><X size={15} /> Not them</button>
            <button type="button" disabled={busy()} onClick={() => void resolve(true)}><Check size={15} /> Approve</button>
          </div>
        )}</Show>
      </div>
      <Show when={!review()}>
        <button class="import-claim-action" type="button" disabled={busy()} onClick={() => void (claim()?.status === "awaiting_owner" ? loadReview() : sendLink())}>
          <Show when={busy()} fallback={<><Link2 size={15} /> {claim()?.status === "awaiting_owner" ? "Review" : "Send link"}</>}>
            <LoaderCircle class="animate-spin" size={15} />
          </Show>
        </button>
      </Show>
    </section>
  );
}
