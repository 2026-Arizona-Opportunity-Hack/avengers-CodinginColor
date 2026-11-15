# Outreach core

Pure, dependency-free outreach rules (Person 4, issues #45 and #46). Routes and tables
(#47) pass in rows from authorized queries; nothing here reads the database or sends
anything.

## Follow-up queue and quarterly touches (`queue.ts`, #45)

- `quarterOf(timestamp, '-07:00')` / `quarterWindow('2026-Q4', '-07:00')`: calendar
  quarters in CIC's Phoenix time, as half-open windows.
- `planQuarterlyTouches(donors, existingTasks, {quarter, offset})`: **one quarterly
  touch per eligible donor per quarter**, due at quarter end. Eligible means not
  archived, has an owner, and consent isn't `denied`. A quarterly task of **any**
  status already existing for that donor and quarter means none is planned, so
  re-running is idempotent. Skipped donors are returned by reason.
- `buildQueue(tasks, {now, ownerId?})`: open tasks split into `overdue`,
  `due_this_week` (due in under 7 days) and `upcoming`, sorted by due date. Pass
  `ownerId` for a board member's own queue.
- `tasksClosedBy(tasks, {donor_id, occurred_at, qualifying}, offset)`: only a logged,
  **qualifying** contact completes that donor's open touch for the contact's quarter.
  A draft never does, and one-off next actions are closed explicitly.
- `reassignOpenTasks(tasks, donorId, newOwnerId)`: when an owner changes, open tasks
  follow the donor; completed history keeps its original owner.

```powershell
node --test packages/outreach/*.test.ts
npx tsc -p packages/outreach
```

## Messages: draft, approve, send or log (`messages.ts`, #46)

Sending is a controlled state machine (plan p. 09): **draft → approved → sent / failed / logged**.

- **Templates** (`thank_you`, `thank_you_sms`, `quarterly_update`): plain text with
  allowlisted `{{fields}}`. Unknown or missing fields throw, and control characters
  are stripped from values. A line using the optional `{{impact}}` is dropped when no
  approved metric is supplied, so there's no impact claim without approved data.
- **Drafts** go to the donor's current email or phone, validated: no `?`, `&` or
  extra headers in email addresses, and phone numbers reduced to digits. Donors with
  consent `denied` can't get a draft at all.
- **Approval** (`approveDraft`) is by the donor's owner or an admin. It stores a
  **SHA-256 of donor, channel, recipient, subject and body**. `editDraft` always
  returns an unapproved draft, and any content change made outside it is caught at
  send time because the hash no longer matches.
- **Delivery** (`recordDelivery`) re-checks approval, consent, owner and current
  contact. It's idempotent: a repeated call on a sent draft records nothing. A
  failure is recorded as `failed`, is never a qualifying contact, and needs a fresh
  approval.
- **Manual send** (`composeLink` + `recordManualSend`): an encoded `mailto:` or `sms:`
  link opens the person's own app. The communication is logged **only after they
  confirm it actually went out**, and it then counts as a qualifying contact (which
  closes the quarterly touch in `queue.ts`). Provider receipts are never faked.
