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
import {
  IMPORT_CLAIM_SCENARIO,
  readScenarioImportClaimEvidence,
  readScenarioServerSnapshot,
} from "./sandbox";

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
    {
      id: "imported-identity-claim",
      title: "An imported person securely joins their history",
      purpose: "Reproduces the production mismatch and proves owner approval converges group access, history, balances, and immutable signed operations across isolated devices.",
      status: "pending",
      steps: [],
    },
    {
      id: "responsive-layout",
      title: "Phone and desktop layouts stay intentional",
      purpose: "Verifies the desktop navigation and centered form independently of the mobile four-person run.",
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
      snapshot.expenses.filter(({ groupId }) => groupId === "scenario-goa-trip").length === expectedExpenseCount &&
      snapshot.expenses.filter(({ groupId }) => groupId === "scenario-goa-trip").every(({ syncStatus }) => syncStatus === "accepted"),
    );
  }, timeoutMs);
  return snapshots;
}

async function scenarioApi<T>(
  apiUrl: string,
  actorId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Dev-User", actorId);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${actorId} ${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
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
  await targetDialog.getByTestId("expense-target-group:scenario-goa-trip").click();
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
    const responsive = findScenario("responsive-layout");
    if (responsive) await runCase(report, responsive, outputDirectory, async () => {
      const context = await browser!.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "America/New_York",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const desktopSession: ActorSession = {
        actor: { id: "dev-desktop", name: "Dev desktop", color: "#426b91" },
        context,
        page,
      };
      try {
        await page.goto(`${runtime!.webUrl}/?scenarioActor=dev`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(() => Boolean((window as ScenarioWindow).__TALLY_SCENARIO__));
        await waitUntil("desktop account to load", async () => (await bridgeSnapshot(page)).connection === "online");
        await prepareExpense(page, "Desktop layout check", "12.34");
        const composer = page.getByRole("dialog", { name: "Add an expense" });
        const composerBox = await composer.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, top: rect.top, bottom: rect.bottom };
        });
        const checks = [
          makeCheck("desktop-sidebar", "Desktop navigation replaces the phone tab bar", await page.locator(".desktop-sidebar").isVisible() && !(await page.locator(".mobile-tabbar").isVisible()), "1440×900 viewport"),
          makeCheck("desktop-composer", "Expense form remains centered and readable", composerBox.width >= 480 && composerBox.width <= 640 && composerBox.top >= 0 && composerBox.bottom <= 900, JSON.stringify(composerBox)),
        ];
        await recordStep(report, responsive, outputDirectory, {
          id: "desktop-form",
          title: "Desktop navigation and expense form",
          sessions: [desktopSession],
          checks,
        });
        await composer.getByRole("button", { name: "Cancel expense form" }).click();
      } finally {
        await context.close();
      }
    });

    const importedClaim = findScenario("imported-identity-claim");
    if (importedClaim) await runCase(report, importedClaim, outputDirectory, async () => {
      const owner = sessions.find(({ actor }) => actor.id === "maya");
      const claimant = sessions.find(({ actor }) => actor.id === "dev");
      const observer = sessions.find(({ actor }) => actor.id === "mira");
      if (!owner || !claimant || !observer) throw new Error("Imported-identity actors are unavailable");
      const imported = IMPORT_CLAIM_SCENARIO;
      const before = await Promise.all([bridgeSnapshot(owner.page), bridgeSnapshot(claimant.page)]);
      await recordStep(report, importedClaim, outputDirectory, {
        id: "isolated-before-claim",
        title: "The placeholder history is not readable by the real account",
        sessions: [owner, claimant],
        clients: before,
        server: readScenarioServerSnapshot(runtime!.databasePath, imported.groupId),
        checks: [
          makeCheck("owner-has-import", "The migration owner sees the imported group", before[0]!.groups.some(({ id }) => id === imported.groupId), `${before[0]!.groups.length} owner groups`),
          makeCheck("claimant-isolated", "The signed-in claimant cannot read placeholder history before approval", !before[1]!.groups.some(({ id }) => id === imported.groupId), `${before[1]!.groups.length} claimant groups`),
        ],
      });

      const link = await scenarioApi<{ url: string }>(
        runtime!.apiUrl,
        owner.actor.id,
        `/api/v1/imports/${imported.batchId}/identities/${imported.identityId}/claim-link`,
        { method: "POST" },
      );
      const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("migrationClaim");
      if (!token) throw new Error("The scenario claim link did not contain a token");
      const request = await scenarioApi<{ status: string; requestId?: string }>(
        runtime!.apiUrl,
        claimant.actor.id,
        "/api/v1/import-claims/claim",
        { method: "POST", body: JSON.stringify({ token }) },
      );
      if (request.status !== "awaiting_owner") throw new Error(`Unexpected claim state ${request.status}`);
      await scenarioApi(
        runtime!.apiUrl,
        owner.actor.id,
        `/api/v1/import-identities/${imported.identityId}/approve`,
        { method: "POST" },
      );
      await Promise.all([forceSync(owner), forceSync(claimant), forceSync(observer)]);

      let after: ScenarioClientSnapshot[] = [];
      await waitUntil("imported history to converge after approval", async () => {
        after = await Promise.all([bridgeSnapshot(owner.page), bridgeSnapshot(claimant.page), bridgeSnapshot(observer.page)]);
        const ownerExpense = after[0]!.expenses.find(({ id }) => id === imported.expenseId);
        const claimantExpense = after[1]!.expenses.find(({ id }) => id === imported.expenseId);
        return after[0]!.groups.some(({ id }) => id === imported.groupId)
          && after[1]!.groups.some(({ id }) => id === imported.groupId)
          && !after[2]!.groups.some(({ id }) => id === imported.groupId)
          && ownerExpense?.yourNetMinor === imported.amountMinor
          && claimantExpense?.yourNetMinor === -imported.amountMinor;
      });
      const server = readScenarioServerSnapshot(runtime!.databasePath, imported.groupId);
      const evidence = readScenarioImportClaimEvidence(runtime!.databasePath);
      const observerSnapshot = await scenarioApi<{ participantAliases?: unknown[] }>(runtime!.apiUrl, observer.actor.id, "/api/v1/snapshot");
      const ownerExpense = after[0]!.expenses.find(({ id }) => id === imported.expenseId);
      const claimantExpense = after[1]!.expenses.find(({ id }) => id === imported.expenseId);
      await recordStep(report, importedClaim, outputDirectory, {
        id: "approved-and-converged",
        title: "Both devices agree after verified owner approval",
        sessions: [owner, claimant, observer],
        clients: after,
        server,
        note: "The accepted signed operation still names the non-readable placeholder; a group-scoped alias safely projects it onto the approved account.",
        checks: [
          ...evaluateLedger(server).checks,
          makeCheck("claim-complete", "The placeholder was securely claimed by the intended account", evidence.identityStatus === "claimed" && evidence.claimedByUserId === claimant.actor.id, JSON.stringify(evidence)),
          makeCheck("group-parity", "Owner and claimant now see the same imported group", after.slice(0, 2).every((client) => client.groups.some(({ id }) => id === imported.groupId)), `${after[0]!.groups.length}/${after[1]!.groups.length} groups`),
          makeCheck("history-parity", "Both devices received the same imported expense", ownerExpense?.amountMinor === imported.amountMinor && claimantExpense?.amountMinor === imported.amountMinor, `${ownerExpense?.amountMinor}/${claimantExpense?.amountMinor}`),
          makeCheck("balance-parity", "The imported balance has equal and opposite device projections", ownerExpense?.yourNetMinor === imported.amountMinor && claimantExpense?.yourNetMinor === -imported.amountMinor, `${ownerExpense?.yourNetMinor}/${claimantExpense?.yourNetMinor}`),
          makeCheck("signed-history-immutable", "Claiming did not rewrite the accepted signed operation", evidence.signedAllocationParticipantId === imported.placeholderUserId && evidence.materializedAllocationParticipantId === claimant.actor.id, JSON.stringify(evidence)),
          makeCheck("observer-isolated-from-alias", "An unrelated group member receives neither the group nor its identity alias", !after[2]!.groups.some(({ id }) => id === imported.groupId) && (observerSnapshot.participantAliases?.length ?? 0) === 0, `${after[2]!.groups.length} groups · ${observerSnapshot.participantAliases?.length ?? 0} aliases`),
        ],
      });
    });

    const concurrent = findScenario("four-way-create");
    if (concurrent) await runCase(report, concurrent, outputDirectory, async () => {
      const inputs = [
        { description: "Ramen dinner", amount: "55.50" },
        { description: "Train tickets", amount: "74.00" },
        { description: "Groceries", amount: "42.25" },
        { description: "Beach cab", amount: "36.00" },
      ];
      const submissions = await Promise.all(sessions.map((session, index) =>
        prepareExpense(session.page, inputs[index]!.description, inputs[index]!.amount),
      ));
      const formChecks = await Promise.all(sessions.map(async ({ page, actor }) => {
        const composer = page.getByRole("dialog", { name: "Add an expense" });
        const details = await composer.locator(".quick-control").evaluateAll((buttons) => buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { label: button.textContent?.trim() ?? "", width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
        }));
        const naturalTextareaVisible = await composer.getByPlaceholder(/I paid \$35/).isVisible().catch(() => false);
        return makeCheck(
          `form-first-${actor.id}`,
          `${actor.name} sees the compact form without scrolling`,
          !naturalTextareaVisible && details.length === 3 && details.every(({ width, height, top, bottom }) => width >= 88 && height >= 44 && top >= 0 && bottom <= 844),
          `controls=${JSON.stringify(details)}`,
        );
      }));
      await recordStep(report, concurrent, outputDirectory, {
        id: "form-ready",
        title: "The structured form is compact on every phone",
        sessions,
        note: "Form entry is the default; payer, split, and date are all visible in one row at 390×844.",
        checks: formChecks,
      });

      const keyboardSession = sessions[0]!;
      const firstComposer = keyboardSession.page.getByRole("dialog", { name: "Add an expense" });
      await firstComposer.getByPlaceholder("What was it for?").focus();
      await keyboardSession.page.setViewportSize({ width: 390, height: 500 });
      await keyboardSession.page.waitForTimeout(150);
      const compactControls = await firstComposer.locator(".quick-control").evaluateAll((buttons) => buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }));
      const keyboardChecks: ScenarioCheck[] = [makeCheck(
        "keyboard-controls-reachable",
        "Paid by, Split, and Date stay reachable above a reduced keyboard viewport",
        compactControls.length === 3 && compactControls.every(({ top, bottom }) => top >= 0 && bottom <= 500),
        JSON.stringify(compactControls),
      )];
      const panelCases = [
        { id: "payer", button: /Paid by/, label: "Choose who paid" },
        { id: "split", button: /Split/, label: "Choose how to split" },
        { id: "date", button: /Date/, label: "Choose expense date" },
      ] as const;
      for (const panelCase of panelCases) {
        await firstComposer.getByRole("button", { name: panelCase.button }).click();
        const panel = firstComposer.getByLabel(panelCase.label);
        await panel.waitFor({ state: "visible" });
        const panelCheck = await panel.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            fixed: getComputedStyle(element).position === "fixed",
            withinViewport: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
            activeTag: document.activeElement?.tagName ?? "",
          };
        });
        keyboardChecks.push(makeCheck(
          `keyboard-safe-${panelCase.id}`,
          `${panelCase.id} choices replace text input without leaving the reduced viewport`,
          panelCheck.fixed && panelCheck.withinViewport && !["INPUT", "TEXTAREA", "SELECT"].includes(panelCheck.activeTag),
          JSON.stringify(panelCheck),
        ));
        if (panelCase.id === "split") {
          await panel.getByRole("button", { name: "Amounts" }).click();
          const lastExactInput = panel.getByLabel(/^Amount for /).last();
          await lastExactInput.focus();
          await keyboardSession.page.waitForTimeout(150);
          const inputBox = await lastExactInput.evaluate((input) => {
            const rect = input.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
          });
          keyboardChecks.push(makeCheck(
            "keyboard-safe-exact-split",
            "The active exact-split input scrolls inside the picker instead of behind the keyboard",
            inputBox.top >= 0 && inputBox.bottom <= inputBox.viewport,
            JSON.stringify(inputBox),
          ));
        }
        await panel.getByRole("button", { name: "Done" }).click();
        await firstComposer.getByPlaceholder("What was it for?").focus();
      }
      await recordStep(report, concurrent, outputDirectory, {
        id: "keyboard-safe-details",
        title: "Every fast detail remains usable with the keyboard open",
        sessions: [keyboardSession],
        note: "The visual viewport is reduced to 390×500 while the description owns focus, reproducing the covered-controls failure without relying on a desktop-only screenshot.",
        checks: keyboardChecks,
      });
      await keyboardSession.page.setViewportSize({ width: 390, height: 844 });

      const barrier = new ScenarioBarrier(sessions.length);
      await Promise.all(submissions.map(async (submit) => {
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
      const maya = sessions[0]!;
      await maya.context.setOffline(true);
      const submit = await prepareExpense(maya.page, "Offline fuel", "28.40");
      await submit();
      let offlineSnapshot: ScenarioClientSnapshot | undefined;
      await waitUntil("offline operation to remain pending", async () => {
        offlineSnapshot = await bridgeSnapshot(maya.page);
        return offlineSnapshot.expenses.some(({ description, syncStatus }) => description === "Offline fuel" && syncStatus === "pending");
      });
      const offlineServer = readScenarioServerSnapshot(runtime!.databasePath);
      const queuedChecks = [
        makeCheck("local-first", "The offline expense is visible on Maya's device", Boolean(offlineSnapshot?.expenses.some(({ description }) => description === "Offline fuel")), "Saved to isolated IndexedDB"),
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

      await maya.context.setOffline(false);
      await forceSync(maya);
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
