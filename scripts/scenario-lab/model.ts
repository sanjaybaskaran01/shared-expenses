export interface ScenarioActor {
  id: string;
  name: string;
  color: string;
}

export const DEFAULT_SCENARIO_ACTORS: readonly ScenarioActor[] = [
  { id: "maya", name: "Maya", color: "#c96b4b" },
  { id: "dev", name: "Dev", color: "#426b91" },
  { id: "mira", name: "Mira", color: "#6f5a8f" },
  { id: "arjun", name: "Arjun", color: "#88702d" },
] as const;

export interface ScenarioParticipantAmount {
  participantId: string;
  amountMinor: number;
}

export interface ScenarioExpenseProjection {
  id: string;
  description: string;
  status: "active" | "voided";
  version: number;
  amountMinor: number;
  payers: ScenarioParticipantAmount[];
  allocations: ScenarioParticipantAmount[];
}

export interface ScenarioPaymentProjection {
  id: string;
  status: "active" | "reversed";
  payerId: string;
  recipientId: string;
  amountMinor: number;
}

export interface ScenarioServerSnapshot {
  groupId: string;
  memberIds: string[];
  expenses: ScenarioExpenseProjection[];
  payments: ScenarioPaymentProjection[];
  operations: Array<{ id: string; targetId: string; status: "accepted" | "conflicted" | "rejected" }>;
}

