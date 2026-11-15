import {
  Campaign, Communication, Dataset, Donor, DonorKind, Draft, FollowUp, Gift, Member, Outcome, Source, Template,
} from './models';

/**
 * Deterministic, entirely fictional demo dataset anchored at 2026-11-15.
 * Emails use example.org and phones use the reserved 555-01xx range.
 */
export const DATASET_VERSION = 3;
export const ANCHOR = '2026-11-15';

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (day: string, hour = 15) => `${day}T${String(hour).padStart(2, '0')}:00:00-07:00`;
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const MEMBERS: Member[] = [
  { id: 'm-ceo', name: 'Dana Whitfield', email: 'dana@cic.example.org', role: 'admin', title: 'Founder & CEO', active: true },
  { id: 'm-pm', name: 'Priya Raman', email: 'priya@cic.example.org', role: 'admin', title: 'Program Manager', active: true },
  { id: 'm-bell', name: 'Marcus Bell', email: 'marcus@board.example.org', role: 'board', title: 'Board member', active: true },
  { id: 'm-ortiz', name: 'Elena Ortiz', email: 'elena@board.example.org', role: 'board', title: 'Board member', active: true },
  { id: 'm-okoro', name: 'Sam Okoro', email: 'sam@board.example.org', role: 'board', title: 'Board member', active: true },
  { id: 'm-park', name: 'Lena Park', email: 'lena@board.example.org', role: 'board', title: 'Board treasurer', active: true },
];
const BOARD = MEMBERS.filter((m) => m.role === 'board').map((m) => m.id);

const PROGRAMS = [
  { id: 'p-ai', title: 'AI Academy' },
  { id: 'p-camp', title: 'Summer Camp' },
  { id: 'p-doc', title: 'Day of Compute' },
];

const CAMPAIGNS: Campaign[] = [
  { id: 'c-gt24', title: 'Giving Tuesday 2024', program_id: null, starts_on: '2024-12-03', location: 'Online' },
  { id: 'c-azg25', title: 'AZ Gives 2025', program_id: null, starts_on: '2025-04-08', location: 'Online' },
  { id: 'c-camp25', title: 'Summer Camp 2025', program_id: 'p-camp', starts_on: '2025-06-09', location: 'Mesa' },
  { id: 'c-doc25', title: 'Day of Compute 2025', program_id: 'p-doc', starts_on: '2025-10-18', location: 'Phoenix' },
  { id: 'c-gt25', title: 'Giving Tuesday 2025', program_id: null, starts_on: '2025-12-02', location: 'Online' },
  { id: 'c-ai26', title: 'AI Academy Fund 2026', program_id: 'p-ai', starts_on: '2026-01-12', location: 'Tempe' },
  { id: 'c-azg26', title: 'AZ Gives 2026', program_id: null, starts_on: '2026-04-07', location: 'Online' },
  { id: 'c-camp26', title: 'Summer Camp 2026', program_id: 'p-camp', starts_on: '2026-06-08', location: 'Mesa' },
  { id: 'c-doc26', title: 'Day of Compute 2026', program_id: 'p-doc', starts_on: '2026-10-17', location: 'Phoenix' },
];

const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Rowan', 'Skyler', 'Emerson', 'Finley',
  'Harper', 'Jules', 'Noel', 'Reese', 'Sage', 'Tatum', 'Blair', 'Dakota', 'Hollis', 'Marlowe', 'Parker', 'Remy',
  'Sasha', 'Wren', 'Ari', 'Bowie', 'Cruz', 'Ellis', 'Indy', 'Kai', 'Lane', 'Milan'];
const LAST = ['Rivera', 'Chen', 'Okafor', 'Nguyen', 'Patel', 'Garcia', 'Kim', 'Haddad', 'Silva', 'Novak', 'Mensah',
  'Ortega', 'Brooks', 'Yazzie', 'Delgado', 'Fischer', 'Tran', 'Abara', 'Lindqvist', 'Morales', 'Sato', 'Begay'];
const EMPLOYERS = ['Copperline Energy', 'Mesa Ridge Labs', 'Sonoran Health', 'Paloverde Bank', 'Cholla Systems',
  'Red Butte Logistics', null, null, null];
const ORGS: Array<[string, DonorKind]> = [
  ['Copperline Energy', 'company'], ['Mesa Ridge Labs', 'company'], ['Paloverde Bank', 'company'],
  ['Cholla Systems', 'company'], ['Saguaro Community Foundation', 'foundation'],
  ['Desert Light Foundation', 'foundation'], ['Valley Tech Fund', 'foundation'], ['Sonoran Health', 'company'],
];

type Pattern = 'new' | 'reactivated' | 'increased' | 'flat' | 'decreased' | 'lapsed' | 'dormant' | 'loyal';
const PATTERNS: Pattern[] = ['loyal', 'increased', 'new', 'decreased', 'lapsed', 'flat', 'reactivated', 'loyal', 'dormant', 'increased', 'new', 'lapsed'];

