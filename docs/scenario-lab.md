# Four-person Scenario Lab

The Scenario Lab is a deterministic, zero-cost multi-user system test for Tally. It operates the real mobile interface as four people at the same time, then compares every device with an independent view of the SQLite ledger.

It deliberately uses scripted actors instead of an LLM for the acceptance layer. The same inputs, barriers, and invariants produce reproducible failures; an exploratory AI user can be added later without weakening the deterministic gate.

## Run it

Requirements are the repository's pinned Bun dependencies and either Google Chrome or Playwright Chromium.

```sh
bun install --frozen-lockfile
bun run scenario:lab
```

The default command uses visible phone-sized browser windows and opens a live report. For CI-style or unattended verification:

```sh
bun run scenario:lab:headless
```

If neither supported browser is installed, run `bunx playwright install chromium` once. The lab itself has no service, model, token, or database cost.

## What it tests

Each run creates four isolated browser contexts at 390×844. Cookies, device keys, IndexedDB, and sync cursors are separate for Maya, Dev, Mira, and Arjun.

1. **Four-way create:** all four people prepare a different expense and one barrier releases the four submit actions together. Realtime propagation must converge without a forced refresh.
2. **Offline replay:** Maya loses connectivity, records a purchase locally, and reconnects. The server must not see it early, and every device must eventually see it once.
3. **Lost response:** the server accepts Dev's signed operation while the browser receives a synthetic network failure. Retrying must produce one operation and one expense, not a duplicate.
4. **Concurrent edit:** Mira and Arjun amend the same base version together. One value becomes canonical and the losing device must retain a visible, reviewable conflict.
5. **Authorization:** an unrelated authenticated development actor requests a snapshot and must receive no group or expense data.

## Independent oracle

A green UI is not treated as proof. At each checkpoint, the lab reads the disposable server database independently and verifies:

- every active expense is fully paid and fully allocated;
- every financial participant is an active group member;
- all member balances sum to zero;
- operation IDs are unique and retries are idempotent;
- canonical expense IDs, descriptions, amounts, versions, and statuses converge on all applicable devices;
- queued writes remain local while offline;
- stale edits produce one canonical winner and one explicit conflict;
- a non-member receives no scoped financial data.

## Evidence

Every run creates an ignored directory under `artifacts/scenario-lab/<run-id>/` containing:

- `index.html`: responsive 2×2 phone review, per-device state, canonical expense table, and pass/fail checks;
- `report.json`: machine-readable checkpoints, client snapshots, server projections, and failure details;
- `screenshots/`: one image per actor at every completed checkpoint;
- `sandbox.sqlite`: the disposable ledger for forensic queries;
- API and web process logs.

Failed runs exit nonzero and preserve their evidence. Successful and failed artifacts are never committed.

## Safety boundaries

- The sandbox database and attachments directory are created inside the run artifact, never taken from environment files.
- The API and web app bind only to `127.0.0.1` on dynamically allocated ports.
- Scenario identities are accepted only by the existing development-auth bypass. Production configuration rejects that bypass.
- The browser scenario bridge is loaded only when Vite is in development mode and a validated `scenarioActor` query is present.
- SMTP and Google credentials are explicitly blanked for the sandbox. No email, invite, OAuth, Cloudflare, deployment, or production API is used.
- The current API source is bundled into the disposable run directory, alongside copied migrations, before execution.

## Adding a scenario

Add a case to `scripts/scenario-lab/run.ts`, express simultaneous actions with `ScenarioBarrier`, and prove the result using the server snapshot and client snapshots rather than a toast alone. Add pure invariant or coordination behavior to `scripts/scenario-lab/model.ts` with a Bun test in `scripts/test/scenario-lab.test.ts`.

Keep scenarios deterministic, use public UI interactions for user actions, and reserve the development bridge for observation and explicit sync control. A scenario should fail with evidence that explains which actor, operation, or invariant diverged.
