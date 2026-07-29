# Tally

Tally is an installable, offline-first shared-expense ledger. A phone writes each expense to IndexedDB before any network request, signs the operation with a per-device P-256 key, and reconciles it with a Bun/SQLite server whenever the server is reachable.

This repository is an original implementation inspired by the shared-expense product category. It does not use Splitwise branding, source code, or proprietary assets.

## Current milestone

The working vertical slice includes:

- Installable, iPhone-first SolidJS PWA with a source-owned component system, light/dark appearance, glass navigation, motion, and generated app icons.
- Multiple groups with contextual group switching, group-level ledgers, per-currency balances, and member views.
- Expense create/edit/delete/restore with equal, exact, percentage, shares, and adjustment splits.
- Single or multiple payers, category/currency/date/recurrence metadata, notes, and expense comments.
- Basic analytics with total/personal spend plus category and monthly charts, loaded lazily with ECharts' SVG renderer.
- Payment recording, deterministic settlement suggestions, payment-aware balances, and a complete signed Activity feed.
- Immediate local saves that continue while the API or host Mac is offline.
- Background push/pull reconciliation, idempotent operation UUIDs, and SSE wakeups.
- Deterministic canonical JSON, SHA-256 content hashes, and P-256 device signatures.
- Append-only server ledger, SQLite projections, explicit stale-edit conflicts, and membership checks.
- Invite-only sign-in through Google or a verified, single-use email link, backed by the same Better Auth session.
- Transactional Gmail SMTP outbox with retry and idempotency.
- Cloudflare Pages/Tunnel, native macOS `launchd`, Docker Compose, and encrypted-backup scaffolding.

Receipt capture/OCR, itemized receipt splitting, full-text search, advanced group administration, notifications, exports, billing, and regulated money movement remain later milestones. OCR is intentionally outside v1.

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

- `expenses.sanjaybaskaran.com`: Cloudflare Workers Static Assets, built from `apps/web/dist`.
- `api.sanjaybaskaran.com`: Cloudflare Tunnel to `127.0.0.1:3000` on the existing Mac.
- SQLite and attachments: a non-iCloud local data directory.
- Encrypted completed backups only: copied into iCloud Drive.
- Email: Gmail SMTP with an app password and `expenses@sanjaybaskaran.com` as the requested From address.

### 1. Production environment

Copy `apps/server/.env.example` to a secret location outside the repository and set at least:

```dotenv
NODE_ENV=production
APP_VERSION=0.1.0
EXPENSES_BUN_PATH=/absolute/path/from-command-v-bun
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/absolute/private/path/expenses.sqlite
ATTACHMENTS_PATH=/absolute/private/path/attachments
WEB_ORIGIN=https://expenses.sanjaybaskaran.com
PUBLIC_API_URL=https://api.sanjaybaskaran.com
BETTER_AUTH_SECRET=
BETTER_AUTH_SECRET_KEYCHAIN_SERVICE=shared-expenses-auth
COOKIE_DOMAIN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CLIENT_SECRET_KEYCHAIN_SERVICE=shared-expenses-google-oauth
DEV_AUTH_BYPASS=false
OWNER_EMAIL=your-real-invited-email@example.com
BOOTSTRAP_GROUP_NAME=Shared expenses
SMTP_USER=the-google-account-that-owns-the-app-password@gmail.com
SMTP_APP_PASSWORD=
SMTP_APP_PASSWORD_KEYCHAIN_SERVICE=shared-expenses-smtp
SMTP_FROM=expenses@sanjaybaskaran.com
```

`OWNER_EMAIL` is the only email allowed to create the first account. Invited placeholder members may then create accounts. Google and email-link sign-in apply the same invite-only account-creation rule; configuring Google does not open public signup. `COOKIE_DOMAIN` is optional; leave it empty for the current host-only API session cookie, or set it only when a deployment deliberately needs one cookie shared by sibling subdomains.

Keep this environment file out of Git, backups, shell history, and launch-agent XML. Restrict it with `chmod 600`; the included `scripts/run-server.sh` loads it for `launchd` through the non-secret `EXPENSES_ENV_FILE` path. When a Keychain service variable is set, the runner reads that secret from the macOS login Keychain and overrides the corresponding plaintext variable, so production does not need the authentication, SMTP, or Google client secret in the env file.

### 2. Add Google as an optional sign-in method

Google sign-in is a server-side OAuth flow and only requests the basic `openid`, `email`, and `profile` identity scopes. It does not grant Tally access to Gmail, Drive, contacts, or a Google Workspace domain.

