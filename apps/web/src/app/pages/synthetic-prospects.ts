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
  { id: 'sample-cedar', name: 'Cedar Finch', kind: 'Person', ownerId: 'm-bell',
    interests: ['Youth coding', 'Mentoring'], giving: [
      { recipient: 'Lantern Code Collective', cause: 'Youth coding', amountCents: 60000, date: '2026-07-18' },
    ] },
  { id: 'sample-prism', name: 'Prism Meadow Fund', kind: 'Organization', ownerId: 'm-bell',
    interests: ['STEM access', 'Digital inclusion'], giving: [
      { recipient: 'Copper Kite Science Center', cause: 'STEM access', amountCents: 350000, date: '2025-11-20' },
    ] },
  { id: 'sample-juniper', name: 'Juniper Cove', kind: 'Person', ownerId: 'm-bell',
    interests: ['AI education', 'Teacher support'], giving: [
      { recipient: 'Little Galaxy Learning Guild', cause: 'AI education', amountCents: 95000, date: '2026-02-16' },
    ] },
  { id: 'sample-marigold', name: 'Marigold Finch', kind: 'Person', ownerId: 'm-ortiz',
    interests: ['Summer learning', 'Youth coding'], giving: [
      { recipient: 'Sunbeam Discovery Camp', cause: 'Summer learning', amountCents: 45000, date: '2026-05-02' },
    ] },
  { id: 'sample-lattice', name: 'Lattice Lantern Trust', kind: 'Organization', ownerId: 'm-ortiz',
    interests: ['STEM access', 'Youth coding'], giving: [
      { recipient: 'Pebble Path Robotics', cause: 'STEM access', amountCents: 800000, date: '2026-01-27' },
      { recipient: 'Lantern Code Collective', cause: 'Youth coding', amountCents: 150000, date: '2025-09-14' },
    ] },
  { id: 'sample-tobin', name: 'Tobin Fern', kind: 'Person', ownerId: 'm-ortiz',
    interests: ['AI education', 'Digital inclusion'], giving: [
      { recipient: 'Silver Acorn AI Lab', cause: 'AI education', amountCents: 180000, date: '2026-09-05' },
    ] },
  { id: 'sample-kite', name: 'Blue Kite Cooperative', kind: 'Organization', ownerId: 'm-ortiz',
    interests: ['Youth coding', 'Mentoring'], giving: [
      { recipient: 'Willow Byte Workshop', cause: 'Youth coding', amountCents: 275000, date: '2025-12-11' },
    ] },
  { id: 'sample-sage', name: 'Sage Bramble', kind: 'Person', ownerId: 'm-okoro',
    interests: ['STEM access', 'Digital inclusion'], giving: [
      { recipient: 'Copper Kite Science Center', cause: 'STEM access', amountCents: 85000, date: '2026-06-23' },
    ] },
  { id: 'sample-beacon', name: 'Beacon Thistle Foundation', kind: 'Organization', ownerId: 'm-okoro',
    interests: ['Summer learning', 'Mentoring'], giving: [
      { recipient: 'Sunbeam Discovery Camp', cause: 'Summer learning', amountCents: 625000, date: '2026-04-29' },
    ] },
  { id: 'sample-rowan', name: 'Rowan Drift', kind: 'Person', ownerId: 'm-okoro',
    interests: ['Youth coding', 'AI education'], giving: [
      { recipient: 'Willow Byte Workshop', cause: 'Youth coding', amountCents: 125000, date: '2026-08-07' },
    ] },
  { id: 'sample-fernlight', name: 'Fernlight Design Group', kind: 'Organization', ownerId: 'm-okoro',
    interests: ['AI education', 'Teacher support'], giving: [
      { recipient: 'Silver Acorn AI Lab', cause: 'AI education', amountCents: 400000, date: '2025-10-24' },
    ] },
  { id: 'sample-hazel', name: 'Hazel Meridian', kind: 'Person', ownerId: 'm-park',
    interests: ['Summer learning', 'Youth coding'], giving: [
      { recipient: 'Summer Sparks', cause: 'Summer learning', amountCents: 55000, date: '2026-05-19' },
    ] },
  { id: 'sample-nimbus', name: 'Nimbus Orchard Fund', kind: 'Organization', ownerId: 'm-park',
    interests: ['AI education', 'STEM access'], giving: [
      { recipient: 'Open Robot Workshop', cause: 'AI education', amountCents: 900000, date: '2026-03-09' },
    ] },
  { id: 'sample-ellis', name: 'Ellis Wildflower', kind: 'Person', ownerId: 'm-park',
    interests: ['Youth coding', 'Digital inclusion'], giving: [
      { recipient: 'Tomorrow Lab', cause: 'Youth coding', amountCents: 72500, date: '2025-12-03' },
    ] },
  { id: 'sample-ember', name: 'Ember Atlas Partners', kind: 'Organization', ownerId: 'm-park',
    interests: ['STEM access', 'Summer learning'], giving: [
      { recipient: 'Neighborhood Compute', cause: 'STEM access', amountCents: 450000, date: '2026-07-30' },
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
