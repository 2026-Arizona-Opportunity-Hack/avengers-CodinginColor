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
