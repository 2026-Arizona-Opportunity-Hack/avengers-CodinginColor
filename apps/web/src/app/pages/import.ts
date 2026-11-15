import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { readSheet } from 'read-excel-file/browser';
import { ImportRow, Store } from '../core/store';
import { ColumnGuess, TARGETS, Target, classifyColumns, parseCsv } from '../core/csv';
import { money, today } from '../core/format';
import { Donor, SOURCE_LABEL, Source } from '../core/models';

const STEPS = ['Upload', 'Map columns', 'Check rows', 'Resolve duplicates', 'Confirm'] as const;
const MAX_BYTES = 5 * 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMPORT_SOURCES: Source[] = ['spreadsheet', 'zeffy', 'benevity', 'az_gives', 'united_way'];
const SAMPLES: Array<{ file: string; source: Source; label: string }> = [
  { file: 'cic_donor_spreadsheet.csv', source: 'spreadsheet', label: 'CIC spreadsheet' },
  { file: 'zeffy_export.csv', source: 'zeffy', label: 'Zeffy export' },
  { file: 'benevity_export.csv', source: 'benevity', label: 'Benevity export' },
  { file: 'az_gives_export.csv', source: 'az_gives', label: 'AZ Gives export' },
];

interface Checked {
  line: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  contact: string | null;
  campaign: string | null;
  amount_cents: number | null;
  date: string;
  problems: string[];
  notes: string[];
  key: string;
}
interface Match { row: Checked; donor: Donor; reason: string; }

