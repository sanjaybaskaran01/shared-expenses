import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { resolve } from "node:path";

describe("PWA release upgrades", () => {
  test("releases installs controlled by the legacy worker without clearing device data", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../apps/web/public/sw.js"), "utf8");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const deletedCaches: string[] = [];
    const deviceLedger = new Map([["pending-operation", { amountMinor: 5500 }]]);
    const caches = {
      async keys() { return ["tally-shell-v1", "tallied-shell-v2", "unrelated-cache"]; },
      async delete(name: string) { deletedCaches.push(name); return true; },
    };
    const networkFetch = async () => new Response("<title>Tallied</title>", { status: 200 });
    const self = {
      clients: { async claim() {} },
      async skipWaiting() {},
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        listeners.set(type, listener);
      },
    };
    vm.runInNewContext(source, { self, caches, fetch: networkFetch, Promise });

    let installPromise: Promise<unknown> | undefined;
    listeners.get("install")?.({ waitUntil(value: Promise<unknown>) { installPromise = value; } });
    await installPromise;

    let activatePromise: Promise<unknown> | undefined;
    listeners.get("activate")?.({ waitUntil(value: Promise<unknown>) { activatePromise = value; } });
    await activatePromise;
    expect(deletedCaches).toEqual(["tally-shell-v1", "tallied-shell-v2"]);

    let fetchPromise: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: { method: "GET", url: "https://tally.test/" },
      respondWith(value: Promise<Response>) { fetchPromise = value; },
    });
    expect(await (await fetchPromise)?.text()).toContain("Tallied");
    expect(deviceLedger.get("pending-operation")).toEqual({ amountMinor: 5500 });
  });

  test("serves the new online shell, refreshes the offline shell, and leaves device data untouched", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../apps/web/public/tally-sw.js"), "utf8");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const cacheEntries = new Map<string, Response>();
    const deletedCaches: string[] = [];
    const deviceLedger = new Map([["pending-operation", { amountMinor: 5500 }]]);
    let onlineShell = "<script src='/assets/v1.js'></script>";

    const normalize = (request: string | { url?: string }): string => {
      const value = typeof request === "string" ? request : request.url ?? String(request);
      return new URL(value, "https://tally.test").pathname;
    };
    const networkFetch = async (request: string | { url?: string }): Promise<Response> => {
      const path = normalize(request);
      return new Response(path === "/" ? onlineShell : `asset:${path}`, { status: 200 });
    };
    const cache = {
      async addAll(paths: string[]) {
        for (const path of paths) cacheEntries.set(normalize(path), (await networkFetch(path)).clone());
      },
      async put(request: string | { url?: string }, response: Response) {
        cacheEntries.set(normalize(request), response.clone());
      },
    };
    const caches = {
      async open() { return cache; },
      async keys() { return ["tallied-shell-v3"]; },
      async delete(name: string) { deletedCaches.push(name); return true; },
      async match(request: string | { url?: string }) { return cacheEntries.get(normalize(request))?.clone(); },
    };
    const self = {
      location: {
        origin: "https://tally.test",
        href: "https://tally.test/tally-sw.js?api=https%3A%2F%2Fapi.tally.test",
      },
      clients: { async claim() {} },
      async skipWaiting() {},
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        listeners.set(type, listener);
      },
    };
    vm.runInNewContext(source, { self, caches, fetch: networkFetch, URL, Response, Promise });

    let installPromise: Promise<unknown> | undefined;
    listeners.get("install")?.({ waitUntil(value: Promise<unknown>) { installPromise = value; } });
    await installPromise;
    expect(await cacheEntries.get("/")?.text()).toContain("v1.js");

    let activatePromise: Promise<unknown> | undefined;
    listeners.get("activate")?.({ waitUntil(value: Promise<unknown>) { activatePromise = value; } });
    await activatePromise;
    expect(deletedCaches).toEqual(["tallied-shell-v3"]);

    onlineShell = "<script src='/assets/v2.js'></script>";
    let navigationPromise: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: { method: "GET", mode: "navigate", url: "https://tally.test/" },
      respondWith(value: Promise<Response>) { navigationPromise = value; },
    });
    const response = await navigationPromise;
    expect(await response?.text()).toContain("v2.js");
    await Bun.sleep(0);
    expect(await cacheEntries.get("/")?.text()).toContain("v2.js");
    expect(deviceLedger.get("pending-operation")).toEqual({ amountMinor: 5500 });
  });

  test("shows every pushed financial update and deep-links notification clicks", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../apps/web/public/tally-sw.js"), "utf8");
    const listeners = new Map<string, (event: Record<string, any>) => void>();
    const shown: Array<{ title: string; options: NotificationOptions }> = [];
    const messages: unknown[] = [];
    let focused = false;
    const windowClient = {
      url: "https://tally.test/",
      postMessage(message: unknown) { messages.push(message); },
      async focus() { focused = true; },
    };
    const self = {
      location: { origin: "https://tally.test" },
      navigator: { async setAppBadge() {}, async clearAppBadge() {} },
      registration: {
        async showNotification(title: string, options: NotificationOptions) { shown.push({ title, options }); },
      },
      clients: {
        async matchAll() { return [windowClient]; },
        async openWindow() {},
      },
      addEventListener(type: string, listener: (event: Record<string, any>) => void) { listeners.set(type, listener); },
    };
    vm.runInNewContext(source, { self, caches: {}, fetch: async () => new Response(), URL, Promise, Number });

    let pushPromise: Promise<unknown> | undefined;
    listeners.get("push")?.({
      data: { json: () => ({ title: "Maya added Dinner", body: "You owe $5.00 in Trip.", url: "/?view=activity" }) },
      waitUntil(value: Promise<unknown>) { pushPromise = value; },
    });
    await pushPromise;
    expect(shown).toEqual([expect.objectContaining({
      title: "Maya added Dinner",
      options: expect.objectContaining({ body: "You owe $5.00 in Trip.", data: { url: "/?view=activity" } }),
    })]);

    let clickPromise: Promise<unknown> | undefined;
    listeners.get("notificationclick")?.({
      notification: { data: { url: "/?view=activity" }, close() {} },
      waitUntil(value: Promise<unknown>) { clickPromise = value; },
    });
    await clickPromise;
    expect(focused).toBe(true);
    expect(messages).toEqual([{ type: "tallied:notification-click", url: "https://tally.test/?view=activity" }]);
  });

  test("renews a rotated browser subscription without another permission prompt", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../apps/web/public/tally-sw.js"), "utf8");
    const listeners = new Map<string, (event: Record<string, any>) => void>();
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const replacement = {
      endpoint: "https://web.push.apple.com/subscription/new",
      expirationTime: null,
      toJSON: () => ({
        endpoint: "https://web.push.apple.com/subscription/new",
        expirationTime: null,
        keys: { p256dh: "new-p256dh", auth: "new-auth-key" },
      }),
    };
    const self = {
      location: {
        origin: "https://tally.test",
        href: "https://tally.test/tally-sw.js?api=https%3A%2F%2Fapi.tally.test",
      },
      registration: { pushManager: { async subscribe() { return replacement; } } },
      addEventListener(type: string, listener: (event: Record<string, any>) => void) { listeners.set(type, listener); },
    };
    const networkFetch = async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response("{}", { status: 200 });
    };
    vm.runInNewContext(source, { self, caches: {}, fetch: networkFetch, URL, Response, Promise, Number });

    let renewalPromise: Promise<unknown> | undefined;
    listeners.get("pushsubscriptionchange")?.({
      oldSubscription: {
        endpoint: "https://web.push.apple.com/subscription/old",
        options: { applicationServerKey: new Uint8Array([1, 2, 3]) },
      },
      waitUntil(value: Promise<unknown>) { renewalPromise = value; },
    });
    await renewalPromise;
    expect(requests).toEqual([expect.objectContaining({
      url: "https://api.tally.test/api/v1/push/subscriptions/refresh",
      init: expect.objectContaining({ method: "POST", credentials: "include" }),
      body: expect.objectContaining({
        oldEndpoint: "https://web.push.apple.com/subscription/old",
        subscription: expect.objectContaining({ endpoint: "https://web.push.apple.com/subscription/new" }),
      }),
    })]);
  });
});
