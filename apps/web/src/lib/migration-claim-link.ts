export function migrationClaimFromHash(hash = window.location.hash): string | undefined {
  if (!hash.startsWith("#")) return undefined;
  const token = new URLSearchParams(hash.slice(1)).get("migrationClaim")?.trim();
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function clearLocationHash(): void {
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}
