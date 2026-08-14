# Privacy and encryption model

## Current status

Tallied has two data paths:

| Path | Status | Server can read expense content? | Used by the current UI? |
|---|---|---:|---:|
| v1 signed ledger | Production-shaped | Yes | Yes |
| v2 confidential ledger | Experimental, disabled by default | Not from stored ciphertext alone | Not yet |

Authentication and group authorization protect both paths from anonymous and unrelated-account reads. That is different from end-to-end encryption: an operator with database or process access can read v1 projections and operation payloads.

## Pending people and verified account handoff

A person may participate in a group ledger before they have accepted an invitation or linked imported history. Tallied represents that person as a non-readable placeholder:

- Only an active group member can create or amend an expense involving the placeholder.
- The placeholder cannot authenticate, receive group snapshots, or read balances.
- A matching display name is never enough to attach the placeholder to an account. Imported email metadata is client-controlled, and membership in another group does not prove that an account owns this imported identity.
- Email invitations bind to the verified email that accepts the magic link. Imported identities use a single-use claim link and, for untrusted identities, explicit migration-owner approval.
- On successful handoff, one database transaction moves payer/allocation projections and group membership to the verified account. Accepted signed operations remain immutable, so Tallied also records a group-scoped participant alias that lets authorized clients reproject the old placeholder id onto the verified account.

The handoff fails closed. A forwarded untrusted import claim grants no data before owner approval; a rejected claim leaves the placeholder and its balances private. A failed invitation email removes the unused placeholder. If projection reassignment or alias creation fails, the transaction rolls back instead of leaving membership and balances attached to different identities. Existing accounts claim pending email invitations whenever a new authenticated session is created; new accounts do the same immediately after account creation.

## v2 design

- Each browser has separate P-256 signing and ECDH agreement key pairs.
- Each group/key epoch has 256 bits of random key material imported as an AES-GCM key.
- Group key material is wrapped independently to each authorized device using ephemeral P-256 ECDH, HKDF-SHA-256, and AES-GCM.
- Expense payloads are encrypted with AES-256-GCM. Routing metadata is authenticated as additional data.
- Ciphertext metadata and hashes are signed by the sending device. The server verifies membership and signatures without decrypting content.
- A key envelope is immutable within a group, epoch, and recipient device. Membership removal requires a new epoch and new envelopes for remaining devices.

The implementation lives in the protocol package, browser crypto library, v2 API routes, and confidential database tables. It deliberately does not reinterpret old plaintext operations as encrypted data. The v2 routes return `404` unless an operator explicitly sets `EXPERIMENTAL_CONFIDENTIAL_SYNC=true`; that flag only opens the experimental server boundary and does not migrate or enable the shipped UI. Keep it disabled on production instances until the migration gates below are complete.

## Important limits

- Every authorized member device must be able to decrypt shared group data. “Only the creator device can read it” is incompatible with collaborative splitting.
- An unlocked browser origin can read its decrypted in-memory data. End-to-end encryption does not fix XSS, a compromised browser extension, an unlocked device, or screenshots.
- The current IndexedDB projections are plaintext. A complete v2 migration must encrypt local projections or keep them memory-only behind an explicit vault-unlock mechanism.
- A lost sole device means lost decryption keys unless the user has an approved recovery key or another authorized device. Magic-link authentication alone must not silently restore encrypted data.
- The custom group-key scheme does not yet provide the full forward-secrecy and post-compromise guarantees of Messaging Layer Security (MLS). MLS is the preferred long-term protocol once browser-ready, audited libraries meet the product's size and compatibility constraints.
- The current device directory is authenticated by the server, not independently transparent or cross-signed. A malicious operator that can alter the database/device directory must be prevented from introducing a device before clients automatically share keys. Existing-device approval, key fingerprints, and auditable device changes are release gates—not optional polish.

## Migration gates

Before marking Tallied end-to-end encrypted:

1. Move all expense creation, projection, sync, and attachments to v2.
2. Add existing-device approval and a user-controlled recovery-key flow.
3. Encrypt local projections and define locked/unlocked behavior.
4. Rotate group epochs on member/device removal and test offline rejoin behavior.
5. Complete an independent cryptographic and web security review.
6. Remove or explicitly quarantine the v1 plaintext endpoints.

The primitives follow the Web Cryptography API and authenticated-encryption guidance. See the [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/), [W3C cryptography guidance](https://www.w3.org/TR/security-guidelines-cryptography/), [OWASP Cryptographic Storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html), and [RFC 9420 (MLS)](https://www.rfc-editor.org/rfc/rfc9420.html).
