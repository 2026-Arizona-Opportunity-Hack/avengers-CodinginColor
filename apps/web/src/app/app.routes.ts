import { inject } from '@angular/core';
import { CanMatchFn, Router, Routes, UrlSegment } from '@angular/router';
import { Store } from './core/store';

/** UI routing only. The API enforces the same rule on every route and query. */
const adminOnly: CanMatchFn = () => inject(Store).isAdmin() || inject(Router).parseUrl('/');
/** Screens whose server routes have not landed yet stay demo-only, so live mode never shows invented data. */
const demoOnly: CanMatchFn = () => !inject(Store).live() || inject(Router).parseUrl('/not-connected');
const overview: CanMatchFn = () => !inject(Store).live() || inject(Router).parseUrl('/donors');

/** Every app screen needs a signed-in member; the server checks again on every request. */
const signedIn: CanMatchFn = (_route, segments: UrlSegment[]) => inject(Store).signedIn()
  || inject(Router).createUrlTree(['/sign-in'], { queryParams: { next: '/' + segments.map((s) => s.path).join('/') } });

export const routes: Routes = [
  { path: 'sign-in', title: 'Sign in · Cadence', loadComponent: () => import('./pages/sign-in').then((m) => m.SignInPage) },
  {
    path: '',
    canMatch: [signedIn],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', title: 'Overview · Cadence', canMatch: [overview], loadComponent: () => import('./pages/overview').then((m) => m.OverviewPage) },
      { path: 'donors', title: 'Donors · Cadence', loadComponent: () => import('./pages/donors').then((m) => m.DonorsPage) },
      { path: 'donors/new', canMatch: [demoOnly], title: 'Add donor · Cadence', loadComponent: () => import('./pages/donor-new').then((m) => m.DonorNewPage) },
      { path: 'donors/:id', title: 'Donor · Cadence', loadComponent: () => import('./pages/donor-detail').then((m) => m.DonorDetailPage) },
      { path: 'donations', canMatch: [demoOnly], title: 'Donations · Cadence', loadComponent: () => import('./pages/donations').then((m) => m.DonationsPage) },
      { path: 'outreach', canMatch: [demoOnly], title: 'Follow-ups · Cadence', loadComponent: () => import('./pages/outreach').then((m) => m.OutreachPage) },
      { path: 'import', title: 'Import · Cadence', canMatch: [adminOnly, demoOnly], loadComponent: () => import('./pages/import').then((m) => m.ImportPage) },
      { path: 'retention', title: 'Retention · Cadence', loadComponent: () => import('./pages/retention').then((m) => m.RetentionPage) },
      { path: 'funders', title: 'Funder reports · Cadence', canMatch: [adminOnly, demoOnly], loadComponent: () => import('./pages/funders').then((m) => m.FundersPage) },
      { path: 'api', title: 'Read API · Cadence', canMatch: [adminOnly, demoOnly], loadComponent: () => import('./pages/api-access').then((m) => m.ApiAccessPage) },
      { path: 'settings', title: 'Settings · Cadence', canMatch: [adminOnly, demoOnly], loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage) },
      { path: 'not-connected', title: 'Not connected yet · Cadence', loadComponent: () => import('./pages/not-connected').then((m) => m.NotConnectedPage) },
      { path: 'account', title: 'Account · Cadence', loadComponent: () => import('./pages/account').then((m) => m.AccountPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
