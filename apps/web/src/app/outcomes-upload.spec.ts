import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { Api, ApiError } from './core/api';
import { Store } from './core/store';
import { OutcomesUpload } from './pages/outcomes-upload';

function setup() {
  const store = { sessionEpoch: signal(1), signedIn: signal(true), isAdmin: signal(true) };
  const api = { request: vi.fn(async (_path: string, _init?: RequestInit) => ({ approved: 1 })) };
  TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: store }, { provide: Api, useValue: api }] });
  const fixture = TestBed.createComponent(OutcomesUpload);
  fixture.componentRef.setInput('example', '[{"value":null}]'); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as {
    text: WritableSignal<string>; approved: WritableSignal<boolean>; error: WritableSignal<string | null>;
    success: WritableSignal<string | null>; save(): Promise<void>; readFile(event: Event): Promise<void>;
  };
  const saved = vi.fn(); fixture.componentInstance.saved.subscribe(saved);
  return { store, api, fixture, page, saved };
}

it('requires explicit approval, keeps null and zero, and refreshes only after persisted approval', async () => {
  const f = setup(); f.page.text.set('[{"value":0},{"value":null}]');
  await f.page.save(); expect(f.api.request).not.toHaveBeenCalled();
  f.page.approved.set(true); await f.page.save();
  expect(JSON.parse(f.api.request.mock.calls[0][1]!.body as string)).toEqual({ approved: true, outcomes: [{ value: 0 }, { value: null }] });
  expect(f.saved).toHaveBeenCalledOnce(); expect(f.page.success()).toContain('Approved 1'); expect(f.page.approved()).toBe(false);
});

it('rejects malformed batches and retains edits when the server rejects approval', async () => {
  const f = setup(); f.page.text.set('{}'); f.page.approved.set(true); await f.page.save();
  expect(f.api.request).not.toHaveBeenCalled(); expect(f.page.error()).toContain('JSON array');
  f.page.text.set('[{"value":0}]'); f.api.request.mockRejectedValueOnce(new ApiError(403)); await f.page.save();
  expect(f.page.error()).toBe('You do not have access to that.'); expect(f.page.text()).toContain('0'); expect(f.saved).not.toHaveBeenCalled();
});

it('never publishes late approval results after sign-out', async () => {
  const f = setup(); let finish!: (value: { approved: number }) => void;
  f.api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.page.text.set('[{"value":0}]'); f.page.approved.set(true); const pending = f.page.save();
  f.store.signedIn.set(false); f.store.sessionEpoch.update(n => n + 1); f.fixture.detectChanges();
  finish({ approved: 1 }); await pending;
  expect(f.saved).not.toHaveBeenCalled(); expect(f.page.success()).toBeNull(); expect(f.page.text()).toBe('');
});

it('bounds file size, requires renewed review on file load and clears approval after editing', async () => {
  const f = setup(), file = { size: 10, text: async () => '[{"value":0}]' };
  f.page.approved.set(true); await f.page.readFile({ target: { files: [file] } } as unknown as Event);
  expect(f.page.text()).toContain('0'); expect(f.page.approved()).toBe(false);
  await f.page.readFile({ target: { files: [{ size: 100_001 }] } } as unknown as Event);
  expect(f.page.error()).toContain('100 KB');
  f.page.approved.set(true); f.fixture.detectChanges();
  const textarea = f.fixture.nativeElement.querySelector('textarea'); textarea.value = '[]'; textarea.dispatchEvent(new Event('input'));
  expect(f.page.approved()).toBe(false);
});
