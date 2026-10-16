/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D9, departed-leg baseline: a time-trial swim is not the baseline of a departed relay leg unless
 * `ScoringSettings.relayLegsAllowTimeTrials` is on. `findDepartedLegSwim` is the one lookup behind both
 * `simulateRoster` (the time it subtracts) and the relay-leg swap ranking (the clock it holds), so a
 * time trial in it moved both. Absent baseline stays absent: the caller then measures against the leg's
 * recorded split, and the vacant-leg penalty path is unchanged.
 *
 * ## Fixtures
 *
 * Part 1 and 2 are CONSTRUCTED rows (a name, a team, an event, a time). Part 3 is REAL: the Henderson
 * State 4x100 Free Relay (place 1) of the 2026 NSISC Championships, from
 * tests/fixtures/nsisc-2026-relay-followups-r1.json. Scott Doll's real Event 35 100 Free (45.39) is
 * re-labelled a time trial in the test; the leg's recorded split is 49.05. No competition standard is
 * typed in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import type { RelayLegOverride, SwimmerResult, Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { applyRelayLegSwap, rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { findDepartedLegSwim, simulateRoster } from '../packages/core/src/lib/relaySimulation';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import { normalizeSwimmerName } from '../packages/core/src/lib/swimmerNames';
import { workspaceFixture } from './helpers/typedFixtures';

/* ---------------------------------- constructed ---------------------------------- */

const HSU = 'HSU';
const RELAY = 'Event 2 Men 4x50 Yard Freestyle Relay';
const FREE50 = 'Event 8 Men 50 Yard Freestyle';
const NAMES = [
  { name: 'Ann Lee', year: 'SR' },
  { name: 'Bea Fox', year: 'JR' },
  { name: 'Cy Ode', year: 'FR' },
  { name: 'Dee Ray', year: 'SO' },
];

function leg(i: number): SwimmerResult {
  const n = NAMES[i];
  return {
    id: `relay-${i}`,
    rank: 1,
    name: n?.name ?? 'Nobody',
    classYear: n?.year ?? 'FR',
    team: HSU,
    time: '1:40.00',
    finalsTime: '1:40.00',
    relayTeamTime: '1:40.00',
    relayLegSplit: '25.00',
    relayLegIndex: i,
    roundSwam: 'A Final',
    points: 0,
    event: RELAY,
    isRelay: true,
    gender: Gender.MEN,
    relayNames: NAMES,
  } as SwimmerResult;
}

function swim(id: string, name: string, event: string, time: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id,
    rank: 1,
    name,
    classYear: 'FR',
    team: HSU,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: Gender.MEN,
    ...extra,
  } as SwimmerResult;
}

const ON = { relayLegsAllowTimeTrials: true } as const;

describe('findDepartedLegSwim and a time-trial swim', () => {
  const flagged = swim('tt', 'Ann Lee', FREE50, '24.50', { isTimeTrial: true });
  const labelled = swim('tt-label', 'Ann Lee', 'Event 201 Men 50 Yard Freestyle Time Trial', '24.50');
  const official = swim('official', 'Ann Lee', FREE50, '25.50');

  it('skips a flagged time trial by default, so the next swim stands in', () => {
    expect(findDepartedLegSwim([flagged, official], 'Ann Lee', RELAY, 0, HSU)?.id).toBe('official');
  });

  it('has no baseline when the only swim at the leg is a time trial', () => {
    expect(findDepartedLegSwim([flagged], 'Ann Lee', RELAY, 0, HSU)).toBeUndefined();
  });

  it('skips a swim whose label says Time Trial', () => {
    expect(findDepartedLegSwim([labelled], 'Ann Lee', RELAY, 0, HSU)).toBeUndefined();
    expect(findDepartedLegSwim([labelled, official], 'Ann Lee', RELAY, 0, HSU)?.id).toBe('official');
  });

  it('takes the time trial when the setting is on', () => {
    expect(findDepartedLegSwim([flagged, official], 'Ann Lee', RELAY, 0, HSU, ON)?.id).toBe('tt');
    expect(findDepartedLegSwim([labelled], 'Ann Lee', RELAY, 0, HSU, ON)?.id).toBe('tt-label');
  });

  it('is off for settings without the field, with false, and without settings', () => {
    expect(findDepartedLegSwim([flagged], 'Ann Lee', RELAY, 0, HSU, {})).toBeUndefined();
    expect(findDepartedLegSwim([flagged], 'Ann Lee', RELAY, 0, HSU, { relayLegsAllowTimeTrials: false })).toBeUndefined();
    expect(findDepartedLegSwim([flagged], 'Ann Lee', RELAY, 0, HSU, undefined)).toBeUndefined();
  });

  it('reads the scored-event boundary: a swim of a later event is a time trial', () => {
    const late = swim('late', 'Ann Lee', 'Event 50 Men 50 Yard Freestyle', '24.50');
    expect(findDepartedLegSwim([late], 'Ann Lee', RELAY, 0, HSU)?.id).toBe('late');
    expect(findDepartedLegSwim([late], 'Ann Lee', RELAY, 0, HSU, { scoredEventNumberMax: 42 })).toBeUndefined();
    expect(
      findDepartedLegSwim([late], 'Ann Lee', RELAY, 0, HSU, { scoredEventNumberMax: 42, relayLegsAllowTimeTrials: true })?.id
    ).toBe('late');
  });
});

describe('simulateRoster measures a departed leg against the split, not a time trial', () => {
  // Ann Lee (SR) departs with removeSeniors. Sam Roe fills leg 0 in 24.00. The relay is 100.00 s with a
  // 25.00 split on leg 0, so a baseline of the split gives 100 - 1.00 = 1:39.00.
  const SAM = swim('sam', 'Sam Roe', FREE50, '24.00');
  const override: RelayLegOverride = {
    relayEntryKey: relayEntryKey(leg(0)),
    legIndex: 0,
    source: 'manual',
    assigneeName: 'Sam Roe',
  };
  const legs = [0, 1, 2, 3].map(leg);
  const clockOf = (rows: SwimmerResult[], settings?: { relayLegsAllowTimeTrials?: boolean }): string | undefined =>
    simulateRoster(rows, [], true, undefined, [override], new Set(), [], settings)
      .filter(r => r.isRelay)
      .map(r => r.relayTeamTime)[0];

  it('uses the leg split when the only departed swim is a time trial (default)', () => {
    const tt = swim('tt', 'Ann Lee', FREE50, '24.50', { isTimeTrial: true });
    expect(clockOf([...legs, SAM, tt])).toBe('1:39.00');
  });

  it('uses the time trial when the setting is on: 100 - (24.50 - 24.00) = 1:39.50', () => {
    const tt = swim('tt', 'Ann Lee', FREE50, '24.50', { isTimeTrial: true });
    expect(clockOf([...legs, SAM, tt], ON)).toBe('1:39.50');
  });

  it('takes the official swim behind a time trial when the setting is off', () => {
    const tt = swim('tt', 'Ann Lee', FREE50, '24.50', { isTimeTrial: true });
    const official = swim('official', 'Ann Lee', FREE50, '25.50');
    // 24.00 - 25.50 = -1.50
    expect(clockOf([...legs, SAM, tt, official])).toBe('1:38.50');
    // The time trial is first in results order and the setting is on: 24.00 - 24.50 = -0.50
    expect(clockOf([...legs, SAM, tt, official], ON)).toBe('1:39.50');
  });

  it('leaves the vacant-leg path unchanged: +3.00 s, split + 3.00 shown', () => {
    const tt = swim('tt', 'Ann Lee', FREE50, '24.50', { isTimeTrial: true });
    const out = simulateRoster([...legs, SAM, tt], [], true, undefined, [], new Set());
    const rows = out.filter(r => r.isRelay).sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
    expect(rows[0]).toMatchObject({ name: '—', relayLegSplit: '28.00' });
    expect(rows[0]?.relayTeamTime).toBe('1:43.00');
  });
});

/* ------------------------------------ real data ------------------------------------ */

const TEAM = 'Henderson State University';
const EVENT = 'Event 42 Men 4x100 Yard Freestyle Relay';
const OUT = 'Scott Doll';
const DOLL_100 = '0b7ddcce-6648-4295-8c49-98a3c1fc3860';
const STRICT = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules, includeRelayLegsInFinals: false },
};

