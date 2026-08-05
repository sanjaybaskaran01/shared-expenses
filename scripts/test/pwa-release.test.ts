import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { resolve } from "node:path";

describe("PWA release upgrades", () => {
  test("serves the new online shell, refreshes the offline shell, and leaves device data untouched", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../apps/web/public/tally-sw.js"), "utf8");
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const cacheEntries = new Map<string, Response>();
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
      async keys() { return ["tally-shell-v2"]; },
      async delete() { return true; },
      async match(request: string | { url?: string }) { return cacheEntries.get(normalize(request))?.clone(); },
    };
    const self = {
      location: { origin: "https://tally.test" },
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
});
