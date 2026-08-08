export type Theme = "system" | "light" | "dark";

export function applyTheme(value: Theme): void {
  const dark = value === "dark" || (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
