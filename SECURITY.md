# Security policy

Use GitHub's private vulnerability reporting for suspected vulnerabilities. Do not open a public issue containing real expense data, identity data, tokens, device keys, databases, receipts, environment files, host details, or provider credentials.

Tally is pre-1.0. Only the latest commit on `main` receives fixes.

## Supported security baseline

- HTTPS and an exact trusted-origin allowlist.
- `DEV_AUTH_BYPASS=false` outside local development.
- Secure, HTTP-only session cookies and mandatory verified identity.
- An API reachable through a reverse proxy; no public database or administrative port.
- Active-membership checks in addition to authentication.
- Frozen dependency lockfile, pinned CI actions, and a clean secret scan.
- Encrypted, restore-tested backups kept separately from the live volume.

Never deploy example credentials or commit `.env`, OAuth client secrets, SMTP app passwords, tunnel credentials, private keys, or databases.

## Confidentiality statement

The v1 device signatures prove operation provenance but do not provide end-to-end encryption. The experimental v2 path stores signed ciphertext and wrapped group keys, but the current product UI still uses v1. Read [docs/privacy-model.md](docs/privacy-model.md) for the exact boundary and migration gates.
