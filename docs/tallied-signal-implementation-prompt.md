# Tallied Signal implementation prompt

## Product objective

Redesign and implement the complete shared-expense application as **Tallied**: a calm, fast, offline-first place to record who paid, split the cost, understand every balance, and settle with confidence. The interface should feel contemporary and precise rather than bank-like, playful, or decorative. It must remain easy to operate one-handed on an iPhone and efficient with a keyboard on desktop.

Preserve all existing ledger, authentication, invitation, offline, conflict, payment, group, activity, and insight behavior. Do not hide complexity that changes money; progressively disclose it at the moment it is needed.

## Signal visual direction

- Use a pearl page (`#F6F5F1`), white surfaces, graphite ink (`#1D1E21`), fog borders (`#D9DEE1`), and signal coral (`#FF6B4A`).
- Coral means action, selection, focus, or sync attention. It never means money gained. Amount direction uses a sign and a written label, with graphite as the default amount color.
- Use a modern neutral sans, compact tracking for display text, and tabular figures for every amount, date, count, and percentage.
- Work on an 8px spacing rhythm. Use 10–14px radii, 1px structural borders, and almost no elevation. Never use gradients or glassmorphism.
- Use Lucide icons consistently. Prefer initials to profile photography. Expense content is financial, so do not reserve layout for photos or receipts.
- Motion is short, interruptible, and useful: a 0.96 press scale, 140–240ms transitions, restrained row entrances, and full reduced-motion support.

## Information architecture

- Primary destinations are Home, Groups, Activity, and You.
- On iPhone, use a slim floating navigation dock inset 16px from the sides and safe area. It has softly rounded ends, no center action, and a small coral active indicator.
- “Add expense” remains a visible text-and-icon action at the top of every primary view. It opens a person/group target picker from global contexts and opens directly in the current group from group activity.
- Home is group-agnostic: show total balances across relationships, then People and Groups.
- Groups opens a bird’s-eye list first. Each row states people, active expenses, and whether the user is owed, owes, or is settled. A group opens to chronological Activity, with Balances and Insights as adjacent tabs.
- Activity emphasizes who changed what, where, when, and the financial value. You contains identity, appearance, privacy, offline, sign-out, and feedback controls.

## Core flows

### Add an expense

1. Choose a recent group, any group, or a person.
2. Focus the native decimal amount field; never draw a custom keyboard.
3. Enter a description with the normal text keyboard.
4. Show three stable disclosure rows: Paid by, Split, and Date. Opening one must not move the amount or description off screen unexpectedly.
5. Keep equal split simple. Reveal exact amounts, percentages, shares, adjustments, multiple payers, notes, category, recurrence, and currency only on demand.
6. Summarize the effect on the current user before saving. Validate on submit, open the invalid section, focus its first invalid control, and announce the error.

### Groups and balances

- Default to a chronological expense ledger with strong date and amount alignment.
- Preserve a group-level currency selector until the first ledger entry, then explain why it is locked.
- Make balances explainable: “You paid”, “Your share”, payments sent/received, and current balance must reconcile.
- Settlement plans must be actionable, use the fewest reasonable transfers, and pause when provisional or conflicted changes exist.

### Invites and trust

- Invite without requiring a group. One action creates a single-use link; Share or Messages chooses the recipient privately.
- Explain the five-link allowance, claim state, expiry, and revocation in plain language.
- Magic-link authentication signs the invited person in and binds the invite in one trip. Google remains an additional mode for invited users.
- State that contacts stay on device, money does not move through Tallied, changes save locally first, and synced group members can see shared records.

## Accessibility and responsive contract

- All routine sheets expose `dialog`; destructive confirmation alone exposes `alertdialog`.
- Every touch action is at least 44×44px. Every custom tab supports roving tabindex, arrows, Home, and End.
- Provide a first-focus skip link, visible focus indicators, logical headings, labelled icon buttons, status announcements, and blocking alerts.
- Text inputs remain at least 16px on iPhone to prevent Safari zoom. Respect safe areas, native date/number/text inputs, coarse pointers, 320px width, zoom, and dark mode.
- Meet WCAG AA contrast for all body text and meaningful controls in both themes.

## Acceptance scenarios

- Organizer: create a trip, add four people, record equal and exact splits, correct an expense, and settle.
- Invited friend: follow a single-use link, sign in, understand privacy, inspect what they owe, and recover from offline state.
- Treasurer: compare multiple groups, audit who changed an entry, explain a balance, review insights, and resolve a conflict.
- Four concurrent people: add expenses together, go offline and replay, retry a lost response once, race an edit, and prove an outsider sees no group data.
- Persona isolation: give every actor an independent browser context, device store, development identity, and sync cursor so one person's session cannot contaminate another's evidence.

The implementation is complete only when these users can finish without guessing what group they are in, what an action will do, whether a change saved, or how a balance was calculated.
