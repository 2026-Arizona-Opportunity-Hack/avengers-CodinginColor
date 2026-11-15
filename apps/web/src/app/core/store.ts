import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ANCHOR, DATASET_VERSION, buildDemoDataset } from './demo-data';
import {
  ApiKey, Channel, Communication, CommunicationKind, CustomField, Dataset, Donor, DonorKind, Draft, FollowUp, Gift, Member,
  SOURCE_LABEL, Source,
} from './models';
import { Api, ApiDonor, ApiDonorPatch, ApiError, ApiMe, LiveConfig } from './api';
import { money, quarterOf, today } from './format';

const STORE_KEY = 'cadence.dataset';
const SESSION_KEY = 'cadence.session';
const SIGNED_IN_KEY = 'cadence.signed-in';

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: state stays in memory */ }
}
const KINDS: DonorKind[] = ['individual', 'company', 'foundation'];
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/** Server donor to UI donor. Company, kind, channel, sources and custom fields live in donor metadata. */
export function fromApiDonor(d: ApiDonor): Donor {
  const m = d.metadata ?? {};
  const custom: Record<string, string> = {};
  if (m['custom'] && typeof m['custom'] === 'object' && !Array.isArray(m['custom'])) {
    for (const [k, v] of Object.entries(m['custom'] as Record<string, unknown>)) if (text(v)) custom[k] = v as string;
  }
  return {
    id: d.id, name: d.name, email: d.email, phone: d.phone, company: text(m['company']),
    kind: KINDS.includes(m['kind'] as DonorKind) ? (m['kind'] as DonorKind) : 'individual',
    owner_id: d.owner_id, consent: d.consent, preferred_channel: m['preferred_channel'] === 'text' ? 'text' : 'email',
    created_at: text(m['created_at']) ?? '', archived_at: d.archived_at,
    sources: Array.isArray(m['sources']) ? (m['sources'] as unknown[]).filter((x): x is Source => typeof x === 'string' && x in SOURCE_LABEL) : [],
    custom,
  };
}

const NO_MEMBER: Member = { id: '', name: '', email: '', role: 'board', title: '', active: false };
const NOT_CONNECTED = 'This action is not connected to the server yet, so nothing was saved.';

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();

export interface NewDonorInput {
  name: string; email: string | null; phone: string | null; company: string | null;
  kind: Donor['kind']; consent: Donor['consent']; preferred_channel: Channel;
  custom: Record<string, string>; source: Source;
}

export interface ImportRow {
  action: 'create' | 'merge' | 'skip';
  matchId: string | null;
  /** Rows in one file with the same key become one donor. */
  key: string;
  donor: NewDonorInput;
  ownerId: string | null;
  gift: { amount_cents: number; campaign: string | null; occurred_at: string } | null;
}

/**
 * Client-side demo store. It enforces the same visibility rule as the server's RLS
 * (board members see only donors they own) so the demo shows role scoping, but the
 * server remains the authority once the API routes are wired.
 */
@Injectable({ providedIn: 'root' })
export class Store {
  private readonly api = inject(Api);
  /** True once a config.json points at a real API. Demo data and browser storage are then never used. */
  readonly live = signal(false);
  /** Last failed or unsupported action, shown to the person instead of a silent no-op. */
  readonly notice = signal<string | null>(null);
  private readonly rawMetadata = new Map<string, Record<string, unknown>>();
  private readonly data = signal<Dataset>(this.initial());
  readonly sessionId = signal<string>(load<string>(SESSION_KEY) ?? 'm-ceo');
  /** Demo mode only: whether someone picked a demo account. Live mode asks Clerk instead. */
  private readonly demoSignedIn = signal<boolean>(load<boolean>(SIGNED_IN_KEY) ?? false);
  readonly signedIn = computed(() => (this.live() ? this.api.status() === 'ready' : this.demoSignedIn()));
  /**
   * Changes whenever a session starts or ends. Async work captures it before a request and
   * drops the result if it changed, so a late response can never repopulate a signed-out view.
   */
  readonly sessionEpoch = signal(0);

