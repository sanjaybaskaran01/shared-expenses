import { createAuthClient } from "better-auth/solid";
import { magicLinkClient } from "better-auth/client/plugins";
import { apiBaseUrl } from "./api";
import { localDb } from "./db";

export const authClient = createAuthClient({
  baseURL: apiBaseUrl,
  fetchOptions: { credentials: "include" },
  plugins: [magicLinkClient()],
});

export async function signOutAndClearLocalLedger(): Promise<void> {
  try {
    await authClient.signOut();
  } finally {
    await localDb.delete();
    window.location.assign("/");
  }
}

export async function getOfflineActorId(): Promise<string | undefined> {
  const actorId = (await localDb.devices.get("current"))?.actorId;
  return actorId && actorId !== "pending-authentication" ? actorId : undefined;
}
