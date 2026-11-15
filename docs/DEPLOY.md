# Deploying the CIC donor platform

This is the runbook for a person, not an agent: **only people create accounts, generate
passwords and paste keys**. Nothing in this file is a real credential. Tracked in #30.

The current public frontend is **Try Now only**: fictional browser-local records, without Clerk/config/API requests. Procedures below configure the separate protected API; they do not enable a public live-login toggle. Historical signed-in walkthrough instructions require a separately supported authenticated client. Default deployment still validates backend settings; runtime API authentication remains enforced.

## What runs where

| Piece | Service | Notes |
|---|---|---|
| API + built web app | One Vercel project (chosen on #30): the Express API runs as a Vercel Function from `src/index.ts`, and the web app is served from `public/` on the same origin | health check `GET /healthz` |
| Database | Neon Postgres (Free) | Two logins: a **migration owner** and a restricted **runtime login** |
| Sign-in | Clerk (development instance for the demo) | Invite-only; admins need a second factor |

Budget: Vercel Hobby is $0 but limited to **non-commercial personal use**. That's fine for the
hackathon demo, but CIC's ongoing use likely needs Vercel Pro (about $20/month, the whole
OHack recurring budget) or another approved plan. Neon and Clerk are $0 on the plans above; see #30.

## 1. Neon: database and the two logins

1. Create a Neon project on **PostgreSQL 16 or newer**. The migration and provisioning
   safety checks use PostgreSQL 16 role options.
2. From **Connect**, copy two connection strings for the owner role (`neondb_owner`):
   - **Direct** host (no `-pooler` in the hostname). This is `MIGRATION_DATABASE_URL`.
     Migrations take a session lock that does not work through the pooler.
   - **Pooled** host (`-pooler`). You'll use its hostname for the runtime login in step 4.
   Keep `?sslmode=require` on both.
3. Put `MIGRATION_DATABASE_URL` in your local `.env` (never commit it) and apply the schema:
   ```powershell
   node --env-file-if-exists=.env db/migrate.ts
   ```
   Re-running is safe: applied migrations are skipped. **Always apply every migration
   with the same owner role.**
4. Create the **runtime login with SQL**, in Neon's SQL Editor or `psql` as the owner.
   **Do not create it in the Neon console**: console-created roles join
   `neon_superuser`, which can bypass row-level security.
   ```sql
   -- Generate a long random password locally first, e.g.
   --   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   CREATE ROLE cic_app LOGIN PASSWORD '<paste the generated password>' NOINHERIT;
   GRANT cic_runtime TO cic_app;
   ```
   `DATABASE_URL` is then the **pooled** URL with `cic_app` and that password. The API
   switches to `cic_runtime` inside each request's transaction, so `cic_app` itself
   needs nothing else. Never grant it BYPASSRLS, table ownership, or `neon_superuser`.

## 2. Clerk: invite-only sign-in

1. Create a Clerk application (a development instance is fine for the demo).
2. Turn off public sign-ups: set the sign-up mode to restricted or invitation-only.
   There is no sign-up endpoint in the API either.
3. Turn on a second factor (authenticator app). The API refuses **admins** whose session
   has no verified second factor. Production MFA may need a paid Clerk plan; this is an
   open decision on #7 and #30.
4. Copy the keys:
   - `CLERK_SECRET_KEY` (`sk_test_…`): server only.
   - `CLERK_PUBLISHABLE_KEY` (`pk_test_…`): public, used by the web build.
   - `CLERK_JWT_ISSUER`: the instance's Frontend API URL (`https://<name>.clerk.accounts.dev`).
5. Invite the CEO (admin) and each board member, and note each person's **user ID**
   (`user_…`) from the Users page.
6. Production instances need a domain CIC controls (for example `donors.codingincolor.net`).
   That's a handoff step, not needed for the demo.

## 3. Organization and members

1. Pick the deployment's organization ID once and keep it:
   `node -e "console.log(crypto.randomUUID())"`, saved as `CIC_ORG_ID`.
