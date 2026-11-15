import { Pool } from 'pg';
import { EnvSchema } from './env.ts';
import { clerkProvider, createVerifier } from './auth.ts';
import { createApp } from './app.ts';

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid API configuration:', [...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(', '));
  process.exit(1);
}
const env = parsed.data;
const db = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000,
  statement_timeout: 10000, max: 10 });
const server = createApp(env, db, createVerifier(env, clerkProvider(env))).listen(env.PORT);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { void db.end(); }));
}
