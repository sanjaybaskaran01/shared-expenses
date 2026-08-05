# Moving from Splitwise to Tallied

## Official-source research and product decision

Research was refreshed on August 4, 2026 using Splitwise-owned sources only.

- The [Splitwise API reference](https://dev.splitwise.com/) exposes authenticated reads for the current user, groups, friends, individual expenses, paginated expenses, comments, currencies, and categories. Group `0` represents expenses outside a group. Expense responses preserve cost, currency, date, notes, recurrence, payment state, deletion timestamps, friendship/group IDs, and each participant's paid and owed shares.
- Splitwise's [OAuth announcement](https://feedback.splitwise.com/forums/162446-general/suggestions/20625340-oauth-2-0-support) confirms OAuth 2 support and the official token endpoint. The older [official OAuth guide](https://blog.splitwise.com/2013/07/15/setting-up-oauth-for-the-splitwise-api/) documents application registration and authorization without asking an integration to collect a Splitwise password.
- Splitwise Support documents per-group and per-friend [CSV spreadsheet exports](https://feedback.splitwise.com/knowledgebase/articles/88333-how-do-i-export-my-transactions-to-a-spreadsheet-o). Its support material also says the complete JSON backup is a Splitwise Pro feature, so Tallied accepts that backup when a person already has one but never requires it.
- The current self-serve API terms say the API is rate-limited, may require an active Pro subscription, is not intended for commercial projects, and may not be used to create an application that replicates or competes with Splitwise. Tallied therefore ships the connector **fail-closed**. It can be enabled only after written approval from Splitwise and explicit server configuration. CSV/JSON upload and outstanding-balance entry do not use the API and remain available.
- No documented token-revocation endpoint was found. Tallied deletes its encrypted, short-lived token immediately after normalization or cancellation. The help text also directs a person to remove the app from Splitwise's authorized applications when provider-side revocation is desired.

Tallied calls only these read endpoints when the approved connector is enabled:

```text
GET /api/v3.0/get_current_user
GET /api/v3.0/get_groups
GET /api/v3.0/get_friends
GET /api/v3.0/get_expenses?limit=100&offset=…
GET /api/v3.0/get_categories
GET /api/v3.0/get_currencies
```

No Splitwise mutation endpoint is present in the client allow-list.

## User experience

Account → **Move from Splitwise** offers four paths:

1. **Connect Splitwise** — shown as the recommended path only when the server reports an approved connector. Otherwise it explains that the direct connector is awaiting provider approval and points to export upload.
2. **Upload Splitwise exports** — accepts multiple CSV files and a complete JSON backup. Parsing, hashing, duplicate detection, and normalization happen in the browser. One bad file produces a file-specific warning and does not discard other valid files; it must be removed or corrected before activation.
3. **Bring outstanding balances only** — fast mobile rows for person, direction, amount, currency, optional group, and effective date.
4. **Start fresh** — exits onboarding without creating an import.

The review defaults to current/non-zero groups. Current status is calculated from the full group balance, not the last record in an export. Older and settled groups stay collapsed until selected. A user can add more files, remove a specific bad file, choose current groups, balances only, or individual groups, and select every imported name that represents their Tallied account. The final button remains available and validates on submission; reconciliation mismatches block activation.

## Architecture

### Local normalization

Raw files never leave the browser. Parsing runs in a dedicated browser worker. Review planning and P-256 operation signing run in a second worker, with bounded concurrency and progress announcements, so a large export does not block taps, scrolling, or assistive technology. That worker sends signed operations directly to encrypted 250-entry staging and returns only a compact reconciliation/name/group summary to the UI; a 100,000-entry signed commit is never cloned into UI state or stored in IndexedDB. The live normalized draft is released once staging starts. Older embedded browsers that cannot clone a non-exportable `CryptoKey` retain a compatibility fallback rather than losing migration entirely. The parser enforces:

- at most 20 files, 10 MiB per file, and 50 MiB total;
- up to 10,000 data rows on a phone and 100,000 on desktop; the phone cap protects the current offline in-memory ledger and never truncates an export silently;
- `.csv` or `.json` extension plus compatible MIME type;
- UTF-8 text, optional BOM, quoted commas/newlines, flexible column order, and bounded field lengths;
- no HTML rendering and no formula execution; values beginning with `=`, `+`, `-`, or `@` remain inert text;
- SHA-256 file fingerprints and deterministic row identities;
- file-scoped warnings with source name and row number.
- two-decimal currencies only. A zero-decimal or three-decimal source such as JPY or KWD is blocked instead of rounded or silently corrupted.

Descriptions, notes, names, and categories are untrusted strings. Solid renders them as text. Tallied never uses `innerHTML` for imported content.

### Import batch

An import batch belongs to exactly one authenticated Tallied account and records:

- batch ID, provider, mode, owner, source-account key, timestamps, status, and rollback status;
- source hashes and selected source groups;
- deterministic external-record mappings;
- imported identities and claim state;
- signed operations and created local entities;
- warnings plus expected and computed reconciliation results.

The client signs each normalized record with the existing P-256 device key. Raw Splitwise record IDs, file hashes, row numbers, friendship IDs, and provider timestamps are **not** embedded in these shared signed operations. They live only in owner-scoped import mappings; group members receive an opaque Tallied record ID plus the attribution needed to explain that the item was imported.

One activation endpoint verifies every signature, validates mapping types, complete planned membership, financial invariants, source-vs-computed balances, and overlap with earlier completed imports, then commits projections and batch metadata in one SQLite transaction. A failure rolls the whole transaction back. Every prepared review stages verified chunks of at most 250 operations and activates only when the exact declared set is complete. A canonical preparation hash binds the complete review envelope, every signed operation content hash, and every source mapping; resume requires an exact match and activation independently recomputes it before touching projections. Signatures are verified as each chunk arrives; activation rechecks mutable device trust and verifies the encrypted row metadata still matches those signed operations without repeating 100,000 public-key checks. The temporary review envelope, signed financial operations, semantic candidates, provider identifiers, and staged undo operations are independently AES-256-GCM encrypted at rest. Staging is limited to 192 MiB per upload and 768 MiB per server instance and expires after 24 hours. A response lost after commit is safe: a retry returns the completed batch without replaying data. Start/resume calculates the missing ordinal ranges once; constant-size chunk acknowledgements avoid a full staging-table scan after every upload. Uploads use bounded timeout/backoff, activation allows five minutes, and a lost activation response polls the owner-scoped batch for a completed state before asking the user to retry. A server restart returns any previously claimed stage to its idempotent `ready` state before accepting requests. If a new preparation differs from a partial older upload, Tallied cancels the owner-scoped stale stage and starts cleanly rather than mixing chunks. If an old signed undo belongs to another device/session, its owner can cancel the inactive stage and restart it.

The local normalized draft and compact prepared-review summary are stored in IndexedDB under the signed-in account ID, excluding raw file contents and the signed operation set, so an interrupted phone can resume without exposing one account's draft to another account on the same browser. Going back or discarding cancels the owner-scoped encrypted stage; completion, explicit discard, or Start fresh clears local migration state. After activation, sync applies each 500-operation page in one IndexedDB transaction instead of issuing per-operation transactions.

### Record types

| Source shape | Tallied representation | Spending analytics |
| --- | --- | --- |
| Explicit paid and owed shares | Read-only imported expense | Included |
| Splitwise payment with sender/recipient | Read-only imported payment | Excluded |
| CSV per-person balance effects | Read-only imported transaction with exact zero-sum effects | Group total may be shown; personal share is not invented |
| Outstanding balance entered by user | Opening balance from Splitwise | Excluded |
| Deleted source transaction | Imported record activated as voided | Excluded while voided |

Imported records show: “Imported from Splitwise by {name} on {date}.” They cannot be edited or individually deleted. New Tallied activity remains editable. **Undo this import** plans, signs, and uploads reversals in a dedicated worker for exactly the active records created by the batch; it never deletes later Tallied activity or a group that gained later activity. A large undo uses the same resumable 250-operation staging boundary, verifies the complete signed set, and changes every projection plus the batch status in one transaction.

### Groups and currencies

Tallied groups have one settlement currency. A Splitwise group containing multiple currencies is deterministically projected into one Tallied group per currency, for example `Goa trip · INR` and `Goa trip · USD`. Group-less friendship history becomes `Mira · INR` (or the applicable currency). This preserves every source group key and amount without conversion or silent netting.

### Imported identities

An imported person starts as a placeholder member and cannot authenticate or read data:

```text
Mira
Imported from Splitwise · Not on Tallied yet
```

Resolution order is importer identity, an owner-scoped provider mapping previously established by a completed claim, then a non-readable placeholder. Exported email metadata never reveals whether an account exists and never adds that account to a group. Raw source emails are not retained in import tables; Tallied stores a keyed email hash used only by the claim flow. A claim token is random, single-use, short-lived, and bound to one identity. The public claim response contains only the provider and expiry—no name, group, amount, or email hint.

Before a new account can be created, the claimant reserves the claim with the email they will verify. For a trusted source email, that email must hash to the imported identity before Google or email-link sign-in starts. For a name-only or untrusted identity, the claimant verifies an email, explicitly confirms the claim while signed in, and the importer sees the claimant's verified name/email before approving or rejecting the transfer. The claimant can safely resume or poll a pending request from the same account. Forwarding a link therefore cannot silently attach the wrong account. Migration claim links are separate from referral invitations and consume no referral credit.

## Reconciliation report

Activation independently calculates balances from normalized records and compares any supplied Splitwise balances by group, person, and currency. It also recomputes and verifies each participant's total paid, total owed, payments sent, payments received, and net amount, plus group totals by currency. These audit totals are progressively disclosed in the final review.

```text
Migration check

Groups imported                         12
Transactions imported                1,842
Duplicate transactions                   0
Unresolved people                        0

Mira · INR
Splitwise ₹2,400     Tallied ₹2,400     Matches
```

Blocking checks include paid total, owed total, zero-sum effects, participant membership, duplicate external IDs, unknown people, malformed currencies, and source-vs-computed balances. A mismatch can be resolved by changing an identity mapping, excluding the affected record/group, correcting an opening balance, or cancelling.

## OAuth lifecycle

The connector uses authorization-code OAuth with a cryptographically random, keyed-hash state value and an exact configured redirect URI. The state is atomically consumed before the code exchange, and the resulting session remains bound to the Tallied account that started it. The unauthenticated provider callback can create no ledger state; downloading the snapshot requires that same signed-in Tallied account. Tokens are encrypted at rest, never logged, used only by an allow-listed HTTPS client, and deleted after the source is normalized into a review draft. Cancellation, denial, expiry, and callback failure also erase token material.

Splitwise's public OAuth material does not document PKCE behavior, so Tallied does not claim or depend on PKCE support. The confidential server performs the code exchange with the provider-issued client secret. If Splitwise documents PKCE for this client type later, it can be added as defense in depth.

## Threat model

| Threat | Control |
| --- | --- |
| OAuth CSRF or account confusion | Random keyed-hash state, owner-bound snapshot session, exact redirect URI, one use, 15-minute expiry |
| Code replay | State atomically rotated before exchange; duplicate callback rejected |
| Token or temporary upload disclosure | Purpose-separated AES-GCM keys derived from the server secret; no token logging; encrypted staging; automatic expiry |
| API mutation | Compile-time/read-time endpoint allow-list contains GET routes only |
| Cross-account preview or commit | Every query and mutation includes `imported_by`; mismatches return 404 |
| Duplicate, overlapping file, or lost response | SHA-256 file fingerprint, keyed external-record digest, deterministic operation IDs, transactional overlap check, completed-batch retry |
| Edited provider record or ambiguous CSV match | Stable Splitwise record IDs are authoritative across batches; CSV candidates use group-scoped financial semantics and block for review rather than silently deduplicating |
| Partial import | Whole activation or undo runs in one SQLite transaction |
| Malformed/oversized file | Client and server limits, capped warning detail, 192 MiB staged quota, per-account upload limit, no raw upload |
| Staging race or disk exhaustion | Transactional conditional byte reservation, 768 MiB instance ceiling, owner-scoped cancellation, and automatic expiry |
| Formula/HTML injection | Imported values remain plain text; no CSV generation or HTML rendering |
| Forwarded identity claim | Opaque token, no pre-verification disclosure, trusted-email hash or owner approval |
| Forged proxy headers | Cloudflare client-IP trust is opt-in; self-host gateways strip the header and otherwise share a conservative public limit key |
| Unclaimed data access | Placeholder memberships are financial participants but never authorized readers |
| Importer undo harming later work | Undo targets batch-owned records only and preserves groups with later activity |
| Offline replay | Local normalized draft and deterministic operations resume safely |

## Data retention and deletion

- Raw uploaded files: browser memory only; discarded immediately after normalization.
- OAuth token: encrypted, maximum 15-minute session; deleted after normalization, denial, cancellation, expiry, or error. Startup and a 15-minute cleanup job erase expired tokens even when no new authorization begins.
- Normalized draft plus compact review: account-scoped local IndexedDB until completion, explicit discard, or Start fresh. The signed operation set is not persisted on the phone. The server never stores raw uploaded files. Prepared activation/undo data is encrypted, bounded, retained for at most 24 hours, and deleted immediately on completion or cancellation.
- Completed batch: source hashes, owner-scoped provider mappings, warnings, reconciliation, and minimal shared provenance retained for audit, deduplication, and undo.
- **Delete imported source data** removes source hashes, warnings, the original batch fingerprint, raw provider identifiers/details, and unused claim tokens. It retains a purpose-separated keyed, non-reversible record digest solely to prevent accidental duplicate imports, plus the minimal Tallied provenance required to explain shared balances.
- **Undo this import** voids/reverses its financial records and revokes its claim links. It does not erase audit operations already synchronized to group members.

## Getting a Splitwise export

On Splitwise web, open a group or friendship, open its settings menu, and choose **Export as spreadsheet**. Select every CSV together in Tallied. Duplicate files are ignored automatically. If you already have a complete JSON backup, Tallied accepts it too; buying Splitwise Pro is not required to use Tallied.

If a file needs attention, Tallied names the file and row and keeps every other valid file in the review. Remove that file or correct and select it again. Nothing is added until **Finish migration** passes every blocking check.

The independent usability findings, severity-ranked fixes, and scenario-to-test evidence are recorded in [the migration persona audit](splitwise-migration-persona-audit.md).
