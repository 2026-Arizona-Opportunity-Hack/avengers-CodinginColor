import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Store } from './core/store';
import { ReportFilters } from './core/report-filters';
import { ReportFiltersControl } from './shared/report-filters';
import type { Gift } from './core/models';

function setup() {
  const donors = [{ id: 'a', owner_id: 'owner-a' }, { id: 'b', owner_id: 'owner-b' }];
  const gift = (donor_id: string, occurred_at: string, campaign_id = 'campaign'): Gift => ({
    id: donor_id + occurred_at, donor_id, campaign_id, occurred_at, amount_cents: 1000, refund_cents: 0,
    currency: 'EUR', status: 'settled', source: 'manual', external_id: null,
  });
  const current = [gift('a', '2026-05-01T12:00:00Z'), gift('b', '2026-05-02T12:00:00Z', 'other')];
  const store = { sessionEpoch: signal(1), gifts: signal(current), ledgerGifts: signal(current), allGifts: signal([...current, { ...gift('a', '2025-01-01T07:00:00Z'), currency: 'USD' }]),
    donors: signal(donors), donor: (id: string) => donors.find(d => d.id === id), historicalDonor: (id: string) => donors.find(d => d.id === id), campaign: (id: string) => ({ program_id: id === 'campaign' ? 'program' : 'other' }),
    programs: signal([{ id: 'program', title: 'Academy' }]), campaigns: signal([{ id: 'campaign', title: 'Spring', program_id: 'program' }]),
    boardMembers: signal([{ id: 'owner-a', name: 'Owner A' }]), isAdmin: signal(true) };
  TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: store }] });
  const filters = TestBed.inject(ReportFilters); TestBed.tick();
  return { filters, store };
}

it('intersects owner/program/campaign with acquisition across all currencies and resets private scope on session change', () => {
  const { filters, store } = setup();
  filters.owner.set('owner-a'); filters.program.set('program'); filters.campaign.set('campaign'); filters.cohort.set('2025');
  expect(filters.gifts().map(g => g.donor_id)).toEqual(['a']); expect(filters.donors().map(d => d.id)).toEqual(['a']);
  filters.cohort.set('2026'); expect(filters.gifts()).toEqual([]);
  store.sessionEpoch.update(n => n + 1); TestBed.tick(); expect(filters.owner()).toBe(''); expect(filters.gifts()).toHaveLength(2);
});

it('validates calendar ranges and carries explicit filter controls into the shared query', () => {
  const { filters } = setup();
  const fixture = TestBed.createComponent(ReportFiltersControl); fixture.detectChanges();
  const inputs = fixture.nativeElement.querySelectorAll('input');
  inputs[0].value = '2026-04-01'; inputs[0].dispatchEvent(new Event('input'));
  inputs[1].value = '2026-11-14'; inputs[1].dispatchEvent(new Event('input'));
  expect(filters.query()['from']).toBe('2026-04-01'); expect(filters.through()).toBe('2026-11-14');
  filters.from.set('2026-02-30'); expect(filters.valid()).toBe(false);
  filters.from.set('2025-01-01'); expect(filters.valid()).toBe(false);
  filters.from.set('2026-04-01'); filters.cohort.set('25'); expect(filters.valid()).toBe(false);
});
