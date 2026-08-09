# Tallied iOS CUJ and Splitwise parity audit

Audited on 9 August 2026 using the live Splitwise iPhone app, Splitwise web, and Tallied at 320×800, 390×844, and desktop sizes. The audit covered every primary page and user journey reachable without changing financial data, sending invitations, purchasing Pro, or performing destructive actions. Tap counts exclude typing characters but include keyboard actions such as Next and the final confirmation.

## Interaction principles

- Keep four stable destinations in the bottom tab bar and preserve each destination's state.
- Put the primary expense action in the lower trailing thumb zone, above rather than inside the navigation.
- Use a labeled action on overview pages and a compact receipt action inside a group, where the context is already clear.
- Open a group expense directly in that group. A global expense starts with a person/group picker.
- Focus the amount for a new form, move to description with the numeric keyboard's Next action, and never select existing text when editing.
- Present one sheet at a time. Keep Cancel and the final action in predictable positions.
- Keep touch targets at least 44×44 points and keep controls clear of safe areas.

These choices follow Apple's guidance for stable tab bars, scoped sheets, and 44×44 point controls:

- https://developer.apple.com/design/human-interface-guidelines/tab-bars
- https://developer.apple.com/design/human-interface-guidelines/sheets
- https://developer.apple.com/videos/play/wwdc2024/10085/?time=78

## Screen inventory

| Area | Splitwise | Tallied | Decision |
| --- | --- | --- | --- |
| Home / Friends | Aggregate balance, friends, search, filters, add friend | Aggregate balance by person or group, invite | Preserve Tallied's cross-group summary; add search later |
| Groups | Reopens the last group on iPhone | Opens a bird's-eye list of all groups | Keep Tallied's overview-first behavior |
| Group | Activity list, balances, top actions, settings, compact FAB | Activity, balances, insights, settings, compact FAB | Keep activity primary; retain free Insights |
| Group settings | Members, add people, invite link, simplify debts, group edit | Members, invite by email, pending/claimed identity, currency | Add rename/leave/delete and an optional invite link later |
| Activity | Searchable recent changes | Account-scoped signed history with category icons | Add search and filtering later |
| Person | Balance hero, shared groups, settle/remind/charts | Balance, shared groups, settle, chronological history | Add reminders and relationship settings later |
| Account | Profile, QR, notifications, security, appearance | Profile, appearance, migration, smart categories, notifications | Add granular notification/security controls later |
| Add expense | Context, description, amount, combined payer/split, details | Context, amount, description, payer/split/date, details | Tallied defaults to the form and reduces required taps |
| Expense detail | Category, payer/split, comments, edit/delete | Category, payer/split, comments, edit/delete/restore/provenance | Tallied has functional parity and stronger auditability |
| Settle up | Records an external payment and explains no money moves | Records an external payment | Retain explicit external-payment copy |

## Core journey tap counts

| Journey | Splitwise iPhone | Tallied after this pass | Result |
| --- | ---: | ---: | --- |
| Add an equal expense from a group | 4 | 3 | Tallied focuses amount, then Next moves to description |
| Add an equal expense from anywhere | 5 | 4 | Both choose a target; Tallied removes one field-focus tap |
| Open group settings | 1 | 1 | Equal |
| Open an existing expense for editing | 2 | 2 | Equal |
| Open group insights/charts | 1 | 1 | Tallied is not paywalled |
| View all groups from a group | 1 | 1 | Tallied returns to an overview rather than another sticky group |
| Find a historical expense by text | 2+ | Not available | Splitwise leads; search is the next high-value parity gap |

Splitwise currently blocks opening payer/split controls until a cost has been entered. Tallied keeps those controls inspectable and validates only when needed, which supports users who think about participants before the amount.

## What Splitwise still has that Tallied does not

The gaps are ordered by likely value to Tallied's finance-first use case.

1. Search and filters across activity and expenses.
2. Group rename, leave/delete/restore, shareable group-invite links, and a simplify-debts preference.
3. Manual reminders and relationship controls such as remove/block/report.
4. Multiple currencies within one group and currency conversion.
5. Receipt attachments, OCR/itemization, and richer exports.
6. Automatic recurring-bill execution rather than recurrence metadata alone.
7. Repayment-provider integrations, QR invitations, profile photos, cover images, and additional languages.

The first three improve repeated core journeys. The remaining items add breadth, cost, or privacy surface and should not displace fast entry, trustworthy sync, and readable balances.

## Where Tallied should remain different

- Show all groups first instead of reopening a previously selected group.
- Keep unlimited expenses and useful insights free.
- Preserve an offline-first, signed history with explicit account-scoped sync status.
- Let an owner add expenses for an invited or imported person before that person claims their account.
- Explain reconciliation and identity claims rather than silently merging histories.
- Keep images optional; finance rows, amounts, dates, payers, and splits remain the visual hierarchy.

## Implemented in this pass

- Replaced the compressed split dock with a full-width, four-item bottom tab bar.
- Added an adaptive floating expense action: labeled on overviews and compact inside a group.
- Kept the action in the lower trailing thumb zone with a 56×56 CSS-pixel target.
- Added enough scroll inset for content to clear the floating action and tab bar.
- Made a new expense focus the amount and use Next to advance to the description.
- Kept edit mode focused on the dialog so existing values are not selected or overwritten.
- Added deterministic tests for action placement, navigation width, routing, and initial focus.

Official Splitwise feature references used to cross-check the live audit:

- https://apps.apple.com/us/app/splitwise/id458023433
- https://kb.splitwise.com/getting-started/how-do-i-use-splitwise
