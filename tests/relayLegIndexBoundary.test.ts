/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * User decision E20 (2026-10-16): `relayStrokeForIndex` throws `InvalidRelayLegIndexError` for a
 * leg index that names no leg. Callers that hold an index from stored data must not crash the
 * lineup, and must not swallow the problem. This file pins each such boundary:
 *
 *  - `simulateRoster` leaves a relay with a fifth named leg on a medley as recorded;
 *  - `rankRelayLegSwaps` skips that relay;
 *  - `suggestRelayAlternatePromotions` and `suggestQuickFillForVacantLeg` skip a bad stored index;
 *  - the lineup audit names the bad relay and the bad stored override
 *    (`relay_leg_index_invalid`), and names nothing for a well-formed relay.
 *
 * Every name, team and time is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type RelayLegOverride, type SwimmerResult } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { simulateRoster } from '../packages/core/src/lib/utils';
import { issueBadgeLabel, buildTeamLineupAudit, suggestQuickFillForVacantLeg } from '../packages/core/src/lib/rosterLineupAudit';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { stableRelayEntryKey } from '../packages/core/src/lib/relayLegMatching';
import { workspaceFixture } from './helpers/typedFixtures';

const TEAM = 'Home';
const EVENT = 'Event 31 Men 4x50 Yard Medley Relay';
const CLOCK = '1:41.00';

const relayLegs = (names: string[]): SwimmerResult[] =>
  names.map(
    (name, i) =>
      ({
        id: `${names[0]}-${i}`,
        rank: 1,
        name,
        classYear: 'FR',
        team: TEAM,
        time: CLOCK,
        finalsTime: CLOCK,
        relayTeamTime: CLOCK,
        roundSwam: 'A Final',
        points: 0,
        event: EVENT,
        gender: Gender.MEN,
        isRelay: true,
        relayLegIndex: i,
        relayLegSplit: '25.00',
        relayNames: names.map(n => ({ name: n, year: 'FR' })),
      }) as SwimmerResult
  );

const FOUR = ['A1', 'A2', 'A3', 'A4'];
const FIVE = ['B1', 'B2', 'B3', 'B4', 'B5'];

const fixtureOf = (
  results: SwimmerResult[],
  overrides: RelayLegOverride[] = [],
  scorerRosterOverrides: { name: string; team: string; gender: Gender; isScorer: boolean }[] = []
) =>
  workspaceFixture({
    id: 'ws',
    name: 'boundary',
    createdAt: 0,
    menResults: results,
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: overrides,
    conference: 'NSISC',
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    scorerRosterOverrides,
  });

const auditItems = (results: SwimmerResult[], overrides: RelayLegOverride[] = []) => {
  const ws = fixtureOf(results, overrides);
  return buildTeamLineupAudit({
    workspace: ws,
    gender: Gender.MEN,
    team: TEAM,
    settings: NSISC_PRESET_SETTINGS,
    allResults: results,
    allScored: results,
    removeSeniors: false,
    detectDuplicates: false,
  }).checklistItems.filter(i => i.type === 'relay_leg_index_invalid');
};

describe('simulateRoster with a fifth named leg on a medley relay', () => {
  const results = relayLegs(FIVE);

  it('does not throw, and leaves the relay as recorded', () => {
    const out = simulateRoster(results, [], false, new Set(['b2']), []);
    expect(out.map(r => r.name)).toStrictEqual(FIVE);
    expect(out.every(r => r.relayMissingLeg === undefined && r.relayLegVacant !== true)).toBe(true);
    expect(out.map(r => r.time)).toStrictEqual(FIVE.map(() => CLOCK));
  });

  it('a well-formed relay beside it is still projected', () => {
    const both = [...relayLegs(FOUR), ...results];
    const out = simulateRoster(both, [], false, new Set(['a2', 'b2']), []);
    const a = out.filter(r => r.isRelay && FOUR.includes(r.relayNames?.[0]?.name ?? ''));
    expect(a.some(r => r.relayLegVacant === true)).toBe(true);
  });
});

describe('the lineup audit names a bad leg index', () => {
  it('a relay with a fifth named leg on a medley: one item, in plain words', () => {
    const items = auditItems(relayLegs(FIVE));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ group: 'relays', relayEvent: EVENT });
    expect(items[0]?.message).toContain('names 5 legs');
  });

  it('a stored override for a leg that does not exist: one item with the key and the index', () => {
    const results = relayLegs(FOUR);
    const key = stableRelayEntryKey(results, results[0] as SwimmerResult);
    const bad: RelayLegOverride = { relayEntryKey: key, legIndex: -1, assigneeName: 'Z', source: 'manual' };
    const items = auditItems(results, [bad]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ relayEvent: EVENT, legIndex: -1, relayEntryKey: key });
  });

  it('a well-formed relay and a good override name nothing', () => {
    const results = relayLegs(FOUR);
    const key = stableRelayEntryKey(results, results[0] as SwimmerResult);
    const good: RelayLegOverride = { relayEntryKey: key, legIndex: 1, assigneeName: 'Z', source: 'manual' };
    expect(auditItems(results, [good])).toStrictEqual([]);
  });

  it('has a badge label', () => {
    expect(issueBadgeLabel({ type: 'relay_leg_index_invalid', message: '' })).toBe('Relay leg');
  });
});

describe('the swap ranking and the quick fill skip a relay with a bad leg index', () => {
  it('rankRelayLegSwaps does not throw for a fifth leg on a medley whose fifth leg is a non-scorer', () => {
    // B5 is off the scoring roster, so the ranking tries to replace leg 5. A medley has no fifth
    // stroke, so the whole relay is skipped.
    const ws = fixtureOf(relayLegs(FIVE), [], [{ name: 'B5', team: TEAM, gender: Gender.MEN, isScorer: false }]);
    const ranking = rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: NSISC_PRESET_SETTINGS });
    expect(ranking.swaps).toStrictEqual([]);
    expect(ranking.legsWithoutBaseline).toBeUndefined();
  });

  it('suggestQuickFillForVacantLeg returns no suggestion for an index that names no leg', () => {
    const results = relayLegs(FOUR);
    const ws = fixtureOf(results);
    const key = stableRelayEntryKey(results, results[0] as SwimmerResult);
    expect(suggestQuickFillForVacantLeg(ws, Gender.MEN, TEAM, key, 9, [])).toBeNull();
    expect(suggestQuickFillForVacantLeg(ws, Gender.MEN, TEAM, key, -1, [])).toBeNull();
  });
});
