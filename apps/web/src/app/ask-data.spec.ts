import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AskDataPage } from './pages/ask-data';
import { Api, ApiError } from './core/api';
import { Store } from './core/store';

function setup() {
  const store = { sessionEpoch: signal(1), signedIn: signal(true), live: signal(true),
    donors: vi.fn(() => [] as { id: string; name: string; owner_id: string }[]),
    allGifts: vi.fn(() => [] as { donor_id: string; amount_cents: number; refund_cents: number; currency: string; occurred_at: string; status: 'settled' | 'pending' | 'void' }[]),
    me: () => ({ id: 'member' }) };
  const api = { request: vi.fn(async () => ({ needs_clarification: false, explanation: 'Active donors assigned to you.', total: 1,
    donors: [{ id: 'donor', name: 'Avery' }] })) };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Store, useValue: store }, { provide: Api, useValue: api }] });
  const fixture = TestBed.createComponent(AskDataPage); fixture.detectChanges();
  const input = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
  const submit = async () => { fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })); await fixture.whenStable(); fixture.detectChanges(); };
  const question = () => { input.value = 'Show my lapsed donors'; input.dispatchEvent(new Event('input')); };
  return { fixture, store, api, input, submit, question };
}
it('submits an explicit question and links only the returned authorized donors', async () => {
  const f = setup(); f.question(); await f.submit();
  expect(f.api.request).toHaveBeenCalledWith('/api/v1/ask-data', expect.objectContaining({ body: '{"question":"Show my lapsed donors"}' }));
  expect(f.fixture.nativeElement.textContent).toContain('1 matching donors');
  expect(f.fixture.nativeElement.querySelector('a').getAttribute('href')).toBe('/donors/donor');
});

it('searches demo donors by owner, exact net threshold, currency and lapsed giving without API requests', async () => {
  const f = setup(); f.store.live.set(false);
  const year = new Date(Date.now() - 7 * 3600_000).getUTCFullYear();
  f.store.donors.mockReturnValue([
    { id: 'own', name: 'Own donor', owner_id: 'member' }, { id: 'other', name: 'Other donor', owner_id: 'other' },
    { id: 'lapsed', name: 'Lapsed donor', owner_id: 'member' }, { id: 'empty', name: 'No history', owner_id: 'member' },
  ]);
  const gift = { donor_id: 'own', amount_cents: 10029, refund_cents: 29, currency: 'USD', status: 'settled' as const,
    occurred_at: `${year}-01-01T07:00:00Z` };
  f.store.allGifts.mockReturnValue([gift, { ...gift, currency: 'EUR', amount_cents: 20000, refund_cents: 0 },
    { ...gift, donor_id: 'other', amount_cents: 30000, refund_cents: 0 },
    { ...gift, donor_id: 'lapsed', occurred_at: `${year - 1}-01-01T07:00:00Z` }]);
  const ask = async (question: string) => {
    f.input.value = question; f.input.dispatchEvent(new Event('input')); await f.submit();
    return [...f.fixture.nativeElement.querySelectorAll('li a')].map((a: any) => a.textContent.trim());
  };
  expect(await ask('show my donors')).toEqual(['Lapsed donor', 'No history', 'Own donor']);
  expect(await ask('show my donors over $100 in USD')).toEqual([]);
  expect(await ask('show my donors over $99.99 in USD')).toEqual(['Own donor']);
  expect(await ask('show my donors over $100 in EUR')).toEqual(['Own donor']);
  expect(await ask('show my lapsed donors')).toEqual(['Lapsed donor']);
  expect(await ask('donors in EUR')).toEqual([]);
  expect(f.fixture.nativeElement.textContent).toContain('A little more detail');
  expect(f.api.request).not.toHaveBeenCalled();
});
it('clears private questions and discards late results after session loss', async () => {
  const f = setup(); let resolve!: (value: Awaited<ReturnType<typeof f.api.request>>) => void;
  f.api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.question(); const pending = f.submit(); f.store.signedIn.set(false); f.store.sessionEpoch.update(n => n + 1); f.fixture.detectChanges();
  resolve({ needs_clarification: false, explanation: 'Private result', total: 1, donors: [{ id: 'donor', name: 'Avery' }] }); await pending;
  expect(f.input.value).toBe(''); expect(f.fixture.nativeElement.textContent).not.toContain('Avery');
  expect(f.fixture.nativeElement.querySelector('.question-bubble')).toBeNull();
});

