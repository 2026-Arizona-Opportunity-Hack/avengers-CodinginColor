import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { Api, ApiError, type DebriefInput } from './core/api';
import { Store } from './core/store';
import { DebriefEntry } from './pages/debrief-entry';

function setup() {
  const store = { live: signal(true), signedIn: signal(true), sessionEpoch: signal(1), refreshLive: vi.fn(async () => {}) };
  const api = { saveDebrief: vi.fn(async (_id: string, _body: DebriefInput): Promise<unknown> => ({})) };
  TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: store }, { provide: Api, useValue: api }] });
  const fixture = TestBed.createComponent(DebriefEntry); fixture.componentRef.setInput('donorId', 'donor'); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as {
    raw: WritableSignal<string>; note: WritableSignal<string>; occurred: WritableSignal<string>; due: WritableSignal<string>;
    action: WritableSignal<string>; reviewed: WritableSignal<boolean>; saved: WritableSignal<boolean>; message: WritableSignal<string>;
    ready: WritableSignal<boolean>; pending: DebriefInput | null; propose(): void; save(e: Event): Promise<void>;
  };
  const prepare = () => { page.raw.set('Discussed Academy.\nAction: Send report\nDue: 2026-12-01T09:00\nSubject: Our report\nDraft: Thank you.'); page.propose(); page.occurred.set('2026-01-01T10:00'); };
  const save = () => page.save(new Event('submit', { cancelable: true }));
  return { fixture, page, api, store, prepare, save };
}

it('prepares an editable local proposal and saves only explicitly reviewed facts atomically', async () => {
  const f = setup(); f.prepare();
  expect(f.api.saveDebrief).not.toHaveBeenCalled(); expect(f.page.note()).toBe('Discussed Academy.');
  expect(f.page.action()).toBe('Send report'); expect(f.page.due()).toBe('2026-12-01T09:00');
  await f.save(); expect(f.api.saveDebrief).not.toHaveBeenCalled();
  f.page.note.set('Reviewed contact note'); f.page.reviewed.set(true); await f.save();
  expect(f.api.saveDebrief).toHaveBeenCalledOnce();
  expect(f.api.saveDebrief.mock.calls[0]).toEqual(['donor', {
    request_id: expect.any(String), reviewed: true, note: 'Reviewed contact note', occurred_at: '2026-01-01T10:00:00-07:00',
    next_action: { title: 'Send report', due_at: '2026-12-01T09:00:00-07:00' },
    draft: { channel: 'email', subject: 'Our report', body: 'Thank you.' },
  }]);
  expect(f.page.saved()).toBe(true); expect(f.page.raw()).toBe(''); expect(f.store.refreshLive).toHaveBeenCalledOnce();
});

it('does not infer dates and rejects missing, normalized or future contact dates before sending', async () => {
  const f = setup(); f.page.raw.set('Contact note\nAction: Call next week\nDue: next week'); f.page.propose();
  expect(f.page.due()).toBe(''); expect(f.page.occurred()).toBe(''); f.page.reviewed.set(true);
  for (const time of ['', '2026-02-30T10:00', '2099-01-01T10:00']) { f.page.occurred.set(time); await f.save(); }
  f.page.occurred.set('2026-01-01T10:00'); await f.save();
  expect(f.api.saveDebrief).not.toHaveBeenCalled(); expect(f.page.message()).toContain('explicit valid due date');
});

it.each([0, 503])('retries uncertain %s saves with the exact request ID and reviewed payload', async status => {
  const f = setup(); f.prepare(); f.page.reviewed.set(true); f.api.saveDebrief.mockRejectedValueOnce(new ApiError(status));
  await f.save(); const first = structuredClone(f.api.saveDebrief.mock.calls[0]);
  expect(f.page.saved()).toBe(false); f.page.note.set('Unreviewed change'); await f.save();
  expect(f.api.saveDebrief.mock.calls[1]).toEqual(first); expect(f.page.saved()).toBe(true);
});

it.each([400, 409])('allows correction after a definitive %s rejection and requires renewed review', async status => {
  const f = setup(); f.prepare(); f.page.reviewed.set(true); f.api.saveDebrief.mockRejectedValueOnce(new ApiError(status));
  await f.save(); const firstId = f.api.saveDebrief.mock.calls[0][1].request_id;
  expect(f.page.pending).toBeNull(); expect(f.page.reviewed()).toBe(false);
  f.page.note.set('Corrected'); await f.save(); expect(f.api.saveDebrief).toHaveBeenCalledOnce();
  f.page.reviewed.set(true); await f.save(); expect(f.api.saveDebrief.mock.calls[1][1].request_id).not.toBe(firstId);
});

it('does not invent a time when notes supply only a due date', () => {
  const f = setup(); f.page.raw.set('Contact note\nAction: Call\nDue: 2026-12-01'); f.page.propose();
  expect(f.page.due()).toBe(''); expect(f.page.action()).toBe('Call');
});

it.each(['session', 'donor'])('clears private notes and ignores a late save after a %s change', async change => {
  const f = setup(); f.prepare(); f.page.reviewed.set(true); let finish!: (value: unknown) => void;
  f.api.saveDebrief.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const pending = f.save();
  if (change === 'session') { f.store.signedIn.set(false); f.store.sessionEpoch.update(n => n + 1); }
  else f.fixture.componentRef.setInput('donorId', 'replacement');
  f.fixture.detectChanges(); finish({}); await pending;
  expect(f.page.raw()).toBe(''); expect(f.page.note()).toBe(''); expect(f.page.pending).toBeNull();
  expect(f.page.saved()).toBe(false); expect(f.store.refreshLive).not.toHaveBeenCalled();
});

it('invalidates the review checkbox when accepted fields are edited', () => {
  const f = setup(); f.prepare(); f.page.reviewed.set(true); f.fixture.detectChanges();
  const note = f.fixture.nativeElement.querySelector('form textarea'); note.value = 'Changed'; note.dispatchEvent(new Event('input', { bubbles: true }));
  expect(f.page.reviewed()).toBe(false);
});

it('does not expose a fake save in demo mode', () => {
  const f = setup(); f.store.live.set(false); f.fixture.detectChanges();
  expect(f.fixture.nativeElement.querySelector('form')).toBeNull();
});