/** [day, campaign] pairs per year so gifts land inside their campaign season. */
const SEASON: Record<number, Array<[string, string | null]>> = {
  2023: [['2023-04-04', null], ['2023-06-20', null], ['2023-11-28', null]],
  2024: [['2024-04-02', null], ['2024-07-15', null], ['2024-12-03', 'c-gt24']],
  2025: [['2025-04-08', 'c-azg25'], ['2025-06-12', 'c-camp25'], ['2025-10-18', 'c-doc25'], ['2025-12-02', 'c-gt25']],
  2026: [['2026-01-20', 'c-ai26'], ['2026-04-07', 'c-azg26'], ['2026-06-10', 'c-camp26'], ['2026-10-17', 'c-doc26'], ['2026-11-09', 'c-doc26']],
};

const YEARS_BY_PATTERN: Record<Pattern, Array<[number, number]>> = {
  // [year, amount multiplier]
  loyal: [[2023, 1], [2024, 1], [2025, 1], [2026, 1]],
  increased: [[2024, 1], [2025, 1], [2026, 2]],
  new: [[2026, 1]],
  decreased: [[2024, 1], [2025, 2], [2026, 1]],
  lapsed: [[2024, 1], [2025, 1]],
  flat: [[2025, 1], [2026, 1]],
  reactivated: [[2023, 1], [2026, 1]],
  dormant: [[2023, 1]],
};

const SOURCES: Source[] = ['spreadsheet', 'zeffy', 'benevity', 'az_gives', 'zeffy', 'spreadsheet', 'united_way'];

const TEMPLATES: Template[] = [
  {
    id: 't-thanks-email', name: 'Thank you for your gift', purpose: 'thank_you', channel: 'email',
    subject: 'Thank you, {{first_name}}',
    body: 'Hi {{first_name}},\n\nThank you for your gift of {{amount}} to {{campaign}}. It goes straight to students learning to build with technology in Phoenix.\n\nI will send you a short update on what your support made possible this quarter.\n\nWith gratitude,\n{{owner_name}}\nCoding in Color',
  },
  {
    id: 't-thanks-text', name: 'Thank you (text)', purpose: 'thank_you', channel: 'text',
    subject: '',
    body: 'Hi {{first_name}}, it is {{owner_name}} from Coding in Color. Your {{amount}} gift to {{campaign}} just came through. Thank you. Students will feel this one.',
  },
  {
    id: 't-quarterly', name: 'Quarterly update', purpose: 'quarterly', channel: 'email',
    subject: '{{quarter}} at Coding in Color',
    body: 'Hi {{first_name}},\n\nA short update for {{quarter}}:\n\n- AI Academy: students completed their capstone projects.\n- Day of Compute: our largest event yet in Phoenix.\n- Summer Camp: registration opens in the spring.\n\nThe full report is attached. Thank you for being part of this.\n\n{{owner_name}}\nCoding in Color',
  },
  {
    id: 't-nudge', name: 'We miss you', purpose: 'nudge', channel: 'email',
    subject: 'What your support built last year',
    body: 'Hi {{first_name}},\n\nLast year your gift helped students in our programs. I would love to show you what happened since, and invite you to our next event.\n\nCould we find 15 minutes this month?\n\n{{owner_name}}\nCoding in Color',
  },
  {
    id: 't-digest', name: 'Board assignment digest', purpose: 'assignment_digest', channel: 'email',
    subject: 'Your donors for {{quarter}}',
    body: 'Hi {{first_name}},\n\nYou are the contact for {{donor_count}} donors this quarter. {{open_count}} have an open next step. Your list is in Coding in Color under Donors.\n\nThank you for carrying these relationships.\nDana',
  },
];

