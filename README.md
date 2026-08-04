# Tallied

Tallied is an installable, offline-first shared-expense ledger. It is designed to keep recording fast when the network is unavailable and reconcile signed changes when connectivity returns.

This is an original implementation in the shared-expense product category. It does not use another product's branding, source code, or proprietary assets.

## What works

- Multiple groups and people, with balances kept separate by currency.
- Expense create, edit, delete, restore, comments, multiple payers, and five split methods.
- Payments, deterministic settlement suggestions, activity history, and spending charts.
- IndexedDB-first writes, background reconciliation, idempotent operations, and conflict records.
- Invite-only Google or email-link authentication.
- Standalone, single-use contact invitations with five credits per account and native sharing.
- Signed P-256 device operations and strict server-side membership checks.
- An experimental v2 server-blind sync boundary using AES-256-GCM group keys wrapped to member devices.

The existing v1 ledger still stores readable projections on its server. The v2 cryptographic path is implemented and tested, but the product UI has not been migrated to it yet. See [the privacy model](docs/privacy-model.md) before making confidentiality claims.

## Fast local start

Requirements: [Bun 1.3.10](https://bun.sh/) and a modern browser.

```sh
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:5173`. Then verify everything with:

```sh
bun run check
```

## Four-person Scenario Lab

Exercise the real interface as Maya, Dev, Mira, and Arjun in four isolated mobile browser profiles:

```sh
bun run scenario:lab           # headed; opens the live evidence report
bun run scenario:lab:headless  # unattended verification
```

The lab runs simultaneous expenses, offline replay, an accepted write with a lost response, competing edits, and outsider authorization against a disposable SQLite ledger on random local ports. It never reads or mutates a development or production database. Each run writes an ignored HTML/JSON evidence package under `artifacts/scenario-lab/`. See [Scenario Lab](docs/scenario-lab.md) for its oracle, safety boundaries, and extension guide.

## One-origin self-hosting

The simplest deployment keeps the browser, API, cookies, and CSP on one origin. Docker Compose builds both services, stores SQLite in one named volume, and exposes only the web gateway on localhost:

```sh
cp apps/server/.env.example .env
# Edit .env: owner identity, a strong auth secret, and one sign-in provider.
docker compose up -d --build
```

Open `http://localhost:8080`. Put a TLS reverse proxy in front before using it across the public internet. Detailed setup and provider tradeoffs are in [Self-hosting](docs/self-hosting.md) and [Storage portability](docs/storage-portability.md).

## Security boundaries

- Browser clients never receive database credentials.
- Authentication is not authorization: every data path also checks active group membership.
- Device signatures establish provenance and tamper evidence; they do not encrypt v1 data.
- The v2 confidential store accepts only authenticated, member-scoped, device-signed ciphertext.
- Invite bearer tokens are random, single-use, stored only as hashes, and placed in URL fragments to avoid request logs and referrers.
- Phone contacts are not uploaded. iPhone uses the native share sheet or Messages recipient picker; supported Android browsers may expose a one-contact picker as a progressive enhancement.

Read [Security](SECURITY.md), [Privacy model](docs/privacy-model.md), and [Architecture](docs/architecture.md) before operating a public instance.

## Repository policy

The public repository contains product code, generic deployment examples, and non-sensitive architecture documentation. It intentionally excludes real domains, personal email addresses, host paths, tunnel identifiers/tokens, database files, backups, private runbooks, and production environment files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tallied is licensed under the [GNU Affero General Public License v3.0](LICENSE).
