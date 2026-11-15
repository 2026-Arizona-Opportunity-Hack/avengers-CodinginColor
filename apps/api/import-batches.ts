import { z } from 'zod';
import { previewCsv } from '../../tools/import-preview.ts';
import { buildImportDrafts } from '../../tools/import-drafts.ts';
import { GiftWriteSchema, IdSchema } from '../../packages/contracts/index.ts';
import { HttpError } from './env.ts';
import type { Client } from './db.ts';
export class ImportError extends HttpError {
  readonly code:string;
  constructor(status:number,code:string) { super(status); this.code=code; }
}
export const fail=(status:number,code:string):never=>{throw new ImportError(status,code);};
export function parse<T>(schema:z.ZodType<T>,value:unknown,code='invalid_decision'):T {
  const r=schema.safeParse(value); if(!r.success) return fail(400,code); return r.data;
}
export const Layout=z.strictObject({mapping:z.record(z.string(),z.string().nullable()).default({}),
  aliases:z.strictObject({campaign:z.record(z.string(),IdSchema.nullable()).default({}),
    contact_person:z.record(z.string(),IdSchema.nullable()).default({})}).default({campaign:{},contact_person:{}}),
  skip_records:z.array(z.int().min(2)).max(20000).default([]),
  batch_values:z.strictObject({currency:GiftWriteSchema.shape.currency.optional(),occurred_at:GiftWriteSchema.shape.occurred_at.optional(),
    status:GiftWriteSchema.shape.status.optional(),refund_cents:GiftWriteSchema.shape.refund_cents.optional()}).default({}),
  date_format:z.enum(['MM/DD/YYYY','DD/MM/YYYY','YYYY-MM-DD']).optional(),utc_offset:z.string().optional()});
export type Batch={id:string;org_id:string;source:string;filename:string;file_sha256:string;raw_csv:Uint8Array|null;
  status:'reviewing'|'committed'|'abandoned';layout:z.infer<typeof Layout>|null;donor_decisions:unknown[]|null;gift_decisions:unknown[]|null;
  donor_plan_hash:string|null;gift_plan_hash:string|null;reviewer_id:string|null;result:Record<string,unknown>|null};
export async function batchOf(client:Client,id:unknown,org:string):Promise<Batch> {
  const key=IdSchema.safeParse(id); if(!key.success) return fail(404,'import_not_found');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['cic-import:'+org]);
  const r=await client.query('SELECT * FROM import_batches WHERE id=$1 AND org_id=$2 FOR UPDATE',[key.data,org]);
  if(!r.rows.length) return fail(404,'import_not_found'); return r.rows[0] as unknown as Batch;
}
export function staged(batch:Batch) {if(batch.status!=='reviewing') fail(409,'batch_not_reviewing');}
export function draftsOf(batch:Batch,layout:unknown=batch.layout??{}) {
  staged(batch); const l=parse(Layout,layout,'invalid_mapping');
  if(Boolean(l.date_format)!==Boolean(l.utc_offset)) fail(400,'invalid_date_options');
  try {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(batch.raw_csv!);
    if(text.includes('\0')) fail(400,'invalid_csv');
    const preview=previewCsv(text,batch.source,batch.filename,l.mapping,
      l.date_format?{date_format:l.date_format,utc_offset:l.utc_offset}:undefined);
    if(preview.rows.length>20000||preview.headers.length>200) fail(400,'row_limit_exceeded');
    const drafts=buildImportDrafts(preview,{batch_id:batch.id,values:l.batch_values,aliases:l.aliases});
    if(l.skip_records.some(n=>!drafts.excluded.some(r=>r.recordNumber===n))) fail(400,'invalid_decision');
    return {preview,drafts};
  } catch(e) {
    if(e instanceof ImportError) throw e;
    if(e instanceof TypeError) fail(400,'invalid_utf8');
    if(e instanceof Error&&['CSV header is missing','CSV has blank or duplicate headers'].includes(e.message)) fail(400,'invalid_csv');
    return fail(400,l.date_format?'invalid_date_options':'invalid_mapping');
  }
}
export const summary=(b:Batch)=>({batch_id:b.id,file_sha256:b.file_sha256,status:b.status,
  ...(b.status==='committed'?{...b.result,replayed:true}:{})});
export function countsOf(b:Batch) {
  const {preview,drafts}=draftsOf(b);
  return {headers:preview.headers,mapping:preview.mapping,issues:drafts.unresolved,
    counts:{rows:preview.rows.length,donors:drafts.donors.length,gifts:drafts.gifts.length,excluded:drafts.excluded.length}};
}
