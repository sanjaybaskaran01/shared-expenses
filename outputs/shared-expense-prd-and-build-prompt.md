# Shared-expense app — product audit, PRD, and build prompt

Date: July 25, 2026
Reference product: an established shared-expense iPhone app, inspected through iPhone Mirroring in an authenticated account
Scope: A functionally close shared-expense product with original branding and original visual assets

## 1. Research method and confidence labels

This document combines:

- **Observed:** directly inspected in the signed-in iPhone app by opening screens and non-destructive controls.
- **Documented:** corroborated by the reference product's current official site, official help center, or App Store listing.
- **Inferred:** required to make an observed flow complete, but inaccessible because the account was authenticated, the free daily expense cap had been reached, a camera was unavailable through iPhone Mirroring, or a Pro subscription was not purchased.

No Pro purchase or free trial was started. No expense, payment, comment, reminder, invite, account change, group change, deletion, QR reset, notification change, or security change was submitted. Destructive controls were identified but not activated.

The installed app did not expose its version inside the audited screens. Apple's current listing showed version 26.6.3 at research time.

## 2. Product definition

Build a mobile-first shared-expense ledger for friends, couples, households, and trip groups. The product records who paid, allocates what each participant owes, nets balances by currency, simplifies group repayments, and provides settlement and audit workflows. It is a ledger first; money movement is an optional regional integration.

Use an original product name, logo, colors, icons, illustrations, mascots, copy, and category artwork. Match the reference product's information architecture and behavior closely without copying its trademark, proprietary artwork, or source code.

### Primary users

- Friends splitting one-off expenses
- Travel groups
- Housemates sharing recurring bills
- Couples using custom ratios
- Families with weighted shares
- Organizers tracking multi-payer or multi-currency costs

### Core value proposition

At any moment, a user can answer:

1. What did we spend?
2. Who paid?
3. What should each person owe?
4. What is everyone's current net balance?
5. What is the smallest practical set of repayments to settle the group?

## 3. Platform and navigation

### Required clients

- Responsive iOS and Android apps
- Responsive web app with the same ledger and account
- Offline-capable expense entry and cloud synchronization

### Mobile root navigation — observed

Use four persistent bottom tabs:

1. **Friends** — friend balances and one-to-one ledgers
2. **Groups** — group balances and group ledgers
3. **Activity** — chronological event feed
4. **Account** — identity, subscription, preferences, security, and appearance

Show a floating **Add expense** action on Friends, Groups, Activity, group detail, and friend detail where appropriate. Preserve the current context when opening the form.

## 4. Functional requirements

### 4.1 Authentication and account lifecycle

Status: partly documented/inferred because the audited session was already signed in.

- Support account creation, login, logout, password reset, and invite-based account creation.
- Store full name, email, optional phone number, avatar, timezone, default currency, and notification language.
- Permit editing name, email, phone, password, timezone, default currency, language, and avatar.
- Offer phone confirmation.
- Allow logging out all devices.
- Allow account closure behind an explicit destructive confirmation.
- Support a privacy preference controlling whether the user may be suggested to people who already have their email address or phone number in contacts.
- Provide a blocklist, user blocking, and user reporting.
- Optional regional/social identity providers may be added, but email-based auth is the baseline.

### 4.2 Friends home

Status: observed.

- Header shows an aggregate balance summary:
  - total the user owes, in warm red/orange;
  - total the user is owed, in green;
  - preserve separate currencies when balances cannot be combined.
- Friend rows show avatar, name, and one of: settled up, user owes amount, or friend owes user amount.
- Filters:
  - none;
  - friends with outstanding balances;
  - friends the user owes;
  - friends who owe the user.
- Search entry point opens full expense search when entitled; otherwise it opens the Pro gate.
- Add-friends flow:
  - search contacts;
  - multi-select existing contacts;
  - add a new contact with name plus phone number or email;
  - require a final review before an invitation is sent;
  - support a QR/add-friend code flow.

### 4.3 QR friend linking

Status: observed.