export function buildDemoDataset(): Dataset {
  const r = rng(20261115);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const donors: Donor[] = [];
  const gifts: Gift[] = [];
  const comms: Communication[] = [];
  const followUps: FollowUp[] = [];
  const drafts: Draft[] = [];
  const load = new Map<string, number>(BOARD.map((id) => [id, 0]));
  let g = 0, c = 0, f = 0;

  const assign = () => {
    const min = Math.min(...load.values());
    const owner = BOARD.find((id) => load.get(id) === min)!;
    load.set(owner, min + 1);
    return owner;
  };

  const people = 40;
  for (let i = 0; i < people + ORGS.length; i++) {
    const isOrg = i >= people;
    const [orgName, orgKind] = isOrg ? ORGS[i - people] : ['', 'individual' as DonorKind];
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const name = isOrg ? orgName : `${first} ${last}`;
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
    const pattern = isOrg ? (['loyal', 'increased', 'flat', 'lapsed'] as Pattern[])[i % 4] : PATTERNS[i % PATTERNS.length];
    const base = isOrg ? (2 + Math.floor(r() * 8)) * 250000 : [2500, 5000, 10000, 15000, 25000, 50000, 100000][Math.floor(r() * 7)];
    const owner = assign();
    const firstYear = YEARS_BY_PATTERN[pattern][0][0];
    const id = `d-${String(i + 1).padStart(3, '0')}`;
    const primarySource = isOrg ? 'spreadsheet' : SOURCES[i % SOURCES.length];
    const donor: Donor = {
      id, name,
      email: isOrg ? `grants@${slug.replace(/\./g, '')}.example.org` : `${slug}@example.org`,
      phone: isOrg ? null : `602-555-01${String(i).padStart(2, '0')}`,
      company: isOrg ? null : pick(EMPLOYERS),
      kind: orgKind,
      owner_id: owner,
      consent: r() < 0.82 ? 'granted' : 'unknown',
      preferred_channel: !isOrg && r() < 0.3 ? 'text' : 'email',
      created_at: iso(`${firstYear}-01-15`),
      archived_at: null,
      sources: [primarySource],
      custom: {},
    };
    if (!isOrg && r() < 0.18) donor.sources.push(primarySource === 'zeffy' ? 'benevity' : 'zeffy');
    if (!isOrg && i % 9 === 0) donor.custom['employer_match'] = 'Yes';
    if (!isOrg && i % 5 === 0) donor.custom['interests'] = pick(['AI Academy', 'Summer Camp', 'Mentoring', 'Day of Compute']);
    donors.push(donor);

    for (const [year, mult] of YEARS_BY_PATTERN[pattern]) {
      const season = SEASON[year];
      const count = isOrg ? 1 : 1 + Math.floor(r() * Math.min(2, season.length));
      const start = Math.floor(r() * (season.length - count + 1));
      for (let k = 0; k < count; k++) {
        const [day, campaign] = season[start + k];
        const amount = Math.round((base * mult) / count / 100) * 100;
        const recentPending = day === '2026-11-09' && k === count - 1 && i % 6 === 0;
        g++;
        gifts.push({
          id: `g-${String(g).padStart(4, '0')}`, donor_id: id,
          campaign_id: campaign ?? (isOrg ? pick(['c-ai26', 'c-camp25', 'c-doc25']) : null),
          amount_cents: amount, refund_cents: i === 13 && year === 2025 ? amount : 0, currency: 'USD',
          occurred_at: iso(addDays(day, Math.floor(r() * 4))), status: recentPending ? 'pending' : 'settled',
          source: isOrg ? 'spreadsheet' : donor.sources[k % donor.sources.length],
          external_id: isOrg ? null : `${donor.sources[0].slice(0, 3).toUpperCase()}-${10000 + g}`,
        });
      }
    }

    const theirGifts = gifts.filter((x) => x.donor_id === id && x.status === 'settled');
    for (const gift of theirGifts.slice(-2)) {
      c++;
      comms.push({
        id: `cm-${c}`, donor_id: id, member_id: owner, kind: donor.preferred_channel, direction: 'outbound',
        summary: 'Thank-you sent', body: `Thanked ${first} for their gift.`,
        occurred_at: iso(addDays(gift.occurred_at.slice(0, 10), 2), 10), draft_id: null,
      });
    }
    if (r() < 0.55) {
      c++;
      const kind = pick(['call', 'meeting', 'text'] as const);
      comms.push({
        id: `cm-${c}`, donor_id: id, member_id: owner, kind, direction: kind === 'text' ? 'inbound' : 'outbound',
        summary: kind === 'meeting' ? 'Coffee at Day of Compute' : kind === 'call' ? 'Check-in call' : 'Replied to quarterly update',
        body: kind === 'meeting'
          ? 'Talked about the AI Academy capstone. Interested in mentoring. Not ready to increase giving yet.'
          : kind === 'call' ? 'Asked about employer matching. Will check with HR.' : '"Love seeing the students\' projects. Count me in for Summer Camp."',
        occurred_at: iso(addDays('2026-10-20', Math.floor(r() * 24)), 11), draft_id: null,
      });
    }
    if (pattern !== 'dormant' && r() < 0.7) {
      f++;
      const action = pick([
        'Invite to Day of Compute debrief', 'Send AI Academy capstone video', 'Ask about employer match',
        'Schedule coffee before Giving Tuesday', 'Share Summer Camp 2027 sponsorship deck', 'Call to say thank you',
      ]);
      followUps.push({
        id: `f-${f}`, donor_id: id, owner_id: owner, kind: 'next_step', action,
        due_on: addDays(ANCHOR, Math.floor(r() * 40) - 12), status: 'open',
        created_at: iso('2026-10-28'), completed_at: null,
      });
    }
    if (pattern === 'lapsed' && !isOrg) {
      f++;
      followUps.push({
        id: `f-${f}`, donor_id: id, owner_id: owner, kind: 'next_step', action: 'Re-engage: gave in 2025, not yet in 2026',
        due_on: addDays(ANCHOR, 3 + (i % 9)), status: 'open', created_at: iso('2026-11-01'), completed_at: null,
      });
    }
  }

  // Recent gifts that still need a thank-you: system drafts, human approves and sends.
  const recent = gifts.filter((x) => x.occurred_at >= '2026-11-01' && x.status !== 'void');
  const firstName = (d: Donor) => (d.kind === 'individual' ? d.name.split(' ')[0] : d.name);
  for (const gift of recent.slice(0, 6)) {
    const donor = donors.find((d) => d.id === gift.donor_id)!;
    const owner = MEMBERS.find((m) => m.id === donor.owner_id)!;
    const t = TEMPLATES.find((x) => x.purpose === 'thank_you' && x.channel === donor.preferred_channel)!;
    const campaign = CAMPAIGNS.find((x) => x.id === gift.campaign_id)?.title ?? 'Coding in Color';
    const amount = `$${(gift.amount_cents / 100).toLocaleString('en-US')}`;
    const fill = (s: string) => s.replace(/{{first_name}}/g, firstName(donor)).replace(/{{amount}}/g, amount)
      .replace(/{{campaign}}/g, campaign).replace(/{{owner_name}}/g, owner.name.split(' ')[0]);
    drafts.push({
      id: `dr-${drafts.length + 1}`, donor_id: donor.id, recipient_member_id: null, owner_id: owner.id,
      template_id: t.id, channel: t.channel, to: (t.channel === 'text' ? donor.phone : donor.email) ?? '',
      subject: fill(t.subject), body: fill(t.body),
      reason: `${amount} gift on ${gift.occurred_at.slice(0, 10)}${gift.status === 'pending' ? ' (pending settlement)' : ''}`,
      status: 'pending', created_at: iso(addDays(gift.occurred_at.slice(0, 10), 1), 8),
      approved_by: null, approved_at: null, sent_by: null, sent_at: null,
    });
  }
  // Sent history: earlier drafts that were approved and sent by a person.
  for (const comm of comms.filter((x) => x.summary === 'Thank-you sent').slice(-8)) {
    const donor = donors.find((d) => d.id === comm.donor_id)!;
    const id = `dr-${drafts.length + 1}`;
    comm.draft_id = id;
    drafts.push({
      id, donor_id: donor.id, recipient_member_id: null, owner_id: comm.member_id,
      template_id: comm.kind === 'text' ? 't-thanks-text' : 't-thanks-email', channel: comm.kind === 'text' ? 'text' : 'email',
      to: (comm.kind === 'text' ? donor.phone : donor.email) ?? '', subject: `Thank you, ${firstName(donor)}`,
      body: comm.body, reason: 'Gift received', status: 'sent', created_at: comm.occurred_at,
      approved_by: comm.member_id, approved_at: comm.occurred_at, sent_by: comm.member_id, sent_at: comm.occurred_at,
    });
  }

  const outcomes: Outcome[] = [];
  const metrics: Array<[string, string, number[]]> = [
    ['p-ai', 'Students enrolled', [38, 52, 71]], ['p-ai', 'Capstone projects shipped', [21, 33, 49]],
    ['p-camp', 'Campers served', [60, 84, 96]], ['p-camp', 'Scholarships awarded', [18, 30, 41]],
    ['p-doc', 'Attendees', [140, 220, 310]], ['p-doc', 'Volunteer mentors', [22, 35, 48]],
  ];
  for (const [program, metric, values] of metrics) {
    values.forEach((value, k) => outcomes.push({
      program_id: program, year: 2024 + k, metric,
      value: program === 'p-doc' && k === 2 && metric === 'Volunteer mentors' ? null : value, approved: true,
    }));
  }

  return {
    version: DATASET_VERSION,
    members: MEMBERS,
    donors,
    programs: PROGRAMS,
    campaigns: CAMPAIGNS,
    gifts,
    communications: comms,
    followUps,
    templates: TEMPLATES,
    drafts,
    outcomes,
    apiKeys: [{
      id: 'k-1', label: 'CIC org dashboard', prefix: 'cic_live_7Hq2', created_at: iso('2026-11-02'),
      created_by: 'm-ceo', last_used_at: iso('2026-11-14', 9), revoked_at: null,
    }],
    customFields: [
      { key: 'employer_match', label: 'Employer match', type: 'select', options: ['Yes', 'No', 'Unknown'] },
      { key: 'interests', label: 'Program interest', type: 'text', options: [] },
    ],
    audit: [],
    assignmentCursor: 0,
  };
}
