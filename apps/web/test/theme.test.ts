import { describe, expect, test } from "bun:test";
import { applyTheme } from "../src/lib/theme";

type ChangeListener = (event: MediaQueryListEvent) => void;

function replaceGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

describe("theme preference", () => {
  test("follows system appearance changes only while System is selected", () => {
    const classes = new Set<string>();
    const listeners = new Set<ChangeListener>();
    const media = {
      matches: false,
      addEventListener: (_name: string, listener: ChangeListener) => listeners.add(listener),
      removeEventListener: (_name: string, listener: ChangeListener) => listeners.delete(listener),
    } as unknown as MediaQueryList;
    const restoreWindow = replaceGlobal("window", { matchMedia: () => media });
    const restoreDocument = replaceGlobal("document", {
      documentElement: {
        classList: {
          toggle: (name: string, enabled: boolean) => {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
        },
      },
    });

    try {
      applyTheme("system");
      expect(classes.has("dark")).toBe(false);
      expect(listeners.size).toBe(1);

      for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
      expect(classes.has("dark")).toBe(true);

      applyTheme("light");
      expect(classes.has("dark")).toBe(false);
      expect(listeners.size).toBe(0);
    } finally {
      applyTheme("light");
      restoreDocument();
      restoreWindow();
    }
  });
});
