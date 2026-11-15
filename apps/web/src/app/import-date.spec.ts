import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { APP_ICONS } from './core/icons';
import { parseCsv } from './core/csv';
import { Store } from './core/store';
import { ImportPage } from './pages/import';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

function setup(value: string) {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideIcons(APP_ICONS)] });
  const store = TestBed.inject(Store); store.enableDemo(true);
  const fixture = TestBed.createComponent(ImportPage);
  const page = fixture.componentInstance as unknown as {
    ingest(name: string, rows: string[][]): void;
    checked(): { date: string; problems: string[] }[];
    commit(): void;
  };
  page.ingest('synthetic-date.csv', parseCsv(`Full name,Email,Donation amount,Gift date\r\nSynthetic Timestamp,timestamp@example.org,12.34,"${value}"`));
  return { fixture, page, store };
}

it('reviews and saves the reported datetime without discarding its time', () => {
  const { fixture, page, store } = setup('12/20/2025, 12:27 PM');
  expect(page.checked()[0].problems).toEqual([]);
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('MM/DD/YYYY');
  expect(fixture.nativeElement.textContent).toContain('America/Phoenix');
  const before = store.allGifts().length;
  page.commit();
  const donor = store.allDonors().find(d => d.email === 'timestamp@example.org')!;
  const gifts = store.allGifts().filter(g => g.donor_id === donor.id);
  expect(store.allGifts()).toHaveLength(before + 1);
  expect(gifts).toHaveLength(1);
  expect(gifts[0]).toMatchObject({ amount_cents: 1234, occurred_at: '2025-12-20T12:27:00-07:00' });
});

it.each([
  ['12/20/2025, 12:00 AM', '2025-12-20T00:00:00-07:00'],
  ['12/20/2025, 12:00 PM', '2025-12-20T12:00:00-07:00'],
  ['2/29/2024, 1:05 PM', '2024-02-29T13:05:00-07:00'],
  ['01/02/2025', '2025-01-02T12:00:00-07:00'],
  ['2025-12-20', '2025-12-20T12:00:00-07:00'],
  ['2025-12-20T23:27:12Z', '2025-12-20T23:27:12Z'],
  ['2025-12-20T12:27:00+02:00', '2025-12-20T12:27:00+02:00'],
])('validates and preserves %s', (value, expected) => {
  const { page } = setup(value);
  expect(page.checked()[0]).toMatchObject({ date: expected, problems: [] });
});

it.each([
  '02/30/2025', '02/29/2025', '2025-02-30', '20/12/2025', '01/02/25',
  '12/20/2025, 0:27 AM', '12/20/2025, 13:27 PM', '12/20/2025, 13:27 AM', '12/20/2025, 12:60 PM',
  '12/20/2025, 12:27', '12/20/2025, 12:27 PM junk', '2025-12-20garbage',
  '2025-12-20T25:00:00Z', '2025-12-20T24:00:00Z', '2025-12-20T12:27:00', '2025-12-20T12:27:00+14:01',
])('keeps invalid or unsupported date %s out of the saved gifts', value => {
  const { page, store } = setup(value);
  expect(page.checked()[0].problems).toContain(`Date “${value}” is not recognized`);
  const before = store.allGifts().length;
  page.commit();
  expect(store.allGifts()).toHaveLength(before);
});
