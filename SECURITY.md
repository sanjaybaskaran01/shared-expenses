# Security policy

Please report vulnerabilities privately to the repository owner before opening a public issue. Do not include real expense data, email addresses, authentication tokens, device keys, database files, receipts, or SMTP credentials in a report.

The project is pre-1.0. Only the latest commit on `main` receives security fixes. The documented production baseline requires HTTPS, an exact trusted-origin allowlist, a localhost-only API bind, FileVault, encrypted off-device backups, secure cookies, mandatory verified email, and `DEV_AUTH_BYPASS=false`.

Never deploy with the example Better Auth secret or commit a Gmail app password. Device signatures provide operation provenance; they are not end-to-end encryption.
