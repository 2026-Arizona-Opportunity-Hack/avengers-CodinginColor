import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Api,ApiError } from './core/api';
import { DonorImpactPage,donorMoney,type ImpactFeed } from './pages/donor-impact';
const feed:ImpactFeed={gifts:[{amount_cents:'12345',refund_cents:'345',currency:'USD',status:'settled',occurred_at:'2026-11-15T01:00:00Z',campaign:'Summer'}],
  outcomes:[{program:'Academy',metric:'Learners',value:'0',unit:'people',denominator:null,period_from:'2026-01-01',period_to:'2027-01-01'}],limit:50,offset:0};
function setup(authenticated=true){
  const api={authenticated:signal(authenticated),identityVersion:signal(1),status:signal('error'),request:vi.fn(async():Promise<ImpactFeed>=>feed),signOut:vi.fn(),mountSignIn:vi.fn(),unmountSignIn:vi.fn(),mountSignUp:vi.fn(),unmountSignUp:vi.fn()};
  TestBed.configureTestingModule({providers:[{provide:Api,useValue:api}]});const fixture=TestBed.createComponent(DonorImpactPage);fixture.detectChanges();return {api,fixture};
}
it('loads donor facts without staff ready status, preserves exact cents/zero and shows Phoenix dates',async()=>{
  const {api,fixture}=setup();await fixture.whenStable();fixture.detectChanges();
  expect(api.request).toHaveBeenCalledWith('/api/v1/impact?limit=50&offset=0');
  expect(fixture.nativeElement.textContent).toContain('USD 123.45');expect(fixture.nativeElement.textContent).toContain('Refunded USD 3.45');
  expect(fixture.nativeElement.textContent).toContain('Learners: 0');expect(fixture.nativeElement.textContent).toContain('Nov 14, 2026');
  expect(donorMoney('9007199254740991','USD')).toBe('USD 90,071,992,547,409.91');
});
it('drops late results and old records when the active identity changes',async()=>{
  const {api,fixture}=setup();await fixture.whenStable();fixture.detectChanges();
  let resolve!:(f:ImpactFeed)=>void;api.request.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  fixture.nativeElement.querySelectorAll('button')[1].click();api.authenticated.set(false);api.identityVersion.update(v=>v+1);fixture.detectChanges();
  resolve(feed);await fixture.whenStable();fixture.detectChanges();expect(fixture.nativeElement.textContent).not.toContain('Summer');
  expect(fixture.nativeElement.textContent).not.toContain('Learners');
});
it('renders a denied donor grant without staff or donor details',async()=>{
  const {api,fixture}=setup(false);api.request.mockRejectedValueOnce(new ApiError(403));api.authenticated.set(true);fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Your donor account is not enabled.');expect(fixture.nativeElement.textContent).not.toContain('Summer');
});

it('clears previous donor records while a replacement identity loads or fails',async()=>{
  const {api,fixture}=setup();await fixture.whenStable();fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Summer');
  let reject!:(reason:unknown)=>void;
  api.request.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  api.identityVersion.update(value=>value+1);fixture.detectChanges();
  const pending=fixture.nativeElement.textContent;
  reject(new ApiError(403));await fixture.whenStable();fixture.detectChanges();
  expect(pending).not.toContain('Summer');expect(pending).not.toContain('Learners');
  expect(fixture.nativeElement.textContent).not.toContain('Summer');
  expect(fixture.nativeElement.textContent).toContain('Your donor account is not enabled.');
});
it('discards an old donor response after a direct authenticated identity switch',async()=>{
  const {api,fixture}=setup();await fixture.whenStable();fixture.detectChanges();
  let finishOld!:(value:ImpactFeed)=>void,finishNew!:(value:ImpactFeed)=>void;
  api.request.mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;}));
  fixture.nativeElement.querySelectorAll('button')[1].click();
  api.request.mockImplementationOnce(()=>new Promise(resolve=>{finishNew=resolve;}));
  api.identityVersion.update(value=>value+1);fixture.detectChanges();
  finishNew({...feed,gifts:[{...feed.gifts[0],campaign:'New donor gift'}],outcomes:[]});
  await fixture.whenStable();fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('New donor gift');
  finishOld(feed);await fixture.whenStable();fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('New donor gift');
  expect(fixture.nativeElement.textContent).not.toContain('Summer');
});
