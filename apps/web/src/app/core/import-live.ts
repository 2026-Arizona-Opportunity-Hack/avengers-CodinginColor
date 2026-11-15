import type { Request } from './outreach-live';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const IMPORT_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'contact_person',
  'campaign', 'occurred_at', 'currency', 'external_id', 'amount_decimal', 'amount_cents'];
export interface ImportIssue { recordNumber?: number | null; field: string; code: string }
export interface ImportPreview {
  headers: string[]; mapping: Array<string | null>; issues: ImportIssue[];
  counts: { rows: number; donors: number; gifts: number; excluded: number };
}
export interface ImportResult {
  batch_id: string; status: 'reviewing' | 'committed' | 'abandoned'; file_sha256?: string; replayed?: boolean;
  preview?: ImportPreview;
  counts?: { donors_created: number; donors_linked: number; gifts_inserted: number; gifts_corrected: number; skipped: number };
}
export interface ImportLayout {
  mapping: Record<string, string | null>; skip_records: number[];
  batch_values: { currency?: string; occurred_at?: string; status?: string; refund_cents?: number };
  date_format?: string; utc_offset?: string;
}
export interface PreviewRow { recordNumber: number; raw: string[]; issues: ImportIssue[] }
export interface PlanRow {
  row: number; action: string; reason: string; existingIds: string[]; matchingRows: number[];
  draft: Record<string, unknown>; candidates: Array<Record<string, unknown>>;
}
export interface ImportPlan { plan_hash: string; donor_plan_hash: string; counts: Record<string, number>; excluded: number; unresolved: ImportIssue[] }
export interface ImportDecision { kind: 'donor' | 'gift'; row: number; action: 'new' | 'link' | 'insert' | 'correct' | 'skip'; donor_id?: string; gift_id?: string }
export interface ImportReview { status: 'ready' | 'needs_review'; total_pending?: number }

const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const path = (batch: string) => `/api/v1/imports/${encodeURIComponent(batch)}`;

/** Sends only reviewed choices and plan hashes; the server constructs all persistence operations. */
export class LiveImports {
  private readonly request: Request;
  constructor(request: Request) { this.request = request; }

  upload(file: File, source: string): Promise<ImportResult> {
    const workbook = /\.xlsx$/i.test(file.name);
    if (!/\.(csv|xlsx)$/i.test(file.name) || !file.size || file.size > 4194304)
      throw new Error('Choose a non-empty CSV or XLSX file up to 4 MiB.');
    if (!/^[ -~]{1,255}$/.test(file.name) || /[\\/]/.test(file.name))
      throw new Error('Use a file name of at most 255 plain-text characters without folders.');
    return this.request('/api/v1/imports', { method: 'POST', body: file, headers: {
      'Content-Type': workbook ? XLSX_MIME : 'text/csv; charset=utf-8',
      'X-Import-Source': source, 'X-Import-Filename': file.name,
    } });
  }

  layout(batch: string, layout: ImportLayout): Promise<ImportResult> {
    return this.request(`${path(batch)}/layout`, post(layout));
  }

  async rows<T>(batch: string, kind: 'preview' | 'donor' | 'gift', planned = false): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; ) {
      const page = await this.request<{ items: T[]; total: number; next_offset: number }>(
        `${path(batch)}/${planned ? 'plan/rows' : 'rows'}?kind=${kind}&limit=200&offset=${offset}`);
      rows.push(...page.items);
      if (page.next_offset >= page.total) return rows;
      if (page.next_offset <= offset) throw new Error('The server returned an incomplete row page. Reload the import.');
      offset = page.next_offset;
    }
  }

  plan(batch: string, kind: 'donor' | 'gift'): Promise<ImportPlan> {
    return this.request(`${path(batch)}/${kind}s/plan`, post());
  }

  review(batch: string, kind: 'donor' | 'gift', plan: ImportPlan, decisions: ImportDecision[]): Promise<ImportReview> {
    return this.request(`${path(batch)}/${kind}s/review`, post({ plan_hash: plan.plan_hash,
      ...(kind === 'gift' ? { donor_plan_hash: plan.donor_plan_hash } : {}), decisions }));
  }

  commit(batch: string, plan: ImportPlan): Promise<ImportResult> {
    return this.request(`${path(batch)}/commit`, post({ donor_plan_hash: plan.donor_plan_hash, plan_hash: plan.plan_hash }));
  }

  abandon(batch: string): Promise<ImportResult> { return this.request(`${path(batch)}/abandon`, post()); }
}
