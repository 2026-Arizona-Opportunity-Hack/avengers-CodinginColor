import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { APP_ICONS } from './core/icons';
import { parseCsv } from './core/csv';
import { Store } from './core/store';
import { ImportPage } from './pages/import';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

function setup() {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store); store.enableDemo(true);
  const fixture = TestBed.createComponent(ImportPage);
  const page = fixture.componentInstance as unknown as {
    ingest(name: string, rows: string[][]): void; commit(): Promise<void>;
    result(): { gifts: number; skipped: number } | null; commitError(): string;
  };
  const upload = async (rows: string, name = 'qa-date.csv') => {
    page.ingest(name, parseCsv('Name,Email,Amount,Date,Transaction ID\n' + rows));
    await page.commit();
  };
  return { store, page, upload };
}
const row = 'QA Date,qa@example.org,23.45,"12/20/2025, 12:27 PM",';

it('blocks legacy filename-only gifts for human review instead of duplicating or guessing', async () => {
  const { store, page, upload } = setup();
  await upload(row + 'qa-date.csv#1');
  const before = structuredClone(store.allGifts());
  await upload(row);
  expect(page.commitError()).toContain('older import without file verification. Nothing was saved');
  expect(store.allGifts()).toEqual(before);
});

it('replays the actual parsed CSV with zero added gifts or net giving, including a renamed file', async () => {
  const { store, page, upload } = setup();
  await upload(row);
  const before = structuredClone(store.allGifts());
  await upload(row);
  expect(page.result()).toMatchObject({ gifts: 0, skipped: 1 });
  expect(store.allGifts()).toEqual(before);
  await upload(row, 'renamed.csv');
  expect(store.allGifts()).toEqual(before);
});

it('retains two identical financial rows with distinct transaction IDs and replays them safely', async () => {
  const { store, page, upload } = setup();
  const before = store.allGifts().length;
  await upload(row + 'txn-a\n' + row + 'txn-b');
  expect(store.allGifts()).toHaveLength(before + 2);
  expect(store.allGifts().slice(-2).map(g => g.external_id)).toEqual(['txn-a', 'txn-b']);
  await upload(row + 'txn-a\n' + row + 'txn-b');
  expect(page.result()).toMatchObject({ gifts: 0, skipped: 2 });
});

it('retains separate identical rows without transaction IDs using their original record numbers', async () => {
  const { store, upload } = setup();
  const before = store.allGifts().length;
  await upload(row + '\n' + row);
  expect(store.allGifts()).toHaveLength(before + 2);
  expect(new Set(store.allGifts().slice(-2).map(g => g.external_id)).size).toBe(2);
});

it('rejects changed facts under the same transaction identity without partially saving earlier rows', async () => {
  const { store, page, upload } = setup();
  await upload(row + 'txn-a');
  const before = JSON.stringify([store.allGifts(), store.allDonors(), store.campaigns(), store.audit()]);
  await upload('New Person,new@example.org,10.00,2025-12-20,txn-new\n' + row.replace('23.45', '99.00') + 'txn-a');
  expect(page.result()).toBeNull();
  expect(page.commitError()).toContain('different facts. Nothing was saved');
  expect(JSON.stringify([store.allGifts(), store.allDonors(), store.campaigns(), store.audit()])).toBe(before);
});
