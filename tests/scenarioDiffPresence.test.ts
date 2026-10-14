/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Scenario diff: "absent from a snapshot" is not "scored 0 points".
 *
 * `pointsThen` / `pointsNow` stay numbers for old callers and read 0 for an
 * absent side. `inThen` / `inNow` carry the truth. Every fixture here pairs
 * a swimmer, event or team that is present at 0 points (a real 4th place under
 * 5/3/1) with one that is absent, so a flag derived from `points > 0` or
 * forced to `true` fails a case.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type Workspace } from '@omniswim/core/types';
import { computeScenarioDiff } from '@omniswim/core/lib/scenarioDiff';

const MEN = Gender.MEN;
const A_FINAL = 'A Final';
const SETTINGS = {
  scoringPoints: [5, 3, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
};
const OPTS = { team: 'HSU', gender: MEN, settings: SETTINGS };

let seq = 0;
function swim(name: string, team: string, event: string, time: string, rank: number) {
  seq += 1;
  return {
    id: `r${seq}`,
    rank,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    roundSwam: A_FINAL,
  };
}

function workspace(menResults: Record<string, unknown>[]): Workspace {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    scoringSettings: SETTINGS,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
  } as unknown as Workspace;
}

function relayLegs(team: string, event: string, teamTime: string, rank: number, names: string[]) {
  return names.map((name, i) => ({
    ...swim(name, team, event, teamTime, rank),
    isRelay: true,
    finalsTime: teamTime,
    relayTeamTime: teamTime,
    relayLegIndex: i,
  }));
}

/** Three RIV swimmers take places 1-3 so an HSU swimmer behind them scores 0. */
function rivalsAhead(event: string): Record<string, unknown>[] {
  return [
    swim(`Rival One ${event}`, 'RIV', event, '20.00', 1),
    swim(`Rival Two ${event}`, 'RIV', event, '21.00', 2),
    swim(`Rival Three ${event}`, 'RIV', event, '22.00', 3),
  ];
}

// Snapshot A: Zed is 4th in 200 Free (present at 0). Quin is 4th in 400 Free
// at 4:00.00 (present at 0). Alice wins 100 Free (5).
const THEN = workspace([
  swim('Alice Adams', 'HSU', '100 Free', '50.00', 1),
  ...rivalsAhead('200 Free'),
  swim('Zed Zero', 'HSU', '200 Free', '1:59.00', 4),
  ...rivalsAhead('400 Free'),
  swim('Quin Quick', 'HSU', '400 Free', '4:00.00', 4),
]);

// Snapshot B: Zed is gone. Quin is still 4th in 400 Free but swims 3:59.00.
// Alice is unchanged.
const NOW = workspace([
  swim('Alice Adams', 'HSU', '100 Free', '50.00', 1),
  ...rivalsAhead('200 Free'),
  ...rivalsAhead('400 Free'),
  swim('Quin Quick', 'HSU', '400 Free', '3:59.00', 4),
]);