it('offers supported prompts without sending until the user submits, then returns focus', async () => {
  const f = setup(); f.store.live.set(false); f.fixture.detectChanges();
  const send = f.fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  const prompts = [...f.fixture.nativeElement.querySelectorAll('.prompt')] as HTMLButtonElement[];
  expect(prompts).toHaveLength(3);
  const focus = vi.spyOn(f.input, 'focus');
  for (let i = 0; i < prompts.length; i++) {
    const prompt = f.fixture.nativeElement.querySelectorAll('.prompt')[i] as HTMLButtonElement;
    prompt.click(); f.fixture.detectChanges();
    expect(f.input.value).toBe(prompt.textContent!.trim());
    expect(f.fixture.nativeElement.querySelector('section')).toBeNull();
    expect(send.disabled).toBe(false);
    await f.submit();
    expect(f.fixture.nativeElement.textContent).not.toContain('A little more detail');
    f.store.sessionEpoch.update(n => n + 1); f.fixture.detectChanges();
  }
  expect(focus).toHaveBeenCalledTimes(6);
  expect(f.api.request).not.toHaveBeenCalled();
});

it('sends with Enter while preserving Shift+Enter and composition input', async () => {
  const f = setup(); f.question();
  const shift = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
  f.input.dispatchEvent(shift);
  const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true });
  f.input.dispatchEvent(composing);
  expect(shift.defaultPrevented).toBe(false); expect(composing.defaultPrevented).toBe(false);
  expect(f.api.request).not.toHaveBeenCalled();
  f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  await f.fixture.whenStable(); f.fixture.detectChanges();
  expect(f.api.request).toHaveBeenCalledTimes(1);
  expect(f.fixture.nativeElement.querySelector('.question-bubble').textContent).toContain('Show my lapsed donors');
  expect(f.fixture.nativeElement.querySelector('.examples')).toBeNull();
  expect(f.input.getAttribute('aria-describedby')).toContain('ask-help');
});

it('announces loading, prevents duplicate sends and clears displayed identity content', async () => {
  const f = setup(); let resolve!: (value: Awaited<ReturnType<typeof f.api.request>>) => void;
  f.api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.question(); const pending = f.submit(); f.fixture.detectChanges();
  expect(f.fixture.nativeElement.querySelector('[role="status"]').textContent).toContain('Finding donors');
  expect(f.fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBe(true);
  expect(f.input.readOnly).toBe(true);
  f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  expect(f.api.request).toHaveBeenCalledTimes(1);
  resolve({ needs_clarification: false, explanation: 'Visible results', total: 1, donors: [{ id: 'donor', name: 'Avery' }] }); await pending;
  expect(f.input.readOnly).toBe(false);
  f.store.sessionEpoch.update(n => n + 1); f.fixture.detectChanges();
  expect(f.input.value).toBe('');
  expect(f.fixture.nativeElement.textContent).not.toContain('Avery');
  expect(f.fixture.nativeElement.querySelector('.question-bubble')).toBeNull();
  expect(f.fixture.nativeElement.querySelectorAll('.prompt')).toHaveLength(3);
});
it('surfaces authorization failures without inventing a result', async () => {
  const f = setup(); f.api.request.mockRejectedValueOnce(new ApiError(403)); f.question(); await f.submit();
  expect(f.fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('do not have access');
  expect(f.fixture.nativeElement.textContent).not.toContain('Avery');
});