- Scanner tab with camera frame and instructions.
- My Code tab with avatar/name, QR code, and a friend-add deep link.
- Actions: share code, copy code, and rotate/change code.
- Warn that anyone with the code may add the user and that it should only be shared with trusted people.
- Changing the code must invalidate the prior token and require confirmation.

### 4.4 Friend detail

Status: observed.

- Header: avatar, name, aggregate relationship balance, and the group(s) contributing to it.
- Actions:
  - Settle up;
  - Remind;
  - Charts (Pro);
  - Convert to default currency when foreign-currency balances exist (Pro).
- Timeline lists private expenses and shared group balance rows.
- Reminder flow:
  - choose in-app email or the platform share sheet;
  - show an editable reminder composer;
  - include the relevant balance and a settle-up deep link;
  - do not send until an explicit Send action.
- Friend settings:
  - identity and email;
  - Pro Duo upgrade offer;
  - remove friend;
  - block user;
  - report user;
  - list shared groups.
- Destructive relationship actions require confirmation and must explain their balance consequences.

### 4.5 Groups home

Status: observed.

- Show the same aggregate owed/owing summary as Friends.
- Group rows show cover/avatar, name, group-level net position, and a short breakdown of contributors.
- Filters:
  - none;
  - groups with outstanding balances;
  - group balances the user owes;
  - group balances the user is owed.
- Search entry point is Pro-gated expense search.
- Create group:
  - group name;
  - cover image;
  - type: Trip, Home, Couple, or Other;
  - for Trip, optional start and end dates;
  - add members after the group shell is created.

### 4.6 Group detail

Status: observed.

- Branded/typed cover area with group name.
- For trips, show date range.
- Show member count.
- Editable group notes/whiteboard.
- Collapsible overall balance summary with per-person contributors.
- Horizontally scrollable action row:
  - Settle up;
  - Charts (Pro);
  - Balances;
  - Totals;
  - Convert to default currency when applicable (Pro);
  - export/other platform-appropriate actions where supported.
- Chronological ledger grouped by month and year.
- Expense/payment rows show date, category or payment icon, description, payer summary, and the user's balance effect.
- Floating Add expense action.

### 4.7 Group settings and membership

Status: observed plus documented.

- Edit cover, name, type, and trip dates.
- Add people from contacts or by new contact details.
- Generate an invite link for members who do not yet have accounts.
- List members with name, email, and their group balance.
- Remove members only after validating that their balance is zero or presenting a resolution workflow.
- Delete group behind confirmation; deletion affects all members.
- Deleted groups and their expenses must be restorable from Activity.
- No admin role is required for parity: a member involved in an expense, or a member of its group, may view/edit/delete it. Audit and notification systems mitigate misuse.
- Pro controls:
  - activate a 30-day Trip Pass for a trip group;
  - set and save a group default split/custom ratio.

### 4.8 Expense creation and editing

Status: editor observed; new-expense save was blocked by the reached free-tier cap.

Fields and controls:

- Participants: friends or group members, including non-group expenses.
- Category with searchable taxonomy.
- Description.
- Currency selector supporting 100+ currencies.
- Decimal amount using fixed-precision money math.
- Payer:
  - one person;
  - multiple people with per-person paid amounts and a running remaining total.
- Split method and allocation.
- Date.
- Recurrence.
- Group assignment or no group.
- Receipt attachment.
- Notes.
- Explicit Save; exit discards unsaved changes after confirmation when appropriate.

Quick two-person split presets — observed:

- You paid, split equally.
- You are owed the full amount.
- The other person paid, split equally.
- The other person is owed the full amount.

Advanced split methods — observed/documented:

1. **Equally:** select included people and divide evenly.
2. **Exact amounts:** enter each person's owed amount.
3. **Percentages:** percentages must total 100%.
4. **Shares:** assign relative weights; useful for families or unequal occupancy.
5. **Adjustment:** begin with an equal split, add/subtract per-person adjustments, and redistribute the remainder equally.
6. **Itemized:** assign receipt line items, tax, tip, and discounts to selected people; mobile receipt scanning/itemization is Pro.
7. **Reimbursement:** web-only parity feature for distributing a refund.

Recurrence — observed:

- Just this once
- Weekly
- Fortnightly
- Monthly
- Yearly

Receipt options — observed:

