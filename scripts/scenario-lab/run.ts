import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  DEFAULT_SCENARIO_ACTORS,
  ScenarioBarrier,
  evaluateClientConvergence,
  evaluateLedger,
  evaluateOutsiderIsolation,
  type ScenarioActor,
  type ScenarioCheck,
  type ScenarioClientSnapshot,
  type ScenarioServerSnapshot,
} from "./model";
import {
  writeScenarioReport,
  type ScenarioCaseReport,
  type ScenarioRunReport,
  type ScenarioStepReport,
} from "./report";
import { startScenarioRuntime, type ScenarioRuntime } from "./runtime";
import { readScenarioServerSnapshot } from "./sandbox";

interface ActorSession {
  actor: ScenarioActor;
  context: BrowserContext;
  page: Page;
}

interface BrowserScenarioBridge {
  sync(): Promise<void>;
  snapshot(): Promise<ScenarioClientSnapshot>;
}

type ScenarioWindow = Window & { __TALLY_SCENARIO__?: BrowserScenarioBridge };

interface RunOptions {
  headless: boolean;
  keepOpen: boolean;
  openReport: boolean;
}

const repositoryRoot = resolve(import.meta.dir, "../..");
const groupName = "Goa trip";

function parseOptions(arguments_: string[]): RunOptions {
  return {
    headless: arguments_.includes("--headless"),
    keepOpen: arguments_.includes("--keep-open"),
    openReport: !arguments_.includes("--no-open-report"),
  };
}

