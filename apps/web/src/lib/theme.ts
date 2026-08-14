export type Theme = "system" | "light" | "dark";

let systemThemeQuery: MediaQueryList | undefined;

function setDarkTheme(enabled: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", enabled);
}

function onSystemThemeChange(event: MediaQueryListEvent): void {
  setDarkTheme(event.matches);
}

function stopFollowingSystemTheme(): void {
  if (!systemThemeQuery) return;
  if (typeof systemThemeQuery.removeEventListener === "function") {
    systemThemeQuery.removeEventListener("change", onSystemThemeChange);
  } else {
    systemThemeQuery.removeListener(onSystemThemeChange);
  }
  systemThemeQuery = undefined;
}

function followSystemTheme(): MediaQueryList | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  if (!systemThemeQuery) {
    systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", onSystemThemeChange);
    } else {
      systemThemeQuery.addListener(onSystemThemeChange);
    }
  }
  return systemThemeQuery;
}

export function applyTheme(value: Theme): void {
  if (value === "system") {
    setDarkTheme(followSystemTheme()?.matches ?? false);
    return;
  }
  stopFollowingSystemTheme();
  setDarkTheme(value === "dark");
}
