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

it('clears the previous feed immediately when an authenticated account is replaced',async()=>{
  const {api,fixture}=setup();await fixture.whenStable();fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Summer');
  let finish!:(f:ImpactFeed)=>void;api.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  api.identityVersion.update(v=>v+1);fixture.detectChanges();
  expect(api.authenticated()).toBe(true);
  expect(fixture.nativeElement.textContent).not.toContain('Summer');
  expect(fixture.nativeElement.textContent).not.toContain('Learners');
  finish({...feed,gifts:[{...feed.gifts[0],campaign:'New account gift'}],outcomes:[]});
  await fixture.whenStable();fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('New account gift');
  expect(fixture.nativeElement.textContent).not.toContain('Summer');
});

it('ignores an old pagination response after a direct authenticated account replacement',async()=>{
  const {api,fixture}=setup();await fixture.whenStable();fixture.detectChanges();
  let oldPage!:(f:ImpactFeed)=>void,nextAccount!:(f:ImpactFeed)=>void;
  api.request.mockImplementationOnce(()=>new Promise(resolve=>{oldPage=resolve;}))
    .mockImplementationOnce(()=>new Promise(resolve=>{nextAccount=resolve;}));
  const page=fixture.componentInstance as unknown as {load(offset:number):Promise<void>};
  const pending=page.load(50);api.identityVersion.update(v=>v+1);fixture.detectChanges();
  oldPage({...feed,gifts:[{...feed.gifts[0],campaign:'Old account page'}],offset:50});
  await pending;fixture.detectChanges();
  expect(fixture.nativeElement.textContent).not.toContain('Old account page');
  expect(fixture.nativeElement.textContent).not.toContain('Summer');
  nextAccount({...feed,gifts:[],outcomes:[]});await fixture.whenStable();fixture.detectChanges();
  expect(fixture.nativeElement.textContent).not.toContain('Old account page');
});
