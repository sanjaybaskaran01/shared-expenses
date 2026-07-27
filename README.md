# Expenses

Expenses is an installable, offline-first shared-expense ledger. A phone writes each expense to IndexedDB before any network request, signs the operation with a per-device P-256 key, and reconciles it with a Bun/SQLite server whenever the server is reachable.

This repository is an original implementation inspired by the shared-expense product category. It does not use any third-party branding, source code, or proprietary assets.

## Current milestone

The working vertical slice includes:

- Installable SolidJS PWA with an original visual system and generated app icons.
- Group expense entry with payer selection and equal participant splits.
- Immediate local saves that continue while the API or host Mac is offline.
- Background push/pull reconciliation, idempotent operation UUIDs, and SSE wakeups.
- Deterministic canonical JSON, SHA-256 content hashes, and P-256 device signatures.
- Append-only server ledger, SQLite projections, explicit stale-edit conflicts, and membership checks.
- Invite-only, verified, single-use email sign-in through Better Auth.
- Transactional Gmail SMTP outbox with retry and idempotency.
- Cloudflare Pages/Tunnel, native macOS `launchd`, Docker Compose, and encrypted-backup scaffolding.

Receipt capture, OCR, detailed edit/conflict UI, settlement UI, arbitrary split methods, and an admin dashboard remain later milestones. OCR is intentionally outside v1.

## Architecture

```text
Phone PWA (IndexedDB + device key)
  ├── static shell ──> Cloudflare Pages
  └── signed sync ──> Cloudflare Tunnel ──> Bun API ──> SQLite + local files
                                                       └── Gmail SMTP outbox
```

The public app shell remains available when the Mac is down. A previously authenticated browser can keep appending expenses locally; it reconciles after the API reconnects. New-device login and email delivery require the API to be online.

## Local development

