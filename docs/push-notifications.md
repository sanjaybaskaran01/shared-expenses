# Push notifications

Tallied uses two complementary update paths:

- An open app receives the existing authenticated server-sent event and syncs the signed ledger. Without Web Push, a visible tab shows one in-app status message; a hidden tab holds it until the user returns.
- A browser with notifications enabled receives standards-based Web Push through its service worker. The notification deep-links to Activity and may update the installed app badge.

Tallied suppresses the live in-app message when the same device has an active server registration, avoiding a second popup beside the operating-system notification. Non-financial group changes and expenses that do not affect the signed-in person's share are not promoted to popups.

There is no notification SaaS or per-message provider account. The Bun API sends Web Push directly to the browser-selected Apple, Google, Mozilla, or Microsoft push service. On iPhone and iPad, Web Push requires iOS/iPadOS 16.4 or later and a Home Screen installation; permission is requested only from the user-initiated switch in Account.

## Data and keys

- The server creates one VAPID key pair on first start. Its private key is encrypted in `app_meta` with a purpose-separated key derived from `BETTER_AUTH_SECRET`; the public key is safe to return to an authenticated client.
- A subscription is bound to an authenticated, active Tallied device. The endpoint and browser keys are encrypted at rest, while a keyed endpoint digest prevents the same browser subscription from remaining attached to two accounts.
- Delivery rechecks that the destination device is still active; revoking a Tallied device disables its push subscription before any queued content is sent.
- Notification rows are created only for recipients that currently have an active push-enabled device. Title, body, and target URL are redacted after Activity is viewed or the user's last subscription expires or is revoked.
- The v1 server already processes plaintext expense content, so deriving a notification does not introduce a new content trust boundary. This mechanism does not apply to the experimental server-blind v2 path; a future v2 notification must be derived by an authorized client or use intentionally generic server-visible metadata.

## Threat model

Authenticated clients are still untrusted input. The API accepts only HTTPS subscription endpoints on recognized browser push-service domains, preventing an account from using the home server as an arbitrary request proxy. It reloads accepted operations from canonical SQLite rows before deriving text, so a replayed request cannot replace signed ledger content with forged notification copy.

Web Push encrypts the payload for the browser subscription, but the resulting notification is intentionally visible UI. A person with access to a device's lock screen may see the actor, expense, group, and balance effect. Users must opt in per device and can revoke the local subscription at any time. Tallied does not log subscription material or notification content.

## Failure behavior

- The ledger is authoritative; notification failure never rolls back or modifies an accepted expense, payment, or balance. An enqueue storage failure makes the sync request retry idempotently.
- Each recipient/operation alert is idempotent. A durable SQLite delivery retries transient failures with bounded exponential backoff.
- A delivery lease makes a row left `sending` by a stopped process eligible for retry. Delivery also rechecks active group membership before disclosing content.
- Browsers can rotate subscriptions without another permission prompt; the service worker replaces the old subscription only for its authenticated owner. Visiting notification settings also repairs a stale server registration.
- HTTP 404 or 410 from a push service expires that subscription. Corrupt encrypted subscription data is skipped rather than crashing the worker.
- If the home API is down, offline ledger entries remain on the originating device. Notifications are derived only after those signed operations reach the API, then delivery resumes normally.
- Web Push is best effort. A missing notification is not evidence that an expense was not recorded; Activity remains the reviewable source of truth.

References: [WebKit Web Push for iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).
