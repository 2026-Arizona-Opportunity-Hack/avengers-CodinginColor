import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Api,ApiError } from './core/api';
import { Store } from './core/store';
import { MemberSettings } from './pages/member-settings';
const admin={id:'admin',clerk_subject:'user_admin',role:'admin',active:true};
const board={id:'board',clerk_subject:'user_board',role:'board',active:true};
function setup(){
  const epoch=signal(1),isAdmin=signal(true);
  const store={sessionEpoch:epoch,live:()=>true,isAdmin,me:()=>({id:'admin'}),allDonors:()=>[{owner_id:'board'}]};
  const request=vi.fn(async(path:string,_init?:RequestInit):Promise<unknown>=>({items:path==='/api/v1/invitations'?[]:[admin,board]}));
  TestBed.configureTestingModule({providers:[{provide:Store,useValue:store},{provide:Api,useValue:{request}}]});
  const fixture=TestBed.createComponent(MemberSettings);fixture.detectChanges();
  return {fixture,request,epoch,isAdmin};
}
describe('live team settings',()=>{
  it('loads true access, rejects a failed change without a success claim, and saves confirmed access',async()=>{
    const {fixture,request}=setup();await fixture.whenStable();fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Current access: board / active');
    const articles=fixture.nativeElement.querySelectorAll('article');
    expect(articles[0].querySelector('button').matches(':disabled')).toBe(true);
    const role=articles[1].querySelector('select') as HTMLSelectElement;role.value='admin';
    request.mockRejectedValueOnce(new ApiError(409));articles[1].querySelector('button').click();await fixture.whenStable();fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Access was not changed.');
    expect(fixture.nativeElement.textContent).toContain('Current access: board / active');
    request.mockResolvedValueOnce({...board,role:'admin'});articles[1].querySelector('button').click();await fixture.whenStable();fixture.detectChanges();
    expect(request.mock.calls.at(-1)).toEqual(['/api/v1/members/board',{method:'PATCH',body:'{"role":"admin","active":true}'}]);
    expect(fixture.nativeElement.textContent).toContain('Access saved.');
    expect(fixture.nativeElement.textContent).toContain('Current access: admin / active');
  });
  it('validates the existing user form and waits for confirmation before adding it',async()=>{
    const {fixture,request}=setup();await fixture.whenStable();fixture.detectChanges();
    const form=fixture.nativeElement.querySelector('[name="subject"]').closest('form') as HTMLFormElement;
    const subject=form.querySelector('[name="subject"]') as HTMLInputElement;
    const submit=async()=>{form.dispatchEvent(new Event('submit',{cancelable:true}));await fixture.whenStable();fixture.detectChanges();};
    subject.value='not a Clerk ID';await submit();expect(request).toHaveBeenCalledTimes(2);
    subject.value='user_new';request.mockRejectedValueOnce(new ApiError(400));await submit();
    expect(fixture.nativeElement.textContent).toContain('Check the user ID and verified primary email');
    expect(subject.value).toBe('user_new');
    request.mockResolvedValueOnce({id:'new',clerk_subject:'user_new',role:'board',active:true});await submit();
    expect(fixture.nativeElement.textContent).toContain('user_new');expect(subject.value).toBe('');
  });
  it('drops a delayed response when the session changes',async()=>{
    const {fixture,request,epoch,isAdmin}=setup();await fixture.whenStable();fixture.detectChanges();
    let resolve!:(value:unknown)=>void;request.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    fixture.nativeElement.querySelector('button').click();epoch.set(2);isAdmin.set(false);fixture.detectChanges();
    resolve({items:[{...board,clerk_subject:'user_late'}]});await fixture.whenStable();fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('user_late');
    expect(fixture.nativeElement.textContent).not.toContain('user_board');
  });
});