describe('computeScenarioDiff: absent is not zero', () => {
  const diff = computeScenarioDiff(NOW, THEN, OPTS);
  const swimmer = (name: string) => diff.swimmers.find(s => s.name === name);
  const event = (name: string) => diff.events.find(e => e.event === name);

  it('scores the present-at-zero rows, so the fixture can tell present from absent', () => {
    const quin = swimmer('Quin Quick');
    expect(quin).toBeDefined();
    expect(quin?.pointsThen).toBe(0);
    expect(quin?.pointsNow).toBe(0);
    expect(swimmer('Alice Adams')).toBeUndefined();
  });

  describe('swimmer rows', () => {
    it('marks a swimmer removed in B as present then, absent now, both at 0 points', () => {
      const zed = swimmer('Zed Zero');
      expect(zed).toBeDefined();
      expect(zed?.pointsThen).toBe(0);
      expect(zed?.pointsNow).toBe(0);
      expect(zed?.inThen).toBe(true);
      expect(zed?.inNow).toBe(false);
      expect(zed?.eventsRemoved).toEqual(['200 Free']);
    });

    it('marks a swimmer present on both sides at 0 points as present on both', () => {
      const quin = swimmer('Quin Quick');
      expect(quin?.inThen).toBe(true);
      expect(quin?.inNow).toBe(true);
      expect(quin?.eventsChanged).toEqual([
        { event: '400 Free', timeThen: '4:00.00', timeNow: '3:59.00' },
      ]);
    });

    it('marks a relay row the team entered only in A as present then, absent now', () => {
      const legs = ['Una', 'Vera', 'Wren', 'Xia'];
      const withRelay = workspace([
        swim('Alice Adams', 'HSU', '100 Free', '50.00', 1),
        ...relayLegs('HSU', '200 Free Relay', '1:30.00', 1, legs),
      ]);
      const withoutRelay = workspace([swim('Alice Adams', 'HSU', '100 Free', '50.00', 1)]);
      const row = computeScenarioDiff(withoutRelay, withRelay, OPTS).swimmers.find(
        s => s.isRelay
      );
      expect(row).toBeDefined();
      expect(row?.name).toBe('200 Free Relay');
      expect(row?.inThen).toBe(true);
      expect(row?.inNow).toBe(false);
      expect(row?.eventsRemoved).toEqual(['200 Free Relay']);
    });

    it('flips the flags when the two snapshots swap', () => {
      const flipped = computeScenarioDiff(THEN, NOW, OPTS);
      const zed = flipped.swimmers.find(s => s.name === 'Zed Zero');
      expect(zed?.inThen).toBe(false);
      expect(zed?.inNow).toBe(true);
      expect(zed?.eventsAdded).toEqual(['200 Free']);
    });
  });

  describe('event rows', () => {
    it('marks an event the team dropped as present then, absent now, both at 0 points', () => {
      const e = event('200 Free');
      expect(e).toBeDefined();
      expect(e?.pointsThen).toBe(0);
      expect(e?.pointsNow).toBe(0);
      expect(e?.inThen).toBe(true);
      expect(e?.inNow).toBe(false);
    });

    it('marks an event present on both sides at 0 points as present on both', () => {
      const e = event('400 Free');
      expect(e).toBeDefined();
      expect(e?.pointsThen).toBe(0);
      expect(e?.pointsNow).toBe(0);
      expect(e?.inThen).toBe(true);
      expect(e?.inNow).toBe(true);
    });
  });

  describe('team totals', () => {
    it('marks a team with rows scoring 0 as present, and one with no rows as absent', () => {
      // HSU's only swimmer is 4th, so the team total is a real 0.
      const zeroTeam = workspace([...rivalsAhead('200 Free'), swim('Zed Zero', 'HSU', '200 Free', '1:59.00', 4)]);
      const noTeam = workspace([...rivalsAhead('200 Free')]);

      const added = computeScenarioDiff(zeroTeam, noTeam, OPTS);
      expect(added.totals.then).toBe(0);
      expect(added.totals.now).toBe(0);
      expect(added.totals.inThen).toBe(false);
      expect(added.totals.inNow).toBe(true);

      const removed = computeScenarioDiff(noTeam, zeroTeam, OPTS);
      expect(removed.totals.inThen).toBe(true);
      expect(removed.totals.inNow).toBe(false);
    });

    it('marks both sides absent when neither snapshot has the team', () => {
      const noTeam = workspace([...rivalsAhead('200 Free')]);
      const none = computeScenarioDiff(noTeam, noTeam, OPTS);
      expect(none.totals).toEqual({
        then: 0,
        now: 0,
        delta: 0,
        inThen: false,
        inNow: false,
      });
      expect(none.swimmers).toEqual([]);
      expect(none.events).toEqual([]);
    });

    it('marks both sides present for a team that has a scoring total', () => {
      expect(diff.totals.inThen).toBe(true);
      expect(diff.totals.inNow).toBe(true);
      expect(diff.totals.then).toBe(5);
      expect(diff.totals.now).toBe(5);
    });
  });
});
