import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Store } from './core/store';
import { ProspectsPage } from './pages/prospects';
import { SYNTHETIC_PROSPECTS, illustrativeMatches } from './pages/synthetic-prospects';

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'prospects', component: ProspectsPage }])] });
});

async function open(url = '/prospects') {
  const store = TestBed.inject(Store); store.enableDemo(true);
  const harness = await RouterTestingHarness.create(url);
  return { store, harness, text: () => harness.routeNativeElement!.textContent! };
}

it('shows all fictional samples to admins without changing the donor or gift ledger', async () => {
  const { store, harness, text } = await open('/prospects?prospect=sample-aster');
  const donors = store.allDonors(); const gifts = store.allGifts();
  expect(text()).toContain('5 potential donors');
  expect(text()).toContain('Bright Circuit Club');
  expect(text()).toContain('Why this match');
  expect(text()).toContain('Previous giving to other nonprofits');
  expect(store.allDonors()).toBe(donors); expect(store.allGifts()).toBe(gifts);
  for (const p of SYNTHETIC_PROSPECTS) expect(store.boardMembers().some(m => m.id === p.ownerId)).toBe(true);
  const search = harness.routeNativeElement!.querySelector('input')!;
  search.value = 'mosaic'; search.dispatchEvent(new Event('input')); harness.detectChanges();
  expect(text()).toContain('1 potential donors');
  expect(harness.routeNativeElement!.querySelector('section ul')!.textContent).not.toContain('Aster Vale');
  harness.routeNativeElement!.querySelector('button')!.click(); harness.detectChanges();
  expect(text()).toContain('5 potential donors');
});

it('scopes list, interest filters and direct details to the assigned board member', async () => {
  const { store, harness, text } = await open();
  store.setSession('m-bell'); harness.detectChanges();
  await harness.navigateByUrl('/prospects?prospect=sample-mosaic');
  expect(text()).toContain('2 potential donors');
  expect(text()).toContain('Potential donor unavailable');
  expect(text()).not.toContain('Mosaic Comet'); expect(text()).not.toContain('Summer Sparks');
  expect(text()).not.toContain('Summer learning');
  await harness.navigateByUrl('/prospects?prospect=sample-aster');
  expect(text()).toContain('Bright Circuit Club');
  const select = harness.routeNativeElement!.querySelector('select')!;
  select.value = 'Community arts'; select.dispatchEvent(new Event('change')); harness.detectChanges();
  expect(text()).toContain('1 potential donors');
  expect(harness.routeNativeElement!.querySelector('section ul')!.textContent).toContain('Wren Solstice');
});

it('clears filters and details on switching personas and allows a fresh selection', async () => {
  const { store, harness, text } = await open('/prospects?prospect=sample-aster');
  const search = harness.routeNativeElement!.querySelector('input')!;
  search.value = 'aster'; search.dispatchEvent(new Event('input')); harness.detectChanges();
  store.setSession('m-ortiz'); harness.detectChanges();
  expect(search.value).toBe(''); expect(text()).not.toContain('Aster Vale');
  expect(text()).not.toContain('Bright Circuit Club');
  store.setSession('m-ceo'); harness.detectChanges();
  expect(text()).not.toContain('Bright Circuit Club');
  await harness.navigateByUrl('/prospects?prospect=sample-mosaic');
  expect(text()).toContain('Summer Sparks');
  await store.signOut(); harness.detectChanges();
  expect(text()).not.toContain('Mosaic Comet');
});

it('never displays synthetic prospects in live mode, including direct detail URLs', async () => {
  const { store, harness, text } = await open('/prospects?prospect=sample-aster');
  store.live.set(true); harness.detectChanges();
  expect(text()).toContain('unavailable in this workspace');
  expect(text()).not.toContain('Aster Vale'); expect(text()).not.toContain('Bright Circuit Club');
});

it('explains deterministic cause and interest overlap and abstains without one', () => {
  expect(illustrativeMatches(SYNTHETIC_PROSPECTS[0]!)).toEqual([
    "Giving to Bright Circuit Club (STEM access) and the STEM access interest overlap with CIC's Day of Compute program.",
    "Giving to Tomorrow Lab (Youth coding) and the Youth coding interest overlap with CIC's Summer Camp program.",
  ]);
  expect(illustrativeMatches(SYNTHETIC_PROSPECTS[4]!)).toEqual([]);
  expect(illustrativeMatches({ ...SYNTHETIC_PROSPECTS[0]!, interests: ['Community arts'] })).toEqual([]);
});
