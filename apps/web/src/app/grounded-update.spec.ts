import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Api, ApiError } from './core/api';
import { Store } from './core/store';
import { GroundedUpdate } from './pages/grounded-update';

const proposal = { subject:'An update',body:'Completed: 0 students. Source: approved workbook.',context_hash:'a'.repeat(64),facts:[{id:'outcome_0',text:'Completed: 0 students.'}] };
function setup() {
  const store = { live:signal(true),signedIn:signal(true),sessionEpoch:signal(1),programs:signal([{id:'program',title:'Academy'}]),refreshLive:vi.fn(async()=>{}) };
  const api = { request:vi.fn(async (_path:string,_init?:RequestInit):Promise<unknown>=>proposal) };
  TestBed.configureTestingModule({providers:[provideRouter([]),{provide:Store,useValue:store},{provide:Api,useValue:api}]});
  const fixture=TestBed.createComponent(GroundedUpdate); fixture.componentRef.setInput('donorId','donor'); fixture.detectChanges();
  const page=fixture.componentInstance as unknown as { propose():Promise<void>;save():Promise<void>;body:WritableSignal<string>;saved:WritableSignal<boolean>;error:WritableSignal<string|null>;proposal:WritableSignal<typeof proposal|null> };
  return {store,api,fixture,page};
}

it('reviews and edits actual source-backed proposals before saving an unapproved draft',async()=>{
  const f=setup(); await f.page.propose(); f.fixture.detectChanges();
  expect(f.fixture.nativeElement.textContent).toContain('Completed: 0 students.');
  const textarea=f.fixture.nativeElement.querySelector('textarea'); textarea.value='Reviewed message'; textarea.dispatchEvent(new Event('input'));
  f.api.request.mockResolvedValueOnce({id:'draft'}); await f.page.save();
  const [path,init]=f.api.request.mock.calls.at(-1)!;
  expect(path).toBe('/api/v1/drafts/grounded'); expect(JSON.parse(init!.body as string)).toMatchObject({donor_id:'donor',program_id:'program',body:'Reviewed message',context_hash:proposal.context_hash});
  expect(f.store.refreshLive).toHaveBeenCalledOnce(); expect(f.page.saved()).toBe(true);
  expect(f.api.request.mock.calls.some(([path])=>path.includes('/approve')||path.includes('/send'))).toBe(false);
});

it('retains edits and refuses a stale/rejected save without pretending it succeeded',async()=>{
  const f=setup(); await f.page.propose(); f.page.body.set('Reviewed');
  f.api.request.mockRejectedValueOnce(new ApiError(409)); await f.page.save();
  expect(f.page.saved()).toBe(false); expect(f.page.body()).toBe('Reviewed'); expect(f.page.error()).toBeTruthy();
  expect(f.store.refreshLive).not.toHaveBeenCalled();
});

it('discards late proposals and clears private draft content after sign-out',async()=>{
  const f=setup(); let finish!:(value:unknown)=>void;
  f.api.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})); const pending=f.page.propose();
  f.store.signedIn.set(false); f.store.sessionEpoch.update(n=>n+1); f.fixture.detectChanges(); finish(proposal); await pending;
  expect(f.page.proposal()).toBeNull(); expect(f.page.body()).toBe(''); expect(f.page.saved()).toBe(false);
});
