import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
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
  imports: [NgIcon, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Read API</h1>
          <p class="lede">Read-only totals for CIC's dashboard. No donor names or contact details.</p>
        </div>
      </header>

      <section aria-labelledby="keys-h">
        <div class="section-head"><h2 id="keys-h">API keys</h2><p>Shown once, stored only as a hash, revocable at any time.</p></div>
        @if (newKey()) {
          <div class="reveal glass" role="status">
            <ng-icon name="lucideKeyRound" size="18" class="text-[var(--green-700)]" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold">Copy this key now. It will not be shown again.</p>
              <code class="secret">{{ newKey() }}</code>
            </div>
            <button hlmBtn size="sm" type="button" (click)="copy(newKey()!)">{{ copied() ? 'Copied' : 'Copy key' }}</button>
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="newKey.set(null)">I stored it</button>
          </div>
        }
        <div class="keys">
          @for (k of store.apiKeys(); track k.id) {
            <article class="key glass" [class.revoked]="!!k.revoked_at">
              <div class="flex items-center gap-2">
                <span class="k-dot" [class.on]="!k.revoked_at" aria-hidden="true"></span>
                <h3 class="flex-1 truncate">{{ k.label }}</h3>
                <span class="tag" [class.solid]="!k.revoked_at" [class.dashed]="!!k.revoked_at">{{ k.revoked_at ? 'Revoked' : 'Active' }}</span>
              </div>
              <code class="prefix">{{ k.prefix }}••••••••</code>
              <p class="meta">Created {{ date(k.created_at) }} by {{ store.member(k.created_by)?.name }}</p>
              <p class="meta">Last used {{ k.last_used_at ? date(k.last_used_at) : 'never' }}</p>
              @if (!k.revoked_at) { <button hlmBtn variant="outline" size="sm" class="mt-3 self-start" type="button" (click)="store.revokeApiKey(k.id)">Revoke</button> }
            </article>
          }
          <form class="key new glass" (submit)="create($event)">
            <h3>New key</h3>
            <label class="field"><span>Label</span><input class="input" name="label" required maxlength="60" placeholder="Board dashboard" [value]="label()" (input)="label.set($any($event.target).value)" /></label>
            <button hlmBtn class="mt-auto self-start" type="submit" [disabled]="!label().trim()"><ng-icon name="lucidePlus" size="16" /> Create key</button>
          </form>
        </div>
      </section>

      <section class="console glass mt-6" aria-labelledby="try-h">
        <div class="c-left">
          <h2 id="try-h">Try a request</h2>
          <div class="ep-tabs" role="tablist" aria-label="Endpoint">
            <button type="button" role="tab" [attr.aria-selected]="endpoint() === 'summary'" (click)="endpoint.set('summary')">/summary</button>
            <button type="button" role="tab" [attr.aria-selected]="endpoint() === 'activity'" (click)="endpoint.set('activity')">/activity</button>
          </div>
          @if (endpoint() === 'summary') {
            <form class="stack" (submit)="$event.preventDefault()">
              <div class="grid grid-cols-2 gap-3">
                <label class="field"><span>from</span><input class="input" type="date" [value]="from()" (input)="from.set($any($event.target).value)" /></label>
                <label class="field"><span>to</span><input class="input" type="date" [value]="to()" (input)="to.set($any($event.target).value)" /></label>
              </div>
              <div class="field"><span id="gb-l">groupBy</span>
                <div class="segmented" role="group" aria-labelledby="gb-l">
                  @for (g of groupings; track g) { <button type="button" [attr.aria-pressed]="groupBy() === g" (click)="groupBy.set(g)">{{ g }}</button> }
                </div></div>
            </form>
            <dl class="params">
              <div><dt>from</dt><dd>First day, YYYY-MM-DD, Phoenix time.</dd></div>
              <div><dt>to</dt><dd>Day after the last day (exclusive). At most 5 years.</dd></div>
              <div><dt>groupBy</dt><dd>month (default), program or owner.</dd></div>
              <div><dt>privacy</dt><dd>Groups under {{ minDonors }} donors return suppressed: true and no numbers.</dd></div>
            </dl>
          } @else {
            <dl class="params">
              <div><dt>limit</dt><dd>1 to 100 recent gifts, newest first.</dd></div>
              <div><dt>returns</dt><dd>Date, program, source, status, currency and net cents. No donor or owner identifiers.</dd></div>
            </dl>
          }
          <dl class="params">
            <div><dt>auth</dt><dd>Authorization: Bearer &lt;key&gt; or X-API-Key: &lt;key&gt;, not both.</dd></div>
            <div><dt>errors</dt><dd>401 bad or missing key · 400 invalid parameter · 429 rate limited.</dd></div>
          </dl>
        </div>
        <div class="c-right">
          <div class="term">
            <div class="term-bar"><span class="method">GET</span><code class="url">{{ endpoint() === 'summary' ? '/api/v1/summary' : '/api/v1/activity' }}</code></div>
            <pre class="code" tabindex="0" aria-label="Example request">{{ endpoint() === 'summary' ? curl() : activityCurl }}</pre>
          </div>
          <div class="term grow">
            <div class="term-bar"><span class="status">200 OK</span><span class="text-xs text-[#9fb8aa]">application/json · preview from demo data</span></div>
            <pre class="code resp" tabindex="0" aria-label="Example response">{{ endpoint() === 'summary' ? response() : activityResponse() }}</pre>
          </div>
        </div>
      </section>
    </div>
  `,
  styles: `
    .promises { list-style: none; margin: 0; padding: 0; display: flex; gap: 8px; flex-wrap: wrap; }
    .promises li { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 999px; background: var(--green-50); color: var(--green-700); font-size: 12.5px; font-weight: 600; }
    .reveal { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 18px; margin-bottom: 14px; flex-wrap: wrap; }
    .secret { display: block; margin-top: 6px; font-size: 13px; padding: 8px 10px; border-radius: 10px; word-break: break-all; background: #fff; border: 1px solid var(--green-200); }
    .keys { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
    .key { border-radius: 20px; padding: 18px; display: flex; flex-direction: column; gap: 4px; min-height: 180px; }
    .key.revoked { opacity: 0.7; }
    .key.new { gap: 10px; border-style: dashed; }
    .k-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-400); }
    .k-dot.on { background: var(--green-500); box-shadow: 0 0 0 3px rgb(0 168 80 / 0.18); }
    .prefix { margin: 8px 0 4px; font-size: 13px; padding: 6px 10px; border-radius: 10px; background: rgb(15 26 21 / 0.05); width: fit-content; }
    .meta { font-size: 12.5px; color: var(--muted-foreground); }
    .console { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 0; border-radius: 22px; overflow: hidden; }
    .c-left { padding: 22px; display: flex; flex-direction: column; gap: 16px; }
    .c-right { padding: 14px; display: flex; flex-direction: column; gap: 12px; background: #0f1f17; }
    .ep-tabs { display: inline-flex; gap: 4px; padding: 4px; border-radius: 14px; background: rgb(15 26 21 / 0.05); width: fit-content; }
    .ep-tabs button { height: 32px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; font-family: var(--font-mono); font-size: 12.5px; cursor: pointer; color: var(--ink-600); }
    .ep-tabs button[aria-selected='true'] { background: #fff; color: var(--foreground); box-shadow: 0 1px 3px rgb(15 50 30 / 0.12); }
    .params { margin: 0; display: flex; flex-direction: column; gap: 8px; }
    .params div { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; font-size: 13px; }
    .params dt { font-family: var(--font-mono); font-size: 12px; color: var(--green-700); padding-top: 1px; }
    .params dd { margin: 0; color: var(--ink-600); }
    .term { border-radius: 14px; background: #0b1912; border: 1px solid rgb(255 255 255 / 0.06); overflow: hidden; display: flex; flex-direction: column; }
    .term.grow { flex: 1; min-height: 0; }
    .term-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid rgb(255 255 255 / 0.06); }
    .method { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: #00a850; color: #04120b; }
    .status { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: rgb(0 168 80 / 0.18); color: #7be3a8; }
    .url { color: #e8f3ec; font-size: 13px; }
    pre.code { background: transparent; border-radius: 0; max-height: 420px; overflow: auto; }
    pre.code.resp { max-height: 460px; }
    @media (max-width: 1000px) { .console { grid-template-columns: 1fr; } }
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
  protected readonly endpoint = signal<'summary' | 'activity'>('summary');
  protected readonly activityCurl = `curl -H "Authorization: Bearer $CIC_API_KEY" \\\n  "${location.origin}/api/v1/activity?limit=5"`;

  /** Same shape as GET /api/v1/activity: aggregates only, never donor or owner identifiers. */
  protected readonly activityResponse = computed(() => JSON.stringify({
    items: [...this.store.allGifts()].filter((g) => g.status !== 'void').sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, 5)
      .map((g) => ({
        occurred_on: g.occurred_at.slice(0, 10),
        program: this.store.program(this.store.campaign(g.campaign_id)?.program_id ?? null)?.title ?? null,
        source: g.source, status: g.status, currency: g.currency,
        net_cents: g.status === 'settled' ? g.amount_cents - g.refund_cents : 0,
      })),
  }, null, 2));

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
