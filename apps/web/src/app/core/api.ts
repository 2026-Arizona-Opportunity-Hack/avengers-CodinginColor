import { Injectable, signal } from '@angular/core';
import type { Clerk } from '@clerk/clerk-js';
import type { Consent, Role } from './models';

/**
 * Live connection to apps/api. Configured at runtime by /config.json so one build serves
 * demo and production; with no config the app stays in demo mode. Both values are public:
 * a Clerk publishable key is safe in the browser, and the API checks every request.
 */
export interface LiveConfig { apiBase: string; clerkPublishableKey: string; }

export type LiveStatus = 'off' | 'loading' | 'signed-out' | 'ready' | 'error';

export interface ApiMe { id: string; org_id: string; role: Role; }
export interface ApiDonor {
  id: string; org_id: string; owner_id: string | null; name: string; email: string | null; phone: string | null;
  consent: Consent; metadata: Record<string, unknown>; archived_at: string | null;
}
export interface ApiDonorPatch {
  name?: string; email?: string | null; phone?: string | null; consent?: Consent; metadata?: Record<string, unknown>;
}
export interface ApiSegmentTotals { donors: number; prior_cents: number; current_cents: number; }
export interface ApiRetention {
  as_of: string;
  windows: { current: { from: string; to: string }; prior: { from: string; to: string } };
  byCurrency: Record<string, {
    donors: { donor_id: string; segment: string; prior_cents: number; current_cents: number; name: string | null }[];
    segments: Record<string, ApiSegmentTotals>;
    retention: { retained_donors: number; prior_donors: number };
    totals: { prior_cents: number; current_cents: number };
  }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(status === 403 && code === 'admin_mfa_required'
      ? 'Your admin account needs two-step verification. Set up an authenticator, then sign in again to finish.'
      : status === 401 ? 'Your session ended. Sign in again.'
      : status === 403 ? 'You do not have access to that.'
      : status === 404 ? 'That record was not found or is not yours.'
      : status === 429 ? 'Too many requests. Wait a moment and try again.'
      : status === 0 ? 'Cannot reach the server.'
      : status >= 500 ? 'The server is unavailable. Try again shortly.'
      : 'The server rejected the request.');
  }
}

const API_BASE = /^(https:\/\/[^\s/]+|http:\/\/localhost(:\d+)?)?$/;

