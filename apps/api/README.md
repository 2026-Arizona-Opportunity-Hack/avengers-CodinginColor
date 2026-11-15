# Core API foundation

Requires Node 24+, `npm ci`, a migrated PostgreSQL database and Clerk instance.
Copy root `.env.example` to `.env` and supply actual values privately. Configure
`CIC_ORG_ID` to CIC's database organization UUID; callers cannot choose an org.
`DATABASE_URL` must use a restricted login granted `cic_runtime`, never the
migration owner. Provision an active membership matching each invited Clerk user
subject using an administrative connection. There is no public sign-up endpoint.

Run `npm run start:api`, `npm run typecheck`, and `npm run test:api`.
`GET /api/v1/me` takes `Authorization: Bearer <Clerk session token>` and returns
only `{id, org_id, role}`. Missing/invalid sessions get 401, disallowed origins or
memberships get 403, and dependency failures get 503 without underlying messages.
Only exact `APP_ORIGIN` is allowed by CORS. Configure invitation-only registration
in Clerk; require verified primary email and MFA for admins. Each request verifies
the signed token's issuer/authorized party, checks the live session and user, and
checks current database membership. Admin tokens must contain a verified second
factor (`fva[1] >= 0`); MFA enrollment alone grants no access.

Database context and runtime role are transaction-local; failed transactions roll
back, and failed rollback destroys the pooled connection. Tests use mocked Clerk,
HTTP, and database clients; they do not prove live provider configuration or Neon
connectivity. No donor or gift routes are implemented in this slice.
