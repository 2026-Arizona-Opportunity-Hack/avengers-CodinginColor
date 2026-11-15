import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store } from './core/store';
import { OwnerDigests } from './pages/owner-digests';

it('groups authorized portfolios and only open actions for admin human review', () => {
  const admin = signal(true);
  const store = {
    isAdmin: admin,
    boardMembers: () => [{ id: 'a', name: 'Avery' }, { id: 'b', name: 'Jordan' }],
    donors: () => [{ id: 'd1', owner_id: 'a', name: 'Donor One' }],
    followUps: () => [
      { id: 't1', donor_id: 'd1', owner_id: 'a', action: 'Call', due_on: '2026-01-01', status: 'open' },
      { id: 't2', donor_id: 'd1', owner_id: 'a', action: 'Finished', due_on: '2026-01-01', status: 'done' },
      { id: 't3', donor_id: 'hidden', owner_id: 'b', action: 'Private', due_on: '2026-01-01', status: 'open' },
    ],
  };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Store, useValue: store }] });
  const fixture = TestBed.createComponent(OwnerDigests);
  fixture.detectChanges();
  const text = fixture.nativeElement.textContent;
  expect(text).toContain('Avery: 1 donors, 1 open actions');
  expect(text).toContain('Jordan: 0 donors, 0 open actions');
  expect(text).toContain('Call:');
  expect(text).not.toContain('Finished');
  expect(text).not.toContain('Private');
  admin.set(false); fixture.detectChanges();
  expect(fixture.nativeElement.textContent.trim()).toBe('');
});
