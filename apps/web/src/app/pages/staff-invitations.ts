import { Component,DestroyRef,effect,inject,signal } from '@angular/core';
import { Api,ApiError } from '../core/api';
import { Store } from '../core/store';
interface Invitation{id:string;email:string;role:string;state:string;expires_at:string;}
@Component({selector:'app-staff-invitations',template:`
  <section class="panel stack" aria-labelledby="invite-h">
    <h2 id="invite-h" class="panel-head">Invite staff</h2>
    <form class="panel-body stack" (submit)="send($event)" novalidate>
      <p>Sending emails this person an invitation valid for seven days. They must verify this primary email before the selected access is granted.</p>
      <fieldset class="form-grid" [disabled]="busy() || !!pending">
        <label class="field"><span>Email</span><input class="input" type="email" name="email" required maxlength="320" /></label>
        <label class="field"><span>Intended role</span><select class="select" name="role"><option value="board">Board member</option><option value="admin">Admin</option></select></label>
      </fieldset>
      <button class="btn primary" type="submit" [disabled]="busy()">{{pending?'Retry invitation delivery':'Send invitation email'}}</button>
    </form>
    @if(message()){<p class="notice" role="status">{{message()}}</p>}
    <div class="panel-body stack">
      <button class="btn" type="button" [disabled]="busy()" (click)="reload()">Reload invitations</button>
      @for(invite of rows();track invite.id){
        <article><h3>{{invite.email}}</h3><p>{{invite.role}} ? {{invite.state}} ? Expires {{invite.expires_at.slice(0,10)}}</p>
          @if(['queued','sent','failed'].includes(invite.state)){<button class="btn" type="button" [disabled]="busy()" (click)="revoke(invite.id)">Revoke invitation</button>}
        </article>
      }@empty{<p>No invitations loaded.</p>}
    </div>
  </section>
`})
export class StaffInvitations{
  private readonly api=inject(Api);private readonly store=inject(Store);
  protected readonly rows=signal<Invitation[]>([]);protected readonly busy=signal(false);protected readonly message=signal('');
  protected pending:{request_id:string;email:string;role:string}|null=null;
  private generation=0;
  constructor(){inject(DestroyRef).onDestroy(()=>this.generation++);effect(()=>{
    const epoch=this.store.sessionEpoch();if(!this.store.isAdmin()){this.generation++;this.rows.set([]);this.pending=null;return;}void this.reload(epoch);
  });}
  protected async reload(epoch=this.store.sessionEpoch()){
    const generation=++this.generation;this.busy.set(true);
    try{const result=await this.api.request<{items:Invitation[]}>('/api/v1/invitations');
      if(epoch===this.store.sessionEpoch()&&generation===this.generation)this.rows.set(result.items);
    }catch(error){if(epoch===this.store.sessionEpoch()&&generation===this.generation)this.message.set(error instanceof ApiError?error.message:'Could not load invitations.');}
    finally{if(generation===this.generation)this.busy.set(false);}
  }
  protected async send(event:Event){
    event.preventDefault();if(this.busy())return;const form=event.target as HTMLFormElement;
    if(!this.pending){const data=new FormData(form),email=String(data.get('email')??'').trim().toLowerCase(),role=String(data.get('role'));
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>320){this.message.set('Enter the staff email address.');return;}
      this.pending={request_id:crypto.randomUUID(),email,role};
    }
    const epoch=this.store.sessionEpoch(),generation=++this.generation;this.busy.set(true);
    try{const saved=await this.api.request<Invitation>('/api/v1/invitations',{method:'POST',body:JSON.stringify(this.pending)});
      if(epoch!==this.store.sessionEpoch()||generation!==this.generation)return;
      this.rows.update(rows=>[saved,...rows.filter(i=>i.id!==saved.id)]);this.pending=null;form.reset();this.message.set('Invitation email sent. Access stays pending until the verified account accepts.');
    }catch(error){if(epoch===this.store.sessionEpoch()&&generation===this.generation){
      if(error instanceof ApiError&&error.status===400){this.pending=null;this.message.set('The invitation was rejected. Correct the email and role.');}
      else this.message.set(error instanceof ApiError&&error.status===409?'This invitation is already pending or closed. Reload invitations and revoke a pending request before changing its details.':'Delivery could not be confirmed. Retry the same invitation or reload its status. Failed delivery does not grant access.');
    }}finally{if(generation===this.generation)this.busy.set(false);}
  }
  protected async revoke(id:string){
    if(this.busy())return;const epoch=this.store.sessionEpoch(),generation=++this.generation;this.busy.set(true);
    try{const saved=await this.api.request<Invitation>(`/api/v1/invitations/${encodeURIComponent(id)}/revoke`,{method:'POST',body:'{}'});
      if(epoch!==this.store.sessionEpoch()||generation!==this.generation)return;
      this.rows.update(rows=>rows.map(i=>i.id===saved.id?saved:i));if(this.pending?.request_id===id)this.pending=null;this.message.set('Invitation revoked.');
    }catch{if(epoch===this.store.sessionEpoch()&&generation===this.generation)this.message.set('Could not confirm provider cleanup. Reload invitations to check access; database revocation takes effect before provider cleanup.');}
    finally{if(generation===this.generation)this.busy.set(false);}
  }
}
