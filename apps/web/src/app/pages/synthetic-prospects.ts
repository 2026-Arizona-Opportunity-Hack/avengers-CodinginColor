// Entirely fictional external giving for the demo; never imported into the CIC gift ledger.
export interface SyntheticProspect {
  id: string;
  name: string;
  kind: 'Person' | 'Organization';
  ownerId: string;
  interests: string[];
  giving: { recipient: string; cause: string; amountCents: number; date: string }[];
}

export const SYNTHETIC_PROSPECTS: SyntheticProspect[] = [
  { id: 'sample-aster', name: 'Aster Vale', kind: 'Person', ownerId: 'm-bell',
    interests: ['Youth coding', 'STEM access'], giving: [
      { recipient: 'Bright Circuit Club', cause: 'STEM access', amountCents: 75000, date: '2026-04-12' },
      { recipient: 'Tomorrow Lab', cause: 'Youth coding', amountCents: 25000, date: '2025-10-03' },
    ] },
  { id: 'sample-mosaic', name: 'Mosaic Comet Foundation', kind: 'Organization', ownerId: 'm-ortiz',
    interests: ['Youth coding', 'Summer learning'], giving: [
      { recipient: 'Summer Sparks', cause: 'Summer learning', amountCents: 500000, date: '2026-06-01' },
    ] },
  { id: 'sample-robin', name: 'Robin Quill', kind: 'Person', ownerId: 'm-okoro',
    interests: ['AI education', 'STEM access'], giving: [
      { recipient: 'Open Robot Workshop', cause: 'AI education', amountCents: 120000, date: '2026-03-22' },
    ] },
  { id: 'sample-orbit', name: 'Paper Orbit Studio', kind: 'Organization', ownerId: 'm-park',
    interests: ['STEM access'], giving: [
      { recipient: 'Neighborhood Compute', cause: 'STEM access', amountCents: 200000, date: '2026-08-14' },
    ] },
  { id: 'sample-wren', name: 'Wren Solstice', kind: 'Person', ownerId: 'm-bell',
    interests: ['Community arts'], giving: [
      { recipient: 'Painted Lantern', cause: 'Community arts', amountCents: 30000, date: '2026-02-09' },
    ] },
];

const PROGRAM_INTERESTS: Record<string, string> = {
  'Youth coding': 'Summer Camp', 'Summer learning': 'Summer Camp',
  'AI education': 'AI Academy', 'STEM access': 'Day of Compute',
};

export function illustrativeMatches(prospect: SyntheticProspect): string[] {
  return prospect.giving.flatMap(gift => prospect.interests.includes(gift.cause) && PROGRAM_INTERESTS[gift.cause]
    ? [`Giving to ${gift.recipient} (${gift.cause}) and the ${gift.cause} interest overlap with CIC's ${PROGRAM_INTERESTS[gift.cause]} program.`]
    : []);
}
