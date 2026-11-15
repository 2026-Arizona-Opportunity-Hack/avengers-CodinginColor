import { Component, computed, inject, signal } from '@angular/core';
import { Store } from '../core/store';
import { date, today } from '../core/format';

type GroupBy = 'month' | 'program' | 'owner';
const MIN_DONORS = 3;

/**
 * Key management and documentation for the read API defined in issue #29
 * (packages/reporting/summary.ts). The response preview is computed with the same
 * grouping, per-currency totals and small-cohort suppression rules.
 */
@Component({
  selector: 'app-api-access',
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Read API</p>
          <h1>Totals for CIC's dashboard</h1>
          <p class="lede">A key-authenticated, read-only API that returns giving already aggregated by month, program or board member. It never returns donor names or contact details.</p>
        </div>
      </header>

      <section aria-labelledby="keys-h">
        <div class="section-head"><h2 id="keys-h">API keys</h2><p>Keys are shown once, stored only as a hash, and can be revoked at any time.</p></div>
        @if (newKey()) {
          <div class="notice key-notice" role="status">
            <div class="stack">
              <strong>Copy this key now. It will not be shown again.</strong>
              <code class="secret">{{ newKey() }}</code>
              <div class="row"><button class="btn small" type="button" (click)="copy(newKey()!)">{{ copied() ? 'Copied' : 'Copy key' }}</button>
                <button class="btn small link" type="button" (click)="newKey.set(null)">I stored it</button></div>
            </div>
          </div>
        }
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th scope="col">Label</th><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead>
            <tbody>
              @for (k of store.apiKeys(); track k.id) {
                <tr>
                  <th scope="row">{{ k.label }}</th>
                  <td class="mono">{{ k.prefix }}…</td>
                  <td>{{ date(k.created_at) }} by {{ store.member(k.created_by)?.name }}</td>
                  <td>{{ k.last_used_at ? date(k.last_used_at) : 'Never' }}</td>
                  <td><span class="tag" [class.solid]="!k.revoked_at" [class.dashed]="!!k.revoked_at">{{ k.revoked_at ? 'Revoked' : 'Active' }}</span></td>
                  <td class="num">@if (!k.revoked_at) { <button class="btn small" type="button" (click)="store.revokeApiKey(k.id)">Revoke</button> }</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <form class="row create" (submit)="create($event)">
          <label class="field grow"><span>New key label</span><input class="input" name="label" required maxlength="60" placeholder="Board dashboard" [value]="label()" (input)="label.set($any($event.target).value)" /></label>
          <button class="btn primary" type="submit" [disabled]="!label().trim()">Create key</button>
        </form>
      </section>

      <section class="section" aria-labelledby="docs-h">
        <div class="section-head"><h2 id="docs-h">Endpoints</h2></div>
        <div class="grid-2">
          <article class="panel">
            <div class="panel-head"><h3><code>GET /api/v1/summary</code></h3></div>
            <dl class="kv panel-body">
              <dt>from</dt><dd>First day, <code>YYYY-MM-DD</code>, Phoenix time.</dd>
              <dt>to</dt><dd>Day after the last day (exclusive). Range at most 5 years.</dd>
              <dt>groupBy</dt><dd><code>month</code> (default), <code>program</code> or <code>owner</code>.</dd>
              <dt>Privacy</dt><dd>Groups with fewer than {{ minDonors }} donors return <code>suppressed: true</code> and no numbers.</dd>
            </dl>
          </article>
          <article class="panel">
            <div class="panel-head"><h3><code>GET /api/v1/activity</code></h3></div>
            <dl class="kv panel-body">
              <dt>limit</dt><dd>1 to 100 recent gifts, newest first.</dd>
              <dt>Returns</dt><dd>Date, program, source, status, currency and net cents. No donor or owner identifiers.</dd>
              <dt>Auth</dt><dd><code>Authorization: Bearer &lt;key&gt;</code> or <code>X-API-Key: &lt;key&gt;</code>, not both.</dd>
              <dt>Errors</dt><dd><code>401</code> bad or missing key · <code>400</code> unknown or invalid parameter.</dd>
            </dl>
          </article>
        </div>
      </section>

      <section class="section" aria-labelledby="try-h">
        <div class="section-head"><h2 id="try-h">Try a request</h2><p>Preview of the response for the current demo data.</p></div>
        <form class="row try" (submit)="$event.preventDefault()">
          <label class="field"><span>from</span><input class="input" type="date" [value]="from()" (input)="from.set($any($event.target).value)" /></label>
          <label class="field"><span>to</span><input class="input" type="date" [value]="to()" (input)="to.set($any($event.target).value)" /></label>
          <div class="field"><span id="gb-l">groupBy</span>
            <div class="segmented" role="group" aria-labelledby="gb-l">
              @for (g of groupings; track g) { <button type="button" [attr.aria-pressed]="groupBy() === g" (click)="groupBy.set(g)">{{ g }}</button> }
            </div></div>
        </form>
        <p class="label req-label">Request</p>
        <pre class="code" tabindex="0" aria-label="Example request">{{ curl() }}</pre>
        <p class="label req-label">Response · 200</p>
        <pre class="code" tabindex="0" aria-label="Example response">{{ response() }}</pre>
      </section>
    </div>
  `,
  styles: `
    .key-notice { margin-bottom: 16px; }
    .secret { font-size: 13px; padding: 8px 10px; border: 1px solid var(--brand); border-radius: 3px; word-break: break-all; background: #fff; }
    .create { margin-top: 16px; align-items: flex-end; }
    .create .grow { flex: 1; max-width: 360px; }
    .try { align-items: flex-end; gap: 12px; margin-bottom: 16px; }
    .req-label { margin: 16px 0 6px; }
    .kv { grid-template-columns: 76px minmax(0, 1fr); }
    .kv dt { text-transform: none; letter-spacing: 0; font-size: 12px; }
    pre.code { max-height: 440px; overflow: auto; }
    h3 code { font-size: 13.5px; }
  `,
})
export class ApiAccessPage {
  protected readonly store = inject(Store);
  protected readonly date = date;
  protected readonly minDonors = MIN_DONORS;
  protected readonly groupings: GroupBy[] = ['month', 'program', 'owner'];
  protected readonly label = signal('');
  protected readonly newKey = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly from = signal(`${today().slice(0, 4)}-01-01`);
  protected readonly to = signal(today());
  protected readonly groupBy = signal<GroupBy>('program');

  protected create(event: Event) {
    event.preventDefault();
    if (!this.label().trim()) return;
    this.newKey.set(this.store.createApiKey(this.label().trim()));
    this.copied.set(false);
    this.label.set('');
  }

  protected async copy(text: string) {
    try { await navigator.clipboard.writeText(text); this.copied.set(true); } catch { this.copied.set(false); }
  }

  protected readonly curl = computed(() =>
    `curl -H "Authorization: Bearer $CIC_API_KEY" \\\n  "${location.origin}/api/v1/summary?from=${this.from()}&to=${this.to()}&groupBy=${this.groupBy()}"`);

  protected readonly response = computed(() => {
    const start = Date.parse(`${this.from()}T00:00:00-07:00`), end = Date.parse(`${this.to()}T00:00:00-07:00`);
    if (!(start < end)) return JSON.stringify({ error: 'invalid_query' }, null, 2);
    type Bucket = { donors: Set<string>; gifts: number; net: number };
    const groups = new Map<string, Bucket>();
    const totals: Bucket = { donors: new Set(), gifts: 0, net: 0 };
    // The API reads every donor in the organization, independent of who is signed in.
    for (const g of this.store.allGifts()) {
      const t = Date.parse(g.occurred_at);
      if (g.status === 'void' || t < start || t >= end) continue;
      const campaign = this.store.campaign(g.campaign_id);
      const donor = this.store.allDonors().find((d) => d.id === g.donor_id);
      const key = this.groupBy() === 'month' ? new Date(t - 7 * 3600_000).toISOString().slice(0, 7)
        : this.groupBy() === 'program' ? this.store.program(campaign?.program_id ?? null)?.title ?? 'unattributed'
        : this.store.member(donor?.owner_id ?? null)?.name ?? 'unassigned';
      const net = g.status === 'settled' ? g.amount_cents - g.refund_cents : 0;
      for (const b of [groups.get(key) ?? groups.set(key, { donors: new Set(), gifts: 0, net: 0 }).get(key)!, totals]) {
        b.donors.add(g.donor_id); b.gifts++; b.net += net;
      }
    }
    const publish = (b: Bucket) => b.donors.size < MIN_DONORS ? { suppressed: true }
      : { suppressed: false, donors: b.donors.size, currencies: { USD: { gifts: b.gifts, net_cents: b.net } } };
    return JSON.stringify({
      groups: [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, b]) => ({ key, ...publish(b) })),
      totals: publish(totals),
    }, null, 2);
  });
}
