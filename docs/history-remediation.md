# Git history remediation runbook

This procedure is intentionally not automated. It rewrites public commit IDs, invalidates existing clones, and can disrupt pull requests, tags, release artifacts, and forks. Obtain explicit approval and coordinate contributors first.

## Proposed scope

1. Preserve a private mirror backup with restricted access.
2. Create a private mailmap that replaces the historical personal author address with a GitHub noreply address. Do not commit that mapping if it contains the old address.
3. Use `git filter-repo` on a fresh mirror clone to remove the historical private runbook/output paths and apply the mailmap.
4. Run the repository secret audit plus an independent scanner against all rewritten objects.
5. Review every branch/tag that will be retained, then force-push all approved rewritten refs once.
6. Close or recreate stale pull requests and invalidate release artifacts whose source commit no longer exists.
7. Ask collaborators to make fresh clones; do not merge an old clone back into rewritten history.
8. Follow the forge's sensitive-data-removal process for cached views where applicable. Fork owners must rewrite or delete their copies independently.

## Local dangling objects

Only after the private backup and rewritten repository have been verified, local reflogs and unreachable objects can be removed with reflog expiration followed by aggressive garbage collection. This is irreversible in the working clone and must be separately approved.

## Verification gates

- No production environment file is tracked in any retained ref.
- No high-confidence secret detector fires on any retained object.
- Removed operational documents and personal author metadata are absent from all retained refs.
- `main`, tags, CI, and release tooling all point to the new commit IDs.
- All known provider credentials that generated an alert have been rotated, regardless of scanner outcome.
