# Contributing

Run `bun install --frozen-lockfile`, then `bun run check` before submitting a change. Add focused tests first for authorization, money, reconciliation, invitation, migration, and cryptographic behavior.

Never include real user data, email addresses, domains, host paths, database files, logs, screenshots of private ledgers, OAuth/SMTP credentials, tunnel configuration, or production environment files. Use `example.com` and synthetic identities in fixtures and documentation.

Security-sensitive changes should state their threat model and failure behavior. Cryptographic changes require test vectors or round-trip/tamper tests and should use standardized browser primitives or audited libraries rather than new unaudited constructions.