@Component({
  selector: 'app-import',
  imports: [RouterLink, NgIcon],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Import</h1>
          <p class="lede">The CIC spreadsheet, Zeffy, Benevity and AZ Gives exports into one donor table, with duplicates merged. Nothing saves until you confirm.</p>
        </div>
      </header>

      <div class="wizard">
      <ol class="rail glass" aria-label="Import progress">
        @for (s of steps; track s; let i = $index) {
          <li [attr.aria-current]="step() === i ? 'step' : null" [class.done]="step() > i">
            <span class="r-dot" aria-hidden="true">@if (step() > i) { <ng-icon name="lucideCheck" size="13" /> } @else { {{ i + 1 }} }</span>
            <span class="flex flex-col"><span class="text-xs text-[var(--ink-600)]">Step {{ i + 1 }}</span><span class="font-semibold">{{ s }}</span></span>
          </li>
        }
      </ol>

      <section class="stage glass">
      <h2 #stepHeading tabindex="-1" class="step-title">{{ steps[step()] }}</h2>

      @switch (step()) {
        @case (0) {
          <div class="split">
            <form class="stack gap" (submit)="$event.preventDefault()">
              <label class="field"><span>Where is this file from?</span>
                <select class="select" (change)="source.set($any($event.target).value)">
                  @for (s of sources; track s) { <option [value]="s" [selected]="source() === s">{{ sourceLabel[s] }}</option> }
                </select></label>
              <label class="drop">
                <ng-icon name="lucideUpload" size="26" aria-hidden="true" />
                <span class="font-semibold">Choose a .csv or .xlsx file</span>
                <span class="hint">Up to 5 MB. Nothing is saved until the last step.</span>
                <input class="input file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" (change)="pick($event)" /></label>
              <label class="field"><span>Gift date for rows without one</span>
                <input class="input" type="date" [max]="now" [value]="fallbackDate()" (input)="fallbackDate.set($any($event.target).value)" />
                <span class="hint">Exports without a date column use this date. Rows with their own date keep it.</span></label>
              @if (fileError()) { <p class="error" role="alert">{{ fileError() }}</p> }
              @if (fileName()) {
                <p class="notice" role="status"><span><strong>{{ fileName() }}</strong>: {{ rawRows().length }} data rows, {{ headers().length }} columns.</span></p>
              }
              <div class="row">
                <button class="btn primary" type="button" [disabled]="!fileName()" (click)="go(1)">Continue to mapping</button>
              </div>
            </form>
            <aside class="samples-box" aria-label="Sample files">
              <h3>Or try a sample</h3>
              <ul class="sample-list">
                @for (s of samples; track s.file) {
                  <li><button type="button" class="sample" (click)="loadSample(s.file, s.source)">
                    <span class="s-icon" aria-hidden="true"><ng-icon name="lucideFileText" size="16" /></span>
                    <span class="flex-1 text-start font-medium">{{ s.label }}</span><span class="s-cta">Load</span></button></li>
                }
              </ul>
              <p class="hint mt-3">Synthetic data. The AZ Gives sample has non-standard headers, a bad email, a formula cell and people who already exist.</p>
            </aside>
          </div>
        }

        @case (1) {
          <div class="intro-row">
            <p class="intro">Exact header matches are mapped automatically. Anything else is a <strong>suggestion</strong> you must accept or change. Data is never mapped on a guess.</p>
            @if (pendingSuggestions() > 0) {
              <button class="btn" type="button" (click)="acceptAll()"><ng-icon name="lucideCheck" size="15" aria-hidden="true" /> Accept all {{ pendingSuggestions() }} suggestions</button>
            }
          </div>
          <ul class="maps" aria-label="Column mapping">
            @for (g of guesses(); track g.header; let i = $index) {
              <li class="map" [attr.data-method]="g.method">
                <div class="m-src">
                  <code>{{ g.header }}</code>
                  <span class="hint truncate">{{ sampleValues(i) }}</span>
                </div>
                <ng-icon name="lucideArrowRight" size="16" class="m-arrow" aria-hidden="true" />
                <div class="m-dst">
                  <select class="select" [attr.aria-label]="'Field for column ' + g.header" (change)="setTarget(i, $any($event.target).value)">
                    @for (t of targetKeys; track t) { <option [value]="t" [selected]="g.target === t">{{ targets[t] }}</option> }
                  </select>
                </div>
                <div class="m-how">
                  @if (g.method === 'exact') { <span class="tag solid"><ng-icon name="lucideCheck" size="12" aria-hidden="true" />Exact match</span> }
                  @else if (g.method === 'suggested') {
                    <label class="accept" [class.on]="accepted().has(i)"><input type="checkbox" [checked]="accepted().has(i)" (change)="toggleAccept(i)" />
                      {{ accepted().has(i) ? 'Accepted' : 'Accept suggestion' }}</label>
                  } @else { <span class="tag">{{ g.target === 'ignore' ? 'Skipped' : 'Chosen by you' }}</span> }
                </div>
                <p class="m-why">{{ g.reason }}</p>
              </li>
            }
          </ul>
          @if (mappingProblem()) { <p class="error" role="alert">{{ mappingProblem() }}</p> }
          <div class="row nav-row">
            <button class="btn" type="button" (click)="go(0)">Back</button>
            <button class="btn primary" type="button" [disabled]="!!mappingProblem()" (click)="go(2)">Check rows</button>
          </div>
        }

        @case (2) {
          <section class="stats small-stats" aria-label="Row check results" style="grid-template-columns: repeat(4, minmax(0, 1fr))">
            <div class="stat"><p class="label">Rows in file</p><p class="value">{{ checked().length }}</p></div>
            <div class="stat"><p class="label">Ready</p><p class="value">{{ ready().length }}</p></div>
            <div class="stat"><p class="label">Need a fix</p><p class="value">{{ checked().length - ready().length }}</p></div>
            <div class="stat"><p class="label">Gift total, ready</p><p class="value">{{ money(readyTotal()) }}</p></div>
          </section>
          <p class="intro">Rows that need a fix are left out of this import. Correct them in the source file and import again.</p>
          <div class="table-wrap">
            <table class="table">
              <caption class="sr-only">Row validation</caption>
              <thead><tr><th scope="col">Line</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col" class="num">Amount</th><th scope="col">Campaign</th><th scope="col">Result</th></tr></thead>
              <tbody>
                @for (r of checked(); track r.line) {
                  <tr [class.muted-row]="r.problems.length">
                    <td class="mono">{{ r.line }}</td>
                    <th scope="row">{{ r.name || '—' }}</th>
                    <td>{{ r.email ?? '—' }}</td>
                    <td class="mono">{{ r.phone ?? '—' }}</td>
                    <td class="num mono">{{ r.amount_cents === null ? '—' : money(r.amount_cents) }}</td>
                    <td>{{ r.campaign ?? 'General support' }}</td>
                    <td>
                      @if (r.problems.length) { <span class="tag danger"><ng-icon name="lucideCircleAlert" size="12" aria-hidden="true" />Needs fix</span> <span class="issue">{{ r.problems.join('; ') }}</span> }
                      @else { <span class="tag solid"><ng-icon name="lucideCheck" size="12" aria-hidden="true" />Ready</span> @if (r.notes.length) { <span class="issue">{{ r.notes.join('; ') }}</span> } }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="row nav-row">
            <button class="btn" type="button" (click)="go(1)">Back</button>
            <button class="btn primary" type="button" [disabled]="ready().length === 0" (click)="go(3)">Find duplicates</button>
          </div>
        }

        @case (3) {
          <p class="intro">One record per donor. Each incoming row below looks like someone already in Cadence. Merging adds the gift to the existing record and fills only empty contact fields.</p>
          @if (matches().length === 0) {
            <div class="empty"><h3>No duplicates found</h3><p>Every ready row is a new donor.</p></div>
          } @else {
            <ul class="list dup-list">
              @for (m of matches(); track m.row.line) {
                <li class="dup">
                  <div class="pair">
                    <div class="rec"><p class="label">Line {{ m.row.line }} in the file</p><p class="strong">{{ m.row.name }}</p>
                      <p class="hint">{{ m.row.email ?? 'No email' }}</p><p class="hint">{{ m.row.phone ?? 'No phone' }}</p></div>
                    <div class="match" aria-hidden="true"><ng-icon name="lucideRepeat" size="16" /></div>
                    <div class="rec existing"><p class="label">Already in Cadence</p><p class="strong"><a [routerLink]="['/donors', m.donor.id]" target="_blank">{{ m.donor.name }}</a></p>
                      <p class="hint">{{ m.donor.email ?? 'No email' }}</p><p class="hint">{{ m.donor.phone ?? 'No phone' }}</p></div>
                  </div>
                  <fieldset class="choice">
                    <legend><span class="tag solid">{{ m.reason }}</span></legend>
                    <div class="seg-choice">
                      @for (opt of decisions; track opt.value) {
                        <label [class.on]="decisionFor(m.row.line) === opt.value"><input type="radio" class="sr-only" [name]="'dup-' + m.row.line" [value]="opt.value" [checked]="decisionFor(m.row.line) === opt.value"
                          (change)="decide(m.row.line, opt.value)" />{{ opt.label }}</label>
                      }
                    </div>
                  </fieldset>
                </li>
              }
            </ul>
          }
          @if (inFileRepeats() > 0) {
            <p class="notice">{{ inFileRepeats() }} row{{ inFileRepeats() === 1 ? '' : 's' }} repeat a person who appears earlier in this file. They are combined into one donor with separate gifts.</p>
          }
          <div class="row nav-row">
            <button class="btn" type="button" (click)="go(2)">Back</button>
            <button class="btn primary" type="button" (click)="go(4)">Review import</button>
          </div>
        }

        @case (4) {
          @if (result(); as r) {
            <div class="done-state">
              <span class="done-icon" aria-hidden="true"><ng-icon name="lucideCircleCheck" size="30" /></span>
              <h3 class="text-lg">Import saved</h3>
              <div class="stack items-center">
                <p>{{ r.created }} new donors, {{ r.merged }} merged into existing records, {{ r.gifts }} gifts recorded, {{ r.skipped }} rows skipped. The import is in the audit log.</p>
                <div class="row"><a class="btn primary" routerLink="/donors">Open donors</a><a class="btn" routerLink="/donations">Open donations</a>
                  <button class="btn" type="button" (click)="restart()">Import another file</button></div>
              </div>
            </div>
          } @else {
            <section class="stats small-stats" aria-label="What will be saved">
              <div class="stat"><p class="label">New donors</p><p class="value">{{ plan().creates }}</p></div>
              <div class="stat"><p class="label">Merged</p><p class="value">{{ plan().merges }}</p></div>
              <div class="stat"><p class="label">Gifts</p><p class="value">{{ plan().gifts }} · {{ money(plan().cents) }}</p></div>
              <div class="stat"><p class="label">Skipped</p><p class="value">{{ plan().skips }}</p></div>
            </section>
            <h3 class="sub-h">Owners for new donors</h3>
            <p class="intro">A contact person who exactly matches an active board member becomes the owner. Everyone else goes to the board member with the fewest donors.</p>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th scope="col">Line</th><th scope="col">New donor</th><th scope="col">Contact person in file</th><th scope="col">Owner</th></tr></thead>
                <tbody>
                  @for (r of newRows(); track r.line) {
                    <tr><td class="mono">{{ r.line }}</td><th scope="row">{{ r.name }}</th><td>{{ r.contact ?? '—' }}</td>
                      <td>@if (ownerFromFile(r); as m) { {{ m.name }} <span class="tag">From file</span> } @else { <span class="tag dashed">Round-robin</span> }</td></tr>
                  }
                </tbody>
              </table>
            </div>
            <div class="row nav-row">
              <button class="btn" type="button" (click)="go(3)">Back</button>
              <button class="btn primary" type="button" (click)="commit()">Save {{ plan().creates + plan().merges }} donors and {{ plan().gifts }} gifts</button>
            </div>
          }
        }
      }
      </section>
      </div>
    </div>
  `,
  styles: `
    .wizard { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 20px; align-items: start; }
    .rail { list-style: none; margin: 0; padding: 10px; border-radius: 20px; display: flex; flex-direction: column; gap: 2px; position: sticky; top: calc(var(--topbar-h) + 24px); }
    .rail li { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; font-size: 13.5px; color: var(--ink-600); }
    .rail li[aria-current='step'] { background: #fff; color: var(--foreground); box-shadow: 0 1px 3px rgb(15 50 30 / 0.1); }
    .r-dot { width: 26px; height: 26px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 600; border: 2px solid rgb(15 26 21 / 0.15); }
    .rail li[aria-current='step'] .r-dot { border-color: var(--primary); color: var(--primary); }
    .rail li.done .r-dot { background: var(--primary); border-color: var(--primary); color: #fff; }
    .stage { border-radius: 22px; padding: 24px 26px; min-width: 0; }
    .drop { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 32px 20px; border-radius: 18px; text-align: center;
      border: 2px dashed rgb(0 122 61 / 0.3); background: rgb(255 255 255 / 0.6); color: var(--green-700); cursor: pointer; transition: border-color 150ms var(--ease), background-color 150ms var(--ease); }
    .drop:hover, .drop:focus-within { border-color: var(--primary); background: #fff; }
    .drop .input.file { margin-top: 10px; max-width: 360px; }
    .samples-box { padding: 4px 0; }
    .samples-box h3 { font-size: 13px; color: var(--muted-foreground); font-weight: 600; margin-bottom: 10px; }
    .sample-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .sample { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--border); background: rgb(255 255 255 / 0.7); cursor: pointer; }
    .sample:hover { background: #fff; border-color: rgb(0 122 61 / 0.35); }
    .s-icon { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--green-50); color: var(--green-700); }
    .s-cta { font-size: 12.5px; font-weight: 600; color: var(--primary); }
    .maps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .map { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) 190px; grid-template-areas: 'src arrow dst how' 'why why why why'; align-items: center; gap: 6px 14px;
      padding: 12px 14px; border-radius: 16px; background: rgb(255 255 255 / 0.7); border: 1px solid var(--border); }
    .map[data-method='suggested'] { border-color: #fcd9b6; background: #fffbf5; }
    .m-src { grid-area: src; display: flex; flex-direction: column; min-width: 0; }
    .m-src code { font-weight: 600; font-size: 13px; }
    .m-arrow { grid-area: arrow; color: var(--ink-400); }
    .m-dst { grid-area: dst; }
    .m-how { grid-area: how; justify-self: end; }
    .m-why { grid-area: why; font-size: 12px; color: var(--muted-foreground); }
    .accept { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; cursor: pointer;
      border: 1px solid #fcd9b6; color: var(--amber-600); background: #fff; }
    .accept.on { background: var(--green-50); border-color: var(--green-200); color: var(--green-700); }
    .accept input { accent-color: var(--primary); }
    .rec { padding: 14px; border-radius: 14px; background: #fff; border: 1px solid var(--border); }
    .rec.existing { border-color: var(--green-200); background: #fbfefc; }
    .match { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--green-50); color: var(--green-700); align-self: center; }
    .seg-choice { display: flex; flex-direction: column; gap: 4px; }
    .seg-choice label { display: flex; align-items: center; height: 36px; padding: 0 12px; border-radius: 12px; border: 1px solid var(--border); background: rgb(255 255 255 / 0.7);
      font-size: 13px; cursor: pointer; }
    .seg-choice label.on { border-color: var(--primary); background: var(--green-50); color: var(--green-700); font-weight: 600; }
    .seg-choice label:focus-within { outline: 2px solid var(--ring); outline-offset: 2px; }
    .done-state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 24px; }
    .done-icon { width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center; background: var(--green-50); color: var(--green-700); }
    @media (max-width: 1000px) { .wizard { grid-template-columns: 1fr; } .rail { position: static; flex-direction: row; overflow-x: auto; } .rail li { min-width: 170px; } }
    @media (max-width: 700px) { .map { grid-template-columns: 1fr; grid-template-areas: 'src' 'dst' 'how' 'why'; } .m-arrow { display: none; } .m-how { justify-self: start; } }
    .step-title { margin-bottom: 16px; outline: none; }
    .gap { gap: 20px; }
    .file { padding: 6px; }
    .hint { font-size: 12.5px; }
    .sample { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .intro { margin-bottom: 16px; max-width: 72ch; }
    .intro-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .samples { font-size: 12.5px; max-width: 260px; }
    .why { font-size: 12.5px; }
    .compact { min-height: 30px; padding: 3px 28px 3px 8px; font-size: 13px; min-width: 160px; }
    .nav-row { margin-top: 24px; }
    .small-stats { margin-bottom: 20px; }
    .small-stats .value { font-size: 22px; }
    .issue { display: block; font-size: 12px; margin-top: 4px; }
    .dup-list { display: flex; flex-direction: column; gap: 12px; }
    .dup-list > li { border: 0; padding: 0; }
    .dup { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 20px; align-items: center; padding: 14px; border-radius: 18px; background: rgb(255 255 255 / 0.5); border: 1px solid var(--border); }
    .pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 12px; }
    .pair p { font-size: 13px; }
    .strong { font-weight: 600; font-size: 14px !important; margin: 2px 0; }
    .choice { display: flex; flex-direction: column; gap: 6px; }
    .choice legend { margin-bottom: 6px; }
    .sub-h { margin: 28px 0 6px; }
    @media (max-width: 860px) { .dup, .pair { grid-template-columns: 1fr; } }
  `,
})
export class ImportPage {
  protected readonly store = inject(Store);
  protected readonly money = money;
  protected readonly steps = STEPS;
  protected readonly sources = IMPORT_SOURCES;
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly samples = SAMPLES;
  protected readonly targets = TARGETS;
  protected readonly targetKeys = Object.keys(TARGETS) as Target[];
  protected readonly now = today();
  protected readonly decisions = [
    { value: 'merge', label: 'Merge into existing donor' },
    { value: 'create', label: 'Keep as a separate donor' },
    { value: 'skip', label: 'Skip this row' },
  ] as const;

  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');
  protected readonly step = signal(0);
  protected readonly source = signal<Source>('spreadsheet');
  protected readonly fileName = signal('');
  protected readonly fileError = signal('');
  protected readonly fallbackDate = signal(this.now);
  protected readonly headers = signal<string[]>([]);
  protected readonly rawRows = signal<string[][]>([]);
  protected readonly guesses = signal<ColumnGuess[]>([]);
  protected readonly accepted = signal(new Set<number>());
  private readonly choices = signal(new Map<number, 'merge' | 'create' | 'skip'>());
  protected readonly result = signal<{ created: number; merged: number; gifts: number; skipped: number } | null>(null);

  protected go(i: number) {
    this.step.set(i);
    queueMicrotask(() => this.stepHeading()?.nativeElement.focus());
  }

  protected restart() {
    this.result.set(null); this.fileName.set(''); this.headers.set([]); this.rawRows.set([]);
    this.choices.set(new Map()); this.go(0);
  }

  protected async pick(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.fileError.set('');
    if (!file) return;
    if (file.size > MAX_BYTES) { this.fileError.set('That file is larger than 5 MB. Split it and import each part.'); return; }
    try {
      if (/\.xlsx$/i.test(file.name)) {
        const sheet = await readSheet(file);
        this.ingest(file.name, sheet.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c)))));
      } else if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
        this.ingest(file.name, parseCsv(await file.text()));
      } else {
        this.fileError.set('Choose a .csv or .xlsx file.');
      }
    } catch {
      this.fileError.set('This file could not be read. Re-export it as CSV and try again.');
    }
  }

  protected async loadSample(file: string, source: Source) {
    const res = await fetch(`samples/${file}`);
    this.source.set(source);
    this.ingest(file, parseCsv(await res.text()));
  }

  private ingest(name: string, rows: string[][]) {
    if (rows.length < 2) { this.fileError.set('The file needs a header row and at least one data row.'); return; }
    const [head, ...data] = rows;
    const width = head.length;
    this.headers.set(head.map((h) => h.trim()));
    this.rawRows.set(data.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')));
    this.guesses.set(classifyColumns(this.headers(), this.rawRows()));
    this.accepted.set(new Set());
    this.choices.set(new Map());
    this.result.set(null);
    this.fileName.set(name);
  }

  protected sampleValues(col: number) {
    return this.rawRows().map((r) => r[col]).filter(Boolean).slice(0, 3).join(' · ');
  }

  protected setTarget(i: number, target: Target) {
    this.guesses.update((gs) => gs.map((g, k) => (k === i ? { ...g, target, method: g.method === 'exact' && g.target === target ? 'exact' : 'none', reason: 'Chosen by you' } : g)));
  }

  protected readonly pendingSuggestions = computed(() => this.guesses().filter((g, i) => g.method === 'suggested' && !this.accepted().has(i)).length);
  protected acceptAll() {
    this.accepted.set(new Set(this.guesses().flatMap((g, i) => (g.method === 'suggested' ? [i] : []))));
  }

  protected toggleAccept(i: number) {
    this.accepted.update((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }

  protected readonly mappingProblem = computed(() => {
    const gs = this.guesses();
    const pending = gs.filter((g, i) => g.method === 'suggested' && !this.accepted().has(i));
    if (pending.length) return `Accept or change ${pending.length} suggested column${pending.length === 1 ? '' : 's'}: ${pending.map((g) => g.header).join(', ')}.`;
    const used = gs.map((g) => g.target).filter((t) => t !== 'ignore');
    const dup = used.find((t, i) => used.indexOf(t) !== i);
    if (dup) return `Two columns map to ${TARGETS[dup]}. Each field can come from one column.`;
    if (!used.includes('first_name') && !used.includes('full_name')) return 'Map a column to First name or Full name.';
    return '';
  });

  private col(target: Target) { return this.guesses().findIndex((g) => g.target === target); }

  protected readonly checked = computed<Checked[]>(() => {
    const c = Object.fromEntries(this.targetKeys.map((t) => [t, this.col(t)])) as Record<Target, number>;
    const cell = (r: string[], t: Target) => (c[t] >= 0 ? (r[c[t]] ?? '').trim() : '');
    return this.rawRows().map((r, i) => {
      const problems: string[] = [], notes: string[] = [];
      if (r.some((v) => /^[=+@]/.test(v.trim()) || /^-[A-Za-z(]/.test(v.trim()))) problems.push('Contains a spreadsheet formula');
      const name = (c.full_name >= 0 ? cell(r, 'full_name') : `${cell(r, 'first_name')} ${cell(r, 'last_name')}`).replace(/\s+/g, ' ').trim();
      if (!name) problems.push('Missing name');
      const rawEmail = cell(r, 'email');
      const email = rawEmail ? rawEmail.toLowerCase() : null;
      if (email && !EMAIL.test(email)) problems.push(`Email “${rawEmail}” is not valid`);
      else if (rawEmail && rawEmail !== email) notes.push('Email lower-cased');
      const digits = cell(r, 'phone').replace(/\D/g, '');
      let phone: string | null = null;
      if (digits) {
        const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
        if (ten.length === 10) phone = `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
        else problems.push('Phone is not 10 digits');
        if (phone && phone !== cell(r, 'phone')) notes.push('Phone formatted');
      }
      const rawAmount = cell(r, 'amount').replace(/[$,\s]/g, '');
      let amount_cents: number | null = null;
      if (rawAmount) {
        if (/^\d+(\.\d{1,2})?$/.test(rawAmount)) amount_cents = Math.round(Number(rawAmount) * 100);
        else if (!problems.includes('Contains a spreadsheet formula')) problems.push(`Amount “${cell(r, 'amount')}” is not a number`);
      }
      const rawDate = cell(r, 'date');
      let date = this.fallbackDate();
      if (rawDate) {
        const us = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        const iso = us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : rawDate.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso))) date = iso;
        else problems.push(`Date “${rawDate}” is not recognized`);
      } else if (amount_cents !== null) notes.push(`Dated ${this.fallbackDate()}`);
      const key = email ?? (phone ? `p:${phone}` : `n:${name.toLowerCase()}`);
      return {
        line: i + 2, name, email: email && EMAIL.test(email) ? email : null, phone, company: cell(r, 'company') || null,
        contact: cell(r, 'contact_person') || null, campaign: cell(r, 'campaign') || null, amount_cents, date, problems, notes, key,
      };
    });
  });

  protected readonly ready = computed(() => this.checked().filter((r) => r.problems.length === 0));
  protected readonly readyTotal = computed(() => this.ready().reduce((s, r) => s + (r.amount_cents ?? 0), 0));

  protected readonly matches = computed<Match[]>(() => {
    const digits = (s: string | null) => (s ?? '').replace(/\D/g, '').slice(-10);
    const out: Match[] = [];
    const seen = new Set<string>();
    for (const row of this.ready()) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      for (const d of this.store.allDonors()) {
        let reason = '';
        if (row.email && d.email?.toLowerCase() === row.email) reason = 'Same email';
        else if (row.phone && digits(d.phone) === digits(row.phone)) reason = 'Same phone';
        else if (d.name.toLowerCase() === row.name.toLowerCase() && row.company && d.company === row.company) reason = 'Same name and company';
        if (reason) { out.push({ row, donor: d, reason }); break; }
      }
    }
    return out;
  });

  protected readonly inFileRepeats = computed(() => {
    const keys = this.ready().map((r) => r.key);
    return keys.length - new Set(keys).size;
  });

  protected decisionFor(line: number) { return this.choices().get(line) ?? 'merge'; }
  protected decide(line: number, value: 'merge' | 'create' | 'skip') {
    this.choices.update((m) => new Map(m).set(line, value));
  }

  /** Every ready row with its final action; repeats follow the first row of their person. */
  private readonly rowsToSave = computed<ImportRow[]>(() => {
    const matchByKey = new Map(this.matches().map((m) => [m.row.key, m]));
    return this.ready().map((r) => {
      const m = matchByKey.get(r.key);
      const decision = m ? this.decisionFor(m.row.line) : 'create';
      return {
        action: decision, matchId: decision === 'merge' ? m!.donor.id : null, key: r.key,
        ownerId: this.ownerFromFile(r)?.id ?? null,
        donor: { name: r.name, email: r.email, phone: r.phone, company: r.company, kind: 'individual', consent: 'unknown',
          preferred_channel: 'email', custom: {}, source: this.source() },
        gift: r.amount_cents ? { amount_cents: r.amount_cents, campaign: r.campaign, occurred_at: `${r.date}T12:00:00-07:00` } : null,
      };
    });
  });

  protected readonly newRows = computed(() => {
    const seen = new Set<string>();
    return this.ready().filter((r, i) => {
      if (this.rowsToSave()[i].action !== 'create' || seen.has(r.key)) return false;
      seen.add(r.key); return true;
    });
  });

  protected readonly plan = computed(() => {
    const rows = this.rowsToSave();
    const created = new Set(rows.filter((r) => r.action === 'create').map((r) => r.key));
    const saved = rows.filter((r) => r.action !== 'skip');
    return {
      creates: created.size,
      merges: saved.length - created.size,
      gifts: saved.filter((r) => r.gift).length,
      cents: saved.reduce((s, r) => s + (r.gift?.amount_cents ?? 0), 0),
      skips: rows.length - saved.length + (this.checked().length - this.ready().length),
    };
  });

  protected ownerFromFile(r: Checked) {
    return r.contact ? this.store.boardMembers().find((m) => m.name.toLowerCase() === r.contact!.toLowerCase()) ?? null : null;
  }

  protected commit() {
    const res = this.store.importRows(this.rowsToSave(), this.source(), this.fileName());
    res.skipped += this.checked().length - this.ready().length;
    this.result.set(res);
    queueMicrotask(() => this.stepHeading()?.nativeElement.focus());
  }
}
