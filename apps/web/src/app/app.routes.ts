import { inject } from '@angular/core';
import { CanMatchFn, Router, Routes, UrlSegment } from '@angular/router';
import { Store } from './core/store';

/** UI routing only. The API enforces the same rule on every route and query. */
const adminOnly: CanMatchFn = () => inject(Store).isAdmin() || inject(Router).parseUrl('/');
/** Screens whose server routes have not landed yet stay demo-only, so live mode never shows invented data. */
const demoOnly: CanMatchFn = () => !inject(Store).live() || inject(Router).parseUrl('/not-connected');

/** Every app screen needs a signed-in member; the server checks again on every request. */
const signedIn: CanMatchFn = (_route, segments: UrlSegment[]) => inject(Store).signedIn()
  || inject(Router).createUrlTree(['/sign-in'], { queryParams: { next: '/' + segments.map((s) => s.path).join('/') } });

export const routes: Routes = [
  { path: 'sign-up', title: 'Accept invitation', loadComponent: () => import('./pages/invitation-sign-up').then(m => m.InvitationSignUpPage) },
  { path: 'sign-in', title: 'Sign in · Coding in Color', loadComponent: () => import('./pages/sign-in').then((m) => m.SignInPage) },
  {
    path: '',
    canMatch: [signedIn],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', title: 'Overview · Coding in Color', loadComponent: () => import('./pages/overview').then((m) => m.OverviewPage) },
      { path: 'donors', title: 'Donors · Coding in Color', loadComponent: () => import('./pages/donors').then((m) => m.DonorsPage) },
      { path: 'donors/new', title: 'Add donor · Coding in Color', loadComponent: () => import('./pages/donor-new').then((m) => m.DonorNewPage) },
      { path: 'donors/:id', title: 'Donor · Coding in Color', loadComponent: () => import('./pages/donor-detail').then((m) => m.DonorDetailPage) },
      { path: 'donations', title: 'Donations · Coding in Color', loadComponent: () => import('./pages/donations').then((m) => m.DonationsPage) },
      { path: 'outreach', title: 'Follow-ups · Coding in Color', loadComponent: () => import('./pages/outreach').then((m) => m.OutreachPage) },
      { path: 'import', title: 'Import · Coding in Color', canMatch: [adminOnly], loadComponent: () => import('./pages/import').then((m) => m.ImportPage) },
      { path: 'retention', title: 'Retention · Coding in Color', loadComponent: () => import('./pages/retention').then((m) => m.RetentionPage) },
      { path: 'funders', title: 'Funder reports · Coding in Color', canMatch: [adminOnly], loadComponent: () => import('./pages/funders').then((m) => m.FundersPage) },
      { path: 'api', title: 'Read API · Coding in Color', canMatch: [adminOnly], loadComponent: () => import('./pages/api-access').then((m) => m.ApiAccessPage) },
      { path: 'settings', title: 'Settings · Coding in Color', canMatch: [adminOnly], loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage) },
      { path: 'not-connected', title: 'Not connected yet · Coding in Color', loadComponent: () => import('./pages/not-connected').then((m) => m.NotConnectedPage) },
      { path: 'account', title: 'Account · Coding in Color', loadComponent: () => import('./pages/account').then((m) => m.AccountPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
