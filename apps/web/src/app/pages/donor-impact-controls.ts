import { Component,DestroyRef,effect,inject,signal } from '@angular/core';
import { Api,ApiError } from '../core/api';
import { Store } from '../core/store';
interface Access{donor_id:string;clerk_subject:string;active:boolean;opted_in:boolean;}
interface Outcome{id:string;program:string;metric:string;value:string|null;unit:string;period_from:string;period_to:string;published:boolean;}
interface Invite{id:string;donor_id:string;email:string;state:string;expires_at:string;}
@Component({selector:'app-donor-impact-controls',template:`
  <section class="panel stack" aria-labelledby="portal-h">
    <h2 class="panel-head" id="portal-h">Donor impact portal</h2>
    <div class="panel-body stack">
      <p>Donor accounts see only their own gifts and explicitly published program updates. Staff access is separate. The portal address is <code>/impact</code>.</p>
      @if(message()){<p class="notice" role="status">{{message()}}</p>}
      <label class="field"><span>Donor to invite or link</span><select class="select" name="impact_donor" [disabled]="busy()" [value]="selected()" (change)="selected.set($any($event.target).value)">
        <option value="">Choose a donor</option>@for(donor of store.allDonors();track donor.id){<option [value]="donor.id">{{donor.name}} | {{donor.email??'No email recorded'}}</option>}
      </select></label>
      <form class="stack" (submit)="invite($event)">
        <h3>1. Send the requested invitation</h3>
        <p>This sends a Clerk sign-up email to the selected donor's recorded email. It does not grant access.</p>
        <label><input type="checkbox" name="requested" [disabled]="busy()" required /> The donor requested an account invitation.</label>
        <button class="btn" type="submit" [disabled]="busy()||!selected()">Send donor invitation email</button>
      </form>
      <form class="stack" (submit)="link($event)">
        <h3>2. Confirm the verified account and opt-in</h3>
        <p>After sign-up, copy this app's Clerk user ID. The server checks its verified primary email matches the selected donor. Never use a staff invitation for a donor.</p>
        <label class="field"><span>Verified Clerk user ID</span><input class="input" name="impact_subject" maxlength="200" [disabled]="busy()" required /></label>
        <label><input type="checkbox" name="opted_in" [disabled]="busy()" required /> The donor opted in to this account being linked to their gifts.</label>
        <button class="btn primary" type="submit" [disabled]="busy()||!selected()">Verify and enable donor access</button>
      </form>
      <h3>Linked accounts</h3>
      @for(access of access();track access.donor_id){<article><p>{{name(access.donor_id)}} | {{access.clerk_subject}} | {{access.active&&access.opted_in?'Access enabled':'Access revoked'}}</p>
        <button class="btn" type="button" [disabled]="busy()||!access.active" (click)="revokeAccess(access.donor_id)">Revoke donor access</button></article>
      }@empty{<p>No donor accounts linked.</p>}
      <h3>Donor invitations</h3><p>Revoking an invitation does not revoke an account already linked. Use Revoke donor access for that.</p>
      @for(invite of invites();track invite.id){<article><p>{{invite.email}} | {{invite.state}} | Expires {{invite.expires_at.slice(0,10)}}</p>
        <button class="btn" type="button" [disabled]="busy()||invite.state==='revoked'" (click)="revokeInvite(invite.id)">Revoke donor invitation</button></article>
      }@empty{<p>No donor invitations.</p>}
      <h3>Publish approved aggregate outcomes</h3>
      <p>Approval does not publish a fact. Only publish aggregate facts suitable for donors. Corrected facts need to be published again.</p>
      @for(outcome of outcomes();track outcome.id){<article><p>{{outcome.program}} | {{outcome.metric}}: {{outcome.value??'Not reported'}} {{outcome.unit}}</p>
        <p>{{outcome.period_from}} to {{outcome.period_to}} | {{outcome.published?'Published to donor feeds':'Not published'}}</p>
        <button class="btn" type="button" [disabled]="busy()" (click)="publish(outcome)">{{outcome.published?'Unpublish outcome':'Publish outcome to donors'}}</button></article>
      }@empty{<p>No approved outcomes available.</p>}
      <button class="btn" type="button" [disabled]="busy()" (click)="reload()">Reload donor portal controls</button>
    </div>
  </section>
`})
export class DonorImpactControls{
  protected readonly store=inject(Store);private readonly api=inject(Api);
  protected readonly access=signal<Access[]>([]);protected readonly outcomes=signal<Outcome[]>([]);protected readonly invites=signal<Invite[]>([]);
  protected readonly busy=signal(false);protected readonly message=signal('');protected readonly selected=signal('');
  private generation=0;private pendingInvite:{donor_id:string;request_id:string;requested:true}|null=null;
  constructor(){inject(DestroyRef).onDestroy(()=>this.generation++);effect(()=>{
    const epoch=this.store.sessionEpoch();this.selected.set('');this.pendingInvite=null;if(!this.store.isAdmin()){this.generation++;this.access.set([]);this.outcomes.set([]);this.invites.set([]);this.pendingInvite=null;return;}void this.reload(epoch);
  });}
  protected name(id:string){return this.store.allDonors().find(d=>d.id===id)?.name??'Donor record';}
  private current(epoch:number,generation:number){return epoch===this.store.sessionEpoch()&&generation===this.generation;}
  private async read(epoch:number,generation:number){
    const [access,outcomes,invites]=await Promise.all([
      this.api.request<{items:Access[]}>('/api/v1/impact/access'),this.api.request<{items:Outcome[]}>('/api/v1/impact/outcomes'),this.api.request<{items:Invite[]}>('/api/v1/impact/invitations')]);
    if(this.current(epoch,generation)){this.access.set(access.items);this.outcomes.set(outcomes.items);this.invites.set(invites.items);}
  }
  protected async reload(epoch=this.store.sessionEpoch()){
    const generation=++this.generation;this.busy.set(true);
    try{await this.read(epoch,generation);}catch(error){if(this.current(epoch,generation))this.message.set(error instanceof ApiError?error.message:'Could not load donor portal controls.');}
    finally{if(generation===this.generation)this.busy.set(false);}
  }
  private async write(path:string,body:unknown,success:string){
    const epoch=this.store.sessionEpoch(),generation=++this.generation;this.busy.set(true);this.message.set('');
    try{await this.api.request(path,{method:'POST',body:JSON.stringify(body)});if(!this.current(epoch,generation))return false;
      await this.read(epoch,generation);if(this.current(epoch,generation))this.message.set(success);return this.current(epoch,generation);
    }catch(error){if(this.current(epoch,generation))this.message.set(error instanceof ApiError&&error.status===400?'Check the donor email, verified Clerk account and opt-in confirmation.':error instanceof ApiError&&error.status===409?'This account or invitation is already linked or closed. Reload before changing it.':'Could not confirm the change. Reload its state before retrying.');return false;}
    finally{if(generation===this.generation)this.busy.set(false);}
  }
  protected async invite(event:Event){
    event.preventDefault();if(this.busy()||!this.selected())return;const form=event.target as HTMLFormElement;
    if(new FormData(form).get('requested')!=='on'){this.message.set('Confirm the donor requested an account invitation.');return;}
    if(this.pendingInvite?.donor_id!==this.selected())this.pendingInvite={donor_id:this.selected(),request_id:crypto.randomUUID(),requested:true};
    if(await this.write('/api/v1/impact/invitations',this.pendingInvite,'Invitation email sent. Access remains disabled until you verify and link the opted-in account.')){this.pendingInvite=null;form.reset();}
  }
  protected async link(event:Event){
    event.preventDefault();if(this.busy()||!this.selected())return;const form=event.target as HTMLFormElement,data=new FormData(form),subject=String(data.get('impact_subject')??'').trim();
    if(data.get('opted_in')!=='on'||!/^user_[A-Za-z0-9]+$/.test(subject)||subject.length>200){this.message.set('Enter the verified Clerk user ID and confirm donor opt-in.');return;}
    if(await this.write('/api/v1/impact/access',{donor_id:this.selected(),clerk_subject:subject,opt_in:true},'Verified donor access enabled.'))form.reset();
  }
  protected revokeAccess(id:string){if(!this.busy())void this.write(`/api/v1/impact/access/${encodeURIComponent(id)}/revoke`,{},'Donor access revoked.');}
  protected revokeInvite(id:string){if(!this.busy())void this.write(`/api/v1/impact/invitations/${encodeURIComponent(id)}/revoke`,{},'Donor invitation revoked.');}
  protected publish(outcome:Outcome){if(!this.busy())void this.write(`/api/v1/impact/outcomes/${encodeURIComponent(outcome.id)}/publication`,{published:!outcome.published},outcome.published?'Outcome withdrawn from donor feeds.':'Outcome explicitly published to funded donor feeds.');}
}
