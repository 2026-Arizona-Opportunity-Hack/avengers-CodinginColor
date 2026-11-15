import { Component,DestroyRef,ElementRef,effect,inject,signal,viewChild } from '@angular/core';
import { Api,ApiError } from '../core/api';
export interface ImpactFeed{
  gifts:{amount_cents:string;refund_cents:string;currency:string;status:string;occurred_at:string;campaign:string|null}[];
  outcomes:{program:string;metric:string;value:string|null;unit:string;denominator:string|null;period_from:string;period_to:string}[];
  limit:number;offset:number;
}
export function donorMoney(cents:string,currency:string){
  const value=BigInt(cents);return `${currency} ${(value/100n).toLocaleString('en-US')}.${(value%100n).toString().padStart(2,'0')}`;
}
@Component({selector:'app-donor-impact',template:`
  <main class="page stack">
    <header class="page-head"><div><h1>Your Coding in Color impact</h1><p class="lede">Your gifts and published program updates.</p></div>
      @if(api.authenticated()){<button class="btn" type="button" (click)="api.signOut()">Sign out</button>}
    </header>
    @if(!api.authenticated()){
      <p>Use the account Coding in Color invited and linked to your donor record.</p>
      @if(api.status()==='error'){<p class="error" role="alert">Sign-in could not load. Reload this page to try again.</p>}
      <div #auth></div>
    }@else{
      @if(message()){<p class="notice" role="alert">{{message()}}</p>}
      <button class="btn" type="button" [disabled]="busy()" (click)="load()">{{busy()?'Loading...':'Refresh your feed'}}</button>
      @if(feed();as current){
        <section aria-labelledby="gifts-h"><h2 id="gifts-h">Your gifts</h2>
          <ul class="stack">@for(gift of current.gifts;track $index){<li class="panel panel-body">
            <p><time [attr.datetime]="gift.occurred_at">{{date(gift.occurred_at)}}</time> | {{gift.campaign??'General support'}}</p>
            <p>{{money(gift.amount_cents,gift.currency)}} | {{gift.status}}</p>
            @if(gift.refund_cents!=='0'){<p>Refunded {{money(gift.refund_cents,gift.currency)}}</p>}
          </li>}@empty{<li>No gifts recorded on this page.</li>}</ul>
          <nav class="row" aria-label="Gift pages"><button class="btn" [disabled]="busy()||current.offset===0" (click)="load(current.offset-50)">Previous</button>
            <button class="btn" [disabled]="busy()||current.gifts.length<50" (click)="load(current.offset+50)">Next</button></nav>
        </section>
        <section aria-labelledby="outcomes-h"><h2 id="outcomes-h">Published program updates</h2>
          <p>Organization-wide results for programs supported by your settled gifts. These results do not measure the effect of any one gift.</p>
          <ul class="stack">@for(outcome of current.outcomes;track $index){<li class="panel panel-body">
            <h3>{{outcome.program}}</h3><p>{{outcome.metric}}: {{outcome.value??'Not reported'}} {{outcome.unit}}</p>
            @if(outcome.denominator!==null){<p>Out of {{outcome.denominator}}</p>}
            <p>{{outcome.period_from}} to {{outcome.period_to}} (end date excluded)</p>
          </li>}@empty{<li>No program updates have been published for your funded programs.</li>}</ul>
        </section>
      }
    }
  </main>
`})
export class DonorImpactPage{
  protected readonly api=inject(Api);private readonly auth=viewChild<ElementRef<HTMLDivElement>>('auth');
  protected readonly feed=signal<ImpactFeed|null>(null);protected readonly busy=signal(false);protected readonly message=signal('');
  protected readonly money=donorMoney;private generation=0;
  protected date(value:string){return new Intl.DateTimeFormat('en-US',{timeZone:'America/Phoenix',dateStyle:'medium'}).format(new Date(value));}
  constructor(){inject(DestroyRef).onDestroy(()=>this.generation++);effect(onCleanup=>{
    this.api.identityVersion();
    this.generation++;this.feed.set(null);this.message.set('');
    if(this.api.authenticated()){void this.load(0);return;}
    const node=this.auth()?.nativeElement;if(this.api.status()!=='signed-out'||!node)return;
    const signup=new URLSearchParams(location.search).has('__clerk_ticket');
    if(signup)this.api.mountSignUp(node,'/impact');else this.api.mountSignIn(node,'/impact');
    onCleanup(()=>signup?this.api.unmountSignUp(node):this.api.unmountSignIn(node));
  });}
  protected async load(offset=0){
    const version=this.api.identityVersion(),generation=++this.generation;this.busy.set(true);this.message.set('');
    try{const feed=await this.api.request<ImpactFeed>(`/api/v1/impact?limit=50&offset=${Math.max(0,offset)}`);
      if(this.api.authenticated()&&version===this.api.identityVersion()&&generation===this.generation)this.feed.set(feed);
    }catch(error){if(version===this.api.identityVersion()&&generation===this.generation){this.feed.set(null);this.message.set(error instanceof ApiError&&error.status===403
      ?'Your donor account is not enabled. Ask Coding in Color to confirm your verified account link and opt-in.':'Your feed could not load. Please try again.');}}
    finally{if(generation===this.generation)this.busy.set(false);}
  }
}
