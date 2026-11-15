import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { toast } from '@spartan-ng/brain/sonner';
import { MemberSettings } from './member-settings';
import { Store } from '../core/store';
import { date } from '../core/format';
import { CustomField } from '../core/models';

type Tab = 'team' | 'access' | 'fields' | 'audit' | 'workspace';
const TABS: Array<{ id: Tab; label: string; icon: string; hint: string }> = [
  { id: 'team', label: 'Team', icon: 'lucideUsers', hint: 'Everyone who can sign in, their role and how many donors they own.' },
  { id: 'access', label: 'Roles and access', icon: 'lucideShieldCheck', hint: 'The server enforces these rules on every request; the interface only mirrors them.' },
  { id: 'fields', label: 'Donor fields', icon: 'lucideListChecks', hint: 'Add, rename or remove fields as Coding in Color changes.' },
  { id: 'audit', label: 'Audit log', icon: 'lucideHistory', hint: 'Every change, recorded in the same transaction as the change itself.' },
  { id: 'workspace', label: 'Workspace', icon: 'lucideDatabase', hint: 'Demo data stored in this browser.' },
];

const ACCESS: Array<[string, string, string]> = [
  ['See donors', 'All donors', 'Only donors they own'],
  ['Log a call, text or meeting', 'Any donor', 'Own donors'],
  ['Approve and record messages', 'Any draft', 'Drafts for own donors'],
  ['Reassign donor owners', 'Yes', 'No'],
  ['Import files', 'Yes', 'No'],
  ['Funder packets', 'Yes', 'No'],
  ['Create or revoke API keys', 'Yes', 'No'],
  ['Edit custom fields', 'Yes', 'No'],
];

