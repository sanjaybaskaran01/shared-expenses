// Bump this name whenever a release must invalidate an installed app shell.
// Cache cleanup intentionally leaves IndexedDB (the offline ledger) untouched.
const CACHE_NAME = "tallied-shell-v7";
const workerUrl = new URL(self.location.href || "/tally-sw.js", self.location.origin);
const configuredApiUrl = workerUrl.searchParams.get("api");
const API_BASE_URL = (() => {
  try {
    const candidate = new URL(configuredApiUrl || self.location.origin, self.location.origin);
    return candidate.protocol === "https:" || candidate.hostname === "localhost"
      ? candidate.origin
      : self.location.origin;
  } catch {
    return self.location.origin;
  }
})();
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/brand-mark.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(async () => (await caches.match("/")) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" ? payload.title : "Tallied changed";
  const body = typeof payload.body === "string" ? payload.body : "Open Tallied to see what changed.";
  const url = typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/?view=activity";
  const tag = typeof payload.tag === "string" ? payload.tag : "tallied-activity";
  const badgeCount = Number.isSafeInteger(payload.badgeCount) && payload.badgeCount > 0 ? payload.badgeCount : 1;
  const setBadge = typeof self.navigator?.setAppBadge === "function"
    ? self.navigator.setAppBadge(badgeCount).catch(() => undefined)
    : Promise.resolve();
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/apple-touch-icon.png",
      tag,
      renotify: true,
      data: { url },
    }),
    setBadge,
  ]));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const oldSubscription = event.oldSubscription;
    const applicationServerKey = oldSubscription?.options?.applicationServerKey;
    if (!oldSubscription?.endpoint || !applicationServerKey) return;
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    const serialized = subscription.toJSON();
    if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys?.auth) return;
    await fetch(`${API_BASE_URL}/api/v1/push/subscriptions/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldEndpoint: oldSubscription.endpoint,
        subscription: {
          endpoint: serialized.endpoint,
          expirationTime: serialized.expirationTime ?? null,
          keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth },
        },
      }),
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetPath = typeof event.notification.data?.url === "string"
    ? event.notification.data.url
    : "/?view=activity";
  const targetUrl = new URL(targetPath, self.location.origin).toString();
  event.waitUntil((async () => {
    if (typeof self.navigator?.clearAppBadge === "function") {
      await self.navigator.clearAppBadge().catch(() => undefined);
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      existing.postMessage({ type: "tallied:notification-click", url: targetUrl });
      await existing.focus();
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});
