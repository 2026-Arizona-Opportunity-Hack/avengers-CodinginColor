import express from 'express';
import { z } from 'zod';
import { buildFunderPacket, packetCsv, type PacketGift, type PacketOutcome } from '../../packages/reporting/funder-packet.ts';
import { instant, retentionReport, ytdWindows, type RetentionGift } from '../../packages/reporting/retention.ts';
import { withMember, type Database } from './db.ts';
import { HttpError, type Env } from './env.ts';
import type { Identity } from './auth.ts';

/** CIC reports in Phoenix time, which has no daylight saving. */
const OFFSET = '-07:00';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RetentionQuery = z.strictObject({ asOf: day, from: day.optional(), programId: z.uuid().optional(),
  ownerId: z.uuid().optional(), campaignId: z.uuid().optional(), cohort: z.string().regex(/^\d{4}$/).optional() });
const PacketQuery = z.strictObject({
  funderId: z.uuid(), programId: z.uuid(), from: day, to: day, format: z.enum(['json', 'csv']).default('json'),
});
const OutcomeUpload = z.strictObject({ approved: z.literal(true), outcomes: z.array(z.strictObject({
  program_id: z.uuid(), from: day, to: day, metric: z.string().trim().min(1).max(120),
  value: z.number().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), unit: z.string().trim().min(1).max(60),
  denominator: z.number().positive().max(Number.MAX_SAFE_INTEGER).nullable(), source: z.string().trim().min(1).max(500),
})).min(1).max(100) });

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

  router.post('/api/v1/reports/outcomes', express.json({ limit: '100kb' }), async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const upload = parse(OutcomeUpload, req.body);
    const rows = upload.outcomes.map(row => {
      const from = `${row.from}T00:00:00${OFFSET}`, to = `${row.to}T00:00:00${OFFSET}`;
      try { if (instant(from) >= instant(to)) throw new Error(); } catch { throw new HttpError(400); }
      return { ...row, from, to };
    });
    await withMember(db, env.CIC_ORG_ID, identity, async (client, member) => {
      if (member.role !== 'admin') throw new HttpError(403);
      for (const row of rows) {
        const program = await client.query('SELECT id FROM programs WHERE id = $1', [row.program_id]);
        if (!program.rows.length) throw new HttpError(404);
        const saved = await client.query(`INSERT INTO program_outcomes
          (org_id, program_id, period_from, period_to, metric, value, unit, denominator, source, approved_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (org_id, program_id, period_from, period_to, metric) DO UPDATE SET
            value = EXCLUDED.value, unit = EXCLUDED.unit, denominator = EXCLUDED.denominator,
            source = EXCLUDED.source, approved_by = EXCLUDED.approved_by, approved_at = now() RETURNING id`,
        [env.CIC_ORG_ID, row.program_id, row.from, row.to, row.metric, row.value, row.unit, row.denominator, row.source, member.id]);
        await client.query(`INSERT INTO audit_events (org_id, actor_id, action, target_id, status)
          VALUES ($1,$2,'report.outcome.approve',$3,'success')`, [env.CIC_ORG_ID, member.id, saved.rows[0].id]);
      }
    });
    res.status(201).json({ approved: rows.length });
  });

  router.get('/api/v1/reports/retention', async (req, res) => {
    const identity = await verify(req.get('Authorization'));
    const q = parse(RetentionQuery, req.query), { asOf } = q;
    let windows;
    try {
      windows = ytdWindows(asOf, OFFSET);
      if (q.from) {
        ytdWindows(q.from, OFFSET); // Validate the actual calendar day, including leap years.
        if (q.from > asOf || q.from.slice(0, 4) !== asOf.slice(0, 4)) throw new Error();
        const prior = Number(q.from.slice(0, 4)) - 1;
        const suffix = q.from.slice(5) === '02-29' ? '02-28' : q.from.slice(5);
        windows.current.from = `${q.from}T00:00:00${OFFSET}`;
        windows.prior.from = `${prior}-${suffix}T00:00:00${OFFSET}`;
      }
    } catch { throw new HttpError(400); }
    const { gifts, names } = await withMember(db, env.CIC_ORG_ID, identity, async (client) => ({
      gifts: (await client.query(`SELECT ${GIFT_COLUMNS} FROM gifts g
        JOIN donors d ON d.id = g.donor_id AND d.org_id = g.org_id
        LEFT JOIN campaigns c ON c.id = g.campaign_id AND c.org_id = g.org_id
        WHERE g.occurred_at < $1::timestamptz AND ($2::uuid IS NULL OR c.program_id = $2)
          AND ($3::uuid IS NULL OR d.owner_id = $3) AND ($4::uuid IS NULL OR g.campaign_id = $4)
          AND ($5::integer IS NULL OR $5 = (SELECT extract(year FROM min(first_gift.occurred_at) AT TIME ZONE 'America/Phoenix')
            FROM gifts first_gift WHERE first_gift.donor_id = g.donor_id AND first_gift.org_id = g.org_id
              AND first_gift.status = 'settled' AND first_gift.amount_cents > first_gift.refund_cents))`,
        [windows.current.to, q.programId ?? null, q.ownerId ?? null, q.campaignId ?? null, q.cohort ?? null])).rows.map(toGift),
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
      const outcomes: PacketOutcome[] = (await client.query(`SELECT program_id, metric, value, unit, denominator, source,
        to_char(period_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS period_from,
        to_char(period_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS period_to,
        to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS approved_at
        FROM program_outcomes WHERE program_id = $1 AND period_from < $3::timestamptz AND period_to > $2::timestamptz
        ORDER BY period_from, metric`, [q.programId, period.from, period.to])).rows.map(row => ({
          program_id: String(row.program_id), metric: String(row.metric), value: row.value === null ? null : Number(row.value),
          unit: String(row.unit), denominator: row.denominator === null ? null : Number(row.denominator), source: String(row.source),
          period: { from: String(row.period_from), to: String(row.period_to) }, approved_at: String(row.approved_at),
        }));
      const built = buildFunderPacket({ funder: { name: String(funder.name) },
        program: { id: String(program.id), title: String(program.title) }, period, gifts, outcomes });
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
