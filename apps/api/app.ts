import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { HttpError, type Env } from './env.ts';
import { withMember, type Database } from './db.ts';
import type { Identity } from './auth.ts';
import { donors } from './donors.ts';
import { gifts } from './gifts.ts';
import { imports } from './imports.ts';
import { createReportingRouter } from './reporting.ts';
import { createDashboardRouter } from './dashboard.ts';
import { createApiKeyRouter } from './api-keys.ts';
import { createOutreachRouter } from './outreach.ts';

export function createApp(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin && origin !== env.APP_ORIGIN) return next(new HttpError(403));
    if (origin) res.set('Access-Control-Allow-Origin', env.APP_ORIGIN);
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH');
      res.set('Access-Control-Allow-Headers', /^\/api\/v1\/imports(?:\/|$)/.test(req.path)
        ? 'Authorization, Content-Type, X-Import-Source, X-Import-Filename' : 'Authorization, Content-Type');
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/api/v1/me', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const member = await withMember(db, env.CIC_ORG_ID, identity, async (_client, membership) => membership);
    res.json(member);
  });
  app.use('/api/v1/donors', express.json({ limit: '32kb' }), donors(env, db, verify));
  app.use('/api/v1/gifts', express.json({ limit: '32kb' }), gifts(env, db, verify));
  app.use('/api/v1/imports', imports(env, db, verify));
  app.use(createReportingRouter(env, db, verify));
  // Key-authenticated CIC dashboard routes (no Clerk session); aggregates only.
  app.use(createDashboardRouter(db, { offset: '-07:00', minDonors: 3, limitPerMinute: 60 }));
  app.use('/api/v1/api-keys', express.json({ limit: '4kb' }));
  app.use(createApiKeyRouter(env, db, verify));
  app.use('/api/v1/follow-ups', express.json({ limit: '32kb' }));
  app.use(createOutreachRouter(env, db, verify));
  app.use((_req, _res, next) => next(new HttpError(404)));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : 503;
    res.status(status).json({ error: status === 503 ? 'Service unavailable' : 'Request rejected' });
  };
  app.use(errors);
  return app;
}