- Take a picture.
- Choose from photo library.
- Import from Files.
- Scan receipt (Pro OCR/itemization).

### 4.9 Expense categories

Status: observed in the iPhone category picker.

Provide search, Recent categories, and this baseline taxonomy:

- Entertainment: Games, Movies, Music, Other, Sports
- Food and drink: Dining out, Groceries, Liquor, Other
- Home: Electronics, Furniture, Household supplies, Maintenance, Mortgage, Other, Pets, Rent, Services
- Life: Childcare, Clothing, Education, Gifts, Insurance, Medical expenses, Other, Taxes
- Transportation/travel: Bicycle, Bus/train, Car, Gas/fuel, Hotel, Other, Parking, Plane, Taxi
- Uncategorized: General
- Utilities: Cleaning, Electricity, Heat/gas, Other, Trash, TV/Phone/Internet, Water

Use original icons and color families. Store category and subcategory separately.

### 4.10 Expense detail, comments, history, and restoration

Status: observed plus documented.

- Display category, description, amount, currency, group, date, creator/date, and last editor/date.
- Display receipt or attachment placeholder.
- Show payer(s), each participant's share, and the user's net effect.
- Show a small free spending-trend preview by category/group when data exists.
- Link deeper analytics to Pro.
- Threaded or chronological comments with a sticky composer and explicit send action.
- Edit action opens the complete expense editor.
- Delete action requires confirmation.
- Maintain an immutable audit event for create, edit, delete, restore, payment, and comment actions.
- Permit deleted expenses and groups to be restored through the relevant Activity event.

### 4.11 Settlements and payments

Status: observed for recording; documented for regional integrations.

- From a group, show each outstanding pairwise balance and a More options route.
- More options lets the user select any payer and any recipient.
- Payment editor shows payer -> recipient, currency, amount, date, group, attachment, and note.
- **Record payment** records a transfer that happened outside the app and clearly states that no money will move.
- A recorded payment is a ledger event and should be editable/commentable/restorable according to permissions.
- Regional real-money integrations may include:
  - a first-party wallet in the US;
  - Venmo and PayPal where supported;
  - Pay by Bank in select European countries;
  - additional local integrations behind feature flags.
- Real-money execution must be delegated to licensed providers; never silently treat a ledger record as a bank transfer.

### 4.12 Group balances and debt simplification

Status: observed/documented.

- Balances screen lists each member as gets back, owes, or settled up.
- Expand non-zero people into recommended pairwise repayments.
- Each repayment row offers Remind and Settle up.
- Debt simplification keeps each person's total net balance unchanged while reducing repayment count.
- Include an educational explanation and optional video/transcript; sharing the explainer is optional.
- Let a group enable/disable simplification, and preserve a recalculable, auditable source ledger.

### 4.13 Totals and analytics

Status: observed.

Free/basic group totals:

- All-time or monthly selector.
- Currency picker limited to currencies present in the ledger.
- Donut chart.
- Total group spending.
- Current user's share and percentage of group spending.
- Previous/next month controls.

Pro analytics:

- Spending over time.
- Spending by category.
- Group/friend filters.
- Date-range filters.
- Currency-aware reporting.
- Drill-down to underlying expenses.

### 4.14 Activity and notifications

Status: observed/documented.

- Recent Activity is reverse chronological.
- Events include expense added, expense updated/deleted/restored, payment, comment, group changes, and membership changes.
- Each row shows actor avatar, action copy, expense/group, balance impact, and timestamp.
- Tapping an event opens the relevant record or restoration flow.
- Push/email notification matrix:
  - added to a group;
  - added as a friend;
  - expense added;
  - expense edited/deleted;
  - comment on an expense;
  - expense due;
  - someone pays the user;
  - monthly activity summary;
  - major product news;
  - product updates and tips.
- Support independent push and email toggles when the channel is available.

### 4.15 Preferences, privacy, security, and appearance

Status: observed.

- Notification settings as above.
- Security toggle: require device passcode/Face ID/biometric before opening the app.
- Appearance: Light, Dark, or System.
- Language for emails and notifications.
- Default currency and timezone.
- Contact-suggestion privacy control.
- Manage blocklist.
- Log out all devices.
- Account closure behind explicit destructive confirmation.

