export function localDateValue(date = new Date()): string {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 10);
}

export function isLocalToday(value: string, now = new Date()): boolean {
  return value === localDateValue(now);
}