2. Copy `db/provision.example.json` to a file **outside the repo**, fill in the Clerk
   user IDs and roles, then run (needs #35):
   ```powershell
   node --env-file-if-exists=.env db/provision.ts C:\path\to\roster.json
   ```
3. Demo only: load fictional data (needs #36). It refuses to run if any real donor exists.
   ```powershell
   node --env-file-if-exists=.env db/seed-demo.ts --yes-demo-data
   ```

## 4. The web service

**Vercel** (chosen on #30). Use the existing project connected to this repository. `vercel.json`
already sets the install and build steps.

> **Root Directory must be the repository root (leave it blank).** If it's set to `apps/web`,
> Vercel ignores `vercel.json` and `src/index.ts`, and deploys only the static web app on
> demo data. `/healthz`, `/config.json` and `/api/*` then all return the web page with a 200.
> That's what `cadence-cic.vercel.app` served on Nov 15, and the smoke check fails 5 of 7 checks.
> To fix it, go to **Settings → Build and Deployment → Root Directory**, clear the field,
> set Framework Preset to **Express** and Node.js to **24.x**, then redeploy.

| Setting | Value |
|---|---|
| Framework | Pinned to Express in `vercel.json`; runs `src/index.ts`, which default-exports the app (no `listen`) |
| Node.js version | 24.x (Angular's build needs 24.15 or newer) |
| Install | `npm ci && npm ci --prefix apps/web` |
| Build | validates required runtime settings without printing values, builds `apps/web`, then `node deploy/vercel-build.ts` copies it into `public/` and writes `config.json` (same-origin API plus the Clerk publishable key) |
| Routing | static files from `public/`; page routes rewrite to `index.html`; `/api/*` and `/healthz` reach the API |

Check these on the **first deploy**; none have been verified on Vercel yet:
1. The build log shows the Angular build succeeding. If npm blocks install scripts
   (for example esbuild's), approve them for `apps/web`.
2. `GET /healthz` returns 200 from the function.
3. A deep link such as `/donors` loads the web app instead of the API's 404.

Running elsewhere: `npm run start:api` (`apps/api/server.ts`) still starts a normal
long-running server.

Environment variables in Vercel → Settings → Environment Variables (the function refuses
to start, logging only the variable *names*, if any is missing or invalid):

| Variable | Value | Secret? |
|---|---|---|
| `DATABASE_URL` | pooled URL with `cic_app` | yes |
| `CIC_ORG_ID` | the UUID from step 3 | no |
| `CLERK_SECRET_KEY` | `sk_test_…` / `sk_live_…` | yes |
| `CLERK_JWT_ISSUER` | `https://<name>.clerk.accounts.dev` | no |
| `APP_ORIGIN` | the production URL, exact origin, e.g. `https://<project>.vercel.app` | no |
| `CLERK_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…`, written into the web app's `config.json` at build time; **the build fails without it** | no (public) |
| `CIC_WEB_DEMO_MODE` | optional: `1` deliberately ships the web app on demo data (no `config.json`) | no |

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is accepted as an alias for `CLERK_PUBLISHABLE_KEY`. Use matching test or live Clerk keys. Set these variables for each environment you deploy. `APP_ORIGIN` must match the exact domain used to open the app; production values do not automatically authorize a preview domain. Keep `CIC_WEB_DEMO_MODE` unset for the connected application.

Before redeploying, apply all committed migrations locally with the migration owner. The Vercel build never runs privileged migrations. Validate configuration locally with `node --env-file-if-exists=.env deploy/check-env.ts`.

**Never** set `MIGRATION_DATABASE_URL` on the web service. It's only used from a
person's machine for migrations, provisioning and seeding.

## 5. Check it works

First run the unauthenticated smoke check against the deployment URL. It needs no keys, and it exits non-zero if
anything fails. A static-only deploy (no API or `config.json`) fails five of the seven checks.

```powershell
node deploy/smoke.ts https://<your-deployment>.vercel.app
```

Then check the signed-in behavior by hand:

| Check | Expected |
|---|---|
| `GET /healthz` | `200 {"status":"ok"}` |
| `GET /api/v1/me` with no token | `401` |
| Sign in as a board member, `GET /api/v1/me` | `200` with role `board` |
| Board member opens another member's donor | `404` |
| Board member requests the funder packet | `403` |
| Admin downloads the funder packet CSV | file downloads; an `audit_events` row is added |
| A request from another website's origin | `403` |

## 6. Backups, rotation and handoff

- **Backups:** Neon keeps restore history for the plan's window. Before risky changes,
  also take a manual dump with the owner URL: `pg_dump "$MIGRATION_DATABASE_URL" -Fc -f cic.dump`.
  Store it privately; it contains donor data.
- **Rotate after the hackathon:** reset the `cic_app` password
  (`ALTER ROLE cic_app PASSWORD '…'`) and roll the Clerk secret key. Then remove team
  members from Neon, Clerk and the host.
- **Hand over to CIC:** transfer the Neon project, Clerk application and host service
  to a CIC-owned account, and add CIC's domain to the Clerk production instance.
