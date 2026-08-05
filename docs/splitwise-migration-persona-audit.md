# Splitwise migration persona audit

Date: August 4, 2026

This audit combines six independent persona walkthroughs with deterministic parser, ledger, claim, interruption, and concurrency tests. The persona walkthroughs treated the UI as a user would: what decision is required, what information is disclosed, whether a safe recovery path is visible, and whether the resulting balance can be trusted. Every severity-0 or severity-1 finding below was either fixed or converted into an explicit blocking limitation.

## Results after remediation

| Persona | Task result | Decisions in normal path | Main uncertainty found | Remediation | Evidence |
| --- | --- | ---: | --- | --- | --- |
| Long-time organizer | Completed without selecting settled history | 4 | “Current” originally depended on record order | Group status now uses aggregate non-deleted balances; older/settled groups remain collapsed | `splitwise-import.test.ts` aggregate-status test |
| Privacy-conscious file user | Completed without OAuth | 3 | Duplicate/overlapping exports and temporary server handling were unclear | Local parsing, file-specific removal, semantic overlap blocking, encrypted bounded staging, explicit 24-hour copy | parser overlap tests; encrypted-stage ledger test |
| Minimalist switcher | Four balances prepared directly for review | 1 per balance plus final review | Generic group/person selection and ambiguous direction added friction | Balance-only skips generic selection, locks the signed-in owner, persists rows, focuses the exact invalid field, and explains “owes me / I owe” | opening-balance parser/reconciliation tests |
| Invited member | Correct person claimed; forwarded untrusted link required owner approval | 2 for trusted email; 3 for untrusted name | A forwarded bearer link could be mistaken for identity proof | Generic public preview, verified-email reservation, explicit signed-in claim, trusted-email match or importer approval, auditable rejection | claim and forwarded-link integration tests |
| Treasurer | Reconciliation blocked bad data and preserved unequal shares/payments/currencies | 3 | File-hash-only dedupe missed overlapping exports; warning storms obscured root cause | Semantic record digest across batches, independent group/person/currency checks, capped detail plus blocking summary, no silent currency conversion | parser, reconciliation, overlap, atomic rollback tests |
| Interrupted mobile user | Reloaded review and safely retried commit/undo | 2 | A lost activation response looked like failure; 100k undo exceeded one request | Account-scoped IndexedDB draft, deterministic IDs, completed-batch lookup, resumable encrypted chunks, staged signed undo | lost-response, staged activation, staged undo, retry tests |

The final deterministic scale smoke on August 4 processed and reconciled 100,000 CSV records (4.95 MiB) in 1.85 seconds, planned the complete 100,001-operation import in 3.57 seconds, and planned 100,000 ordered undo operations in 0.77 seconds on the development Mac. The 6.19-second end-to-end planning run stayed within the documented desktop row limit without dropping warnings or weakening reconciliation. It measured the normalized draft at 59.96 MiB and the signed commit at 131.01 MiB, while the compact review returned to UI state was only 0.99 KiB. Browser parsing, review planning, operation signing, and undo signing/upload run in dedicated workers so this CPU work does not freeze the migration controls. Phones use a hard 10,000-entry safety cap because the current offline store materializes the ledger in memory; larger exports are directed to desktop and are never truncated.

## Severity-ranked findings and fixes

### Severity 0

- **Overlapping CSV exports could duplicate financial history.** Fixed with a source-independent semantic record key in the browser and a purpose-keyed semantic digest checked transactionally by the server.
- **A 100,000-record undo could not fit the request-body limit.** Fixed with 250-operation undo chunks, bounded signing concurrency, atomic final verification, cancellation ownership, activation/cancel exclusion, and lost-response retry.
- **A non-owner could delete another account's staged chunks by guessing a batch ID.** Fixed by deleting only the owner-scoped parent and relying on its foreign-key cascade. Cross-owner cancellation is tested.

### Severity 1

- Temporary activation data exposed emails/provider identifiers to a database reader. Review envelopes and staged provider values are now AES-256-GCM encrypted with purpose-separated derived keys.
- Expired OAuth and staged-upload material was cleaned only when another flow began. Startup and 15-minute cleanup now erase it independently.
- Repeated malformed rows could create an unusable 100,000-item warning list. Detail is capped at 200 with a blocking aggregate warning.
- Provider denial, replay, cross-account snapshot access, and callback abuse needed explicit handling. Denial consumes state, replay is rejected, snapshots are owner-bound, callback attempts are bounded, and Cloudflare's client-IP header is used only when that proxy trust is explicitly configured.
- Exported email metadata could otherwise reveal or attach an existing account without consent. Preflight now returns placeholders only; an account becomes active through a verified claim, and a proven owner-scoped mapping can then be reused.
- Edited provider records and coincidentally identical CSV rows needed different duplicate rules. Stable Splitwise IDs now hard-block edited reimports, while CSV candidates are scoped to the source group and surface a blocking ambiguity instead of silently deleting a transaction.
- Balance-only rows were easy to lose on reload and validation did not identify a precise control. Rows are account-scoped in IndexedDB and errors now focus an `aria-invalid` field linked to its message.
- Completed imports did not show who imported them or when. Read-only expense detail now renders the signed import attribution.
- Large planning/signing originally ran on the UI thread. It now runs in a dedicated worker, reports bounded progress, and retains a compatibility fallback only for browsers that cannot clone the device key.
- Every chunk acknowledgement originally recomputed every missing ordinal. Missing ranges are now calculated only when starting or resuming; chunk acknowledgement work stays bounded as the import grows.
- A 30-second activation timeout could mislabel a healthy home server as failed. Staged activation and undo now allow five minutes and poll the owner-scoped batch after a lost or retryable response.
- A 100,000-entry review originally cloned and persisted a roughly 131 MiB signed commit beside a roughly 60 MiB normalized draft. Planning now sends 250-entry chunks straight from its worker to encrypted server staging, returns only a compact review summary, releases the live draft, and never stores the signed commit in IndexedDB.
- A resumed stage was identified only by fingerprint and count. A canonical preparation hash now binds the exact review, signed content hashes, and source mappings; mismatched partial stages are owner-cancelled and rebuilt, and activation recomputes the binding independently.
- A 100,000-entry undo could still freeze the UI and the live store cannot safely materialize that volume on an iPhone. Undo now runs in a dedicated worker, and phone migrations stop at 10,000 entries with explicit desktop guidance.
- Post-import sync originally projected every pulled operation through separate IndexedDB calls. It now applies each ordered 500-operation pull page in one transaction with bulk operation/expense writes.
- Skipping repeated cryptographic verification also skipped mutable device trust. Activation now rechecks that every operation belongs to a group created by the import and that the one signing device is still active; revocation after staging is covered by an integration test.

### Accepted limitation

Tallied's current monetary protocol represents two decimal minor units. JPY, KWD, and other currencies with a different minor-unit exponent are blocked with a clear error. They are never rounded, multiplied, converted, or silently imported. Supporting them requires a separate protocol-wide money migration, not a parser exception.

## Trust assessment

The post-fix personas trusted the financial result when all blocking checks passed because:

1. payer and owed totals are independently validated;
2. every effect must add to zero;
3. supplied source balances are compared by group, person, and currency;
4. imported records are immutable outside an exact batch undo;
5. activation and undo are transactional and retry-safe;
6. unknown identity ownership never grants data access.

No persona is asked to understand external IDs, operation signatures, staging, or reconciliation internals during the happy path. Those details appear only in help or when Tallied blocks an unsafe migration.
