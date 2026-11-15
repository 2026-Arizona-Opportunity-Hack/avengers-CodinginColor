import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AskDataPage } from './pages/ask-data';
import { Api, ApiError } from './core/api';
import { Store } from './core/store';

function setup() {
  const store = { sessionEpoch: signal(1), signedIn: signal(true) };
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
it('clears private questions and discards late results after session loss', async () => {
  const f = setup(); let resolve!: (value: Awaited<ReturnType<typeof f.api.request>>) => void;
  f.api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.question(); const pending = f.submit(); f.store.signedIn.set(false); f.store.sessionEpoch.update(n => n + 1); f.fixture.detectChanges();
  resolve({ needs_clarification: false, explanation: 'Private result', total: 1, donors: [{ id: 'donor', name: 'Avery' }] }); await pending;
  expect(f.input.value).toBe(''); expect(f.fixture.nativeElement.textContent).not.toContain('Avery');
});
it('surfaces authorization failures without inventing a result', async () => {
  const f = setup(); f.api.request.mockRejectedValueOnce(new ApiError(403)); f.question(); await f.submit();
  expect(f.fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('do not have access');
  expect(f.fixture.nativeElement.textContent).not.toContain('Avery');
});
