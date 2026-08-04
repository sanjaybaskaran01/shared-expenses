# Storage portability

## Decision

Keep a stable sync API between the PWA and storage. Never ask a user to paste database credentials into the frontend.

SQLite remains the zero-cost default because it has no separate service, is easy to back up, and suits a single small Tallied instance. The entire persistent state lives in a mounted volume, so moving an instance means stopping writes, copying a consistent SQLite backup, and changing the volume/path.

Postgres is the recommended second backend for operators who need managed hosting, multiple API replicas, or standard provider portability. A future implementation should move auth and application queries behind one asynchronous Kysely repository and run equivalent migrations for SQLite and Postgres. Kysely has first-party SQLite and Postgres dialects, and Better Auth supports both database families.

## Compared approaches

| Approach | Setup | Portability | Offline fit | Security | Decision |
|---|---:|---:|---:|---:|---|
| SQLite volume behind Tallied API | Lowest | Copy one file/backup | Excellent | Credentials never enter browser | Default now |
| Standard Postgres behind Tallied API | Medium | Broad managed/self-hosted choice | Excellent; sync API unchanged | Strong with TLS and least-privilege role | Next adapter |
| libSQL/Turso | Low to medium | SQLite-compatible, provider/driver coupling | Embedded replica is attractive | Still keep tokens server-side | Optional later |
| Cloudflare D1 | Low on Workers | Cloudflare-specific runtime/dialect | Sync API still works | Server-side binding is safe | Deployment-specific adapter, not core default |
| Browser connects directly to hosted DB | Looks low | Provider-specific | Conflict/auth logic duplicated | Exposes a high-value credential/RLS surface | Rejected |
| One database per user | High | Operationally fragmented | Difficult group transactions and recovery | Smaller breach domain | Rejected for v1 |

The present repository implements SQLite only. The browser/API boundary, one-origin gateway, deterministic migrations, and versioned confidential operation format are the portability seams; a Postgres adapter must land with parity tests before documentation claims it works.

Sources: [Kysely dialects](https://www.kysely.dev/docs/dialects), [Kysely setup and migrations](https://www.kysely.dev/docs/getting-started), [Better Auth database support](https://better-auth.com/docs/concepts/database), [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction), and [Neon serverless Postgres driver](https://neon.com/docs/serverless/serverless-driver).
