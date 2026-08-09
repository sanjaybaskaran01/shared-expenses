# Architecture

## Default deployment

```text
Browser / installed PWA
  ├─ IndexedDB: offline queue, projections, device keys
  └─ HTTPS, same origin
       └─ reverse proxy
            ├─ static web assets
            └─ Bun API
                 ├─ SQLite volume
                 └─ SMTP or Google OAuth
```

The default Docker topology exposes one gateway. The API container is reachable only inside the Compose network. A public operator supplies TLS through a reverse proxy or outbound tunnel without opening the database or an administrative port.

## Trust boundaries

The static app and API are separate components but share an origin in the easiest deployment. The API owns authentication, authorization, rate limits, migrations, and storage credentials. A browser must never connect directly to SQLite, Postgres, or a hosted database with an administrative key.

Every v1 operation is written locally before upload, hashed canonically, and signed by a non-exportable P-256 device key. The server verifies the session actor, device ownership, signature, and group membership before materializing a projection.

The experimental v2 path separates:

- Control plane: account/session, opaque group identifier, membership, device public keys, invite state, and wrapped group keys.
- Data plane: signed AES-GCM ciphertext operations. The server routes and stores these without parsing expense content.

## Availability

After a device has signed in, the PWA can open and queue work when the API is down. New-device authentication, invitations, key distribution, and cross-device synchronization require the API. Self-hosters are responsible for database backups, TLS, configured email or Google delivery, and recovery testing.
