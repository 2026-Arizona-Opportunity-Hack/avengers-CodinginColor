/**
 * Live Outreach and API-key calls (#48), framework-free so they run under `node --test`.
 * Each function takes the app's authenticated request function and returns the UI models the
 * Outreach and API pages already render. Owner: Outreach/Reporting (@nathannarik).
 */
import type { ApiKey, Channel, Draft, DraftStatus, FollowUp } from './models';

export type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface ApiFollowUp {
  id: string; donor_id: string; owner_id: string; kind: 'quarterly' | 'next_action'; quarter?: string | null;
  title: string; status: 'open' | 'done' | 'cancelled'; due_at: string; donor_name?: string;
}
export interface ApiDraft {
  id: string; donor_id: string; author_id: string; channel: 'email' | 'sms'; recipient: string; subject: string | null;
  body: string; status: 'draft' | 'approved' | 'sent' | 'failed' | 'logged'; approved_by: string | null;
  approved_at: string | null; created_at: string;
}
export interface ApiKeyRow { id: string; name: string; hint: string; created_by: string; created_at: string; revoked_at: string | null }

/** UI template IDs the server can render. Nudges and board digests stay local-only for now. */
export const LIVE_TEMPLATES: Readonly<Record<string, string>> = {
  't-thanks-email': 'thank_you', 't-thanks-text': 'thank_you_sms', 't-quarterly': 'quarterly_update',
};
const UI_TEMPLATE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LIVE_TEMPLATES).map(([ui, api]) => [api, ui]));

const id = encodeURIComponent;
const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Calendar date of an instant at a fixed UTC offset (CIC is in Phoenix: -07:00 all year). */
export function localDate(instant: string, offset = '-07:00'): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error('Offset must look like -07:00');
  const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error('Invalid timestamp');
  return new Date(ms + minutes * 60_000).toISOString().slice(0, 10);
}

export function toFollowUp(f: ApiFollowUp, offset = '-07:00'): FollowUp {
  return {
    id: f.id, donor_id: f.donor_id, owner_id: f.owner_id, kind: f.kind === 'quarterly' ? 'quarterly' : 'next_step',
    action: f.title, due_on: localDate(f.due_at, offset), status: f.status === 'cancelled' ? 'dismissed' : f.status,
    created_at: f.due_at, completed_at: null,
  };
}

const DRAFT_STATUS: Record<ApiDraft['status'], DraftStatus> = {
  draft: 'pending', failed: 'pending', approved: 'approved', sent: 'sent', logged: 'sent',
};
export function toDraft(d: ApiDraft): Draft {
  const channel: Channel = d.channel === 'sms' ? 'text' : 'email';
  return {
    id: d.id, donor_id: d.donor_id, recipient_member_id: null, owner_id: d.author_id, template_id: '', channel,
    to: d.recipient, subject: d.subject ?? '', body: d.body, reason: '', status: DRAFT_STATUS[d.status],
    created_at: d.created_at, approved_by: d.approved_by, approved_at: d.approved_at, sent_by: null, sent_at: null,
  };
}

export function toApiKey(k: ApiKeyRow): ApiKey {
  return { id: k.id, label: k.name, prefix: k.hint, created_at: k.created_at, created_by: k.created_by,
    last_used_at: null, revoked_at: k.revoked_at };
}

/** Open follow-ups, most urgent first (the server already splits and sorts them). */
export async function loadFollowUps(request: Request, scope: 'mine' | 'all' = 'mine'): Promise<FollowUp[]> {
  const q = await request<{ overdue: ApiFollowUp[]; due_this_week: ApiFollowUp[]; upcoming: ApiFollowUp[] }>(
    `/api/v1/follow-ups?scope=${scope}`);
  return [...q.overdue, ...q.due_this_week, ...q.upcoming].map((f) => toFollowUp(f));
}
export const addNextStep = (request: Request, donorId: string, title: string, dueAt: string) =>
  request<ApiFollowUp>('/api/v1/follow-ups', post({ donor_id: donorId, title, due_at: dueAt })).then((f) => toFollowUp(f));
export const completeFollowUp = (request: Request, followUpId: string) =>
  request<{ id: string; status: string }>(`/api/v1/follow-ups/${id(followUpId)}/complete`, post());
/** Admin only: one quarterly touch per eligible donor; repeating it adds nothing. */
export const planQuarter = (request: Request, quarter: string) =>
  request<{ created: number; skipped: Record<string, number> }>('/api/v1/follow-ups/quarterly', post({ quarter }));

export async function loadDrafts(request: Request): Promise<Draft[]> {
  return (await request<{ items: ApiDraft[] }>('/api/v1/drafts')).items.map(toDraft);
}
/** Null when the template has no server version; the caller should say so instead of drafting locally. */
export async function createLiveDraft(request: Request, donorId: string, templateId: string,
  fields: Record<string, string>): Promise<Draft | null> {
  const template = LIVE_TEMPLATES[templateId];
  if (!template) return null;
  const created = await request<Omit<ApiDraft, 'donor_id' | 'author_id' | 'approved_by' | 'approved_at' | 'created_at'>>(
    '/api/v1/drafts', post({ donor_id: donorId, template, fields }));
  return { ...toDraft({ ...created, donor_id: donorId, author_id: '', approved_by: null, approved_at: null,
    created_at: new Date().toISOString() }), template_id: UI_TEMPLATE[template] ?? '' };
}
/** Any edit drops the approval on the server; the draft must be approved again. */
export const editLiveDraft = (request: Request, draftId: string, patch: { subject?: string; body?: string }) =>
  request<{ id: string; status: ApiDraft['status'] }>(`/api/v1/drafts/${id(draftId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const approveLiveDraft = (request: Request, draftId: string) =>
  request<{ id: string; status: ApiDraft['status'] }>(`/api/v1/drafts/${id(draftId)}/approve`, post());
/** mailto:/sms: link for the approved text; the server rechecks consent and contact first. */
export const composeHref = async (request: Request, draftId: string) =>
  (await request<{ href: string }>(`/api/v1/drafts/${id(draftId)}/compose`)).href;
/** Only after the person confirms they actually sent it; closes this quarter's touch for the donor. */
export const logManualSend = (request: Request, draftId: string) =>
  request<{ status: 'logged'; closed_follow_ups: number; already_logged: boolean }>(
    `/api/v1/drafts/${id(draftId)}/manual-send`, post({ confirmed: true }));

export async function loadApiKeys(request: Request): Promise<ApiKey[]> {
  return (await request<{ items: ApiKeyRow[] }>('/api/v1/api-keys')).items.map(toApiKey);
}
/** The raw key comes back exactly once: show it, never store it. */
export async function issueApiKey(request: Request, name: string, createdBy: string): Promise<{ key: ApiKey; secret: string }> {
  const r = await request<{ id: string; name: string; hint: string; key: string }>('/api/v1/api-keys', post({ name }));
  return { key: toApiKey({ id: r.id, name: r.name, hint: r.hint, created_by: createdBy,
    created_at: new Date().toISOString(), revoked_at: null }), secret: r.key };
}
export const revokeApiKey = (request: Request, keyId: string) =>
  request<{ id: string; revoked_at: string }>(`/api/v1/api-keys/${id(keyId)}/revoke`, post());
