// Vercel entry point (#30). Vercel's zero-config Express support runs this module's default
// export as one function; it must not call listen(). Local and other hosts keep using
// `npm run start:api` (apps/api/server.ts). Static files come from public/ (the built web app).
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import express from 'express';
import { createApp } from '../apps/api/app.ts';
import { clerkProvider, createVerifier } from '../apps/api/auth.ts';
import { EnvSchema } from '../apps/api/env.ts';
import { webApp } from './web.ts';

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

// The built web app is served first; API and health paths always fall through to createApp.
// Keep the path a literal URL relative to this file so Vercel's file tracer bundles public/.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
// The tracer only bundles the whole folder when it sees express.static() on that path in this file;
// passing it into webApp() alone bundled just the JS chunks (no index.html, config.json or fonts).
const assets = express.static(publicDir, {
  index: false, dotfiles: 'ignore', fallthrough: true,
  // config.json and index.html change on every deploy; hashed assets can be cached.
  setHeaders: (res, path) => { if (/\.(?:html|json)$/i.test(path)) res.setHeader('Cache-Control', 'no-cache'); },
});
export default express().disable('x-powered-by').use(webApp(publicDir, assets))
  .use(createApp(env, db, createVerifier(env, clerkProvider(env))));
