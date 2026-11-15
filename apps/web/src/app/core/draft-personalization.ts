import type { Dataset, Donor, Template } from './models';

type Context = Pick<Dataset, 'gifts' | 'campaigns' | 'communications' | 'outcomes' | 'programs'>;

/** Local facts only; communication bodies and internal notes never enter outgoing copy. */
export function personalizeDraft(template: Template, donor: Donor | null, context: Context,
  extra: Record<string, string> = {}, asOf = new Date().toISOString()): { subject: string; body: string } {
  const gift = donor ? context.gifts.filter((g) => g.donor_id === donor.id && g.status === 'settled'
    && g.amount_cents > g.refund_cents && Date.parse(g.occurred_at) <= Date.parse(asOf))
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0] : undefined;
  const campaign = context.campaigns.find((c) => c.id === gift?.campaign_id);
  const date = (value: string) => new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix',
  }).format(new Date(value));
  const amount = gift ? new Intl.NumberFormat('en-US', { style: 'currency', currency: gift.currency })
    .format((gift.amount_cents - gift.refund_cents) / 100) : '';
  const communication = donor ? context.communications.filter((c) => c.donor_id === donor.id
    && c.direction !== 'internal' && ['email', 'text', 'call', 'meeting'].includes(c.kind)
    && (!c.status || ['sent', 'logged', 'delivered', 'received'].includes(c.status))
    && Date.parse(c.occurred_at) <= Date.parse(asOf))
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0] : undefined;
  // Only known structured program interests are safe to reuse, never arbitrary custom prose.
  const interest = context.programs.find((p) => p.title === donor?.custom['interests']);
  const facts = campaign?.program_id ? context.outcomes.filter((o) => o.program_id === campaign.program_id
    && o.approved && o.value !== null && o.year <= new Date(asOf).getUTCFullYear()) : [];
  const year = Math.max(...facts.map((o) => o.year));
  const program = context.programs.find((p) => p.id === campaign?.program_id);
  const vars: Record<string, string> = {
    first_name: donor ? (donor.kind === 'individual' ? donor.name.trim().split(/\s+/)[0] : donor.name) : '',
    amount: amount || 'your support', campaign: campaign?.title ?? 'Coding in Color',
    gift_date: gift ? date(gift.occurred_at) : '',
    gift_context: gift ? `Thank you for your ${amount} net gift on ${date(gift.occurred_at)}${campaign ? ` to ${campaign.title}` : ''}.` : 'Thank you for staying connected with Coding in Color.',
    history_context: communication ? `Our records include ${communication.direction === 'inbound' ? 'your' : 'our'} ${communication.kind} on ${date(communication.occurred_at)}.` : '',
    interest_context: interest ? `You listed ${interest.title} as a program interest. Would you like an update about it?` : '',
    program_facts: facts.filter((o) => o.year === year).map((o) => `${program?.title} (${o.year}), program-wide: ${o.metric}: ${o.value}.`).join('\n'),
    ...extra,
  };
  const fill = (s: string) => s.replace(/{{(\w+)}}/g, (_, key: string) => vars[key] ?? `{{${key}}}`)
    .replace(/\n{3,}/g, '\n\n');
  return { subject: fill(template.subject), body: fill(template.body) };
}
