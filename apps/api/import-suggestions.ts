import type { Router } from 'express';
import { z } from 'zod';
import { suggestColumn } from '../../tools/import-suggest.ts';
import { batchOf, draftsOf, fail, parse } from './import-batches.ts';
import type { ImportAccess } from './import-plans.ts';
import { RateLimiter } from './rate-limit.ts';

const Request = z.strictObject({ header: z.string().min(1).max(300) });

/** Read-only advice: original cells and reviewed decisions never leave the server. */
export function registerImportSuggestions(router: Router, admin: ImportAccess, org: string, propose = suggestColumn) {
  const limiter = new RateLimiter({ limit: 20, windowMs: 60_000, maxEntries: 1000 });
  router.post('/:id/suggestion', async (req, res) => {
    const header = await admin(req.get('Authorization'), async (c, m) => {
      const request = parse(Request, req.body);
      const { preview } = draftsOf(await batchOf(c, req.params.id as string, org));
      if (!preview.headers.some((h, i) => h === request.header && preview.mapping[i] === null)
        || !preview.issues.some(i => i.recordNumber === null && i.code === 'unmapped_column' && i.field === request.header))
        fail(400, 'invalid_decision');
      if (!limiter.hit(m.id).ok) fail(429, 'rate_limited');
      return request.header;
    });
    // Release the database transaction before waiting for the optional provider.
    try { res.json({ suggestion: await propose({ header, samples: [] }) }); }
    catch { res.json({ suggestion: null, unavailable: true }); }
  });
}
