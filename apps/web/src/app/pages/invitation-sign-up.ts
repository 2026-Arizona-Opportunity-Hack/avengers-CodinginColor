import { Component,ElementRef,effect,inject,viewChild } from '@angular/core';
import { Router,RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Store } from '../core/store';
@Component({selector:'app-invitation-sign-up',imports:[RouterLink],template:`
  <main class="page stack"><h1>Accept your Coding in Color invitation</h1>
    @if(api.status()==='error'){<p class="error" role="alert">{{api.error()}}</p>
      @if(api.canRetry()){<button class="btn" (click)="api.manageSecurity()">Manage account security</button><button class="btn" (click)="store.refreshLive()">Retry access</button>}
    }@else{<div #signup></div>}
    <a routerLink="/sign-in">Already have an account? Sign in</a>
  </main>
`})
export class InvitationSignUpPage{
  protected readonly api=inject(Api);protected readonly store=inject(Store);private readonly router=inject(Router);
  private readonly signup=viewChild<ElementRef<HTMLDivElement>>('signup');
  constructor(){effect(onCleanup=>{
    if(this.api.status()==='ready'){void this.router.navigateByUrl('/');return;}
    const node=this.signup()?.nativeElement;if(this.api.status()!=='signed-out'||!node)return;
    this.api.mountSignUp(node);onCleanup(()=>this.api.unmountSignUp(node));
  });}
}
