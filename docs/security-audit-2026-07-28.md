# Public repository security audit — 2026-07-28

## Scope

The audit covered the checked-out tree, every reachable ref and reflog, all loose Git objects including unreachable/dangling blobs and commits, GitHub branches and retained pull-request refs, recent push events, workflow artifacts/configuration, runtime error responses, authentication/authorization paths, browser storage, and generic host exposure.

Ignored production environment files were checked only for Git tracking status and were not copied into reports or command output.

## Results

- No private keys or recognizable Google, GitHub, AWS, Slack, Stripe, SMTP, tunnel, or credential-bearing database URL patterns were found in local Git blobs.
- Exact currently configured credential values were compared against local Git blobs without printing the values; no matches were found.
- GitHub's secret-scanning alerts endpoint returned no open alerts at the time of review.
- The production environment file is ignored, absent from the index, and absent from reachable history.
- No database, WAL, backup, receipt, attachment, or browser private-key material was tracked.
- Historical commit metadata contains a personal author email, and historical documents disclosed deployment-specific domains and operational choices. Those are privacy/operational disclosures, not credentials, but they should be removed from public history.
- Unreachable local objects exist from amended/deleted work. They were scanned and did not contain a detected credential. They are not referenced by the remote repository, but local garbage collection has not been run because it is destructive.
- v1 data authorization was scoped by verified session, active group membership, and trusted device. v1 content remains readable to the server operator.
- A generic 500 response previously returned raw exception messages. It now returns a request reference and logs only the error class, request method, and path.

## Current-tree remediation

- Removed personal deployment/runbook documents from the public tree.
- Replaced personal domains, email addresses, host paths, and service names with generic examples.
- Added a tracked-tree and all-local-Git-blob secret audit that never prints matched values.
- Pinned direct dependencies and GitHub Actions to reviewed immutable versions/commits.
- Made the default Compose topology same-origin and stopped exposing the API container as a host port.
- Added production-safe configuration checks and generic SMTP defaults.
- Added the server-blind v2 storage boundary without making a premature end-to-end-encryption claim.

## Remaining destructive remediation

Removing old author metadata and deleted operational documents from already-published history requires a coordinated history rewrite and force-push. Pruning dangling local objects requires expiring reflogs and garbage collection. Neither action was executed during this audit. See [history-remediation.md](history-remediation.md).

Secret scanning is a control, not proof that a repository never contained a secret. Any provider alert should be treated as real until its repository, commit/object ID, path, detector, and rotation status are reconciled.
