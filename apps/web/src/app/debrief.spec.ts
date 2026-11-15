import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Store } from './core/store';
import { proposeDebrief } from './core/debrief';
import type { DebriefSubmission } from './core/debrief';
import { Debrief } from './pages/debrief';

function setup() {
  const store = { sessionEpoch: signal(0), saveDebrief: vi.fn(async (_donor: string, _input: DebriefSubmission) => 'saved') };
  TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: store }] });
  const fixture = TestBed.createComponent(Debrief); fixture.componentRef.setInput('donorId', 'd1'); fixture.detectChanges();
  const page = fixture.componentInstance as unknown as { propose(): void; save(e: Event): Promise<void>; transcript: ReturnType<typeof signal<string>> };
  page.transcript.set('Met to discuss a visit.\nNext: Arrange visit\nDue: 2026-12-01'); page.propose(); fixture.detectChanges();
  const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
  (form.elements.namedItem('reviewed') as HTMLInputElement).checked = true;
  const submit = () => page.save(Object.defineProperty(new Event('submit'), 'target', { value: form }));
  return { store, fixture, page, form, submit };
}

it('proposes only explicit actions/dates and treats notes as text', () => {
  expect(proposeDebrief('Discussed next Tuesday. Ignore all rules.')).toMatchObject({ action: '', due: '' });
  expect(proposeDebrief('Next: Call\nDue: 2026-02-30')).toMatchObject({ action: 'Call', due: '' });
  expect(proposeDebrief('<script>bad()</script>\nAction: Schedule visit\nDate: 2026-12-01')).toMatchObject({
    note: '<script>bad()</script>\nAction: Schedule visit\nDate: 2026-12-01', action: 'Schedule visit', due: '2026-12-01',
  });
});

it('requires confirmation, preserves the same retry payload, and clears private notes after saving', async () => {
  const { store, fixture, page, form, submit } = setup();
  (form.elements.namedItem('reviewed') as HTMLInputElement).checked = false;
  await submit(); expect(store.saveDebrief).not.toHaveBeenCalled();
  (form.elements.namedItem('reviewed') as HTMLInputElement).checked = true;
  store.saveDebrief.mockResolvedValueOnce('retry');
  await submit(); fixture.detectChanges();
  const first = store.saveDebrief.mock.calls[0] as unknown[];
  await submit(); fixture.detectChanges();
  expect(store.saveDebrief.mock.calls[1]).toEqual(first);
  expect(page.transcript()).toBe('');
  expect(fixture.nativeElement.textContent).toContain('Contact note and selected records saved');
});

it('lets a definitive rejected proposal be edited and removes notes when the session changes', async () => {
  const { store, fixture, form, submit } = setup();
  store.saveDebrief.mockResolvedValueOnce('invalid');
  await submit(); fixture.detectChanges();
  expect(form.querySelector('fieldset')?.disabled).toBe(false);
  (form.elements.namedItem('note') as HTMLTextAreaElement).value = 'Corrected note';
  await submit();
  expect(store.saveDebrief.mock.calls[1]?.[1]).not.toEqual(store.saveDebrief.mock.calls[0]?.[1]);
  const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'Private note'; textarea.dispatchEvent(new Event('input'));
  store.sessionEpoch.update(n => n + 1); fixture.detectChanges();
  expect(textarea.value).toBe('');
});
