/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The relay-leg swap ranking reads the leg rows of the relay it is ranking,
 * not those of a relay that ties it (improvement plan 2026-10-10, advisor
 * follow-up of 2026-10-13; the `legRowsForTemplate` signature filter survived a
 * mutation in the review of ddb838fb).
 *
 * ## Why this test exists
 *
 * One team's A and B relays can share event, round, place and clock. Their leg
 * rows then share every field the swap ranking filters on, and only the named
 * swimmers tell the two relays apart. `legRowsForTemplate` keeps a row only
 * when it names no swimmers or names the template's swimmers. Without that,
 * the leg row looked up for a leg index is the first row of either relay, so
 * the swap showed the other relay's leg split as the time of the swimmer going
 * out.
 *
 * Real rows: `tests/fixtures/nsisc-2026-relay-followups-r1.json`. Henderson
 * State's 4x100 Free Relay A won the A final (3:02.81); Scott Doll swam leg 2
 * in 49.05. The real data holds no tied pair of one team's relays, so the
 * second relay is derived from the real one: same event, round, place and
 * clock, four other names, and a leg split of 42.00 on leg 2. It is placed in
 * `menResults` BEFORE the real relay, so a lookup that ignores the swimmers
 * finds its row first.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type ScoringSettings,
  type SwimmerResult,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { relayEntryLegSignature } from '../packages/core/src/lib/utils';
import { workspaceFixture } from './helpers/typedFixtures';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };

const HSU = 'Henderson State University';
const EVENT = 'Event 42 Men 4x100 Yard Freestyle Relay';
const LEG = 2;
/** Legs of an A/B final are not auto-eligible, so a non-scorer's vacated leg costs the relay. */
const STRICT: ScoringSettings = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
};

const realLegs = fixture.menResults.filter(
  r => r.isRelay && r.team === HSU && r.event === EVENT && r.rank === 1
);
const SIBLING_NAMES = ['Sib One', 'Sib Two', 'Sib Three', 'Sib Four'];
const sibling: SwimmerResult[] = realLegs.map((r, i) => ({
  ...r,
  id: `derived-sibling-${i}`,
  name: SIBLING_NAMES[i]!,
  relayLegSplit: i === LEG ? '42.00' : r.relayLegSplit,
  relayLegSplitDetail: undefined,
  relayNames: SIBLING_NAMES.map(name => ({ name, year: 'FR' })),
}));

function rank(menResults: SwimmerResult[]) {
  const ws = workspaceFixture({
    id: 'ws-tied-leg-rows',
    name: 'tied leg rows',
    createdAt: 0,
    menResults,
    womenResults: fixture.womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    conference: 'NSISC',
    scoringSettings: STRICT,
    scorerRosterOverrides: [{ name: 'Scott Doll', team: HSU, gender: Gender.MEN, isScorer: false }],
  });
  return rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: STRICT });
}

const firstReal = fixture.menResults.indexOf(realLegs[0]!);
const siblingFirst = [
  ...fixture.menResults.slice(0, firstReal),
  ...sibling,
  ...fixture.menResults.slice(firstReal),
];
const realSignature = relayEntryLegSignature(realLegs[0]!);

describe('the tied relay used by this test', () => {
  it('shares event, round, place and clock with the real relay, and names other swimmers', () => {
    expect(realLegs.map(r => [r.name, r.relayLegIndex, r.relayLegSplit])).toStrictEqual([
      ['Colin Candebat', 0, '44.32'],
      ['Vitor Sa', 1, '45.09'],
      ['Scott Doll', 2, '49.05'],
      ['Oliver Pozvai', 3, '44.35'],
    ]);
    expect(realLegs[0]!.relayTeamTime).toBe('3:02.81');
    expect(relayEntryLegSignature(sibling[0]!)).not.toBe(realSignature);
    expect(sibling[0]!.relayTeamTime).toBe(realLegs[0]!.relayTeamTime);
  });
});

describe('rankRelayLegSwaps on a tied pair of relays', () => {
  it('without the tie, the swap out of Scott Doll shows his leg split, 49.05', () => {
    const swaps = rank(fixture.menResults).swaps.filter(s => s.relayEvent === EVENT && s.legIndex === LEG);
    expect(swaps.length).toBeGreaterThan(0);
    expect(new Set(swaps.map(s => s.outTime))).toStrictEqual(new Set(['49.05']));
  });

  it("with the tie, the swap out of the real relay shows that relay's leg split, not the other relay's", () => {
    const swaps = rank(siblingFirst).swaps.filter(
      s => s.relayEvent === EVENT && s.legIndex === LEG && s.relayEntryKey.endsWith(`|${realSignature}`)
    );
    expect(swaps.length).toBeGreaterThan(0);
    expect(new Set(swaps.map(s => s.outAthlete))).toStrictEqual(new Set(['Scott Doll']));
    expect(new Set(swaps.map(s => s.outTime))).toStrictEqual(new Set(['49.05']));
  });

  it('the order of the two relays in the results does not change the answer', () => {
    const siblingLast = [...fixture.menResults, ...sibling];
    const pick = (menResults: SwimmerResult[]) =>
      rank(menResults)
        .swaps.filter(s => s.relayEvent === EVENT && s.legIndex === LEG)
        .map(s => `${s.outAthlete} ${s.outTime} ${s.inAthlete}`)
        .sort();
    expect(pick(siblingFirst)).toStrictEqual(pick(siblingLast));
  });
});