### 4.16 Search

Status: observed as Pro gate; behavior documented.

- Search the full expense/payment history across descriptions, notes, comments, people, groups, amounts, dates, and categories.
- Filter by friend/group, date range, category, currency, amount, and record type.
- Results must open the record and preserve navigation context.
- Search is a Pro entitlement for parity.

### 4.17 Export, backups, and synchronization

Status: documented.

- Export a group or account ledger to CSV.
- Pro account backup to JSON and high-resolution receipt storage may be supported for parity.
- Cloud sync across iOS, Android, and web.
- Offline creation/editing queues locally and synchronizes later.
- Use client-generated idempotency keys and conflict-safe versioning to avoid duplicated expenses.

## 5. Premium entitlement note

The following list combines what was visible in the app's Pro paywall with current official documentation. Do not purchase a subscription during development or testing; use mocked entitlements and sandbox billing.

### Directly visible in the audited iPhone app

- Expense search
- Unlimited expenses and ad-free expense entry
- Currency conversion across 100+ currencies
- Receipt scanning/itemization
- Trip Pass: share Pro perks with a trip group for 30 days
- Charts and graphs
- Custom split ratios/default split behavior
- Pro Duo for two people

The audited paywall offered a seven-day trial followed by USD $59.99/year ($4.99/month effective). Treat that as a time-, region-, and account-specific observation, not a hard-coded product requirement.

### Current official documentation adds or clarifies

- Free users may add up to four expenses per day.
- Transaction import from a connected credit/debit account is available only in select countries (official marketing currently says US for card import).
- Default splits can be saved for a group or friendship.
- Early access to new features.
- Annual Individual + Trip Pass, annual Duo + Trip Pass, and monthly Individual plan shapes.
- Annual plans include a yearly Trip Pass that grants a selected trip group's members Pro access for 30 days.
- High-resolution receipt storage and downloadable JSON backup have been advertised as Pro benefits.

### Recommended entitlement model

- `FREE`: core ledger, groups, friends, basic totals, four new expenses/day.
- `PRO_INDIVIDUAL`: all premium features for one user.
- `PRO_DUO`: same for owner plus one nominated person.
- `TRIP_PASS`: scoped entitlement granted to every member of one group for a 30-day window.
- Feature flags by region for bank/card import and payment rails.

Entitlements must be server-authoritative and cached locally for offline UX. Purchases use Apple/Google/web billing with receipt validation and grace-period handling.

## 6. Core calculation rules

Use decimal/fixed-point arithmetic; never binary floating point for money.

### Expense invariants

- Sum of payer contributions equals expense total.
- Sum of participant allocations equals expense total.
- Percentage allocations total 100%.
- Share allocations have a positive total number of shares.
- Every expense has at least one payer and one participant.
- Currency is stored as ISO 4217 code plus minor-unit amount.
- Editing an expense creates a new version and a balance-delta event; it does not rewrite history invisibly.

### Equal-split rounding

- Calculate in minor units.
- Divide total by selected participants.
- Allocate leftover minor units deterministically using a stable order.
- Display exactly which users received the rounding remainder.

### Net balances

For user `u` on expense `e`:

`net(u,e) = amount_paid(u,e) - allocated_share(u,e)`

Aggregate by friendship/group and currency. Positive means the user should receive money; negative means the user owes money.

### Debt simplification

- Compute each member's net position per currency.
- Match debtors to creditors until all balances are zero within minor-unit tolerance.
- Never merge currencies unless an explicit conversion has occurred.
- Preserve the original expense ledger; simplification changes settlement recommendations, not expenses.

### Currency conversion

- By default, keep currencies separate.
- Changing an expense's currency label is not conversion.
- Pro conversion applies a captured current exchange rate to all selected historical records in a friendship/group, including settled records.
- Show a strong warning because conversion can change other members' balances and may be difficult to reverse.
- Record the source/target currencies, rate, timestamp, provider, actor, and affected record IDs.

## 7. Suggested data model