function runId(): string {
  return `${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
}

function scenarioDefinitions(): ScenarioCaseReport[] {
  return [
    {
      id: "four-way-create",
      title: "Four people add expenses together",
      purpose: "Proves concurrent UI writes, signed devices, realtime fan-out, complete splits, and cross-device convergence.",
      status: "pending",
      steps: [],
    },
    {
      id: "offline-replay",
      title: "An offline purchase rejoins the ledger",
      purpose: "Proves local-first creation, queued operation preservation, reconnection replay, and eventual convergence.",
      status: "pending",
      steps: [],
    },
    {
      id: "lost-response",
      title: "A lost response retries exactly once",
      purpose: "Accepts a write on the server, drops the response, retries the same signed operation, and rejects duplication.",
      status: "pending",
      steps: [],
    },
    {
      id: "concurrent-edit",
      title: "Two people correct one expense",
      purpose: "Creates a real stale-write race and requires one canonical edit plus an explicit conflict on the losing device.",
      status: "pending",
      steps: [],
    },
    {
      id: "authorization",
      title: "An outsider sees nothing",
      purpose: "Verifies server-side group scoping independently of what the four member interfaces display.",
      status: "pending",
      steps: [],
    },
  ];
}

function makeCheck(id: string, label: string, passed: boolean, detail: string): ScenarioCheck {
  return { id, label, status: passed ? "passed" : "failed", detail };
}

async function bridgeSnapshot(page: Page): Promise<ScenarioClientSnapshot> {
  return page.evaluate(async () => {
    const bridge = (window as ScenarioWindow).__TALLY_SCENARIO__;
    if (!bridge) throw new Error("Scenario bridge is unavailable");
    return bridge.snapshot();
  });
}

async function forceSync(session: ActorSession): Promise<void> {
  await session.page.evaluate(async () => {
    const bridge = (window as ScenarioWindow).__TALLY_SCENARIO__;
    if (!bridge) throw new Error("Scenario bridge is unavailable");
    await bridge.sync();
  });
}

async function waitUntil(label: string, condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(120);
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function waitForClients(
  sessions: readonly ActorSession[],
  expectedExpenseCount: number,
  timeoutMs = 15_000,
): Promise<ScenarioClientSnapshot[]> {
  let snapshots: ScenarioClientSnapshot[] = [];
  await waitUntil(`${expectedExpenseCount} expenses to converge`, async () => {
    snapshots = await Promise.all(sessions.map(({ page }) => bridgeSnapshot(page)));
    return snapshots.every((snapshot) =>
      snapshot.connection === "online" &&
      snapshot.expenses.length === expectedExpenseCount &&
      snapshot.expenses.every(({ syncStatus }) => syncStatus === "accepted"),
    );
  }, timeoutMs);
  return snapshots;
}

async function outsiderSnapshot(apiUrl: string): Promise<{ actorId: string; groups: Array<{ id: string; name: string }>; expenses: unknown[] }> {
  const response = await fetch(`${apiUrl}/api/v1/snapshot`, { headers: { "X-Dev-User": "scenario-outsider" } });
  if (!response.ok) throw new Error(`Outsider snapshot returned ${response.status}`);
  const value = await response.json() as { groups: Array<{ id: string; name: string }>; expenses: unknown[] };
  return { actorId: "scenario-outsider", groups: value.groups, expenses: value.expenses };
}

async function canonicalChecks(
  runtime: ScenarioRuntime,
  clients: readonly ScenarioClientSnapshot[],
): Promise<{ server: ScenarioServerSnapshot; checks: ScenarioCheck[] }> {
  const server = readScenarioServerSnapshot(runtime.databasePath);
  const checks = [
    ...evaluateLedger(server).checks,
    ...evaluateClientConvergence(server, clients),
    evaluateOutsiderIsolation(await outsiderSnapshot(runtime.apiUrl)),
  ];
  return { server, checks };
}

async function captureScreens(
  sessions: readonly ActorSession[],
  outputDirectory: string,
  prefix: string,
): Promise<Record<string, string>> {
  const screenshotDirectory = join(outputDirectory, "screenshots");
  await mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  const entries = await Promise.all(sessions.map(async ({ actor, page }) => {
    const filename = `${prefix}-${actor.id}.png`;
    await page.screenshot({ path: join(screenshotDirectory, filename), animations: "disabled" });
    return [actor.id, `screenshots/${filename}`] as const;
  }));
  return Object.fromEntries(entries);
}

function assertChecks(checks: readonly ScenarioCheck[]): void {
  const failed = checks.filter(({ status }) => status === "failed");
  if (failed.length) throw new Error(failed.map(({ label, detail }) => `${label}: ${detail}`).join("; "));
}

async function recordStep(
  report: ScenarioRunReport,
  scenario: ScenarioCaseReport,
  outputDirectory: string,
  input: {
    id: string;
    title: string;
    sessions: readonly ActorSession[];
    note?: string;
    clients?: ScenarioClientSnapshot[];
    server?: ScenarioServerSnapshot;
    checks: ScenarioCheck[];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const step: ScenarioStepReport = {
    id: input.id,
    title: input.title,
    status: input.checks.every(({ status }) => status === "passed") ? "passed" : "failed",
    startedAt: now,
    finishedAt: now,
    ...(input.note ? { note: input.note } : {}),
    screenshots: await captureScreens(input.sessions, outputDirectory, `${scenario.id}-${input.id}`),
    ...(input.clients ? { clients: input.clients } : {}),
    ...(input.server ? { server: input.server } : {}),
    checks: input.checks,
  };
  scenario.steps.push(step);
  await writeScenarioReport(outputDirectory, report);
  assertChecks(input.checks);
}

async function prepareExpense(page: Page, description: string, amount: string): Promise<() => Promise<void>> {
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  const targetDialog = page.getByRole("dialog", { name: "Who is this with?" });
  await targetDialog.getByRole("button", { name: `${groupName} 4 people`, exact: true }).click();
  const composer = page.getByRole("dialog", { name: "Add an expense" });
  await composer.getByLabel("Total in USD").fill(amount);
  await composer.getByPlaceholder("What was it for?").fill(description);
  return async () => {
    await composer.getByRole("button", { name: /^Add / }).click();
    await composer.waitFor({ state: "hidden" });
  };
}

async function openExpenseForEdit(page: Page, description: string, replacement: string): Promise<() => Promise<void>> {
  await page.getByRole("button", { name: "Groups", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(groupName, "i") }).click();
  await page.getByRole("button", { name: new RegExp(description, "i") }).click();
  const detail = page.getByRole("dialog", { name: "Expense details" });
  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "Edit expense" });
  await composer.getByPlaceholder("What was it for?").fill(replacement);
  return async () => {
    await composer.getByRole("button", { name: "Save changes", exact: true }).click();
    await composer.waitFor({ state: "hidden" });
  };
}

async function runCase(
  report: ScenarioRunReport,
  scenario: ScenarioCaseReport,
  outputDirectory: string,
  action: () => Promise<void>,
): Promise<void> {
  scenario.status = "running";
  await writeScenarioReport(outputDirectory, report);
  try {
    await action();
    scenario.status = "passed";
  } catch (error) {
    scenario.status = "failed";
    const message = error instanceof Error ? error.message : String(error);
    scenario.steps.push({
      id: "failure",
      title: "Scenario stopped",
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      note: message,
      screenshots: {},
      checks: [makeCheck("scenario-error", "Scenario completed without an unexpected error", false, message)],
    });
    await writeScenarioReport(outputDirectory, report);
    throw error;
  }
  await writeScenarioReport(outputDirectory, report);
}

async function launchBrowser(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless, channel: "chrome" });
  } catch (error) {
    try {
      return await chromium.launch({ headless });
    } catch {
      throw new Error(`Chrome or Playwright Chromium is required. Install one with \"bunx playwright install chromium\". ${error instanceof Error ? error.message : ""}`);
    }
  }
}

