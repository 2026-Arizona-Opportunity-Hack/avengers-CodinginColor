import type { Client } from './db.ts';
import { fail, type Layout } from './import-batches.ts';
import type { z } from 'zod';

export async function aliasCatalog(c: Client, org: string) {
  return { campaigns: (await c.query('SELECT id,title FROM campaigns WHERE org_id=$1 ORDER BY title,id', [org])).rows,
    owners: (await c.query('SELECT * FROM public.assignable_owners()')).rows };
}

/** Validate reviewed IDs again when plans are refreshed and immediately before atomic commit. */
export async function validateAliases(c: Client, org: string, aliases: z.infer<typeof Layout>['aliases']) {
  if (!Object.keys(aliases.campaign).length && !Object.keys(aliases.contact_person).length) return;
  const catalog = await aliasCatalog(c, org);
  for (const [field, entries] of [['campaign', catalog.campaigns], ['contact_person', catalog.owners]] as const) {
    const allowed = new Set(entries.map(r => String(r.id)));
    if (Object.values(aliases[field]).some(id => id !== null && !allowed.has(id))) fail(400, 'invalid_alias');
  }
}