1. Open [Google Cloud Console](https://console.cloud.google.com/), create or select a project such as `Tally`, then open **Google Auth Platform**.
2. Choose **Get started**. Set the app name to `Tally`, choose a monitored support email, select **External** audience, and add a developer contact email. Keep the project in **Testing** while configuring it.
3. Under **Data Access**, keep only the basic identity scopes: `openid`, `.../auth/userinfo.email`, and `.../auth/userinfo.profile`. Do not add Gmail, Drive, Calendar, or other API scopes.
4. Under **Clients**, create a client with application type **Web application** and name it `Tally Web`.
5. Add these exact **Authorized redirect URIs** (scheme, host, port, path, and trailing slash rules are exact):

   ```text
   http://localhost:3000/api/auth/callback/google
   https://api.sanjaybaskaran.com/api/auth/callback/google
   ```

   This integration does not load Google's JavaScript SDK, so Authorized JavaScript origins are not required for the server-side flow.
6. Copy the client ID into `GOOGLE_CLIENT_ID` in the production environment file. Store the client secret in the macOS login Keychain rather than the repository or env file:

   ```sh
   security add-generic-password -U -a "$USER" -s shared-expenses-google-oauth -w
   ```

   Run the command interactively and paste the client secret only into its secure prompt. Keep `GOOGLE_CLIENT_SECRET=` empty and set `GOOGLE_CLIENT_SECRET_KEYCHAIN_SERVICE=shared-expenses-google-oauth`.
7. Restart the API after releasing the code. `GET /api/v1/auth/capabilities` should report `"google": true`; the login screen will then show **Continue with Google** above the existing email-link option.

For the initial invite-only rollout, Google's Testing status is sufficient when requesting only basic Sign in with Google identity scopes. Before publishing branded OAuth consent broadly, verify `sanjaybaskaran.com` in Google Search Console and publish matching homepage, privacy-policy, and terms links. Never commit or send the client secret in chat.

### 3. Install the native services

The example `launchd` files in `deploy/` contain placeholders on purpose. Copy them to `~/Library/LaunchAgents`, replace every placeholder with an explicit absolute path, and validate them with `plutil -lint` before loading. The production API follows `runtime/current/server/index.js`; the first deterministic release preserves an existing legacy runtime and updates `EXPENSES_SERVER_ENTRY` automatically. A cold reboot still requires a person to unlock FileVault and log in.

### 4. Release from CI artifacts

Push a clean `main` commit and wait for the `CI` workflow. CI performs validation, builds the production web and API packages once, includes every migration, generates SHA-256 manifests, and uploads `tally-release-<commit>`.

```sh
bun run release -- all
bun run release -- web
bun run release -- api
bun run release -- all --dry-run
```

The release command refuses tracked changes, non-`main` branches, unpushed commits, failed CI, missing artifacts, and checksum mismatches. Untracked files only produce a warning. It does not build or run the full test suite on the home Mac.

API packages are staged under `runtime/releases/<commit>`, preceded by an online SQLite snapshot, and activated by atomically switching `runtime/current`. Local and public health checks must report the exact commit within 30 seconds or the previous release is restored. Web publication captures the current Cloudflare Worker version and automatically rolls it back if release metadata, hashed assets, manifest, or service-worker policy fail verification. Release history and timings are stored outside the repository under Application Support; no release or database snapshot is pruned automatically.

The Worker has the `expenses.sanjaybaskaran.com` custom domain configured in Cloudflare. Static assets remain available while the home Mac is offline. The repository includes static-host security and cache headers. Do not proxy the PWA through the home Mac; that would defeat offline app-shell availability.

`GET /release.json` identifies the web commit. `GET /health` identifies the API commit, build time, semantic version, and server time.

### 5. Expose only the API

Install `cloudflared`, create a named tunnel, and route only `api.sanjaybaskaran.com` to `http://127.0.0.1:3000`. Do not add a router port-forward. For a token-managed tunnel, store the token in macOS Keychain under service `shared-expenses-tunnel`, then adapt `deploy/com.shared-expenses.tunnel.plist.example`; its runner reads the token at startup without putting it in the plist or process arguments. `deploy/cloudflared-config.example.yml` remains available for credential-file installations.

### 6. Validate Gmail delivery

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

- [Product requirements and build prompt](outputs/splitwise-replica-prd-and-build-prompt.md)
- [Accepted zero-cost infrastructure plan](outputs/zero-cost-fast-stack-infrastructure-plan.md)

## License

[GNU Affero General Public License v3.0](LICENSE).
