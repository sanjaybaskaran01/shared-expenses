import { createSignal } from "solid-js";

export interface ReleaseInfo {
  version: string;
  commit: string;
  builtAt: string;
}

const POLL_INTERVAL_MS = 30 * 60_000; // 30 min while foregrounded — bounded, no battery/data abuse

const [runningRelease, setRunningRelease] = createSignal<ReleaseInfo | undefined>(undefined);
const [updateAvailable, setUpdateAvailable] = createSignal(false);

export function parseReleaseInfo(value: unknown): ReleaseInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || typeof record.commit !== "string" || typeof record.builtAt !== "string") {
    return undefined;
  }
  return { version: record.version, commit: record.commit, builtAt: record.builtAt };
}

export function hasNewerRelease(baseline: ReleaseInfo | undefined, latest: ReleaseInfo | undefined): boolean {
  if (!baseline || !latest) return false;
  return latest.commit !== baseline.commit;
}

async function fetchRelease(): Promise<ReleaseInfo | undefined> {
  try {
    const response = await fetch("/release.json", { cache: "no-store" });
    if (!response.ok) return undefined;
    return parseReleaseInfo(await response.json());
  } catch {
    return undefined;
  }
}

function watchServiceWorker(registration: ServiceWorkerRegistration): void {
  const flagIfUpdateInstalled = (worker: ServiceWorker | null) => {
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) setUpdateAvailable(true);
    });
  };
  if (registration.waiting && navigator.serviceWorker.controller) setUpdateAvailable(true);
  flagIfUpdateInstalled(registration.installing);
  registration.addEventListener("updatefound", () => flagIfUpdateInstalled(registration.installing));
  navigator.serviceWorker.addEventListener("controllerchange", () => setUpdateAvailable(true));
}

export async function initReleaseWatch(registration?: ServiceWorkerRegistration): Promise<void> {
  const baseline = await fetchRelease();
  setRunningRelease(baseline);
  if (registration) watchServiceWorker(registration);

  const checkForNewer = async () => {
    if (updateAvailable()) return;
    void registration?.update().catch(() => {});
    const latest = await fetchRelease();
    if (hasNewerRelease(baseline, latest)) setUpdateAvailable(true);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForNewer();
  });
  window.addEventListener("focus", () => void checkForNewer());
  window.setInterval(() => {
    if (document.visibilityState === "visible") void checkForNewer();
  }, POLL_INTERVAL_MS);
}

export function reloadForUpdate(): void {
  // tally-sw.js already calls skipWaiting()+clients.claim() on its own, so a
  // plain reload is enough to pick up the new shell/assets — no postMessage
  // round-trip to the worker required.
  location.reload();
}

export const releaseWatch = { runningRelease, updateAvailable };