@Component({
  selector: 'app-settings',
  imports: [NgIcon, HlmButtonImports, MemberSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if(store.live()){<app-member-settings />}@else{
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Settings</h1>
          <p class="lede">People, permissions, donor fields and history.</p>
        </div>
      </header>

      <div class="settings">
        <nav class="snav glass" aria-label="Settings sections">
          @for (t of tabs; track t.id) {
            <button type="button" [attr.aria-current]="tab() === t.id ? 'page' : null" (click)="tab.set(t.id)">
              <ng-icon [name]="t.icon" size="16" aria-hidden="true" /><span class="flex-1 text-start">{{ t.label }}</span>
            </button>
          }
        </nav>

        <section class="sbody glass" [attr.aria-label]="current().label">
          <header class="s-head"><h2>{{ current().label }}</h2><p>{{ current().hint }}</p></header>

          @switch (tab()) {
            @case ('team') {
              <div class="members">
                @for (m of store.members(); track m.id) {
                  <article class="member">
                    <span class="m-avatar" aria-hidden="true">{{ store.initials(m.name) }}</span>
                    <div class="min-w-0 flex-1">
                      <p class="flex items-center gap-2 font-semibold">{{ m.name }}<span class="tag" [class.solid]="m.role === 'admin'">{{ m.role === 'admin' ? 'Admin' : 'Board' }}</span></p>
                      <p class="meta truncate">{{ m.title }} · {{ m.email }}</p>
                      @if (m.role === 'board') {
                        <div class="load"><span class="meta">{{ store.ownerLoad().get(m.id) }} donors owned</span>
                          <span class="track"><span [style.width.%]="((store.ownerLoad().get(m.id) ?? 0) / maxLoad()) * 100"></span></span></div>
                      }
                    </div>
                  </article>
                }
              </div>
              <p class="note"><ng-icon name="lucideLock" size="14" aria-hidden="true" /> Invitation only. New people are invited in Clerk and then given a role here; there are no shared passwords.</p>
            }
            @case ('access') {
              <div class="overflow-x-auto">
                <table class="table matrix">
                  <caption class="sr-only">What each role can do</caption>
                  <thead><tr><th scope="col">Action</th><th scope="col">Admin (CEO, staff)</th><th scope="col">Board member</th></tr></thead>
                  <tbody>
                    @for (a of access; track a[0]) {
                      <tr><th scope="row">{{ a[0] }}</th>
                        <td><span class="cell" [attr.data-yes]="a[1] !== 'No'"><ng-icon [name]="a[1] === 'No' ? 'lucideX' : 'lucideCheck'" size="14" aria-hidden="true" />{{ a[1] }}</span></td>
                        <td><span class="cell" [attr.data-yes]="a[2] !== 'No'"><ng-icon [name]="a[2] === 'No' ? 'lucideX' : 'lucideCheck'" size="14" aria-hidden="true" />{{ a[2] }}</span></td></tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            @case ('fields') {
              <div class="fields-grid">
                <ul class="field-list">
                  @for (f of store.customFields(); track f.key) {
                    <li>
                      <span class="f-type" aria-hidden="true"><ng-icon [name]="typeIcon[f.type]" size="15" /></span>
                      <div class="min-w-0 flex-1"><p class="font-semibold">{{ f.label }}</p>
                        <p class="meta truncate">{{ f.type }}@if (f.options.length) { · {{ f.options.join(', ') }} }</p></div>
                      <button hlmBtn variant="ghost" size="sm" type="button" (click)="edit(f)">Edit</button>
                      <button hlmBtn variant="ghost" size="sm" type="button" (click)="store.removeCustomField(f.key)">Remove</button>
                    </li>
                  } @empty { <li class="meta">No custom fields.</li> }
                </ul>
                <form class="field-form" (submit)="save($event)">
                  <h3>{{ editingKey() ? 'Edit field' : 'Add a field' }}</h3>
                  <label class="field"><span>Label</span><input class="input" name="label" required maxlength="40" [value]="draft().label" (input)="patch({ label: $any($event.target).value })" /></label>
                  <label class="field"><span>Type</span>
                    <select class="select" (change)="patch({ type: $any($event.target).value })">
                      @for (t of types; track t) { <option [value]="t" [selected]="draft().type === t">{{ t }}</option> }
                    </select></label>
                  @if (draft().type === 'select') {
                    <label class="field"><span>Options, comma separated</span><input class="input" [value]="draft().options.join(', ')" (input)="patch({ options: split($any($event.target).value) })" /></label>
                  }
                  @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
                  <div class="row">
                    <button hlmBtn type="submit" [disabled]="!draft().label.trim()">{{ editingKey() ? 'Save field' : 'Add field' }}</button>
                    @if (editingKey()) { <button hlmBtn variant="ghost" type="button" (click)="reset()">Cancel</button> }
                  </div>
                  <p class="meta">Removing a field deletes its values from every donor.</p>
                </form>
              </div>
            }
            @case ('audit') {
              <ol class="audit">
                @for (e of recent(); track e.id) {
                  <li>
                    <span class="a-dot" aria-hidden="true"></span>
                    <div class="min-w-0 flex-1">
                      <p><strong>{{ store.member(e.actor_id)?.name }}</strong> <code>{{ e.action }}</code> <span class="meta">{{ e.target }}</span></p>
                      <p class="meta">{{ date(e.at) }} at {{ e.at.slice(11, 16) }}</p>
                    </div>
                  </li>
                } @empty { <li class="meta">No changes recorded in this session yet. Edit a donor or approve a draft and it appears here.</li> }
              </ol>
            }
            @case ('workspace') {
              <div class="ws">
                <div><p class="font-semibold">Workspace records</p><p class="meta">Restore the original records and discard changes in this browser.</p></div>
                <button hlmBtn variant="outline" type="button" (click)="resetDemo()"><ng-icon name="lucideRotateCcw" size="16" /> Reset records</button>
              </div>
            }
          }
        </section>
      </div>
    </div>
    }
  `,
  styles: `
    .settings { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 20px; align-items: start; }
    .snav { border-radius: 20px; padding: 8px; display: flex; flex-direction: column; gap: 2px; position: sticky; top: calc(var(--topbar-h) + 24px); }
    .snav button { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px; border: 0; border-radius: 12px; background: transparent; cursor: pointer;
      font-size: 13.5px; font-weight: 500; color: var(--ink-600); }
    .snav button:hover { background: rgb(255 255 255 / 0.7); color: var(--foreground); }
    .snav button[aria-current='page'] { background: #fff; color: var(--foreground); box-shadow: 0 1px 3px rgb(15 50 30 / 0.1); }
    .snav button[aria-current='page'] ng-icon { color: var(--primary); }
    .sbody { border-radius: 22px; padding: 24px 26px; min-width: 0; }
    .s-head { margin-bottom: 18px; }
    .s-head p { font-size: 13px; color: var(--muted-foreground); margin-top: 2px; }
    .meta { font-size: 12.5px; color: var(--muted-foreground); }
    .members { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .member { display: flex; gap: 12px; padding: 14px; border-radius: 16px; background: rgb(255 255 255 / 0.7); border: 1px solid var(--border); }
    .m-avatar { width: 40px; height: 40px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--green-50); color: var(--green-700); font-weight: 600; font-size: 13px; }
    .load { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .track { height: 6px; border-radius: 999px; background: rgb(15 26 21 / 0.07); overflow: hidden; }
    .track span { display: block; height: 100%; background: var(--primary); border-radius: 999px; }
    .note { display: flex; align-items: center; gap: 8px; margin-top: 16px; font-size: 12.5px; color: var(--muted-foreground); }
    .matrix th, .matrix td { width: 33%; }
    .cell { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-600); }
    .cell[data-yes='true'] { color: var(--green-700); font-weight: 500; }
    .fields-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
    .field-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .field-list li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; background: rgb(255 255 255 / 0.7); border: 1px solid var(--border); }
    .f-type { width: 32px; height: 32px; flex: none; border-radius: 10px; display: grid; place-items: center; background: rgb(15 26 21 / 0.05); color: var(--ink-600); }
    .field-form { display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 16px; background: rgb(255 255 255 / 0.6); border: 1px dashed var(--input); }
    .audit { list-style: none; margin: 0; padding: 0; position: relative; display: flex; flex-direction: column; gap: 4px; }
    .audit li { display: flex; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--hair); }
    .a-dot { width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--primary); flex: none; }
    .audit code { font-size: 12px; padding: 1px 6px; border-radius: 6px; background: rgb(15 26 21 / 0.05); }
    .ws { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px; border-radius: 16px; background: rgb(255 255 255 / 0.6); border: 1px solid var(--border); }
    @media (max-width: 1000px) { .settings { grid-template-columns: 1fr; } .snav { position: static; flex-direction: row; overflow-x: auto; } .fields-grid { grid-template-columns: 1fr; } }
  `,
})
export class SettingsPage {
  protected readonly store = inject(Store);
  protected readonly date = date;
  protected readonly access = ACCESS;
  protected readonly types: CustomField['type'][] = ['text', 'number', 'date', 'select'];
  private readonly blank: CustomField = { key: '', label: '', type: 'text', options: [] };
  protected readonly draft = signal<CustomField>({ ...this.blank });
  protected readonly editingKey = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly recent = computed(() => this.store.audit().slice(0, 40));
  protected readonly tabs = TABS;
  protected readonly tab = signal<Tab>('team');
  protected readonly current = computed(() => TABS.find((t) => t.id === this.tab())!);
  protected readonly maxLoad = computed(() => Math.max(1, ...this.store.ownerLoad().values()));
  protected readonly typeIcon: Record<CustomField['type'], string> = { text: 'lucideStickyNote', number: 'lucideChartColumn', date: 'lucideCalendar', select: 'lucideListChecks' };
  protected resetDemo() { this.store.resetDemo(); toast.success('Records reset', { description: 'Original records restored.' }); }

  protected patch(p: Partial<CustomField>) { this.draft.update((d) => ({ ...d, ...p })); }
  protected split(s: string) { return s.split(',').map((x) => x.trim()).filter(Boolean); }
  protected edit(f: CustomField) { this.draft.set({ ...f, options: [...f.options] }); this.editingKey.set(f.key); }
  protected reset() { this.draft.set({ ...this.blank }); this.editingKey.set(null); this.error.set(''); }

  protected save(event: Event) {
    event.preventDefault();
    const d = this.draft();
    const label = d.label.trim();
    const key = this.editingKey() ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key) { this.error.set('Use letters or numbers in the label.'); return; }
    if (!this.editingKey() && this.store.customFields().some((f) => f.key === key)) { this.error.set('A field with this name already exists.'); return; }
    if (d.type === 'select' && d.options.length === 0) { this.error.set('Add at least one option.'); return; }
    this.store.saveCustomField({ key, label, type: d.type, options: d.type === 'select' ? d.options : [] }, this.editingKey());
    this.reset();
  }
}
