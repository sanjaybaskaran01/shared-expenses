import { parseSplitwiseCsv, parseSplitwiseJson } from "./splitwise-import";

interface ParseRequest {
  kind: "csv" | "json";
  text: string;
  options: { sourceName: string; sourceHash: string; maxBytes?: number; maxRows?: number };
}

self.addEventListener("message", (event: MessageEvent<ParseRequest>) => {
  try {
    const { kind, text, options } = event.data;
    const draft = kind === "json" ? parseSplitwiseJson(text, options) : parseSplitwiseCsv(text, options);
    self.postMessage({ ok: true, draft });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "This export could not be read" });
  }
});
