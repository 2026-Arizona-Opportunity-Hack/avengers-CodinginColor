import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Api } from './core/api';
import { Store } from './core/store';
import { DonorImpactControls } from './pages/donor-impact-controls';
it('requires explicit donor request/opt-in and separately publishes an approved outcome',async()=>{
  let linked=false,published=false,invited=false;
  const request=vi.fn(async(path:string,init?:RequestInit):Promise<unknown>=>{
    if(init?.method==='POST'){
      if(path==='/api/v1/impact/access')linked=true;
      if(path==='/api/v1/impact/invitations')invited=true;
      if(path.endsWith('/publication'))published=JSON.parse(String(init.body)).published;
      return {};
    }
    if(path.endsWith('/access'))return {items:linked?[{donor_id:'donor',clerk_subject:'user_first',active:true,opted_in:true}]:[]};
    if(path.endsWith('/outcomes'))return {items:[{id:'outcome',program:'Academy',metric:'Learners',value:'0',unit:'people',period_from:'2026-01-01',period_to:'2027-01-01',published}]};
    return {items:invited?[{id:'invite',donor_id:'donor',email:'first@example.org',state:'sent',expires_at:'2026-11-22'}]:[]};
  });
  TestBed.configureTestingModule({providers:[{provide:Api,useValue:{request}},{provide:Store,useValue:{sessionEpoch:signal(1),isAdmin:()=>true,allDonors:()=>[{id:'donor',name:'Synthetic',email:'first@example.org'}]}}]});
  const fixture=TestBed.createComponent(DonorImpactControls);fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();
  expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
  const selected=fixture.nativeElement.querySelector('[name="impact_donor"]') as HTMLSelectElement;selected.value='donor';selected.dispatchEvent(new Event('change'));fixture.detectChanges();
  const forms=fixture.nativeElement.querySelectorAll('form') as NodeListOf<HTMLFormElement>;
  const submit=async(form:HTMLFormElement)=>{form.dispatchEvent(new Event('submit',{cancelable:true}));await fixture.whenStable();fixture.detectChanges();};
  await submit(forms[0]);expect(invited).toBe(false);
  (forms[0].querySelector('[name="requested"]') as HTMLInputElement).checked=true;await submit(forms[0]);expect(invited).toBe(true);
  expect(fixture.nativeElement.textContent).toContain('Access remains disabled until you verify and link');
  (forms[1].querySelector('[name="impact_subject"]') as HTMLInputElement).value='user_first';await submit(forms[1]);expect(linked).toBe(false);
  (forms[1].querySelector('[name="opted_in"]') as HTMLInputElement).checked=true;await submit(forms[1]);expect(linked).toBe(true);
  const write=request.mock.calls.find(([path,init])=>path==='/api/v1/impact/access'&&init?.method==='POST');
  expect(JSON.parse(String(write?.[1]?.body))).toEqual({donor_id:'donor',clerk_subject:'user_first',opt_in:true});
  const publish=Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(b=>b.textContent?.includes('Publish outcome to donors'))!;
  expect(published).toBe(false);publish.click();await fixture.whenStable();fixture.detectChanges();expect(published).toBe(true);
  expect(fixture.nativeElement.textContent).toContain('Published to donor feeds');expect(fixture.nativeElement.textContent).toContain('Learners: 0');
});
