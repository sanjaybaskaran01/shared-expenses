import type { ConnectionState } from "./sync";

export interface AccountSyncCopy {
  short: string;
  detail: string;
}

export function accountSyncCopy(input: {
  connection: ConnectionState;
  pendingCount: number;
  groupCount: number;
}): AccountSyncCopy {
  const groups = `${input.groupCount} ${input.groupCount === 1 ? "group" : "groups"}`;
  if (input.connection === "online") {
    return input.pendingCount > 0
      ? { short: `Syncing ${input.pendingCount}`, detail: `Syncing ${input.pendingCount} ${input.pendingCount === 1 ? "change" : "changes"} for this account · ${groups}` }
      : { short: "Up to date", detail: `Up to date on this account · ${groups}` };
  }
  if (input.connection === "connecting") return { short: "Checking", detail: `Checking for updates · ${groups}` };
  return input.pendingCount > 0
    ? { short: "Saved on device", detail: `Offline · ${input.pendingCount} ${input.pendingCount === 1 ? "change" : "changes"} saved on this device · ${groups}` }
    : { short: "Offline", detail: `Offline · showing ${groups} saved on this device` };
}
