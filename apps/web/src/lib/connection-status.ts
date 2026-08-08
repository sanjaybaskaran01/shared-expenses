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
      ? { short: `${input.pendingCount} syncing`, detail: `${input.pendingCount} changes syncing on this account · ${groups}` }
      : { short: "Up to date", detail: `Up to date on this account · ${groups}` };
  }
  if (input.connection === "connecting") return { short: "Checking", detail: `Checking this account · ${groups}` };
  return input.pendingCount > 0
    ? { short: `${input.pendingCount} on device`, detail: `Offline · ${input.pendingCount} changes saved on this device · ${groups}` }
    : { short: "Offline", detail: `Offline · showing ${groups} saved on this device` };
}