- `users`
- `user_profiles`
- `devices_sessions`
- `friendships`
- `blocks_reports`
- `groups`
- `group_memberships`
- `group_invites`
- `friend_invite_tokens`
- `expenses`
- `expense_versions`
- `expense_payers`
- `expense_allocations`
- `expense_items`
- `expense_item_assignments`
- `recurring_expense_rules`
- `payments`
- `comments`
- `attachments`
- `categories`
- `activity_events`
- `notification_preferences`
- `notifications`
- `exchange_rate_snapshots`
- `currency_conversion_batches`
- `subscriptions`
- `entitlement_grants`
- `trip_passes`
- `transaction_import_connections`
- `imported_transactions`
- `sync_operations`

Use UUIDs, `created_at`, `updated_at`, `deleted_at`, actor IDs, and row versions. Soft-delete financial records and groups to support restoration.

## 8. Permissions and safety

- Users may read records they participate in or records in groups they belong to.
- For parity, involved users/group members may edit or delete shared expenses; every mutation creates an audit event and notification.
- Invite links and QR tokens must be random, expiring/revocable, rate-limited, and stored hashed where possible.
- Receipt files are private, encrypted in transit and at rest, and exposed only through short-lived URLs.
- Payment credentials and bank access must be handled by licensed providers; do not store raw credentials.
- Confirm before deleting an expense, removing a friend/member, deleting a group, rotating an invite code, converting historical currencies, or closing an account.
- Provide restore flows for soft-deleted expenses and groups.
- Never imply that **Record payment** moved real money.

## 9. Non-functional requirements

- WCAG 2.2 AA / platform accessibility; dynamic text and screen-reader labels.
- p95 common-screen load under 1.5 seconds on a warm connection.
- Idempotent writes and retry-safe offline synchronization.
- Deterministic balance calculations shared across backend and clients through conformance tests.
- Ledger recomputation and invariant checks available as an admin/maintenance job.
- Encrypt personal data and attachments; minimize contact uploads and document retention.
- Localize currency, date, decimal, and plural formatting.
- Support at least the current App Store language set: English, Dutch, French, German, Indonesian, Italian, Japanese, Polish, Portuguese, Spanish, Swedish, and Thai.
- Analytics must not include expense descriptions, comments, receipt content, or contact details.

## 10. Release plan

### Phase 1 — faithful core

- Auth/account
- Friends/groups
- Expense CRUD
- Equal/exact/percentage/shares/adjustment splits
- Multiple payers
- Per-currency balances
- Basic settlements recorded outside the app
- Activity/audit log
- Comments
- Recurring expenses
- Basic totals
- Offline queue and cloud sync

### Phase 2 — parity depth

- Contact imports, invite links, QR codes
- Debt simplification
- Attachments and receipt storage
- Notifications and reminders
- CSV export and restoration flows
- Full category taxonomy
- Dark mode, localization, biometric lock

### Phase 3 — premium

- Entitlements and sandbox billing
- Search
- Charts/graphs
- Currency conversion
- OCR receipt scan and itemization
- Saved custom/default splits
- Pro Duo and Trip Pass
- Transaction import in eligible regions
- Ads/limit strategy for Free

### Phase 4 — regulated integrations

- Region-specific money movement through licensed providers
- Bank/card import hardening, consent, re-authentication, and deletion

## 11. Acceptance tests

At minimum, automate these:

1. A two-person $10.01 equal split balances to exactly $10.01.
2. Three payers' contributions and five participants' allocations independently sum to the same total.
3. Exact, percentage, shares, and adjustment splits reject invalid totals.
4. Balances remain separated for USD and EUR until explicit conversion.
5. Simplification changes recommended payments but not any member's net balance.
6. Editing or deleting an expense produces an audit event, a notification, and the correct balance delta.
7. Restoring a deleted expense/group restores the prior balances exactly.
8. An offline expense synced twice produces one server record.
9. A recurring monthly expense generates one instance per cycle and can stop future instances without deleting history.
10. Free daily cap allows four expense creations and gates the fifth without corrupting a draft.
11. Trip Pass entitlements apply only to one group and expire after 30 days.
12. Record payment changes the ledger but never calls a money-movement provider.
13. Real payment flows cannot execute without provider confirmation and an idempotency key.
14. Revoked QR/invite links cannot add a friend or member.
15. A non-member cannot read group expenses or receipt URLs.

