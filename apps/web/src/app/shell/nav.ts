/** Navigation model shared by the sidebar, the mobile drawer and the command palette. */
export interface NavItem {
  path: string;
  label: string;
  icon: string;
  /** Admin-only screen; the API enforces the same rule. */
  admin?: boolean;
  exact?: boolean;
  /** Has live server routes (#59); other screens are hidden in live mode. */
  live?: boolean;
}
export interface NavGroup { label: string; items: NavItem[]; }

export const NAV: NavGroup[] = [
  { label: 'Workspace', items: [
    { path: '/', label: 'Overview', icon: 'lucideLayoutDashboard', exact: true, live: true },
    { path: '/donors', label: 'Donors', icon: 'lucideUsers', live: true },
    { path: '/ask', label: 'Ask your data', icon: 'lucideSearch', live: true },
    { path: '/donations', label: 'Donations', icon: 'lucideHandCoins', live: true },
    { path: '/outreach', label: 'Follow-ups', icon: 'lucideSend', live: true },
  ] },
  { label: 'Insights', items: [
    { path: '/retention', label: 'Retention', icon: 'lucideRepeat', live: true },
    { path: '/funders', label: 'Funder reports', icon: 'lucideFileText', admin: true, live: true },
  ] },
  { label: 'Data', items: [
    { path: '/import', label: 'Import', icon: 'lucideUpload', admin: true, live: true },
    { path: '/api', label: 'Read API', icon: 'lucideKeyRound', admin: true, live: true },
    { path: '/settings', label: 'Settings', icon: 'lucideSettings', admin: true, live: true },
  ] },
];