type Row = SwimmerResult & Record<string, unknown>;
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: Row[]; womenResults: Row[] };

function swapClock(opts: { timeTrial: boolean; allow: boolean }): { clock: string | undefined; team: unknown } {
  const men = fixture.menResults.map(r =>
    r.id === DOLL_100 && opts.timeTrial ? ({ ...r, isTimeTrial: true } as Row) : r
  );
  const settings = { ...STRICT, ...(opts.allow ? { relayLegsAllowTimeTrials: true } : {}) };
  const ws: Workspace = workspaceFixture({
    id: 'w',
    name: 'w',
    createdAt: 0,
    menResults: men,
    womenResults: fixture.womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    conference: 'NSISC',
    scoringSettings: settings,
    scorerRosterOverrides: [{ name: OUT, team: TEAM, gender: Gender.MEN, isScorer: false }],
  });
  const ranking = rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings });
  const first = ranking.swaps.find(s => s.relayEvent === EVENT && s.outAthlete === OUT);
  expect(first, 'the removed swimmer has a swap on the target relay').toBeDefined();
  const { patch } = applyRelayLegSwap(ws, first!, { team: TEAM, gender: Gender.MEN });
  const after = simulateRoster(
    ws.menResults,
    [],
    false,
    new Set(),
    patch.relayLegOverrides ?? [],
    new Set([normalizeSwimmerName(OUT)]),
    [],
    { ...(opts.allow ? { relayLegsAllowTimeTrials: true } : {}) }
  );
  const team = [
    ...new Set(after.filter(r => r.isRelay && r.team === TEAM && r.event === EVENT && r.rank === 1).map(r => r.relayTeamTime)),
  ];
  return { clock: first!.clockLegTime, team };
}

describe('the relay swap holds the departed clock the way simulateRoster subtracts it (real relay)', () => {
  it('official 100 Free: the clock is the individual time, 45.39', () => {
    expect(swapClock({ timeTrial: false, allow: false }).clock).toBe('45.39');
  });

  it('the same swim as a time trial, setting off: the clock is the leg split, 49.05', () => {
    expect(swapClock({ timeTrial: true, allow: false }).clock).toBe('49.05');
  });

  it('the time trial with the setting on: the clock is the time trial, 45.39', () => {
    expect(swapClock({ timeTrial: true, allow: true }).clock).toBe('45.39');
  });

  it('a held clock moves nothing: every configuration re-scores to the relay as swum', () => {
    const swum = fixture.menResults.find(r => r.isRelay === true && r.team === TEAM && r.event === EVENT && r.rank === 1);
    expect(swum?.relayTeamTime).toBeDefined();
    for (const opts of [
      { timeTrial: false, allow: false },
      { timeTrial: true, allow: false },
      { timeTrial: true, allow: true },
    ]) {
      expect(swapClock(opts).team, JSON.stringify(opts)).toEqual([swum?.relayTeamTime]);
    }
  });
});
