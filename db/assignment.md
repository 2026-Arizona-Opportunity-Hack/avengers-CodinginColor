# Atomic donor creation and assignment

Migration `002_assignment.sql` adds `create_assigned_donor(name, email, phone,
consent, metadata)`. Backend callers validate `DonorWriteSchema` first and call
the function inside their verified membership transaction. Organization and
actor come from transaction-local context, never donor form fields.

The function locks one organization cursor, counts nonarchived donors for each
active board member, chooses the least-loaded member, and rotates UUID ties
after the last assigned owner. Admins, inactive members and other organizations
are excluded. Donor creation, cursor advancement and audit insert commit or roll
back together. No eligible owner raises an error without partial writes.

Only donor ID and owner ID are returned: a board member may create a donor
assigned to someone else without gaining access to that donor's contact details.
Existing owners are never changed by this function. Runtime direct donor inserts
are revoked; the dedicated non-login function role has only scoped permissions.
Unsafe pre-existing role flags or memberships cause migration failure.

Run `node --test tests/assignment.test.mjs` for embedded PostgreSQL checks.
For concurrent transaction proof, run `node --test tests/assignment-postgres.test.mjs`
with `CORE_TEST_DATABASE_URL` explicitly pointing to a fresh disposable database
named `cic_test_*` in an empty test cluster. Never use the application database.
This test creates roles/schema and synthetic data; it skips when the variable is
absent. It proves actual blocking with separate connections, commit visibility
and rollback. Local native tests require a running PostgreSQL server.

Migration `003_owner_override.sql` adds `reassign_donor(donor_id, owner_id)` for
active admins. It accepts only an active board member in the same organization,
locks the assignment cursor before changing ownership, and records an audit event
in the same transaction. It returns only the donor and owner IDs. Missing or
foreign donors raise `P0002`; invalid owners raise `P0001`; unauthorized callers
raise `42501`. Existing gifts remain attached to the donor. Runtime cannot update
ownership directly. Run `node --test tests/owner-override.test.mjs` for embedded
database authorization and rollback checks.

Outreach task updates and API create and reassignment routes remain follow-ups.