Requirements: [Bun 1.3.10](https://bun.sh/) and a modern browser.

```sh
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:5173`. Development mode uses a local auth bypass and seeds a `Weekend trip` group with two participants. The API listens only on `127.0.0.1:3000`.

Run the full verification suite:

```sh
bun run check
```

## Hosted v1 setup

The accepted zero-incremental-cost deployment is:

- `expenses.example.com` (pick your own domain): Cloudflare Pages, built from `apps/web/dist`.
- `api.expenses.example.com` (pick your own subdomain): Cloudflare Tunnel to `127.0.0.1:3000` on the existing Mac.
- SQLite and attachments: a non-iCloud local data directory.
- Encrypted completed backups only: copied into iCloud Drive.
- Email: Gmail SMTP with an app password and an address at your own domain as the requested From address.

### 1. Production environment

Copy `apps/server/.env.example` to a secret location outside the repository and set at least:

```dotenv
NODE_ENV=production
EXPENSES_BUN_PATH=/absolute/path/from-command-v-bun
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/absolute/private/path/expenses.sqlite
ATTACHMENTS_PATH=/absolute/private/path/attachments
WEB_ORIGIN=https://expenses.example.com
PUBLIC_API_URL=https://api.expenses.example.com
BETTER_AUTH_SECRET=
BETTER_AUTH_SECRET_KEYCHAIN_SERVICE=shared-expenses-auth
COOKIE_DOMAIN=
DEV_AUTH_BYPASS=false
OWNER_EMAIL=your-real-invited-email@example.com
BOOTSTRAP_GROUP_NAME=Shared expenses
SMTP_USER=maintainer@example.com
SMTP_APP_PASSWORD=
SMTP_APP_PASSWORD_KEYCHAIN_SERVICE=shared-expenses-smtp
SMTP_FROM=expenses@example.com
```

`OWNER_EMAIL` is the only email allowed to create the first account. Invited placeholder members may then create accounts. Sign-in uses a verified, single-use link and does not require a password. `COOKIE_DOMAIN` is optional; set it (e.g. `.expenses.example.com`) only if the web app and API share a parent domain and you want the session cookie shared across both subdomains.

Keep this environment file out of Git, backups, shell history, and launch-agent XML. Restrict it with `chmod 600`; the included `scripts/run-server.sh` loads it for `launchd` through the non-secret `EXPENSES_ENV_FILE` path. When either Keychain service variable is set, the runner reads that secret from the macOS login Keychain and overrides the corresponding plaintext variable, so production does not need either secret in the env file.

### 2. Build and run the API

```sh
bun run check
bun --filter @expenses/server build
bun apps/server/dist/index.js
```

The example `launchd` files in `deploy/` contain placeholders on purpose. Copy them to `~/Library/LaunchAgents`, replace every placeholder with an explicit absolute path, and validate them with `plutil -lint` before loading. A cold reboot still requires a person to unlock FileVault and log in.

### 3. Publish the PWA

Create a Cloudflare Pages project with:

- Build command: `bun install --frozen-lockfile && VITE_API_URL=https://api.expenses.example.com bun --cwd apps/web run build` (substitute your real API hostname)
- Output directory: `apps/web/dist`
- Custom domain: your chosen web hostname (e.g. `expenses.example.com`)

The repository includes static-host security and cache headers. Before deploying, update the `connect-src` origin in `apps/web/public/_headers` from the placeholder `https://api.expenses.example.com` to your real API hostname — it must match `PUBLIC_API_URL`/`VITE_API_URL` or the browser will block API requests under CSP. Do not proxy the PWA through the home Mac; that would defeat offline app-shell availability.

### 4. Expose only the API

Install `cloudflared`, create a named tunnel, and route only your API hostname (e.g. `api.expenses.example.com`) to `http://127.0.0.1:3000`. Do not add a router port-forward. For a token-managed tunnel, store the token in macOS Keychain under service `shared-expenses-tunnel`, then adapt `deploy/com.shared-expenses.tunnel.plist.example`; its runner reads the token at startup without putting it in the plist or process arguments. `deploy/cloudflared-config.example.yml` remains available for credential-file installations.

### 5. Validate Gmail delivery

The selected From address is a Cloudflare-forwarded alias, not necessarily an authenticated Gmail sending identity. Before inviting anyone, send real verification messages to Gmail, Outlook, and iCloud. Inspect `Authentication-Results` for SPF, DKIM, and DMARC alignment and confirm whether Google exposes the underlying Gmail address. Strict DMARC may reject this arrangement; deployment is not complete until those tests pass.

No Resend integration is present.

## Backups

The scripts require `sqlite3`, `age`, `tar`, and `shasum`. Generate an age identity once, keep the private identity outside the backup destination, and store an additional recovery copy in a password manager or offline medium.

```sh
EXPENSES_DATABASE_PATH=/private/data/expenses.sqlite \
EXPENSES_ATTACHMENTS_PATH=/private/data/attachments \
EXPENSES_BACKUP_DESTINATION="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Expenses Backups" \
EXPENSES_AGE_RECIPIENT=age1... \
./scripts/backup.sh

EXPENSES_AGE_IDENTITY=/private/keys/expenses-age-key.txt \
./scripts/verify-backup.sh "/path/to/expenses-YYYYMMDDTHHMMSSZ.tar.gz.age"
```

The backup script uses SQLite's online backup command, verifies database integrity, hashes the payload, encrypts it locally, and only then moves the completed archive into the destination. It never applies retention deletion automatically.

For an unattended Mac deployment, copy `scripts/run-backup.sh` and `scripts/backup.sh` outside protected workspace folders, add the four backup variables shown above to the permissions-restricted production env file, and adapt `deploy/com.shared-expenses.backup.plist.example`. The example runs daily at 03:00 local time; verify at least one encrypted archive with `scripts/verify-backup.sh` before relying on the schedule.

After deliberately restoring an older database, rotate its server generation before starting the API:

```sh
bun run recovery:new-generation /absolute/path/to/restored.sqlite
```

Trusted clients detect that change, reset their pull cursor, and replay their complete retained signed ledgers in bounded batches. Never run this command against the normal live database; it is a restore-only reconciliation trigger.

## Portable OSS deployment

Docker Compose is provided as the deferred self-hosting mechanism:

```sh
cp apps/server/.env.example .env
docker compose build
docker compose up -d
```

The default bindings expose the API and web container on localhost only. Put your own TLS reverse proxy or tunnel in front of them. The hosted v1 should use native Bun plus `launchd` on the Mac; Docker Desktop is not required there.

## Ledger guarantees

- Money is stored as integer minor units; floating-point currency arithmetic is prohibited.
- Operations are immutable and identified by permanent UUIDs.
- Duplicate pushes are harmless.
- Financial amendments with stale base versions become explicit conflicts.
- Device signatures establish provenance but never bypass membership or authorization.
- “Settle up” will record an external payment; this application will not move money.
- Multiple currencies stay separate unless a user records an explicit conversion rate.

## Product and infrastructure documents

- [Product requirements and build prompt](outputs/shared-expense-prd-and-build-prompt.md)
- [Accepted zero-cost infrastructure plan](outputs/zero-cost-fast-stack-infrastructure-plan.md)

## License

[GNU Affero General Public License v3.0](LICENSE).
