# Self-hosting

## Quick path

1. Install Docker with Compose.
2. Copy `apps/server/.env.example` to `.env`.
3. Set a random `BETTER_AUTH_SECRET`, the initial `OWNER_EMAIL`, a valid `SMTP_FROM`, and either SMTP delivery or Google OAuth.
4. Run `docker compose up -d --build`.
5. Open `http://localhost:8080` locally.
6. Before inviting anyone over the internet, put HTTPS in front of port 8080 and change both `WEB_ORIGIN` and `PUBLIC_API_URL` to that exact public origin.

The API is not published as a host port in the default Compose file. Nginx serves the PWA and proxies `/api/*` and `/health` internally, which avoids cross-origin cookie/CORS setup.

## Required secrets

Generate the authentication secret rather than inventing one:

```sh
openssl rand -base64 48
```

Keep `.env` outside Git and restrict it to the service account. OAuth client secrets, SMTP app passwords, tunnel credentials, databases, and backups must not be committed or embedded in web assets.

## Email or Google

Email magic links require a working SMTP account. Google is optional and requires a Web OAuth client whose redirect URI is:

```text
https://your-tally-origin.example/api/auth/callback/google
```

Google sign-in does not grant access to Gmail or contacts; request only OpenID, email, and profile identity scopes. Invite-only account creation applies to both sign-in modes.

With SMTP, Tallied emails the group invitation. On a Google-only installation, Tallied creates the pending group member and gives the inviter a link to share; the recipient must sign in with the invited Google address. Standalone invite links similarly reserve the first submitted email before starting Google sign-in, so forwarding a link cannot bind it to a different account while that reservation is active.

## Database movement

Use SQLite's online backup mechanism while the service is running, or stop the API before copying the database plus any attachment directory. Do not copy only the main file while WAL writes are active. Restore into a private volume/path, verify integrity, and then start one API instance against it.

## Public exposure checklist

- HTTPS is mandatory and the configured origins match exactly.
- `DEV_AUTH_BYPASS=false`.
- The API/database is not exposed directly to the internet.
- `TRUST_CLOUDFLARE_PROXY` stays disabled unless Cloudflare is the only path to the origin and overwrites `cf-connecting-ip`. If a forwarded chain is required, `TRUSTED_PROXY_CIDRS` contains only the exact proxy addresses or narrow subnets—not a broad private range.
- Backups are encrypted and a restore has been tested.
- SMTP sender alignment and delivery are verified.
- Dependencies and GitHub Actions remain pinned and CI is green.
- Review [the privacy model](privacy-model.md); v1 is not end-to-end encrypted.
