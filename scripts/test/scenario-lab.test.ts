import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SCENARIO_ACTORS,
  ScenarioBarrier,
  evaluateClientConvergence,
  evaluateLedger,
  evaluateOutsiderIsolation,
  type ScenarioClientSnapshot,
  type ScenarioServerSnapshot,
} from "../scenario-lab/model";
import { readScenarioServerSnapshot, seedScenarioDatabase } from "../scenario-lab/sandbox";

const serverSnapshot: ScenarioServerSnapshot = {
  groupId: "goa-trip",
  memberIds: ["ananya", "dev", "mira", "arjun"],
  expenses: [{
    id: "dinner",
    description: "Ramen dinner",
    status: "active",
    version: 1,
    amountMinor: 12_000,
    payers: [{ participantId: "ananya", amountMinor: 12_000 }],
    allocations: [
      { participantId: "ananya", amountMinor: 3_000 },
      { participantId: "dev", amountMinor: 3_000 },
      { participantId: "mira", amountMinor: 3_000 },
      { participantId: "arjun", amountMinor: 3_000 },
    ],
  }],
  payments: [{
    id: "partial-settlement",
    status: "active",
    payerId: "dev",
    recipientId: "ananya",
    amountMinor: 1_000,
  }],
  operations: [
    { id: "op-expense", targetId: "dinner", status: "accepted" },
    { id: "op-payment", targetId: "partial-settlement", status: "accepted" },
  ],
};

function convergedClient(actorId: string): ScenarioClientSnapshot {
  return {
    actorId,
    connection: "online",
    groups: [{ id: "goa-trip", name: "Goa trip" }],
    expenses: [{
      id: "dinner",
      description: "Ramen dinner",
      status: "active",
      version: 1,
      syncStatus: "accepted",
      amountMinor: 12_000,
    }],
    operations: [{ id: "op-expense", targetId: "dinner", syncStatus: "accepted" }],
  };
}

describe("scenario lab model", () => {
  test("defines four stable, unique people", () => {
    expect(DEFAULT_SCENARIO_ACTORS).toHaveLength(4);
    expect(new Set(DEFAULT_SCENARIO_ACTORS.map(({ id }) => id)).size).toBe(4);
    expect(DEFAULT_SCENARIO_ACTORS.map(({ name }) => name)).toEqual(["Ananya", "Dev", "Mira", "Arjun"]);
  });

  test("releases simultaneous actors only when everyone reaches the barrier", async () => {
    const barrier = new ScenarioBarrier(4);
    let released = 0;
    const waits = [1, 2, 3].map(() => barrier.wait().then(() => released += 1));
    await Promise.resolve();
    expect(released).toBe(0);
    waits.push(barrier.wait().then(() => released += 1));
    await Promise.all(waits);
    expect(released).toBe(4);
  });

  test("proves allocation integrity and zero-sum balances", () => {
    const result = evaluateLedger(serverSnapshot);
    expect(result.checks.every(({ status }) => status === "passed")).toBe(true);
    expect(result.balances).toEqual({ ananya: 8_000, arjun: -3_000, dev: -2_000, mira: -3_000 });
  });

  test("detects malformed allocations and duplicate operation ids", () => {
    const result = evaluateLedger({
      ...serverSnapshot,
      expenses: [{ ...serverSnapshot.expenses[0]!, allocations: [{ participantId: "dev", amountMinor: 2_000 }] }],
      operations: [serverSnapshot.operations[0]!, serverSnapshot.operations[0]!],
    });
    expect(result.checks.filter(({ status }) => status === "failed").map(({ id }) => id).sort()).toEqual([
      "allocation-integrity",
      "operation-uniqueness",
      "zero-sum",
    ]);
  });

  test("compares all four local ledgers with the canonical projection", () => {
    const clients = DEFAULT_SCENARIO_ACTORS.map(({ id }) => convergedClient(id));
    expect(evaluateClientConvergence(serverSnapshot, clients).every(({ status }) => status === "passed")).toBe(true);
    clients[2]!.expenses[0]!.description = "Stale dinner";
    expect(evaluateClientConvergence(serverSnapshot, clients).find(({ id }) => id === "client-mira")?.status).toBe("failed");
  });

  test("fails if an outsider can observe sandbox financial data", () => {
    expect(evaluateOutsiderIsolation({ actorId: "outsider", groups: [], expenses: [] }).status).toBe("passed");
    expect(evaluateOutsiderIsolation({
      actorId: "outsider",
      groups: [{ id: "goa-trip", name: "Goa trip" }],
      expenses: [],
    }).status).toBe("failed");
  });

  test("seeds an isolated SQLite sandbox with all four people", async () => {
    const root = await mkdtemp(join(tmpdir(), "tally-scenario-test-"));
    try {
      const databasePath = join(root, "scenario.sqlite");
      await seedScenarioDatabase({ databasePath });
      const snapshot = readScenarioServerSnapshot(databasePath);
      expect(snapshot.memberIds).toEqual(["ananya", "arjun", "dev", "mira"]);
      expect(snapshot.expenses).toEqual([]);
      expect(evaluateLedger(snapshot).checks.every(({ status }) => status === "passed")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
