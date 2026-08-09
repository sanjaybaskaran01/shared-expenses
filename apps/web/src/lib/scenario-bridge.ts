import { localDb } from "./db";
import { appStore } from "./store";

export interface ScenarioBridgeSnapshot {
  actorId: string;
  connection: string;
  groups: Array<{ id: string; name: string; settlementCurrency: string }>;
  members: Array<{ groupId: string; userId: string; displayName: string; status: string }>;
  expenses: Array<{
    id: string;
    groupId: string;
    description: string;
    status: "active" | "voided";
    version: number;
    syncStatus: string;
    amountMinor: number;
    yourNetMinor: number;
  }>;
  operations: Array<{ id: string; targetId: string; syncStatus: string }>;
}

interface ScenarioBridge {
  readonly actorId: string;
  sync(): Promise<void>;
  snapshot(): Promise<ScenarioBridgeSnapshot>;
}

declare global {
  interface Window {
    __TALLY_SCENARIO__?: ScenarioBridge;
  }
}

export function installScenarioBridge(actorId: string): void {
  if (!import.meta.env.DEV) return;
  window.__TALLY_SCENARIO__ = {
    actorId,
    sync: () => appStore.sync(),
    async snapshot() {
      const [groups, members, expenses, operations] = await Promise.all([
        localDb.groups.toArray(),
        localDb.members.toArray(),
        localDb.expenses.toArray(),
        localDb.operations.toArray(),
      ]);
      return {
        actorId,
        connection: appStore.connection(),
        groups: groups.map(({ id, name, settlementCurrency }) => ({ id, name, settlementCurrency })),
        members: members.map(({ groupId, userId, displayName, status }) => ({ groupId, userId, displayName, status })),
        expenses: expenses.map(({ id, groupId, description, status, version, syncStatus, amountMinor, yourNetMinor }) => ({
          id,
          groupId,
          description,
          status,
          version,
          syncStatus,
          amountMinor,
          yourNetMinor,
        })),
        operations: operations.map(({ id, targetId, syncStatus }) => ({ id, targetId, syncStatus })),
      };
    },
  };
}
