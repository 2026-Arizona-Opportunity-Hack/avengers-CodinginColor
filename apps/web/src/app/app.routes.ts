import { inject } from '@angular/core';
import { CanMatchFn, Router, Routes } from '@angular/router';
import { Store } from './core/store';

/** UI routing only. The API enforces the same rule on every route and query. */
const adminOnly: CanMatchFn = () => inject(Store).isAdmin() || inject(Router).parseUrl('/');

export const routes: Routes = [
  { path: '', title: 'Overview · Cadence', loadComponent: () => import('./pages/overview').then((m) => m.OverviewPage) },
  { path: 'donors', title: 'Donors · Cadence', loadComponent: () => import('./pages/donors').then((m) => m.DonorsPage) },
  { path: 'donors/new', title: 'Add donor · Cadence', loadComponent: () => import('./pages/donor-new').then((m) => m.DonorNewPage) },
  { path: 'donors/:id', title: 'Donor · Cadence', loadComponent: () => import('./pages/donor-detail').then((m) => m.DonorDetailPage) },
  { path: 'donations', title: 'Donations · Cadence', loadComponent: () => import('./pages/donations').then((m) => m.DonationsPage) },
  { path: 'outreach', title: 'Outreach · Cadence', loadComponent: () => import('./pages/outreach').then((m) => m.OutreachPage) },
  { path: 'import', title: 'Import · Cadence', canMatch: [adminOnly], loadComponent: () => import('./pages/import').then((m) => m.ImportPage) },
  { path: 'retention', title: 'Retention · Cadence', loadComponent: () => import('./pages/retention').then((m) => m.RetentionPage) },
  { path: 'funders', title: 'Funder reports · Cadence', canMatch: [adminOnly], loadComponent: () => import('./pages/funders').then((m) => m.FundersPage) },
  { path: 'api', title: 'Read API · Cadence', canMatch: [adminOnly], loadComponent: () => import('./pages/api-access').then((m) => m.ApiAccessPage) },
  { path: 'settings', title: 'Settings · Cadence', canMatch: [adminOnly], loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage) },
  { path: '**', redirectTo: '' },
];