## 12. Success metrics

- Time from Add expense to Save
- Expense-save success/error rate
- Percentage of expenses requiring later edits
- Weekly active groups
- Invite acceptance rate
- Settlement completion rate
- Average outstanding-balance age
- Offline-sync failure and duplication rate
- Comment/reminder engagement
- Free-to-Pro conversion and subscription retention
- Receipt-scan correction rate
- Balance invariant violations (target: zero)

## 13. Risks and deliberate boundaries

- **Trademark/UI risk:** use original branding and artwork; reproduce workflows, not another product's identity.
- **Financial correctness:** calculations and auditability are more important than animation polish.
- **Permissions parity:** open group editing is surprising; explain it and provide audit/notification safeguards.
- **Currency conversion:** it mutates historical monetary meaning; gate it with warnings and an audit batch.
- **Payment regulation:** ledger recording can ship before real transfers.
- **Contact privacy:** use on-device matching where possible and upload only normalized hashes with consent.
- **OCR uncertainty:** show confidence and require a review screen before itemized expenses are saved.
- **Free-tier friction:** preserve drafts when the daily cap is hit.

## 14. Copy/paste implementation prompt

```text
You are a senior product engineer and product designer. Build a production-quality, mobile-first shared-expense application inspired by the functional behavior of established shared-expense apps, but use an original product name, logo, visual system, illustrations, icons, category artwork, and copy. Do not copy any third-party source code or proprietary assets.

Start by reading the full PRD in this prompt and convert it into a tracked implementation plan. Make reasonable decisions without asking routine questions. If the repository already has a stack, preserve it; otherwise use:

- Mobile/web UI: Next.js 15 + TypeScript + React, responsive PWA architecture, Tailwind or an equivalent token-based styling system
- Backend: PostgreSQL + Prisma, transactional API routes/server actions, background jobs for recurrence and notifications
- Auth: a mature auth provider with email/password or magic link; optional social sign-in
- Storage: S3-compatible private object storage with signed URLs
- Queue: a durable job queue
- Tests: Vitest/Jest for business logic, Playwright for end-to-end flows
- Money: integer minor units plus ISO 4217 currency codes; never floating point

Product architecture:

1. Four root mobile tabs: Friends, Groups, Activity, Account.
2. Persistent Add expense action in ledger contexts.
3. Friends and Groups show aggregate owed/owing summaries, per-row balances, filters for outstanding/you owe/you are owed, and Pro-gated full-history search.
4. Add friends from contacts, manual name + phone/email, invite link, or revocable personal QR code. Require review before any invitation is sent.
5. Create groups with name, cover, type (Trip/Home/Couple/Other), optional trip dates, notes, members, and invite links.
6. Group detail includes balance summary, chronological ledger, Settle up, Balances, Totals, Charts, currency conversion when applicable, settings, and Add expense.
7. Friend detail includes total relationship balance across groups/private expenses, Settle up, Remind, Charts, conversion when applicable, ledger rows, and relationship settings.

Implement complete expense CRUD with:

- friends/group participants and non-group expenses;
- searchable category taxonomy;
- description, amount, currency, payer(s), allocation, date, recurrence, group, receipt, and notes;
- one or multiple payers with per-person paid amounts;
- split equally, exact amounts, percentages, shares, and adjustment;
- itemized receipt allocation with tax/tip/discount hooks;
- weekly, fortnightly, monthly, yearly, or one-time recurrence;
- receipt from camera, photo library, or file import;
- explicit Save, safe draft preservation, edit versions, comments, delete, and restore.

Use this category baseline:

- Entertainment: Games, Movies, Music, Other, Sports
- Food and drink: Dining out, Groceries, Liquor, Other
- Home: Electronics, Furniture, Household supplies, Maintenance, Mortgage, Other, Pets, Rent, Services
- Life: Childcare, Clothing, Education, Gifts, Insurance, Medical expenses, Other, Taxes
- Transportation/travel: Bicycle, Bus/train, Car, Gas/fuel, Hotel, Other, Parking, Plane, Taxi
- Uncategorized: General
- Utilities: Cleaning, Electricity, Heat/gas, Other, Trash, TV/Phone/Internet, Water

Ledger rules:

- Store all money in minor units.
- Sum of payer contributions must equal the expense total.
- Sum of participant allocations must equal the expense total.
- Define per-expense net as amount paid minus allocated share.
- Aggregate balances per friendship/group and per currency.
- Allocate equal-split rounding deterministically.
- Preserve currencies separately unless a user explicitly invokes Pro conversion.
- Debt simplification may reduce recommended transfers but must not alter any person's net balance or the source ledger.
- Every create/edit/delete/restore/payment/comment action must generate an immutable activity event.

Settlement:

- Let users choose payer, recipient, currency, amount, date, group, receipt, and note.
- Record outside payments with a notice that no money is moved.
- Keep real-money integrations behind regional provider abstractions and feature flags.
- Never simulate a successful bank transfer.

Totals and activity:

- Provide all-time/monthly totals, present-currency selector, donut chart, total spent, user share, and percentage.
- Provide an Activity feed showing actor, action, object, balance impact, timestamp, and deep link.
- Let deleted expenses/groups be restored from Activity.
- Provide push/email notification preferences for membership, friendship, expense create/edit/delete, comments, due expenses, payments, monthly summary, news, and tips.

Account and safety:

- Profile, avatar, email, phone confirmation, password, timezone, default currency, language, contact-suggestion privacy, blocklist, log out all devices, and close account.
- App lock via platform biometrics/passcode.
- Light, Dark, and System appearance.
- Confirm deletion, relationship removal, group deletion, invite/QR rotation, historical currency conversion, and account closure.
- Private attachments, least-privilege access, expiring signed URLs, audit logs, and rate-limited invite tokens.

Implement server-authoritative entitlements:

- Free: core ledger and basic totals, with a four-new-expenses-per-day cap.
- Pro Individual: unlimited ad-free expenses, full-history search, charts, currency conversion, OCR receipt scan/itemization, saved default/custom splits, eligible transaction import, high-resolution receipt storage, export/backup, and early access flags.
- Pro Duo: Pro for owner + one nominated person.
- Trip Pass: Pro granted to all members of one group for 30 days.

Use mocked/sandbox billing only. Build clear paywalls but never initiate a real purchase in tests. Preserve expense drafts when a paywall appears.

Data entities should cover users, sessions, friendships, blocks/reports, groups, memberships, invites, expenses, expense versions, payers, allocations, itemization, recurrence, payments, comments, attachments, categories, activity, notification preferences, rates/conversion batches, subscriptions/entitlements/trip passes, transaction imports, and offline sync operations. Use UUIDs, row versions, actor IDs, timestamps, and soft deletion.

Quality bar:

- Responsive, accessible, localized, polished, and fast.
- Original visual design with calm neutral surfaces, clear green positive balances, warm red/orange negative balances, and a distinct premium accent.
- WCAG 2.2 AA; dynamic type; screen-reader labels; large touch targets.
- Offline queue with idempotency keys and conflict-safe synchronization.
- Unit tests for every money/split/conversion/simplification invariant.
- End-to-end tests for friend/group creation, every split method, multiple payers, recurring expenses, record payment, comment, reminder draft, deletion/restoration, free cap, Pro gates, QR revocation, and unauthorized access.

Deliver in vertical slices. For each slice: schema migration, API/business logic, UI, fixtures, unit tests, end-to-end test, and short documentation. Seed realistic demo data in multiple groups and currencies. Do not use real contact data, payment credentials, or external messages in fixtures/tests.

Before declaring completion, run lint, typecheck, unit tests, end-to-end tests, build, and a balance-invariant audit over the seed database. Report any intentionally deferred items and why.
```

## 15. Sources

This audit was compiled from the reference product's public marketing site, its
public help centre, its App Store listing, and a hands-on inspection of the
installed iPhone app in an authenticated account. Specific vendors and URLs are
deliberately omitted: this document describes the shared-expense product
category, and nothing here reproduces any third party's branding, copy, or code.

