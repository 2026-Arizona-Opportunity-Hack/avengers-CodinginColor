import { Component, computed, inject, signal } from '@angular/core';
import { Store } from '../core/store';
import { date } from '../core/format';
import { CustomField } from '../core/models';

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
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Settings</p>
          <h1>People, fields and audit</h1>
          <p class="lede">Who can sign in and what they can do, which fields a donor record carries, and every change made.</p>
        </div>
      </header>

      <section aria-labelledby="m-h">
        <div class="section-head"><h2 id="m-h">Members</h2><p>Invitation only. Each person signs in with their own account; there are no shared passwords.</p></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Title</th><th scope="col">Role</th><th scope="col" class="num">Donors owned</th></tr></thead>
            <tbody>
              @for (m of store.members(); track m.id) {
                <tr><th scope="row">{{ m.name }}</th><td>{{ m.email }}</td><td>{{ m.title }}</td>
                  <td><span class="tag" [class.solid]="m.role === 'admin'">{{ m.role === 'admin' ? 'Admin' : 'Board' }}</span></td>
                  <td class="num mono">{{ m.role === 'board' ? store.ownerLoad().get(m.id) : '—' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="section" aria-labelledby="a-h">
        <div class="section-head"><h2 id="a-h">What each role can do</h2><p>The server enforces these rules on every request; the interface only mirrors them.</p></div>
        <table class="table access">
          <thead><tr><th scope="col">Action</th><th scope="col">Admin (CEO, staff)</th><th scope="col">Board member</th></tr></thead>
          <tbody>
            @for (a of access; track a[0]) { <tr><th scope="row">{{ a[0] }}</th><td>{{ a[1] }}</td><td>{{ a[2] }}</td></tr> }
          </tbody>
        </table>
      </section>

      <section class="section" aria-labelledby="f-h">
        <div class="section-head"><h2 id="f-h">Custom donor fields</h2><p>Add, rename or remove fields as CIC changes. Removing a field deletes its values.</p></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th scope="col">Label</th><th scope="col">Key</th><th scope="col">Type</th><th scope="col">Options</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (f of store.customFields(); track f.key) {
                <tr><th scope="row">{{ f.label }}</th><td class="mono">{{ f.key }}</td><td>{{ f.type }}</td><td>{{ f.options.join(', ') || '—' }}</td>
                  <td class="actions-cell"><button class="btn small" type="button" (click)="edit(f)">Edit</button>
                    <button class="btn small link" type="button" (click)="store.removeCustomField(f.key)">Remove</button></td></tr>
              } @empty { <tr><td colspan="5">No custom fields.</td></tr> }
            </tbody>
          </table>
        </div>
        <form class="field-form" (submit)="save($event)">
          <h3>{{ editingKey() ? 'Edit field' : 'Add a field' }}</h3>
          <div class="row fields">
            <label class="field"><span>Label</span><input class="input" name="label" required maxlength="40" [value]="draft().label" (input)="patch({ label: $any($event.target).value })" /></label>
            <label class="field"><span>Type</span>
              <select class="select" (change)="patch({ type: $any($event.target).value })">
                @for (t of types; track t) { <option [value]="t" [selected]="draft().type === t">{{ t }}</option> }
              </select></label>
            @if (draft().type === 'select') {
              <label class="field grow"><span>Options, comma separated</span><input class="input" [value]="draft().options.join(', ')" (input)="patch({ options: split($any($event.target).value) })" /></label>
            }
            <button class="btn primary" type="submit" [disabled]="!draft().label.trim()">{{ editingKey() ? 'Save field' : 'Add field' }}</button>
            @if (editingKey()) { <button class="btn" type="button" (click)="reset()">Cancel</button> }
          </div>
          @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        </form>
      </section>

      <section class="section" aria-labelledby="l-h">
        <div class="section-head"><h2 id="l-h">Audit log</h2><p>Recorded in the same transaction as each change.</p></div>
        <table class="table">
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th></tr></thead>
          <tbody>
            @for (e of recent(); track e.id) {
              <tr><td class="mono">{{ date(e.at) }} {{ e.at.slice(11, 16) }}</td><th scope="row">{{ store.member(e.actor_id)?.name }}</th><td class="mono">{{ e.action }}</td><td>{{ e.target }}</td></tr>
            } @empty { <tr><td colspan="4">No changes recorded in this session yet.</td></tr> }
          </tbody>
        </table>
      </section>

      <section class="section" aria-labelledby="r-h">
        <div class="section-head"><h2 id="r-h">Demo data</h2></div>
        <p class="reset">All records are synthetic and stored only in this browser. <button class="btn" type="button" (click)="store.resetDemo()">Reset demo data</button></p>
      </section>
    </div>
  `,
  styles: `
    .access td, .access th { width: 33%; }
    .actions-cell { display: flex; gap: 6px; justify-content: flex-end; }
    .field-form { margin-top: 20px; padding: 16px 20px; border: 1px solid var(--rule); border-radius: var(--radius); }
    .field-form h3 { margin-bottom: 12px; }
    .fields { align-items: flex-end; gap: 12px; }
    .fields .field { min-width: 180px; }
    .fields .grow { flex: 1; }
    .reset { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
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
  protected readonly recent = computed(() => this.store.audit().slice(0, 25));

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
