import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { DonorImpactControls } from './donor-impact-controls';
import { StaffInvitations } from './staff-invitations';
import { Api, ApiError } from '../core/api';
import { Store } from '../core/store';
interface Staff { id:string; clerk_subject:string; role:'admin'|'board'; active:boolean; }

@Component({
  selector:'app-member-settings',
  imports:[StaffInvitations,DonorImpactControls],
  template:`
    <div class="page stack">
      <header class="page-head"><div><h1>Team settings</h1><p class="lede">Manage who can access Coding in Color.</p></div></header>
      <p>Admins manage the organization. Board members see their own donors and outreach. Reassign an owner's active donors before deactivating them or changing their role.</p>
      @if(message()){<p class="notice" role="status">{{message()}}</p>}
      <button class="btn" type="button" [disabled]="busy()" (click)="reload()">Reload team</button>
      <section class="panel" aria-labelledby="members-h">
        <h2 id="members-h" class="panel-head">Members</h2>
        <div class="panel-body stack">
          @for(member of rows();track member.id){
            <article class="stack">
              <h3>{{member.clerk_subject}}{{member.id===store.me().id?' (you)':''}}</h3>
              <p>Current access: {{member.role}} / {{member.active?'active':'inactive'}}</p>
              <p class="meta">Member {{member.id}} | {{load(member.id)}} active donors</p>
              <fieldset class="row" [disabled]="busy() || member.id===store.me().id">
                <label class="field"><span>Role</span><select #role class="select" [value]="member.role" [attr.aria-label]="'Role for '+member.clerk_subject"><option value="board">Board member</option><option value="admin">Admin</option></select></label>
                <label><input #active type="checkbox" [checked]="member.active" [attr.aria-label]="'Active access for '+member.clerk_subject" /> Active access</label>
                <button class="btn" type="button" (click)="save(member,role.value,active.checked)">Save access</button>
              </fieldset>
            </article>
          }@empty{<p>No members loaded.</p>}
        </div>
      </section>
      <app-staff-invitations />
      <app-donor-impact-controls />
      <form class="panel" (submit)="add($event)" novalidate>
        <h2 class="panel-head">Add an existing Clerk user</h2>
        <fieldset class="panel-body stack" [disabled]="busy()">
          <p>Use the user ID from this app's Clerk Users page. The person must have a verified primary email. Creating access here does not send an email.</p>
          <label class="field"><span>Clerk user ID</span><input class="input" name="subject" required maxlength="200" placeholder="user_..." /></label>
          <label class="field"><span>Role</span><select class="select" name="role"><option value="board">Board member</option><option value="admin">Admin</option></select></label>
          <button class="btn primary" type="submit">Add verified user</button>
        </fieldset>
      </form>
    </div>
  `,
})
export class MemberSettings {
  protected readonly store=inject(Store);
  private readonly api=inject(Api);
  protected readonly rows=signal<Staff[]>([]);
  protected readonly busy=signal(false);
  protected readonly message=signal('');
  private generation=0;
  constructor(){
    inject(DestroyRef).onDestroy(()=>this.generation++);
    effect(()=>{
      const epoch=this.store.sessionEpoch();
      if(!this.store.live()||!this.store.isAdmin()){this.generation++;this.rows.set([]);return;}
      void this.reload(epoch);
    });
  }
  protected load(id:string){return this.store.allDonors().filter(d=>d.owner_id===id).length;}
  protected async reload(epoch=this.store.sessionEpoch()){
    const generation=++this.generation;this.busy.set(true);
    try{
      const result=await this.api.request<{items:Staff[]}>('/api/v1/members');
      if(epoch===this.store.sessionEpoch()&&generation===this.generation)this.rows.set(result.items);
    }catch(error){if(epoch===this.store.sessionEpoch()&&generation===this.generation)this.message.set(error instanceof ApiError?error.message:'Could not load team members.');}
    finally{if(generation===this.generation)this.busy.set(false);}
  }
  protected async save(member:Staff,role:string,active:boolean){
    if(this.busy()||member.id===this.store.me().id)return;
    await this.write(`/api/v1/members/${encodeURIComponent(member.id)}`,'PATCH',{role,active});
  }
  protected async add(event:Event){
    event.preventDefault();if(this.busy())return;
    const form=event.target as HTMLFormElement,data=new FormData(form);
    const clerk_subject=String(data.get('subject')??'').trim(),role=String(data.get('role'));
    if(!/^user_[A-Za-z0-9]+$/.test(clerk_subject)||clerk_subject.length>200){this.message.set('Enter a Clerk user ID from this app.');return;}
    if(await this.write('/api/v1/members','POST',{clerk_subject,role,active:true}))form.reset();
  }
  private async write(path:string,method:string,body:unknown){
    const epoch=this.store.sessionEpoch(),generation=++this.generation;this.busy.set(true);this.message.set('');
    try{
      const saved=await this.api.request<Staff>(path,{method,body:JSON.stringify(body)});
      if(epoch!==this.store.sessionEpoch()||generation!==this.generation)return false;
      this.rows.update(rows=>[...rows.filter(m=>m.id!==saved.id),saved]);
      this.message.set('Access saved.');return true;
    }catch(error){
      if(epoch===this.store.sessionEpoch()&&generation===this.generation)this.message.set(error instanceof ApiError&&error.status===409
        ?'Access was not changed. Reassign active donors first and keep an active admin. Existing users appear when you reload the team.'
        :error instanceof ApiError&&error.status===400?'Check the user ID and verified primary email in this Clerk app.':error instanceof ApiError?error.message:'Could not confirm the access change. Reload the team before retrying.');
      return false;
    }finally{if(generation===this.generation)this.busy.set(false);}
  }
}
