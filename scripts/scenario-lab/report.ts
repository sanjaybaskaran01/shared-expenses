import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScenarioActor, ScenarioCheck, ScenarioClientSnapshot, ScenarioServerSnapshot } from "./model";

export interface ScenarioStepReport {
  id: string;
  title: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  note?: string;
  screenshots: Record<string, string>;
  clients?: ScenarioClientSnapshot[];
  server?: ScenarioServerSnapshot;
  checks: ScenarioCheck[];
}

export interface ScenarioCaseReport {
  id: string;
  title: string;
  purpose: string;
  status: "pending" | "running" | "passed" | "failed";
  steps: ScenarioStepReport[];
}

export interface ScenarioRunReport {
  schemaVersion: 1;
  runId: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  actors: readonly ScenarioActor[];
  apiUrl: string;
  webUrl: string;
  scenarios: ScenarioCaseReport[];
  error?: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function moneyMinor(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}

function renderCheck(check: ScenarioCheck): string {
  return `<li class="check ${check.status}"><span>${check.status === "passed" ? "✓" : "!"}</span><div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div></li>`;
}

function renderEvidence(step: ScenarioStepReport, actors: readonly ScenarioActor[]): string {
  if (!step.clients?.length && !step.server) return "";
  const clientCards = (step.clients ?? []).map((client) => {
    const actor = actors.find(({ id }) => id === client.actorId);
    const pending = client.operations.filter(({ syncStatus }) => syncStatus === "pending").length;
    const conflicts = client.operations.filter(({ syncStatus }) => syncStatus === "conflicted").length;
    return `<div class="client-proof"><div><i style="--actor:${actor?.color ?? "#667078"}"></i><strong>${escapeHtml(actor?.name ?? client.actorId)}</strong></div><span>${escapeHtml(client.connection)}</span><small>${client.expenses.length} expenses · ${pending} pending · ${conflicts} conflicts</small></div>`;
  }).join("");
  const expenseRows = (step.server?.expenses ?? []).map((expense) => `<tr><td>${escapeHtml(expense.description)}</td><td>${escapeHtml(moneyMinor(expense.amountMinor))}</td><td>v${expense.version}</td><td>${expense.payers.length} paid · ${expense.allocations.length} split</td></tr>`).join("");
  const operationCounts = (step.server?.operations ?? []).reduce<Record<string, number>>((counts, operation) => {
    counts[operation.status] = (counts[operation.status] ?? 0) + 1;
    return counts;
  }, {});
  return `<section class="evidence"><div class="evidence-title"><strong>Machine-verifiable checkpoint</strong><span>${step.server ? `${step.server.expenses.length} canonical expenses · ${operationCounts.accepted ?? 0} accepted · ${operationCounts.conflicted ?? 0} conflicted` : "Local device state"}</span></div>${clientCards ? `<div class="client-grid">${clientCards}</div>` : ""}${expenseRows ? `<div class="table-scroll"><table><thead><tr><th>Canonical expense</th><th>Amount</th><th>Version</th><th>Structure</th></tr></thead><tbody>${expenseRows}</tbody></table></div>` : ""}</section>`;
}

function renderStep(step: ScenarioStepReport, actors: readonly ScenarioActor[]): string {
  const screens = actors.map((actor) => {
    const source = step.screenshots[actor.id];
    return `<figure><figcaption><i style="--actor:${actor.color}"></i>${escapeHtml(actor.name)}</figcaption>${source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(`${actor.name} after ${step.title}`)}">` : `<div class="screen-placeholder">Waiting for evidence</div>`}</figure>`;
  }).join("");
  return `<article class="step ${step.status}">
    <header><div><span class="step-id">${escapeHtml(step.id)}</span><h3>${escapeHtml(step.title)}</h3></div><span class="status">${escapeHtml(step.status)}</span></header>
    ${step.note ? `<p class="note">${escapeHtml(step.note)}</p>` : ""}
    <div class="phone-grid">${screens}</div>
    ${renderEvidence(step, actors)}
    <ul class="checks">${step.checks.map(renderCheck).join("")}</ul>
  </article>`;
}

function reportHtml(report: ScenarioRunReport): string {
  const passedChecks = report.scenarios.flatMap(({ steps }) => steps.flatMap(({ checks }) => checks)).filter(({ status }) => status === "passed").length;
  const failedChecks = report.scenarios.flatMap(({ steps }) => steps.flatMap(({ checks }) => checks)).filter(({ status }) => status === "failed").length;
  const scenarios = report.scenarios.map((scenario) => `<section class="scenario">
    <div class="scenario-heading"><div><span>Scenario ${escapeHtml(scenario.id)}</span><h2>${escapeHtml(scenario.title)}</h2><p>${escapeHtml(scenario.purpose)}</p></div><b class="status">${escapeHtml(scenario.status)}</b></div>
    ${scenario.steps.map((step) => renderStep(step, report.actors)).join("") || `<div class="empty">Waiting to start</div>`}
  </section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${report.status === "running" ? '<meta http-equiv="refresh" content="2">' : ""}<title>Tally Scenario Lab · ${escapeHtml(report.runId)}</title>
<style>
:root{color-scheme:light;--ink:#1c2429;--muted:#667078;--line:#dfe2df;--paper:#f4f2ed;--card:#fff;--ok:#176b4a;--bad:#a9432d;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}main{width:min(1500px,100%);margin:auto;padding:28px}.run-head{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;padding:26px 0;border-bottom:1px solid var(--line)}.eyebrow,.scenario-heading span,.step-id{font:700 11px/1.2 ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(28px,4vw,52px);letter-spacing:-.045em;margin:8px 0 5px}h2,h3,p{margin:0}.run-meta{display:flex;gap:10px;flex-wrap:wrap}.metric{min-width:108px;border:1px solid var(--line);background:rgba(255,255,255,.7);padding:12px 14px;border-radius:10px}.metric small{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;margin-top:3px;font-size:19px}.scenario{padding:30px 0;border-bottom:1px solid var(--line)}.scenario-heading{display:grid;grid-template-columns:1fr auto;gap:20px;margin-bottom:16px}.scenario-heading h2{margin:5px 0;font-size:25px;letter-spacing:-.025em}.scenario-heading p{color:var(--muted);max-width:720px}.status{align-self:start;border:1px solid var(--line);border-radius:999px;padding:7px 10px;font:700 10px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em;text-transform:uppercase}.step{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:14px;box-shadow:0 8px 30px rgba(24,34,38,.04)}.step>header{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:14px}.step h3{font-size:17px;margin-top:4px}.note{color:var(--muted);font-size:13px;margin:-5px 0 15px}.phone-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#f8f8f6}figcaption{height:38px;display:flex;align-items:center;gap:8px;padding:0 10px;font-size:12px;font-weight:650;background:#fff;border-bottom:1px solid var(--line)}figcaption i,.client-proof i{width:8px;height:8px;border-radius:2px;background:var(--actor)}figure img{display:block;width:100%;aspect-ratio:390/844;object-fit:cover;object-position:top}.screen-placeholder{display:grid;place-items:center;aspect-ratio:390/844;color:var(--muted);font-size:12px}.evidence{margin-top:14px;border:1px solid var(--line);border-radius:10px;overflow:hidden}.evidence-title{display:flex;justify-content:space-between;gap:12px;padding:12px;background:#f8f8f6;border-bottom:1px solid var(--line);font-size:12px}.evidence-title span{color:var(--muted)}.client-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--line)}.client-proof{padding:11px 12px;border-right:1px solid var(--line)}.client-proof:last-child{border-right:0}.client-proof div{display:flex;align-items:center;gap:7px}.client-proof span{float:right;margin-top:-15px;font-size:10px;color:var(--muted)}.client-proof small{display:block;margin-top:5px;color:var(--muted);font-size:10px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:11px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:600;background:#fcfcfb}tbody tr:last-child td{border-bottom:0}.checks{list-style:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0 0;padding:0}.check{display:flex;gap:9px;padding:10px;border:1px solid var(--line);border-radius:8px}.check>span{display:grid;place-items:center;flex:0 0 22px;height:22px;border-radius:50%;font-weight:800}.check.passed>span{background:#e4f2ea;color:var(--ok)}.check.failed>span{background:#f7e5e0;color:var(--bad)}.check strong,.check small{display:block}.check strong{font-size:12px}.check small{font-size:11px;color:var(--muted);margin-top:2px}.empty{border:1px dashed var(--line);padding:30px;text-align:center;color:var(--muted);border-radius:12px}.error{margin-top:16px;background:#f7e5e0;color:var(--bad);padding:14px;border-radius:10px;font:12px/1.5 ui-monospace,SFMono-Regular,monospace}@media(max-width:900px){main{padding:18px}.run-head{grid-template-columns:1fr}.phone-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.client-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.client-proof:nth-child(2){border-right:0}.client-proof:nth-child(-n+2){border-bottom:1px solid var(--line)}.checks{grid-template-columns:1fr}}@media(max-width:520px){.phone-grid,.client-grid{grid-template-columns:1fr}.client-proof{border-right:0;border-bottom:1px solid var(--line)}.client-proof:nth-child(3){border-bottom:1px solid var(--line)}.client-proof:last-child{border-bottom:0}.evidence-title{display:grid}.run-meta{display:grid;grid-template-columns:1fr 1fr}.metric{min-width:0}}
</style></head><body><main>
<header class="run-head"><div><span class="eyebrow">Tally · deterministic multi-user test</span><h1>Scenario Lab</h1><p>Four isolated people. One disposable ledger. Evidence after every synchronized step.</p></div><div class="run-meta"><div class="metric"><small>Run</small><strong>${escapeHtml(report.runId.slice(-8))}</strong></div><div class="metric"><small>Status</small><strong>${escapeHtml(report.status)}</strong></div><div class="metric"><small>Passed checks</small><strong>${passedChecks}</strong></div><div class="metric"><small>Failed checks</small><strong>${failedChecks}</strong></div></div></header>
${report.error ? `<div class="error">${escapeHtml(report.error)}</div>` : ""}${scenarios}
</main></body></html>`;
}

export async function writeScenarioReport(outputDirectory: string, report: ScenarioRunReport): Promise<void> {
  await Promise.all([
    writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(outputDirectory, "index.html"), reportHtml(report), { mode: 0o600 }),
  ]);
}
