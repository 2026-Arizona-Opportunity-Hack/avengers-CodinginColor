import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Store } from './core/store';
import { ANCHOR } from './core/demo-data';
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
  expect(text()).toContain(`${SYNTHETIC_PROSPECTS.length} potential donors`);
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
  expect(text()).toContain(`${SYNTHETIC_PROSPECTS.length} potential donors`);
});

it('scopes list, interest filters and direct details to the assigned board member', async () => {
  const { store, harness, text } = await open();
  store.setSession('m-bell'); harness.detectChanges();
  await harness.navigateByUrl('/prospects?prospect=sample-mosaic');
  expect(text()).toContain(`${SYNTHETIC_PROSPECTS.filter(p => p.ownerId === store.me().id).length} potential donors`);
  expect(text()).toContain('Potential donor unavailable');
  expect(text()).not.toContain('Mosaic Comet'); expect(text()).not.toContain('Summer Sparks');
  await harness.navigateByUrl('/prospects?prospect=sample-aster');
  expect(text()).toContain('Bright Circuit Club');
  const select = harness.routeNativeElement!.querySelector('select')!;
  select.value = 'Community arts'; select.dispatchEvent(new Event('change')); harness.detectChanges();
  expect(text()).toContain('1 potential donors');
  expect(harness.routeNativeElement!.querySelector('section ul')!.textContent).toContain('Wren Solstice');
});

it('gives every active board member a useful private portfolio without changing canonical records', async () => {
  const store = TestBed.inject(Store); store.enableDemo(true);
  const before = structuredClone({ donors: store.allDonors(), gifts: store.allGifts(), communications: store.communications() });
  const harness = await RouterTestingHarness.create('/prospects');
  for (const member of store.boardMembers()) {
    const own = SYNTHETIC_PROSPECTS.filter(p => p.ownerId === member.id);
    const foreign = SYNTHETIC_PROSPECTS.filter(p => p.ownerId !== member.id);
    expect(own.length, member.name).toBeGreaterThanOrEqual(4);
    store.setSession(member.id); harness.detectChanges();
    const root = harness.routeNativeElement!;
    const links = () => [...root.querySelectorAll('section[aria-label="Potential donor results"] a')];
    expect(links().map(a => a.querySelector('strong')!.textContent)).toEqual(own.map(p => p.name));
    expect([...root.querySelectorAll('select option')].map(o => (o as HTMLOptionElement).value)).toEqual([
      '', ...new Set(own.flatMap(p => p.interests).sort()),
    ]);
    const search = root.querySelector('input')!;
    search.value = foreign[0]!.name; search.dispatchEvent(new Event('input')); harness.detectChanges();
    expect(links()).toHaveLength(0);
    root.querySelector('button')!.click(); harness.detectChanges();
    const select = root.querySelector('select')!;
    select.value = own[0]!.interests[0]!; select.dispatchEvent(new Event('change')); harness.detectChanges();
    expect(links().map(a => a.querySelector('strong')!.textContent)).toEqual(
      own.filter(p => p.interests.includes(select.value)).map(p => p.name));
    root.querySelector('button')!.click(); harness.detectChanges();
    await harness.navigateByUrl('/prospects');
    for (const prospect of foreign) {
      await harness.navigateByUrl(`/prospects?prospect=${prospect.id}`);
      expect(root.textContent).toContain('Potential donor unavailable');
      expect(root.textContent).not.toContain(prospect.name);
    }
    await harness.navigateByUrl(`/prospects?prospect=${own[0]!.id}`);
    expect(root.textContent).toContain(own[0]!.giving[0]!.recipient);
  }
  store.setSession('m-ceo'); harness.detectChanges();
  expect({ donors: store.allDonors(), gifts: store.allGifts(), communications: store.communications() }).toEqual(before);
});

it('keeps prospect IDs unique and giving valid, historical, assigned and separate from actual donors', () => {
  const store = TestBed.inject(Store); store.enableDemo(true);
  expect(SYNTHETIC_PROSPECTS.length).toBeGreaterThanOrEqual(20);
  expect(new Set(SYNTHETIC_PROSPECTS.map(p => p.id)).size).toBe(SYNTHETIC_PROSPECTS.length);
  for (const prospect of SYNTHETIC_PROSPECTS) {
    expect(store.boardMembers().some(m => m.id === prospect.ownerId)).toBe(true);
    expect(store.allDonors().some(d => d.id === prospect.id)).toBe(false);
    expect(prospect.giving.length).toBeGreaterThan(0);
    for (const gift of prospect.giving) {
      expect(Number.isSafeInteger(gift.amountCents) && gift.amountCents > 0).toBe(true);
      expect(new Date(gift.date).toISOString().slice(0, 10)).toBe(gift.date);
      expect(gift.date < ANCHOR).toBe(true);
    }
    if (prospect.id !== 'sample-wren') expect(illustrativeMatches(prospect).length).toBeGreaterThan(0);
  }
  expect(illustrativeMatches(SYNTHETIC_PROSPECTS.find(p => p.id === 'sample-wren')!)).toEqual([]);
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
