// Vercel entry point (#30). Vercel's zero-config Express support runs this module's default
// export as one function; it must not call listen(). Local and other hosts keep using
// `npm run start:api` (apps/api/server.ts). Static files come from public/ (the built web app).
import { Pool } from 'pg';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createApp } from '../apps/api/app.ts';
import { clerkProvider, createVerifier } from '../apps/api/auth.ts';
import { EnvSchema } from '../apps/api/env.ts';

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Names only: values can be credentials.
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].join(', ');
  throw new Error(`Invalid API configuration: ${names}`);
}
const env = parsed.data;
// Serverless instances are short-lived and many: keep each pool small and use Neon's pooled host.
const db = new Pool({ connectionString: env.DATABASE_URL, max: 3, idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5000, statement_timeout: 10_000 });

// The built web app lives in public/ (deploy/vercel-build.ts). Vercel's static builder snapshots
// public/ before the build command runs, so files generated there are never put on the CDN; this
// function serves them instead. The new URL(..., import.meta.url) form lets Vercel's file tracer bundle public/.
const web = fileURLToPath(new URL('../public', import.meta.url));
const hashed = /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/;
const app = express().disable('x-powered-by');
app.use(express.static(web, {
  index: false,
  setHeaders: (res, file) => res.setHeader('Cache-Control', hashed.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'),
}));
// Client-side routes (/donors/123) get the app shell; /api and /healthz always reach the API.
app.get(/^\/(?!api\/|healthz$).*/, (req, res, next) => {
  if (!req.accepts('html')) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile('index.html', { root: web });
});
app.use(createApp(env, db, createVerifier(env, clerkProvider(env))));

export default app;