export interface ScenarioClientSnapshot {
  actorId: string;
  connection: string;
  groups: Array<{ id: string; name: string; settlementCurrency: string }>;
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

export interface ScenarioCheck {
  id: string;
  label: string;
  status: "passed" | "failed";
  detail: string;
}

export interface ScenarioRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ScenarioViewport {
  width: number;
  height: number;
}

export interface ScenarioLedgerEvaluation {
  balances: Record<string, number>;
  checks: ScenarioCheck[];
}

function check(id: string, label: string, passed: boolean, detail: string): ScenarioCheck {
  return { id, label, status: passed ? "passed" : "failed", detail };
}

export function evaluateMobilePrimaryAction(
  action: ScenarioRect,
  navigation: ScenarioRect,
  viewport: ScenarioViewport,
): ScenarioCheck[] {
  const centerX = action.left + action.width / 2;
  const centerY = action.top + action.height / 2;
  const hasVerticalClearance =
    action.bottom <= navigation.top - 8 || navigation.bottom <= action.top - 8;
  const hasHorizontalClearance =
    action.right <= navigation.left - 8 || navigation.right <= action.left - 8;
  const detail = JSON.stringify({ action, navigation, viewport, centerX, centerY });
  return [
    check(
      "primary-action-hit-area",
      "The mobile primary action has at least a 44 by 44 pixel touch target",
      action.width >= 44 && action.height >= 44,
      detail,
    ),
    check(
      "primary-action-thumb-zone",
      "The mobile primary action sits in the lower thumb zone",
      centerY >= viewport.height * 0.62 &&
        centerY <= navigation.bottom &&
        centerX >= viewport.width * 0.2 &&
        centerX <= viewport.width * 0.85,
      detail,
    ),
    check(
      "primary-action-clearance",
      "The mobile primary action stays clear of navigation and ledger content",
      (hasVerticalClearance || hasHorizontalClearance) &&
        action.right <= viewport.width &&
        action.left >= 0 &&
        action.bottom <= viewport.height,
      detail,
    ),
  ];
}

function addBalance(balances: Record<string, number>, actorId: string, amountMinor: number): void {
  balances[actorId] = (balances[actorId] ?? 0) + amountMinor;
}

export function evaluateLedger(snapshot: ScenarioServerSnapshot): ScenarioLedgerEvaluation {
  const balances = Object.fromEntries(snapshot.memberIds.map((id) => [id, 0])) as Record<string, number>;
  const malformedExpenses: string[] = [];
  const unknownParticipants = new Set<string>();
  const members = new Set(snapshot.memberIds);

  for (const expense of snapshot.expenses.filter(({ status }) => status === "active")) {
    const paid = expense.payers.reduce((sum, item) => sum + item.amountMinor, 0);
    const allocated = expense.allocations.reduce((sum, item) => sum + item.amountMinor, 0);
    if (paid !== expense.amountMinor || allocated !== expense.amountMinor) malformedExpenses.push(expense.id);
    for (const payer of expense.payers) {
      if (!members.has(payer.participantId)) unknownParticipants.add(payer.participantId);
      addBalance(balances, payer.participantId, payer.amountMinor);
    }
    for (const allocation of expense.allocations) {
      if (!members.has(allocation.participantId)) unknownParticipants.add(allocation.participantId);
      addBalance(balances, allocation.participantId, -allocation.amountMinor);
    }
  }

  for (const payment of snapshot.payments.filter(({ status }) => status === "active")) {
    if (!members.has(payment.payerId)) unknownParticipants.add(payment.payerId);
    if (!members.has(payment.recipientId)) unknownParticipants.add(payment.recipientId);
    addBalance(balances, payment.payerId, payment.amountMinor);
    addBalance(balances, payment.recipientId, -payment.amountMinor);
  }

  const operationIds = snapshot.operations.map(({ id }) => id);
  const uniqueOperations = new Set(operationIds).size === operationIds.length;
  const zeroSum = Object.values(balances).reduce((sum, value) => sum + value, 0) === 0;
  return {
    balances: Object.fromEntries(Object.entries(balances).sort(([left], [right]) => left.localeCompare(right))),
    checks: [
      check(
        "allocation-integrity",
        "Every active expense is fully paid and fully allocated",
        malformedExpenses.length === 0,
        malformedExpenses.length ? `Malformed: ${malformedExpenses.join(", ")}` : `${snapshot.expenses.length} expense projections reconcile`,
      ),
      check(
        "operation-uniqueness",
        "Every operation id is unique",
        uniqueOperations,
        uniqueOperations ? `${operationIds.length} unique operations` : "Duplicate operation ids detected",
      ),
      check(
        "member-boundaries",
        "Every financial participant belongs to the group",
        unknownParticipants.size === 0,
        unknownParticipants.size ? `Unknown: ${[...unknownParticipants].join(", ")}` : `${snapshot.memberIds.length} active members only`,
      ),
      check(
        "zero-sum",
        "All participant balances sum to zero",
        zeroSum,
        `Net ${Object.values(balances).reduce((sum, value) => sum + value, 0)} minor units`,
      ),
    ],
  };
}

function expenseFingerprint(expense: Pick<ScenarioExpenseProjection, "id" | "description" | "status" | "version" | "amountMinor">): string {
  return JSON.stringify([expense.id, expense.description, expense.status, expense.version, expense.amountMinor]);
}

export function evaluateClientConvergence(
  server: ScenarioServerSnapshot,
  clients: readonly ScenarioClientSnapshot[],
): ScenarioCheck[] {
  const canonical = server.expenses.map(expenseFingerprint).sort();
  return clients.map((client) => {
    const local = client.expenses.filter(({ groupId }) => groupId === server.groupId).map(expenseFingerprint).sort();
    const matching = JSON.stringify(local) === JSON.stringify(canonical);
    const settled = client.expenses.every(({ syncStatus }) => syncStatus === "accepted");
    const online = client.connection === "online";
    return check(
      `client-${client.actorId}`,
      `${client.actorId} converged on the canonical ledger`,
      matching && settled && online,
      matching && settled && online
        ? `${local.length} expenses · online · accepted`
        : `matching=${matching} settled=${settled} connection=${client.connection}`,
    );
  });
}

export function evaluateOutsiderIsolation(snapshot: {
  actorId: string;
  groups: Array<{ id: string; name: string }>;
  expenses: unknown[];
}): ScenarioCheck {
  const isolated = snapshot.groups.length === 0 && snapshot.expenses.length === 0;
  return check(
    "outsider-isolation",
    "An unrelated account cannot observe the group",
    isolated,
    isolated ? `${snapshot.actorId} sees no financial data` : `${snapshot.actorId} received scoped data`,
  );
}

export class ScenarioBarrier {
  private arrived = 0;
  private readonly promise: Promise<void>;
  private release!: () => void;

  constructor(private readonly parties: number) {
    if (!Number.isSafeInteger(parties) || parties < 1) throw new RangeError("Barrier parties must be a positive integer");
    this.promise = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  wait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived > this.parties) throw new RangeError("Too many actors reached the barrier");
    if (this.arrived === this.parties) this.release();
    return this.promise;
  }
}
