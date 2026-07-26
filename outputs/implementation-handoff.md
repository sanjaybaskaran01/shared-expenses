# Expenses implementation handoff

Date: July 25, 2026

Repository working name: `shared-expenses`

Product name: Expenses

License: AGPL-3.0-only

## Delivered milestone

The repository now contains a tested offline-first vertical slice: an installable SolidJS PWA, Bun/SQLite synchronization API, deterministic signed operation protocol, equal participant splits, invite-only passwordless email authentication, Gmail SMTP outbox, recovery replay, original app assets, and deployment/backup scaffolding.

The primary mobile workflow was tested through the in-app browser at an iPhone-sized viewport. One expense synchronized normally. The API was then stopped, a second expense was saved locally, and the API was restarted. The client retained the second entry as `on device`, reconnected automatically, pushed the signed operation, and changed its status to accepted without duplication.

Verification at handoff:

- 16 automated tests passing.
- TypeScript checks passing in all three workspaces.
- Protocol, PWA, and server production builds passing.
- Production sign-in screen visually inspected at a mobile viewport.
- Production magic-link request smoke-tested against Better Auth and the SQLite email outbox.
- Uninvited-email requests verified to disclose no account state and enqueue no message.
- Dependency audit reports no known vulnerabilities.
- Backup scripts pass shell syntax checks.
- Both `launchd` examples pass `plutil -lint`.
- Docker Compose configuration validates. Container image execution awaits a running Docker daemon or GitHub CI.

## Asset generation

The creative direction began with ImageGen and was deliberately constrained away from Splitwise branding. The exact prompt was:

> Create an original app icon and compact brand-mark concept for a privacy-minded, offline-first shared-expense ledger called “Expenses.” Use a dark midnight-navy rounded-square background. Center three small interlocking ledger tiles or cards that suggest shared records and reconciliation: one indigo, one teal, one coral. Add minimal abstract line marks suggesting entries and a subtle central check/reconciliation motif. Crisp vector-like geometry, high contrast, friendly but serious fintech feel, excellent legibility at 32px and 512px. No words, letters, currency symbols, people, mascot, gradient-heavy gloss, coins, arrows copied from existing finance apps, or resemblance to the Splitwise logo. Square 1:1 composition with generous safe-area padding, suitable for an iOS/PWA app icon and as the basis of a simple SVG brand mark.

That raster concept is retained as design provenance. Production icons do not depend on a nondeterministic generation step: `apps/web/public/brand-mark.svg` is an original, hand-defined geometric mark, and `apps/web/scripts/generate-assets.ts` uses Sharp to reproduce the 192px, 512px, maskable, Apple touch, and Open Graph PNG assets.

## Inputs still required from the owner

No secret was requested or stored during implementation. Deployment needs:

1. The real `OWNER_EMAIL` value.
2. A generated Better Auth secret.
3. The Gmail account address and its app password.
4. A Cloudflare Pages project, named Tunnel, and the two DNS/custom-domain mappings.
5. A private local data directory and an age backup identity/recipient.
6. A decision to create and push the public GitHub repository; the code is committed locally first and contains no detected secret material.

The Gmail From address remains `expenses@sanjaybaskaran.com` as requested. Because it is a Cloudflare-forwarded alias, Gmail/Outlook/iCloud delivery and DMARC alignment testing remain a launch gate.

## Scope boundary

This is the v1 foundation and primary expense-entry flow, not the complete long-term PRD. Receipt upload/OCR, arbitrary split methods, edit/conflict-resolution screens, settlement UI, advanced group administration, exports, and the admin dashboard remain later milestones. The data model and operation protocol already reserve the relevant operation types and projections.