async function createActorSessions(browser: Browser, webUrl: string): Promise<ActorSession[]> {
  const sessions: ActorSession[] = [];
  for (const actor of DEFAULT_SCENARIO_ACTORS) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: "en-US",
      timezoneId: "America/New_York",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${webUrl}/?scenarioActor=${encodeURIComponent(actor.id)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(() => Boolean((window as ScenarioWindow).__TALLY_SCENARIO__));
    await waitUntil(`${actor.name} to load the shared group`, async () => {
      const snapshot = await bridgeSnapshot(page);
      return snapshot.connection === "online" && snapshot.groups.some(({ name }) => name === groupName);
    });
    sessions.push({ actor, context, page });
  }
  return sessions;
}

async function maybeOpenReport(path: string, enabled: boolean): Promise<void> {
  if (!enabled || process.platform !== "darwin") return;
  const command = Bun.which("open");
  if (!command) return;
  const process_ = Bun.spawn([command, path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await process_.exited;
}

async function run(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const id = runId();
  const outputRoot = resolve(process.env.TALLY_SCENARIO_OUTPUT ?? join(repositoryRoot, "artifacts/scenario-lab"));
  const outputDirectory = join(outputRoot, id);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const report: ScenarioRunReport = {
    schemaVersion: 1,
    runId: id,
    status: "running",
    startedAt: new Date().toISOString(),
    actors: DEFAULT_SCENARIO_ACTORS,
    apiUrl: "starting",
    webUrl: "starting",
    scenarios: scenarioDefinitions(),
  };
  await writeScenarioReport(outputDirectory, report);
  await maybeOpenReport(join(outputDirectory, "index.html"), options.openReport && !options.headless);

  let runtime: ScenarioRuntime | undefined;
  let browser: Browser | undefined;
  let sessions: ActorSession[] = [];
  const stop = async () => {
    await Promise.allSettled(sessions.map(({ context }) => context.close()));
    if (browser) await browser.close().catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(143)));

  try {
    runtime = await startScenarioRuntime(repositoryRoot, outputDirectory);
    report.apiUrl = runtime.apiUrl;
    report.webUrl = runtime.webUrl;
    browser = await launchBrowser(options.headless);
    sessions = await createActorSessions(browser, runtime.webUrl);

    const findScenario = (scenarioId: string) => report.scenarios.find(({ id: value }) => value === scenarioId);
    const concurrent = findScenario("four-way-create");
    if (concurrent) await runCase(report, concurrent, outputDirectory, async () => {
      const inputs = [
        { description: "Ramen dinner", amount: "55.50" },
        { description: "Train tickets", amount: "74.00" },
        { description: "Groceries", amount: "42.25" },
        { description: "Beach cab", amount: "36.00" },
      ];
      const barrier = new ScenarioBarrier(sessions.length);
      await Promise.all(sessions.map(async (session, index) => {
        const submit = await prepareExpense(session.page, inputs[index]!.description, inputs[index]!.amount);
        await barrier.wait();
        await submit();
      }));
      const clients = await waitForClients(sessions, 4);
      const evidence = await canonicalChecks(runtime!, clients);
      await recordStep(report, concurrent, outputDirectory, {
        id: "converged",
        title: "All four expenses reached every device",
        sessions,
        note: "The four submit buttons were released by one barrier; no forced refresh or manual sync was used.",
        clients,
        server: evidence.server,
        checks: evidence.checks,
      });
    });

    const offline = findScenario("offline-replay");
    if (offline) await runCase(report, offline, outputDirectory, async () => {
      const ananya = sessions[0]!;
      await ananya.context.setOffline(true);
      const submit = await prepareExpense(ananya.page, "Offline fuel", "28.40");
      await submit();
      let offlineSnapshot: ScenarioClientSnapshot | undefined;
      await waitUntil("offline operation to remain pending", async () => {
        offlineSnapshot = await bridgeSnapshot(ananya.page);
        return offlineSnapshot.expenses.some(({ description, syncStatus }) => description === "Offline fuel" && syncStatus === "pending");
      });
      const offlineServer = readScenarioServerSnapshot(runtime!.databasePath);
      const queuedChecks = [
        makeCheck("local-first", "The offline expense is visible on Ananya's device", Boolean(offlineSnapshot?.expenses.some(({ description }) => description === "Offline fuel")), "Saved to isolated IndexedDB"),
        makeCheck("not-premature", "The server has not invented an offline write", !offlineServer.expenses.some(({ description }) => description === "Offline fuel"), "No server projection before reconnection"),
      ];
      await recordStep(report, offline, outputDirectory, {
        id: "queued",
        title: "Purchase saved while the network is unavailable",
        sessions,
        clients: await Promise.all(sessions.map(({ page }) => bridgeSnapshot(page))),
        server: offlineServer,
        checks: queuedChecks,
      });

      await ananya.context.setOffline(false);
      await forceSync(ananya);
      const clients = await waitForClients(sessions, 5);
      const evidence = await canonicalChecks(runtime!, clients);
      await recordStep(report, offline, outputDirectory, {
        id: "replayed",
        title: "The queued operation synchronized once",
        sessions,
        clients,
        server: evidence.server,
        checks: evidence.checks,
      });
    });

    const lostResponse = findScenario("lost-response");
    if (lostResponse) await runCase(report, lostResponse, outputDirectory, async () => {
      const dev = sessions[1]!;
      let responseDropped = false;
      await dev.page.route("**/api/v1/sync/push", async (route) => {
        if (!responseDropped && route.request().method() === "POST") {
          responseDropped = true;
          await route.fetch();
          await route.abort("failed");
          return;
        }
        await route.continue();
      });
      const submit = await prepareExpense(dev.page, "Retry coffee", "18.75");
      await submit();
      await waitUntil("server to accept the dropped-response write", async () =>
        readScenarioServerSnapshot(runtime!.databasePath).expenses.some(({ description }) => description === "Retry coffee"),
      );
      await dev.page.unroute("**/api/v1/sync/push");
      await forceSync(dev);
      const clients = await waitForClients(sessions, 6);
      const evidence = await canonicalChecks(runtime!, clients);
      const retryExpenses = evidence.server.expenses.filter(({ description }) => description === "Retry coffee");
      const retryOperations = evidence.server.operations.filter(({ targetId }) => targetId === retryExpenses[0]?.id);
      const checks = [
        ...evidence.checks,
        makeCheck("idempotent-retry", "A lost response did not duplicate the expense", retryExpenses.length === 1 && retryOperations.length === 1, `${retryExpenses.length} projection · ${retryOperations.length} operation`),
      ];
      await recordStep(report, lostResponse, outputDirectory, {
        id: "deduplicated",
        title: "The signed retry was recognized as the same operation",
        sessions,
        note: "The server accepted the first POST, while the browser received a synthetic network failure.",
        clients,
        server: evidence.server,
        checks,
      });
    });

    const concurrentEdit = findScenario("concurrent-edit");
    if (concurrentEdit) await runCase(report, concurrentEdit, outputDirectory, async () => {
      const editors = [sessions[2]!, sessions[3]!];
      const replacements = ["Ramen dinner · Mira", "Ramen dinner · Arjun"];
      const originalId = readScenarioServerSnapshot(runtime!.databasePath).expenses.find(({ description }) => description === "Ramen dinner")?.id;
      if (!originalId) throw new Error("The shared Ramen dinner expense is missing before the edit race");
      const barrier = new ScenarioBarrier(editors.length);
      await Promise.all(editors.map(async (session, index) => {
        const submit = await openExpenseForEdit(session.page, "Ramen dinner", replacements[index]!);
        await barrier.wait();
        await submit();
      }));
      await waitUntil("one stale edit conflict", async () => {
        const operations = readScenarioServerSnapshot(runtime!.databasePath).operations.filter(({ targetId }) => targetId === originalId);
        return operations.filter(({ status }) => status === "accepted").length === 2 && operations.filter(({ status }) => status === "conflicted").length === 1;
      });
      await Promise.all(sessions.map((session) => forceSync(session)));
      const clients = await Promise.all(sessions.map(({ page }) => bridgeSnapshot(page)));
      const server = readScenarioServerSnapshot(runtime!.databasePath);
      const conflictClients = clients.filter((client) => client.expenses.some(({ id, syncStatus }) => id === originalId && syncStatus === "conflicted"));
      const canonical = server.expenses.find(({ id }) => id === originalId);
      const unaffected = clients.filter((client) => !conflictClients.includes(client));
      const unaffectedConverged = unaffected.every((client) => client.expenses.some(({ id, description, syncStatus }) => id === originalId && description === canonical?.description && syncStatus === "accepted"));
      const checks = [
        ...evaluateLedger(server).checks,
        makeCheck("single-winner", "Exactly one simultaneous edit became canonical", Boolean(canonical && canonical.version === 2), canonical ? `${canonical.description} · version ${canonical.version}` : "Missing canonical expense"),
        makeCheck("visible-conflict", "Exactly one device retained an explicit conflict", conflictClients.length === 1, `${conflictClients.length} conflicted device`),
        makeCheck("unaffected-convergence", "Non-conflicted devices received the winning edit", unaffectedConverged, `${unaffected.length} unaffected devices checked`),
        evaluateOutsiderIsolation(await outsiderSnapshot(runtime!.apiUrl)),
      ];
      await recordStep(report, concurrentEdit, outputDirectory, {
        id: "resolved",
        title: "One winner, one reviewable conflict",
        sessions,
        note: "The lab treats a clearly marked conflict as correct; silently overwriting either person's edit would fail.",
        clients,
        server,
        checks,
      });
    });

    const authorization = findScenario("authorization");
    if (authorization) await runCase(report, authorization, outputDirectory, async () => {
      const outsider = await outsiderSnapshot(runtime!.apiUrl);
      const clients = await Promise.all(sessions.map(({ page }) => bridgeSnapshot(page)));
      const server = readScenarioServerSnapshot(runtime!.databasePath);
      const check = evaluateOutsiderIsolation(outsider);
      await recordStep(report, authorization, outputDirectory, {
        id: "scoped",
        title: "Membership remains the server-side boundary",
        sessions,
        clients,
        server,
        checks: [check],
      });
    });

    report.status = report.scenarios.every(({ status }) => status === "passed") ? "passed" : "failed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeScenarioReport(outputDirectory, report);
    console.log(`[scenario-lab] ${report.status}: ${join(outputDirectory, "index.html")}`);
    if (options.keepOpen && !options.headless && browser) {
      console.log("[scenario-lab] keep-open enabled; press Ctrl+C to close the sandbox");
      await new Promise<void>(() => undefined);
    }
    await stop();
  }
  if (report.status !== "passed") process.exitCode = 1;
}

if (import.meta.main) void run();
