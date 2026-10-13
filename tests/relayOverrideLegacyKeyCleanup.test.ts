/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Editing and reporting an override of a tied relay sees the key saved before
 * A and B were told apart (improvement plan 2026-10-10, advisor follow-up of
 * 2026-10-13).
 *
 * ## Why this test exists
 *
 * A team's tied A and B relays share event, round, place and clock. Since
 * ddb838fb an override of a tied relay is stored under a key that also names
 * the relay's swimmers, and `findRelayLegOverride` still reads the plain key
 * saved before that, for both relays. `removeRelayLegOverride` and
 * `upsertRelayLegOverride` compared exact keys, so "clear leg" on a tied relay
 * left the plain key in place and the leg stayed overridden. The "Clear
 * override" button in the relay card looked for the exact key too and did not
 * show for a leg that only had the plain key.
 *
 * Real data holds no tied relay of one team, so the relays are synthetic, in
 * the shape `relayOverrideTieKey.test.ts` builds.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type RelayLegOverride, type SwimmerResult } from '../packages/core/src/types';
import { simulateRoster } from '../packages/core/src/lib/utils';
import {
  findRelayLegOverride,
  hasRelayLegOverride,
  relayTemplateFromLeg,
  removeRelayLegOverride,
  stableRelayEntryKey,
  upsertRelayLegOverride,
} from '../packages/core/src/lib/relayLegMatching';

const TEAM = 'Home';
const EVENT = 'Event 31 Men 4x50 Yard Freestyle Relay';
const CLOCK = '1:21.00';
const LEG = 1;
const OTHER_LEG = 2;

const relayLegs = (names: string[], clock = CLOCK, round = 'A Final', rank = 2): SwimmerResult[] =>
  names.map(
    (name, i) =>
      ({
        id: `${round}-${names[0]}-${i}`,
        rank,
        name,
        classYear: 'FR',
        team: TEAM,
        time: clock,
        finalsTime: clock,
        relayTeamTime: clock,
        roundSwam: round,
        points: 0,
        event: EVENT,
        gender: Gender.MEN,
        isRelay: true,
        relayLegIndex: i,
        relayLegStroke: 'free',
        relayLegSplit: '20.00',
        relayNames: names.map(n => ({ name: n, year: 'FR' })),
      }) as SwimmerResult
  );

const fifty = (name: string, time: string): SwimmerResult =>
  ({
    id: `ind-${name}`,
    rank: 1,
    name,
    classYear: 'FR',
    team: TEAM,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event: 'Event 8 Men 50 Yard Freestyle',
    gender: Gender.MEN,
  }) as SwimmerResult;

const A = ['A1', 'A2', 'A3', 'A4'];
const B = ['B1', 'B2', 'B3', 'B4'];
const C = ['C1', 'C2', 'C3', 'C4'];
const tied = [...relayLegs(A), ...relayLegs(B)];
const untied = relayLegs(C, '1:30.00', 'B Final', 9);
const individuals = [fifty('X1', '20.00'), fifty('Y1', '20.50')];
const results = [...tied, ...untied, ...individuals];

const aLeg = tied.find(r => r.name === 'A2') as SwimmerResult;
const bLeg = tied.find(r => r.name === 'B2') as SwimmerResult;
const cLeg = untied.find(r => r.name === 'C2') as SwimmerResult;
const aKey = stableRelayEntryKey(results, aLeg);
const bKey = stableRelayEntryKey(results, bLeg);
const cKey = stableRelayEntryKey(results, cLeg);
const plainKey = `${TEAM}|${EVENT}|A Final|2|${CLOCK}`;

const at = (key: string, legIndex: number, assigneeName: string): RelayLegOverride => ({
  relayEntryKey: key,
  legIndex,
  assigneeName,
  source: 'manual',
});

describe('the keys', () => {
  it('a tied relay key is its plain key plus the swimmers; an untied relay key is plain', () => {
    expect(aKey).not.toBe(bKey);
    expect(aKey.startsWith(`${plainKey}|`)).toBe(true);
    expect(bKey.startsWith(`${plainKey}|`)).toBe(true);
    expect(cKey).toBe(`${TEAM}|${EVENT}|B Final|9|1:30.00`);
  });
});

describe('upsertRelayLegOverride', () => {
  const legacy = at(plainKey, LEG, 'X1');
  const legacyOtherLeg = at(plainKey, OTHER_LEG, 'Y1');
  const bOwn = at(bKey, LEG, 'Y1');
  const cOwn = at(cKey, LEG, 'Y1');
  const next = at(aKey, LEG, 'Y1');

  it("replaces the plain key's override of the leg instead of leaving both", () => {
    expect(upsertRelayLegOverride([legacy], next)).toStrictEqual([next]);
  });

  it("keeps the sibling's own override, the other leg's override and another relay's override", () => {
    const out = upsertRelayLegOverride([legacy, legacyOtherLeg, bOwn, cOwn], next);
    expect(out).toStrictEqual([legacyOtherLeg, bOwn, cOwn, next]);
  });

  it('still replaces an override under the exact same key', () => {
    const own = at(aKey, LEG, 'X1');
    expect(upsertRelayLegOverride([own], next)).toStrictEqual([next]);
  });

  it('an untied relay key is unchanged: it replaces only its own key and leg', () => {
    const cNext = at(cKey, LEG, 'X1');
    expect(upsertRelayLegOverride([cOwn, legacy], cNext)).toStrictEqual([legacy, cNext]);
  });

  it('the cleared leg does not come back from the plain key afterwards', () => {
    const wrote = upsertRelayLegOverride([legacy], next);
    const cleared = removeRelayLegOverride(wrote, aKey, LEG);
    expect(findRelayLegOverride(cleared, relayTemplateFromLeg(tied, aLeg), LEG, tied)).toBeUndefined();
  });
});

