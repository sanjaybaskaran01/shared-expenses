export function inviteTokenFromHash(hash = window.location.hash): string | undefined {
  if (!hash.startsWith("#")) return undefined;
  const token = new URLSearchParams(hash.slice(1)).get("invite")?.trim();
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function clearInviteToken(): void {
  if (!inviteTokenFromHash()) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}

export type InvitationShareResult = "shared" | "copied" | "cancelled";

export async function shareInvitation(url: string): Promise<InvitationShareResult> {
  const text = "Join me on Tally to split shared expenses and keep balances clear.";
  if (navigator.share) {
    try {
      await navigator.share({ title: "Join me on Tally", text, url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // A browser may expose navigator.share but reject a particular payload.
    }
  }
  await navigator.clipboard.writeText(`${text}\n${url}`);
  return "copied";
}

interface ContactPickerEntry {
  name?: string[];
  tel?: string[];
}

interface ContactPickerNavigator extends Navigator {
  contacts?: {
    select(
      properties: Array<"name" | "tel">,
      options: { multiple: false },
    ): Promise<ContactPickerEntry[]>;
  };
}

export function contactPickerAvailable(): boolean {
  return typeof (navigator as ContactPickerNavigator).contacts?.select === "function";
}

export async function pickContactForMessage(): Promise<ContactPickerEntry | undefined> {
  const picker = (navigator as ContactPickerNavigator).contacts;
  if (!picker) return undefined;
  const [contact] = await picker.select(["name", "tel"], { multiple: false });
  return contact;
}

export function messageInvitation(url: string, phone = ""): void {
  const text = `Join me on Tally to split shared expenses: ${url}`;
  const recipient = phone.replace(/[^+\d]/g, "");
  // iOS accepts '&body=' for SMS composition; Android accepts '?body='.
  const separator = /iPad|iPhone|iPod/.test(navigator.userAgent) ? "&" : "?";
  window.location.assign(`sms:${recipient}${separator}body=${encodeURIComponent(text)}`);
}