export async function loadLiveConfig(): Promise<LiveConfig | null> {
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const raw = (await res.json()) as Partial<LiveConfig>;
    const apiBase = typeof raw.apiBase === 'string' ? raw.apiBase.replace(/\/$/, '') : null;
    const key = raw.clerkPublishableKey;
    if (apiBase === null || !API_BASE.test(apiBase) || typeof key !== 'string' || !/^pk_(test|live)_\S+$/.test(key)) return null;
    return { apiBase, clerkPublishableKey: key };
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class Api {
  readonly status = signal<LiveStatus>('off');
  readonly authenticated = signal(false);
  readonly identityVersion = signal(0);
  readonly error = signal<string | null>(null);
  readonly errorCode = signal<'admin_mfa_required' | null>(null);
  private config: LiveConfig | null = null;
  private clerk: Clerk | null = null;
  get baseUrl() { return this.config?.apiBase ?? ''; }

  /** Loads Clerk only in live mode, so demo builds never fetch it. */
  async start(config: LiveConfig, onSignedIn: () => void, onSignedOut: () => void) {
    this.config = config;
    this.status.set('loading');
    try {
      const [{ Clerk }, { ui }] = await Promise.all([import('@clerk/clerk-js'), import('@clerk/ui')]);
      this.clerk = new Clerk(config.clerkPublishableKey);
      await this.clerk.load({ ui, localization: { signIn: { start: { title: 'Sign in to Coding in Color' } } } });
      let sessionId = this.clerk.session?.id ?? null;
      this.authenticated.set(!!sessionId);this.identityVersion.update(v=>v+1);
      if (sessionId) onSignedIn(); else this.status.set('signed-out');
      this.clerk.addListener(({ session }) => {
        const next = session?.id ?? null;
        if (next === sessionId) return;
        const previous=sessionId;sessionId=next;
        this.identityVersion.update(v=>v+1);this.authenticated.set(!!next);
        if(previous)onSignedOut();
        if(next)onSignedIn();else this.status.set('signed-out');
      });
    } catch {
      this.fail('Sign-in could not load. Check the Clerk publishable key in config.json.');
    }
  }

  fail(message: string, code?: string) {
    this.error.set(message);
    this.errorCode.set(code === 'admin_mfa_required' ? code : null);
    this.status.set('error');
  }

  canRetry() { return !!this.clerk?.session; }

  mountSignIn(node: HTMLDivElement, redirect?: string) { this.clerk?.mountSignIn(node, {
    ...(redirect ? {forceRedirectUrl:redirect} : {}),
    appearance: { elements: { rootBox: { width: '100%' }, cardBox: { width: '100%' }, card: { width: '100%' } } },
  }); }
  mountSignUp(node: HTMLDivElement, redirect = '/') { this.clerk?.mountSignUp(node, { routing: 'hash', signInUrl: '/sign-in', forceRedirectUrl: redirect }); }
  unmountSignUp(node: HTMLDivElement) { this.clerk?.unmountSignUp(node); }
  unmountSignIn(node: HTMLDivElement) { this.clerk?.unmountSignIn(node); }
  async signOut() { await this.clerk?.signOut(); }
  manageSecurity() { this.clerk?.openUserProfile({ __experimental_startPath: '/security' }); }
  mountSecurity(node: HTMLDivElement) {
    this.clerk?.mountUserProfile(node, { routing: 'hash', __experimental_startPath: '/security',
      appearance: { elements: { rootBox: { width: '100%' }, cardBox: { width: '100%' }, card: { width: '100%' } } } });
  }
  unmountSecurity(node: HTMLDivElement) { this.clerk?.unmountUserProfile(node); }
  async securityEnrolled() { return (await this.clerk?.user?.reload())?.twoFactorEnabled === true; }

  async request<T>(path: string, init: RequestInit = {}, parse: 'json' | 'blob' = 'json'): Promise<T> {
    if (!this.config || !this.clerk?.session) throw new ApiError(401);
    const token = await this.clerk.session.getToken();
    if (!token) throw new ApiError(401);
    let res: Response;
    try {
      const headers = new Headers(init.headers);
      if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      headers.set('Authorization', `Bearer ${token}`);
      res = await fetch(`${this.config.apiBase}${path}`, {
        ...init,
        credentials: 'omit',
        headers,
      });
    } catch {
      throw new ApiError(0);
    }
    if (!res.ok) {
      const error = await res.json().catch(() => null);
      throw new ApiError(res.status, error?.code === 'admin_mfa_required' ? error.code : undefined);
    }
    return (parse === 'blob' ? res.blob() : res.json()) as Promise<T>;
  }

  me() { return this.request<ApiMe>('/api/v1/me'); }

  /** Every donor this member may see. The API caps a page at 100, so this pages until done. */
  async allDonors(includeArchived = false): Promise<ApiDonor[]> {
    const all: ApiDonor[] = [];
    for (const archived of includeArchived ? [false, true] : [false]) for (let offset = 0; ; offset += 100) {
      const page = await this.request<{ items: ApiDonor[] }>(`/api/v1/donors?limit=100&offset=${offset}${archived ? '&archived=true' : ''}`);
      all.push(...page.items);
      if (page.items.length < 100) break;
    }
    return all;
  }

  patchDonor(id: string, patch: ApiDonorPatch) {
    return this.request<ApiDonor>(`/api/v1/donors/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  archiveDonor(id: string) {
    return this.request<ApiDonor>(`/api/v1/donors/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  }

  retention(asOf: string, filters: Partial<Record<'from' | 'programId' | 'ownerId' | 'campaignId' | 'cohort', string>> = {}) {
    return this.request<ApiRetention>(`/api/v1/reports/retention?${new URLSearchParams({ asOf, ...filters })}`);
  }
}
