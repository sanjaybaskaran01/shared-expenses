export function money(amountMinor: number, currency = "USD", compact = false): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 2,
  }).format(amountMinor / 100);
}
