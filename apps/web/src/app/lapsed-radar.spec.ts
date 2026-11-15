import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Store } from './core/store';
import { Api } from './core/api';
import { RetentionPage } from './pages/retention';

it('opens the lapsed drill-down from outreach and creates one pending nudge for repeated clicks', async () => {
  const createDraft = vi.fn(async () => ({ id: 'draft' }));
  TestBed.configureTestingModule({ providers: [
    { provide: Store, useValue: { createDraft, sessionEpoch: signal(1), donor: () => ({ name:'Avery' }) } },
    { provide: Api, useValue: {} },
    { provide: ActivatedRoute, useValue: { snapshot:{ queryParamMap:convertToParamMap({segment:'lapsed'}) } } },
  ] });
  const page = TestBed.runInInjectionContext(() => new RetentionPage()) as unknown as {
    selected: Signal<string | null>; nudged: Signal<Set<string>>; nudge(id: string): Promise<void>;
  };
  expect(page.selected()).toBe('lapsed');
  await Promise.all([page.nudge('donor'),page.nudge('donor')]);
  expect(createDraft).toHaveBeenCalledOnce();
  expect(createDraft).toHaveBeenCalledWith('donor','t-nudge','Lapsed: gave last period, not this period');
  expect(page.nudged().has('donor')).toBe(true);
});
