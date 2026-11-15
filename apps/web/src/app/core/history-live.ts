import type { Campaign, Communication, Gift, Program } from './models';
import type { Request } from './outreach-live';

interface Contact {
  id: string; donor_id: string; draft_id: string | null; channel: 'email' | 'sms' | 'call' | 'meeting';
  status: string; occurred_at: string; actor_id: string; note: string | null; subject: string | null; body: string | null;
}
async function all<T>(request: Request, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await request<{ items: T[] }>(`${path}?limit=100&offset=${offset}`);
    items.push(...page.items);
    if (page.items.length < 100) return items;
  }
}
export const loadGifts = (request: Request) => all<Gift>(request, '/api/v1/gifts');
export async function loadContacts(request: Request): Promise<Communication[]> {
  return (await all<Contact>(request, '/api/v1/communications')).map(c => ({
    id: c.id, donor_id: c.donor_id, member_id: c.actor_id, kind: c.channel === 'sms' ? 'text' : c.channel,
    direction: 'outbound', summary: `${c.status === 'failed' ? 'Failed: ' : ''}${c.subject || c.note?.split('\n')[0] || c.channel}`,
    body: c.body ?? c.note ?? '', occurred_at: c.occurred_at, draft_id: c.draft_id, status: c.status,
  }));
}
export async function loadCatalog(request: Request) {
  const catalog = await request<{ programs: Program[]; campaigns: Array<{ id: string; title: string; program_id: string | null }> }>('/api/v1/catalog');
  return { programs: catalog.programs, campaigns: catalog.campaigns.map(c => ({ ...c, starts_on: '', location: '' } as Campaign)) };
}
export const logContact = (request: Request, donor: string, channel: string, occurred_at: string, note: string) =>
  request(`/api/v1/donors/${encodeURIComponent(donor)}/communications`, {
    method: 'POST', body: JSON.stringify({ channel: channel === 'text' ? 'sms' : channel, occurred_at, note }),
  });
