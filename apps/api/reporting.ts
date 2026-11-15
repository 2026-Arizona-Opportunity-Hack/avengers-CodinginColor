import express from 'express';
import { z } from 'zod';
import { buildFunderPacket, packetCsv, type PacketGift } from '../../packages/reporting/funder-packet.ts';
import { instant, retentionReport, ytdWindows, type RetentionGift } from '../../packages/reporting/retention.ts';
import { withMember, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';

/** CIC reports in Phoenix time, which has no daylight saving. */
const OFFSET = '-07:00';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RetentionQuery = z.strictObject({ asOf: day });
const PacketQuery = z.strictObject({
  funderId: z.uuid(), programId: z.uuid(), from: day, to: day, format: z.enum(['json', 'csv']).default('json'),
});

function parse<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) throw new HttpError(400);
  return result.data;
}

// Bigint columns are read as text and narrowed here; checkGift() rejects anything unsafe.
const GIFT_COLUMNS = `g.donor_id, g.amount_cents::text AS amount_cents, g.refund_cents::text AS refund_cents,
  g.currency, g.status, to_char(g.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`;
const toGift = (r: Record<string, unknown>): RetentionGift => ({
  donor_id: String(r.donor_id), amount_cents: Number(r.amount_cents), refund_cents: Number(r.refund_cents),
  currency: String(r.currency), status: r.status as RetentionGift['status'], occurred_at: String(r.occurred_at),
});

/**
 * Member-authenticated reporting routes. Row-level security scopes every query: board members
 * see only donors they own, admins see the whole organization, other orgs are never visible.
 */
export function createReportingRouter(env: Env, db: Database, verify: (header: string | undefined) => Promise<Identity>) {
  const router = express.Router();

  router.get('/api/v1/reports/retention', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const { asOf } = parse(RetentionQuery, req.query);
    let windows;
    try { windows = ytdWindows(asOf, OFFSET); } catch { throw new HttpError(400); }
    const { gifts, names } = await withMember(db, env.CIC_ORG_ID, identity, async (client) => ({
      gifts: (await client.query(`SELECT ${GIFT_COLUMNS} FROM gifts g WHERE g.occurred_at < $1::timestamptz`,
        [windows.current.to])).rows.map(toGift),
      names: new Map((await client.query('SELECT id, name FROM donors')).rows.map((r) => [String(r.id), String(r.name)])),
    }));
    const report = retentionReport(gifts, windows);
    res.json({
      as_of: asOf, windows,
      byCurrency: Object.fromEntries(Object.entries(report.byCurrency).map(([currency, c]) => [currency, {
        ...c, donors: c.donors.map((d) => ({ ...d, name: names.get(d.donor_id) ?? null })),
      }])),
    });
  });

  router.get('/api/v1/reports/funder-packet', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const q = parse(PacketQuery, req.query);
    const period = { from: `${q.from}T00:00:00${OFFSET}`, to: `${q.to}T00:00:00${OFFSET}` };
    try { if (instant(period.from) >= instant(period.to)) throw new Error(); } catch { throw new HttpError(400); }
    const packet = await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      if (member.role !== 'admin') throw new HttpError(403);
      const [funder] = (await client.query('SELECT name FROM donors WHERE id = $1', [q.funderId])).rows;
      const [program] = (await client.query('SELECT id, title FROM programs WHERE id = $1', [q.programId])).rows;
      if (!funder || !program) throw new HttpError(404);
      const gifts: PacketGift[] = (await client.query(`SELECT g.id, g.source, g.external_id, c.program_id, ${GIFT_COLUMNS}
        FROM gifts g LEFT JOIN campaigns c ON c.id = g.campaign_id WHERE g.donor_id = $1`, [q.funderId])).rows
        .map((r) => ({ ...toGift(r), id: String(r.id), source: String(r.source),
          external_id: r.external_id === null ? null : String(r.external_id),
          program_id: r.program_id === null ? null : String(r.program_id) }));
      const built = buildFunderPacket({ funder: { name: String(funder.name) },
        program: { id: String(program.id), title: String(program.title) }, period, gifts, outcomes: [] });
      // Exports are audited in the same transaction; a failed export records nothing.
      await client.query(`INSERT INTO audit_events (org_id, actor_id, action, target_id, status)
        VALUES ($1, $2, 'report.funder_packet.export', $3, 'success')`, [env.CIC_ORG_ID, member.id, q.funderId]);
      return built;
    });
    if (q.format === 'csv') {
      res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="funder-packet.csv"');
      res.send(packetCsv(packet));
    } else res.json(packet);
  });

  return router;
}