  readonly members = computed(() => this.data().members);
  readonly programs = computed(() => this.data().programs);
  readonly campaigns = computed(() => this.data().campaigns);
  readonly templates = computed(() => this.data().templates);
  readonly outcomes = computed(() => this.data().outcomes);
  readonly apiKeys = computed(() => this.data().apiKeys);
  readonly customFields = computed(() => this.data().customFields);
  readonly audit = computed(() => this.data().audit);

  /** Until live data loads there is no member; fall back to the least-privileged role. */
  readonly me = computed<Member>(() => this.members().find((m) => m.id === this.sessionId()) ?? this.members()[0] ?? NO_MEMBER);
  readonly isAdmin = computed(() => this.me().role === 'admin');
  readonly boardMembers = computed(() => this.members().filter((m) => m.role === 'board' && m.active));

  /** Donors this session may see: admins see the organization, board members their own. */
  readonly donors = computed(() => {
    const all = this.data().donors.filter((d) => !d.archived_at);
    return this.isAdmin() ? all : all.filter((d) => d.owner_id === this.me().id);
  });
  private readonly visibleIds = computed(() => new Set(this.donors().map((d) => d.id)));
  readonly gifts = computed(() => this.data().gifts.filter((g) => this.visibleIds().has(g.donor_id)));
  readonly communications = computed(() => this.data().communications.filter((c) => this.visibleIds().has(c.donor_id)));
  readonly followUps = computed(() => this.data().followUps.filter((f) => this.visibleIds().has(f.donor_id)));
  readonly drafts = computed(() => this.data().drafts.filter((d) =>
    this.isAdmin() || d.owner_id === this.me().id || d.recipient_member_id === this.me().id));

  /** Every donor regardless of session, for import duplicate checks (admin-only screen). */
  readonly allDonors = computed(() => this.data().donors.filter((d) => !d.archived_at));
  readonly allGifts = computed(() => this.data().gifts);

  readonly ownerLoad = computed(() => {
    const counts = new Map<string, number>(this.boardMembers().map((m) => [m.id, 0]));
    for (const d of this.allDonors()) if (d.owner_id && counts.has(d.owner_id)) counts.set(d.owner_id, counts.get(d.owner_id)! + 1);
    return counts;
  });

  constructor() {
    // Live donor records stay in memory only: no donor PII is written to browser storage.
    effect(() => { if (!this.live()) save(STORE_KEY, this.data()); });
    effect(() => { if (!this.live()) save(SESSION_KEY, this.sessionId()); });
    effect(() => { if (!this.live()) save(SIGNED_IN_KEY, this.demoSignedIn()); });
  }

  private initial(): Dataset {
    const stored = load<Dataset>(STORE_KEY);
    return stored && stored.version === DATASET_VERSION ? stored : buildDemoDataset();
  }

  readonly anchor = ANCHOR;

  member(id: string | null) { return this.members().find((m) => m.id === id) ?? null; }
  donor(id: string) { return this.donors().find((d) => d.id === id) ?? null; }
  campaign(id: string | null) { return this.campaigns().find((c) => c.id === id) ?? null; }
  program(id: string | null) { return this.programs().find((p) => p.id === id) ?? null; }
  template(id: string) { return this.templates().find((t) => t.id === id) ?? null; }

