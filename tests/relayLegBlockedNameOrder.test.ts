/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A relay leg named "Last, First" blocks the same swimmer's "First Last" row from
 * a second leg of the same relay (identity R3, finding A9).
 *
 * `listEligibleRelayLegCandidates` took its blocked names from `relayLegNameKeys`,
 * which uses the comma-order-preserving key, and tested each candidate with the
 * same key. A leg spelled "Akin, Bartu" therefore did not block the row "Bartu
 * Akin", and one swimmer could be offered for two legs of one relay. The check now
 * reads both sides through `canonicalSwimmerName`. The callers' keys are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import {
  listEligibleRelayLegCandidates,
  relayLegNameKeys,
  resolveOverrideAssignee,
  suggestBestRelayLegFill,
} from '../packages/core/src/lib/relayLegMatching';
import { swimmerResult } from './helpers/typedFixtures';

const TEAM = 'Henderson State University';
const RELAY = 'Event 31 Men 4x50 Yard Freestyle Relay';

const swim = (id: string, name: string, time: string) =>
  swimmerResult({
    id,
    rank: 1,
    name,
    classYear: 'SO',
    team: TEAM,
    time,
    points: 0,
    event: 'Event 8 Men 50 Yard Freestyle',
    gender: Gender.MEN,
  });

const pool = [
  swim('a', 'Bartu Akin', '20.10'),
  swim('b', 'Riley Adams', '21.50'),
  swim('c', 'Cam Mask', '22.00'),
];

const relay = swimmerResult({
  id: 'r',
  rank: 1,
  name: 'Henderson State University',
  classYear: 'unknown',
  team: TEAM,
  time: '1:25.00',
  points: 0,
  event: RELAY,
  gender: Gender.MEN,
  isRelay: true,
  relayNames: [
    { name: 'Akin, Bartu', year: 'SO' },
    { name: 'Dan Other', year: 'SO' },
  ],
});

describe('relay leg blocked-name check is order-insensitive', () => {
  it('a leg named "Akin, Bartu" blocks the row "Bartu Akin" from another leg', () => {
    const assigned = relayLegNameKeys(relay);
    expect([...assigned]).toContain('akin, bartu'); // the caller's key keeps comma order
    const names = listEligibleRelayLegCandidates(pool, RELAY, 1, assigned, TEAM, Gender.MEN).map(s => s.name);
    expect(names).not.toContain('Bartu Akin');
    // Unrelated swimmers are unaffected, fastest first.
    expect(names).toStrictEqual(['Riley Adams', 'Cam Mask']);
  });

  it('the same blocked name in "First Last" order still blocks (no regression)', () => {
    const names = listEligibleRelayLegCandidates(pool, RELAY, 1, new Set(['bartu akin']), TEAM, Gender.MEN).map(
      s => s.name
    );
    expect(names).toStrictEqual(['Riley Adams', 'Cam Mask']);
  });

  it('with nobody blocked, all three are offered', () => {
    const names = listEligibleRelayLegCandidates(pool, RELAY, 1, new Set(), TEAM, Gender.MEN).map(s => s.name);
    expect(names).toStrictEqual(['Bartu Akin', 'Riley Adams', 'Cam Mask']);
  });

  it('autofill does not put the "Akin, Bartu" leg swimmer on a second leg', () => {
    const fill = suggestBestRelayLegFill(pool, relay, 1, new Set(), new Set());
    expect(fill?.swimmer.name).toBe('Riley Adams');
  });

  it('an override assigned to "Akin, Bartu" resolves to the row "Bartu Akin"; an unrelated override still resolves to its own row', () => {
    const base = { relayEntryKey: 'k', legIndex: 1, source: 'manual' } as const;
    const hit = resolveOverrideAssignee({ ...base, assigneeName: 'Akin, Bartu' }, pool, TEAM, RELAY, 1, Gender.MEN);
    expect(hit?.name).toBe('Bartu Akin');
    const other = resolveOverrideAssignee({ ...base, assigneeName: 'Riley Adams' }, pool, TEAM, RELAY, 1, Gender.MEN);
    expect(other?.name).toBe('Riley Adams');
    const nobody = resolveOverrideAssignee({ ...base, assigneeName: 'Nobody, Real' }, pool, TEAM, RELAY, 1, Gender.MEN);
    expect(nobody).toBeNull();
  });
});
