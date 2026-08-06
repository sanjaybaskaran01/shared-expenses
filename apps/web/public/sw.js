// Compatibility bridge for installs created before Tallied moved to /tally-sw.js.
// It removes only legacy app-shell caches; IndexedDB ledger data is never touched.
const LEGACY_SHELL_PREFIXES = ["tally-shell-", "tallied-shell-"];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(
        names
          .filter((name) => LEGACY_SHELL_PREFIXES.some((prefix) => name.startsWith(prefix)))
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method === "GET") event.respondWith(fetch(event.request));
});