  giftsFor(donorId: string) { return this.gifts().filter((g) => g.donor_id === donorId); }
  netCents(g: Gift) { return g.status === 'settled' ? g.amount_cents - g.refund_cents : 0; }
  lifetime(donorId: string) { return this.giftsFor(donorId).reduce((s, g) => s + this.netCents(g), 0); }
  lastGift(donorId: string) {
    return this.giftsFor(donorId).filter((g) => g.status !== 'void').sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0] ?? null;
  }

  setSession(id: string) { if (!this.live()) this.sessionId.set(id); }

  /** Demo sign-in: no password exists because no real account exists. Live mode uses Clerk. */
  signInDemo(id: string) {
    if (this.live() || !this.members().some((m) => m.id === id)) return;
    this.sessionId.set(id);
    this.demoSignedIn.set(true);
    this.sessionEpoch.update((n) => n + 1);
  }

  async signOut() {
    this.sessionEpoch.update((n) => n + 1);
    if (this.live()) await this.api.signOut();
    else this.demoSignedIn.set(false);
    this.notice.set(null);
  }

  /** Initials for avatars. */
  initials(name: string) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  }

  resetDemo() {
    if (this.live()) return;
    this.data.set(buildDemoDataset());
  }

  /** Switches to live mode and loads the signed-in member's data once Clerk has a session. */
  connect(config: LiveConfig) {
    this.live.set(true);
    this.data.set(this.emptyDataset([], []));
    void this.api.start(config, () => void this.refreshLive(), () => {
      this.sessionEpoch.update((n) => n + 1);
      this.rawMetadata.clear();
      this.data.set(this.emptyDataset([], []));
      this.notice.set(null);
    });
  }

  async refreshLive() {
    this.api.status.set('loading');
    try {
      const [me, donors] = await Promise.all([this.api.me(), this.api.allDonors()]);
      this.loadLive(me, donors);
      this.api.status.set('ready');
    } catch (e) {
      this.api.fail(e instanceof ApiError ? e.message : 'Could not load your data.');
    }
  }

  private emptyDataset(members: Member[], donors: Donor[]): Dataset {
    const demo = buildDemoDataset();
    return {
      version: DATASET_VERSION, members, donors, programs: [], campaigns: [], gifts: [], communications: [], followUps: [],
      templates: demo.templates, drafts: [], outcomes: [], apiKeys: [], customFields: demo.customFields, audit: [],
      assignmentCursor: 0,
    };
  }

  /**
   * There is no member directory route yet, so other owners show a short ID until one exists.
   * Visibility comes from the server: board members only ever receive their own donors.
   */
  private loadLive(me: ApiMe, donors: ApiDonor[]) {
    this.rawMetadata.clear();
    for (const d of donors) this.rawMetadata.set(d.id, d.metadata ?? {});
    const others = [...new Set(donors.map((d) => d.owner_id).filter((id): id is string => !!id && id !== me.id))];
    const members: Member[] = [
      { id: me.id, name: 'You', email: '', role: me.role, title: me.role === 'admin' ? 'Administrator' : 'Board member', active: true },
      ...others.map((id) => ({ id, name: `Member ${id.slice(0, 6)}`, email: '', role: 'board' as const, title: 'Board member', active: true })),
    ];
    this.data.set(this.emptyDataset(members, donors.map(fromApiDonor)));
    this.sessionId.set(me.id);
    this.sessionEpoch.update((n) => n + 1);
  }

  private putDonor(saved: ApiDonor) {
    this.rawMetadata.set(saved.id, saved.metadata ?? {});
    this.data.update((d) => ({ ...d, donors: d.donors.map((x) => (x.id === saved.id ? fromApiDonor(saved) : x)) }));
  }

  private mutate(fn: (d: Dataset) => void, action: string, target: string) {
    if (this.live()) { this.notice.set(NOT_CONNECTED); return; }
    this.data.update((current) => {
      const next = structuredClone(current);
      fn(next);
      next.audit.unshift({ id: uid('a'), actor_id: this.me().id, action, target, at: nowIso() });
      return next;
    });
  }

  /** Round-robin: the active board member with the fewest donors; ties rotate. */
  private nextOwner(d: Dataset): string | null {
    const board = d.members.filter((m) => m.role === 'board' && m.active);
    if (!board.length) return null;
    const counts = board.map((m) => d.donors.filter((x) => !x.archived_at && x.owner_id === m.id).length);
    const min = Math.min(...counts);
    const tied = board.filter((_, i) => counts[i] === min);
    const pick = tied[d.assignmentCursor % tied.length];
    d.assignmentCursor++;
    return pick.id;
  }

  addDonor(input: NewDonorInput): Donor {
    let created!: Donor;
    this.mutate((d) => {
      created = {
        id: uid('d'), name: input.name, email: input.email, phone: input.phone, company: input.company,
        kind: input.kind, owner_id: this.isAdmin() ? this.nextOwner(d) : this.me().id, consent: input.consent, preferred_channel: input.preferred_channel,
        created_at: nowIso(), archived_at: null, sources: [input.source], custom: input.custom,
      };
      d.donors.push(created);
    }, 'donor.create', input.name);
    return created;
  }

  /** Owner the next new donor would get, for previews. Does not advance the cursor. */
  previewOwner(): Member | null {
    if (!this.isAdmin()) return this.me();
    const copy = structuredClone(this.data());
    return this.member(this.nextOwner(copy));
  }

  addGift(input: { donor_id: string; amount_cents: number; campaign_id: string | null; occurred_at: string; source: Source }) {
    this.mutate((d) => d.gifts.push({
      id: uid('g'), refund_cents: 0, currency: 'USD', status: 'settled', external_id: null, ...input,
    }), 'gift.create', input.donor_id);
  }

  /** Resolves true when saved. In live mode the API validates, scopes and audits the change. */
  async updateDonor(id: string, patch: Partial<Pick<Donor, 'name' | 'email' | 'phone' | 'company' | 'consent' | 'preferred_channel' | 'custom'>>): Promise<boolean> {
    if (!this.live()) {
      this.mutate((d) => Object.assign(d.donors.find((x) => x.id === id)!, patch), 'donor.update', id);
      return true;
    }
    const { name, email, phone, consent, company, preferred_channel, custom } = patch;
    const metadata = { ...(this.rawMetadata.get(id) ?? {}) };
    if (company !== undefined) metadata['company'] = company;
    if (preferred_channel !== undefined) metadata['preferred_channel'] = preferred_channel;
    if (custom !== undefined) metadata['custom'] = custom;
    const body: ApiDonorPatch = { name, email, phone, consent, metadata };
    return this.liveWrite(async () => this.putDonor(await this.api.patchDonor(id, body)));
  }

  async reassign(id: string, ownerId: string): Promise<boolean> {
    if (!this.isAdmin()) return false;
    if (this.live()) { this.notice.set(NOT_CONNECTED); return false; }
    this.mutate((d) => { d.donors.find((x) => x.id === id)!.owner_id = ownerId; }, 'donor.reassign', id);
    return true;
  }

  async archiveDonor(id: string): Promise<boolean> {
    if (!this.live()) {
      this.mutate((d) => { d.donors.find((x) => x.id === id)!.archived_at = nowIso(); }, 'donor.archive', id);
      return true;
    }
    return this.liveWrite(async () => this.putDonor(await this.api.archiveDonor(id)));
  }

  private async liveWrite(run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      this.notice.set(null);
      return true;
    } catch (e) {
      this.notice.set(e instanceof ApiError ? e.message : 'The change could not be saved.');
      return false;
    }
  }

  logCommunication(input: { donor_id: string; kind: CommunicationKind; summary: string; body: string; occurred_at: string }) {
    this.mutate((d) => d.communications.push({
      id: uid('cm'), member_id: this.me().id, direction: input.kind === 'note' ? 'internal' : 'outbound', draft_id: null, ...input,
    }), `communication.${input.kind}`, input.donor_id);
  }

  addFollowUp(input: { donor_id: string; action: string; due_on: string; kind?: FollowUp['kind'] }) {
    this.mutate((d) => {
      const donor = d.donors.find((x) => x.id === input.donor_id)!;
      d.followUps.push({
        id: uid('f'), donor_id: input.donor_id, owner_id: donor.owner_id ?? this.me().id, kind: input.kind ?? 'next_step',
        action: input.action, due_on: input.due_on, status: 'open', created_at: nowIso(), completed_at: null,
      });
    }, 'followup.create', input.donor_id);
  }

  setFollowUpStatus(id: string, status: FollowUp['status']) {
    this.mutate((d) => {
      const f = d.followUps.find((x) => x.id === id)!;
      f.status = status; f.completed_at = status === 'open' ? null : nowIso();
    }, `followup.${status}`, id);
  }

  fillTemplate(templateId: string, donor: Donor | null, extra: Record<string, string> = {}): { subject: string; body: string } {
    const t = this.template(templateId)!;
    const owner = this.member(donor?.owner_id ?? this.me().id);
    const last = donor ? this.lastGift(donor.id) : null;
    const vars: Record<string, string> = {
      first_name: donor ? (donor.kind === 'individual' ? donor.name.split(' ')[0] : donor.name) : '',
      amount: last ? money(last.amount_cents) : 'your gift',
      campaign: this.campaign(last?.campaign_id ?? null)?.title ?? 'Coding in Color',
      owner_name: owner?.name.split(' ')[0] ?? 'Coding in Color',
      quarter: quarterOf(today()),
      ...extra,
    };
    const fill = (s: string) => s.replace(/{{(\w+)}}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
    return { subject: fill(t.subject), body: fill(t.body) };
  }

  createDraft(donorId: string, templateId: string, reason: string): Draft | null {
    const donor = this.donor(donorId);
    const t = this.template(templateId);
    if (!donor || !t) return null;
    const { subject, body } = this.fillTemplate(templateId, donor);
    const draft: Draft = {
      id: uid('dr'), donor_id: donor.id, recipient_member_id: null, owner_id: donor.owner_id ?? this.me().id,
      template_id: t.id, channel: t.channel, to: (t.channel === 'text' ? donor.phone : donor.email) ?? '',
      subject, body, reason, status: 'pending', created_at: nowIso(),
      approved_by: null, approved_at: null, sent_by: null, sent_at: null,
    };
    this.mutate((d) => d.drafts.push(draft), 'draft.create', donor.id);
    return draft;
  }

  /** Quarterly touch: one draft per visible donor with consent and a reachable channel. */
  generateQuarterly(templateId: string): number {
    const quarter = quarterOf(today());
    const existing = new Set(this.drafts().filter((d) => d.template_id === templateId && d.reason.startsWith(quarter)).map((d) => d.donor_id));
    const targets = this.donors().filter((d) => d.consent !== 'denied' && d.email && !existing.has(d.id));
    const t = this.template(templateId)!;
    this.mutate((data) => {
      for (const donor of targets) {
        const { subject, body } = this.fillTemplate(templateId, donor);
        data.drafts.push({
          id: uid('dr'), donor_id: donor.id, recipient_member_id: null, owner_id: donor.owner_id ?? this.me().id,
          template_id: t.id, channel: 'email', to: donor.email!, subject, body, reason: `${quarter} quarterly update`,
          status: 'pending', created_at: nowIso(), approved_by: null, approved_at: null, sent_by: null, sent_at: null,
        });
      }
    }, 'draft.quarterly', `${targets.length} donors`);
    return targets.length;
  }

  /** Board digest: one draft per board member listing their portfolio. Admin only. */
  generateDigests(): number {
    if (!this.isAdmin()) return 0;
    const quarter = quarterOf(today());
    const t = this.templates().find((x) => x.purpose === 'assignment_digest')!;
    const board = this.boardMembers();
    this.mutate((data) => {
      for (const m of board) {
        const mine = data.donors.filter((d) => !d.archived_at && d.owner_id === m.id);
        const open = data.followUps.filter((f) => f.owner_id === m.id && f.status === 'open').length;
        const vars: Record<string, string> = {
          first_name: m.name.split(' ')[0], quarter, donor_count: String(mine.length), open_count: String(open),
        };
        const fill = (s: string) => s.replace(/{{(\w+)}}/g, (_, k: string) => vars[k] ?? '');
        data.drafts.push({
          id: uid('dr'), donor_id: null, recipient_member_id: m.id, owner_id: this.me().id, template_id: t.id,
          channel: 'email', to: m.email, subject: fill(t.subject),
          body: `${fill(t.body)}\n\n${mine.map((d) => `- ${d.name}`).join('\n')}`,
          reason: `${quarter} board assignment digest`, status: 'pending', created_at: nowIso(),
          approved_by: null, approved_at: null, sent_by: null, sent_at: null,
        });
      }
    }, 'draft.digest', `${board.length} board members`);
    return board.length;
  }

  editDraft(id: string, patch: Pick<Draft, 'subject' | 'body'>) {
    this.mutate((d) => Object.assign(d.drafts.find((x) => x.id === id)!, patch), 'draft.edit', id);
  }

  approveDraft(id: string) {
    this.mutate((d) => {
      const dr = d.drafts.find((x) => x.id === id)!;
      dr.status = 'approved'; dr.approved_by = this.me().id; dr.approved_at = nowIso();
    }, 'draft.approve', id);
  }

  discardDraft(id: string) {
    this.mutate((d) => { d.drafts.find((x) => x.id === id)!.status = 'discarded'; }, 'draft.discard', id);
  }

  /** Recorded after the person sends it from their own mail or phone. The system never sends. */
  markSent(id: string) {
    this.mutate((d) => {
      const dr = d.drafts.find((x) => x.id === id)!;
      if (dr.status !== 'approved') return;
      dr.status = 'sent'; dr.sent_by = this.me().id; dr.sent_at = nowIso();
      if (dr.donor_id) {
        d.communications.push({
          id: uid('cm'), donor_id: dr.donor_id, member_id: this.me().id, kind: dr.channel, direction: 'outbound',
          summary: dr.subject || 'Text message', body: dr.body, occurred_at: dr.sent_at, draft_id: dr.id,
        });
      }
    }, 'draft.sent', id);
  }

  importRows(rows: ImportRow[], source: Source, fileName: string): { created: number; merged: number; gifts: number; skipped: number } {
    const result = { created: 0, merged: 0, gifts: 0, skipped: 0 };
    const createdByKey = new Map<string, string>();
    this.mutate((d) => {
      for (const row of rows) {
        if (row.action === 'skip') { result.skipped++; continue; }
        let donorId: string;
        const target = row.action === 'merge' ? row.matchId : createdByKey.get(row.key) ?? null;
        if (target) {
          const existing = d.donors.find((x) => x.id === target)!;
          existing.email ??= row.donor.email;
          existing.phone ??= row.donor.phone;
          existing.company ??= row.donor.company;
          if (!existing.sources.includes(source)) existing.sources.push(source);
          donorId = existing.id;
          result.merged++;
        } else {
          const donor: Donor = {
            id: uid('d'), name: row.donor.name, email: row.donor.email, phone: row.donor.phone, company: row.donor.company,
            kind: row.donor.kind, owner_id: row.ownerId ?? this.nextOwner(d), consent: 'unknown', preferred_channel: 'email',
            created_at: nowIso(), archived_at: null, sources: [source], custom: {},
          };
          d.donors.push(donor);
          donorId = donor.id;
          createdByKey.set(row.key, donor.id);
          result.created++;
        }
        if (row.gift && row.gift.amount_cents > 0) {
          let campaign = d.campaigns.find((c) => c.title.toLowerCase() === (row.gift!.campaign ?? '').toLowerCase());
          if (!campaign && row.gift.campaign) {
            campaign = { id: uid('c'), title: row.gift.campaign, program_id: null, starts_on: row.gift.occurred_at.slice(0, 10), location: '' };
            d.campaigns.push(campaign);
          }
          d.gifts.push({
            id: uid('g'), donor_id: donorId, campaign_id: campaign?.id ?? null, amount_cents: row.gift.amount_cents,
            refund_cents: 0, currency: 'USD', occurred_at: row.gift.occurred_at, status: 'settled', source,
            external_id: `${fileName}#${result.created + result.merged}`,
          });
          result.gifts++;
        }
      }
    }, 'import.commit', `${fileName}: ${rows.length} rows`);
    return result;
  }

  createApiKey(label: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const secret = `cic_live_${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32)}`;
    const key: ApiKey = {
      id: uid('k'), label, prefix: secret.slice(0, 13), created_at: nowIso(), created_by: this.me().id,
      last_used_at: null, revoked_at: null,
    };
    this.mutate((d) => d.apiKeys.push(key), 'apikey.create', label);
    return secret;
  }

  revokeApiKey(id: string) {
    this.mutate((d) => { d.apiKeys.find((k) => k.id === id)!.revoked_at = nowIso(); }, 'apikey.revoke', id);
  }

  saveCustomField(field: CustomField, originalKey: string | null) {
    this.mutate((d) => {
      const i = d.customFields.findIndex((f) => f.key === (originalKey ?? field.key));
      if (i >= 0) d.customFields[i] = field; else d.customFields.push(field);
    }, originalKey ? 'field.update' : 'field.create', field.key);
  }

  removeCustomField(key: string) {
    this.mutate((d) => {
      d.customFields = d.customFields.filter((f) => f.key !== key);
      for (const donor of d.donors) delete donor.custom[key];
    }, 'field.remove', key);
  }

  communicationsFor(donorId: string): Communication[] {
    return this.communications().filter((c) => c.donor_id === donorId);
  }
}
