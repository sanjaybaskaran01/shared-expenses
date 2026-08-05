import type { NormalizedImportDraft } from "@expenses/protocol";
import { parseSplitwiseCsv, parseSplitwiseJson } from "./splitwise-import";

interface ParseOptions {
  sourceName: string;
  sourceHash: string;
  maxBytes?: number;
  maxRows?: number;
}

export function parseImportTextOffMainThread(
  kind: "csv" | "json",
  text: string,
  options: ParseOptions,
): Promise<NormalizedImportDraft> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(kind === "json" ? parseSplitwiseJson(text, options) : parseSplitwiseCsv(text, options));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./splitwise-import.worker.ts", import.meta.url), { type: "module" });
    const timeout = globalThis.setTimeout(() => {
      worker.terminate();
      reject(new Error("This export took too long to read"));
    }, 60_000);
    worker.addEventListener("message", (event: MessageEvent<{ ok: boolean; draft?: NormalizedImportDraft; error?: string }>) => {
      globalThis.clearTimeout(timeout);
      worker.terminate();
      if (event.data.ok && event.data.draft) resolve(event.data.draft);
      else reject(new Error(event.data.error ?? "This export could not be read"));
    }, { once: true });
    worker.addEventListener("error", () => {
      globalThis.clearTimeout(timeout);
      worker.terminate();
      reject(new Error("This export could not be read on this device"));
    }, { once: true });
    worker.postMessage({ kind, text, options });
  });
}