describe('removeRelayLegOverride', () => {
  const legacy = at(plainKey, LEG, 'X1');
  const legacyOtherLeg = at(plainKey, OTHER_LEG, 'Y1');
  const aOwn = at(aKey, LEG, 'X1');
  const bOwn = at(bKey, LEG, 'Y1');
  const cOwn = at(cKey, LEG, 'Y1');

  it("drops the plain key's override of a tied relay's leg", () => {
    expect(removeRelayLegOverride([legacy], aKey, LEG)).toStrictEqual([]);
  });

  it('drops both the plain and the own key of that leg', () => {
    expect(removeRelayLegOverride([legacy, aOwn], aKey, LEG)).toStrictEqual([]);
  });

  it("keeps the sibling's own override, the other legs and another relay's override", () => {
    const out = removeRelayLegOverride([legacy, legacyOtherLeg, aOwn, bOwn, cOwn], aKey, LEG);
    expect(out).toStrictEqual([legacyOtherLeg, bOwn, cOwn]);
  });

  it('an untied relay key removes only its own key and leg, as before', () => {
    expect(removeRelayLegOverride([legacy, cOwn], cKey, LEG)).toStrictEqual([legacy]);
  });

  it('a key that only starts with the plain key text is another relay, not a tied one', () => {
    // A clock of 1:21.001 would read as 1:21.00 followed by more text.
    const otherRelay = `${plainKey}1`;
    expect(removeRelayLegOverride([legacy], otherRelay, LEG)).toStrictEqual([legacy]);
    expect(hasRelayLegOverride([legacy], otherRelay, LEG)).toBe(false);
    expect(upsertRelayLegOverride([legacy], at(otherRelay, LEG, 'Y1'))).toStrictEqual([
      legacy,
      at(otherRelay, LEG, 'Y1'),
    ]);
  });

  it('the plain key itself removes only the plain key', () => {
    expect(removeRelayLegOverride([legacy, aOwn, bOwn], plainKey, LEG)).toStrictEqual([aOwn, bOwn]);
  });

  it('end to end: after "clear leg" the leg of the tied relay is vacant, not X1', () => {
    const left = new Set(['a2']);
    const before = simulateRoster(results, [], false, left, [legacy]);
    expect(before.some(r => r.isRelay && r.name === 'X1' && r.relayLegIndex === LEG)).toBe(true);
    const cleared = removeRelayLegOverride([legacy], aKey, LEG);
    const after = simulateRoster(results, [], false, left, cleared);
    expect(after.some(r => r.isRelay && r.name === 'X1')).toBe(false);
    expect(after.filter(r => r.isRelay && r.relayLegIndex === LEG && r.relayLegVacant === true)).toHaveLength(1);
  });
});

describe('hasRelayLegOverride', () => {
  const legacy = at(plainKey, LEG, 'X1');
  const aOwn = at(aKey, LEG, 'X1');
  const bOwn = at(bKey, LEG, 'Y1');
  const states: [string, RelayLegOverride[]][] = [
    ['none', []],
    ['plain key only', [legacy]],
    ['own key of A only', [aOwn]],
    ['own key of B only', [bOwn]],
    ['plain and own key of A', [legacy, aOwn]],
    ['another leg only', [at(plainKey, OTHER_LEG, 'X1')]],
  ];

  it('answers what findRelayLegOverride finds, for the key of A and of B', () => {
    for (const [label, overrides] of states) {
      for (const [leg, key] of [
        [aLeg, aKey],
        [bLeg, bKey],
      ] as const) {
        const template = relayTemplateFromLeg(tied, leg);
        const found = findRelayLegOverride(overrides, template, LEG, tied) !== undefined;
        expect(hasRelayLegOverride(overrides, key, LEG), `${label} / ${leg.name}`).toBe(found);
      }
    }
  });

  it('is true for the plain key on a tied relay (the indicator the card read missed it)', () => {
    expect(hasRelayLegOverride([legacy], aKey, LEG)).toBe(true);
    expect(hasRelayLegOverride([legacy], bKey, LEG)).toBe(true);
  });

  it('is false for another leg, another relay and an own key of the sibling', () => {
    expect(hasRelayLegOverride([legacy], aKey, OTHER_LEG)).toBe(false);
    expect(hasRelayLegOverride([legacy], cKey, LEG)).toBe(false);
    expect(hasRelayLegOverride([bOwn], aKey, LEG)).toBe(false);
  });

  it('agrees with removeRelayLegOverride: an override it reports is one clearing removes', () => {
    for (const [, overrides] of states) {
      const has = hasRelayLegOverride(overrides, aKey, LEG);
      const cleared = removeRelayLegOverride(overrides, aKey, LEG);
      expect(cleared.length < overrides.length).toBe(has);
    }
  });
});
