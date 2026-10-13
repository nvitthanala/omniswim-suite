/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D9 follow-up (architect review 2026-10-13, finding 1): a swim of an event
 * numbered past the meet's scored program is a time trial for a relay leg, with
 * or without the `isTimeTrial` flag, and a Boys/Girls word does not rescue it.
 *
 * ## Why this test exists
 *
 * `isTimeTrialSwim` read the flag and the label only. `Event 939 Boys 100 Yard
 * Breaststroke` (no "Time Trial" in the label, no flag, event number past the
 * 2026 NSISC program that ends at event 42) filled a medley breast leg while
 * the same swim from a SwimCloud import, which the bridge flags, did not. And
 * a flagged `Event 939 Boys` row got back in through the Boys/Girls
 * championship exception.
 *
 * The boundary of a loaded meet lives on `officialTeamScores.eventThrough`, not
 * on `scoringSettings`, so the caller-level cases below build a workspace the
 * way a loaded meet is built: the boundary on `officialTeamScores` and nothing
 * in the settings. Real rows: `tests/fixtures/nsisc-2026-relay-followups-r1.json`
 * (Delta State's Jacob Hamblen swam `Event 939 Boys 100 Yard Breaststroke`
 * 53.66R, past event 42).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type RelayLegOverride,
  type ScoringSettings,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import {
  listEligibleRelayLegCandidates,
  relayLegMatchSettings,
  swimmerMatchesRelayLeg,
} from '../packages/core/src/lib/relayLegMatching';
import {
  loadedMeetHistoryLabel,
  relayLegHistoryCandidates,
} from '../packages/core/src/lib/relayLegHistoryCandidates';
import { buildRelaysFromIndividualLineup } from '../packages/core/src/lib/relayBuilder';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { buildWhatIfProjection } from '../packages/core/src/lib/whatIfProjection';
import { isTimeTrialSwim } from '../packages/core/src/lib/utils';
import { buildHistoryFromWorkspace, historicalSwimFromResult } from '../packages/core/src/lib/athleteHistory';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };

const DSU = 'Delta State University';
const M_400MEDLEY = 'Event 20 Men 4x100 Yard Medley Relay';
const BREAST_LEG = 1;
const HAMBLEN = 'Jacob Hamblen';
const MAUSS = 'Neill Mauss';
/** Delta State's 4x100 Medley Relay B (11th, 3:22.86): Neill Mauss swims the breaststroke leg. */
const RELAY_B_KEY = `${DSU}|${M_400MEDLEY}|B Final|11|3:22.86`;

const EVENT_939 = 'Event 939 Boys 100 Yard Breaststroke';

/** Hamblen's real 100 Breaststroke at event 26 is removed: his only one is the post-meet event 939. */
const menResults: SwimmerResult[] = fixture.menResults.filter(
  r => !(r.name === HAMBLEN && r.event === 'Event 26 Men 100 Yard Breaststroke')
);

function workspace(
  over: Partial<Workspace> = {},
  settings: Partial<ScoringSettings> = {}
): Workspace {
  const override: RelayLegOverride = {
    relayEntryKey: RELAY_B_KEY,
    legIndex: BREAST_LEG,
    assigneeName: HAMBLEN,
    source: 'manual',
  };
  return {
    id: 'ws-relay-leg-boundary',
    name: '2026 NSISC (relay leg boundary)',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    // Neill Mauss leaves the B relay; the override names Hamblen for his breaststroke leg.
    deletedSwimmers: [{ name: MAUSS, gender: Gender.MEN }],
    relayLegOverrides: [override],
    conference: 'NSISC',
    // The loaded meet's boundary: on officialTeamScores, nothing in the settings.
    officialTeamScores: { eventThrough: 42, men: {}, women: {} },
    scoringSettings: { ...NSISC_PRESET_SETTINGS, ...settings },
    ...over,
  } as Workspace;
}

function breastLeg(ws: Workspace): SwimmerResult {
  const rows = buildWhatIfProjection({ workspace: ws, gender: Gender.MEN, removeSeniors: false }).rows;
  return rows.find(
    r =>
      r.isRelay === true &&
      r.team === DSU &&
      r.event === M_400MEDLEY &&
      r.roundSwam === 'B Final' &&
      r.rank === 11 &&
      r.relayLegIndex === BREAST_LEG
  ) as SwimmerResult;
}

describe('isTimeTrialSwim and the scored program', () => {
  it('a swim past the boundary is a time trial with no flag and no Time Trial label', () => {
    expect(isTimeTrialSwim({ event: 'Event 938 Women 100 Yard Breaststroke' }, 42)).toBe(true);
    expect(isTimeTrialSwim({ event: EVENT_939 }, 42)).toBe(true);
  });

  it('the Boys/Girls championship exception does not rescue a flagged swim past the boundary', () => {
    expect(isTimeTrialSwim({ event: EVENT_939, isTimeTrial: true }, 42)).toBe(true);
    // Inside the program the exception still holds, as before.
    expect(isTimeTrialSwim({ event: 'Event 39 Boys 200 Yard Breaststroke', isTimeTrial: true }, 42)).toBe(false);
  });

  it('no boundary: the flag and the label decide, as before', () => {
    expect(isTimeTrialSwim({ event: 'Event 938 Women 100 Yard Breaststroke' })).toBe(false);
    expect(isTimeTrialSwim({ event: EVENT_939, isTimeTrial: true })).toBe(false);
    expect(isTimeTrialSwim({ event: 'Event 38 Women 100 Yard Breaststroke' }, 42)).toBe(false);
    // An unnumbered label is never past the boundary.
    expect(isTimeTrialSwim({ event: '100 Breaststroke' }, 42)).toBe(false);
  });
});

describe('the settings a workspace hands the leg matchers', () => {
  it('reads the boundary from officialTeamScores, which wins over the settings value, as the engine does', () => {
    expect(relayLegMatchSettings(workspace()).scoredEventNumberMax).toBe(42);
    expect(
      relayLegMatchSettings(workspace({}, { scoredEventNumberMax: 999 })).scoredEventNumberMax
    ).toBe(42);
  });

  it('falls back to scoringSettings.scoredEventNumberMax, and to no boundary', () => {
    expect(
      relayLegMatchSettings(workspace({ officialTeamScores: undefined }, { scoredEventNumberMax: 40 }))
        .scoredEventNumberMax
    ).toBe(40);
    expect(
      relayLegMatchSettings(workspace({ officialTeamScores: undefined })).scoredEventNumberMax
    ).toBeUndefined();
  });

  it('carries the time-trial opt-in', () => {
    expect(relayLegMatchSettings(workspace()).relayLegsAllowTimeTrials).toBeUndefined();
    expect(relayLegMatchSettings(workspace({}, { relayLegsAllowTimeTrials: true })).relayLegsAllowTimeTrials).toBe(true);
  });
});

describe('leg candidates (the offer side)', () => {
  const pool = menResults.filter(r => !r.isRelay && r.team === DSU);
  const names = (ws: Workspace) =>
    listEligibleRelayLegCandidates(pool, M_400MEDLEY, BREAST_LEG, new Set(), DSU, Gender.MEN, relayLegMatchSettings(ws)).map(
      r => r.name
    );

  it('the real event 939 swim is on the pool and matches the leg when no boundary is known', () => {
    const hamblen939 = pool.find(r => r.name === HAMBLEN && r.event === EVENT_939) as SwimmerResult;
    expect(hamblen939.time).toBe('53.66R');
    expect(swimmerMatchesRelayLeg(hamblen939, M_400MEDLEY, BREAST_LEG)).toBe(true);
    expect(names(workspace({ officialTeamScores: undefined }))).toContain(HAMBLEN);
  });

  it('is left off the leg once the meet states its boundary', () => {
    expect(names(workspace())).not.toContain(HAMBLEN);
    expect(names(workspace()).length).toBeGreaterThan(3);
  });

  it('is offered and labelled when the coach opts in', () => {
    const ws = workspace({}, { relayLegsAllowTimeTrials: true });
    const hit = listEligibleRelayLegCandidates(
      pool, M_400MEDLEY, BREAST_LEG, new Set(), DSU, Gender.MEN, relayLegMatchSettings(ws)
    ).find(r => r.name === HAMBLEN);
    expect(hit?.relayLegTimeTrial).toBe(true);
    expect(hit?.event).toBe(EVENT_939);
  });
});

describe('the projected relay (the resolve side)', () => {
  it('fills the leg from event 939 when the meet states no boundary (the defect)', () => {
    const leg = breastLeg(workspace({ officialTeamScores: undefined }));
    expect(leg.name).toBe(HAMBLEN);
    expect(leg.relayLegVacant).toBe(false);
  });

  it('leaves the leg vacant, with the time-trial reason, once the boundary is on officialTeamScores', () => {
    const leg = breastLeg(workspace());
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.name).toBe('—');
    expect(leg.relayMissingLeg?.reason).toBe('time_trial_only');
  });

  it('leaves it vacant for a boundary stored in the settings too', () => {
    const leg = breastLeg(workspace({ officialTeamScores: undefined }, { scoredEventNumberMax: 42 }));
    expect(leg.relayLegVacant).toBe(true);
  });

  it('fills and labels the leg when the coach opts in', () => {
    const leg = breastLeg(workspace({}, { relayLegsAllowTimeTrials: true }));
    expect(leg.name).toBe(HAMBLEN);
    expect(leg.relayLegVacant).toBe(false);
    expect(leg.relayLegTimeTrial).toBe(true);
  });
});

describe('history candidates', () => {
  it('a history swim of an event past the boundary fills no leg unless allowed', () => {
    const hamblen939 = menResults.find(r => r.name === HAMBLEN && r.event === EVENT_939) as SwimmerResult;
    // The copy of the loaded meet's own result that `buildHistoryFromWorkspace` makes: it carries the loaded
    // meet's label, so the loaded meet's boundary judges it (a history swim of another meet is not judged
    // by this boundary: tests/relayTiedAmbiguityMigration.test.ts).
    const history = buildHistoryFromWorkspace(workspace()).find(
      h => h.name === HAMBLEN && h.event === hamblen939.event
    ) as NonNullable<ReturnType<typeof historicalSwimFromResult>>;
    expect(history.meetLabel).toBe(loadedMeetHistoryLabel(workspace()));
    const pool = menResults.filter(r => !r.isRelay && r.team === DSU && r.name === HAMBLEN && r !== hamblen939);
    const run = (ws: Workspace) =>
      relayLegHistoryCandidates({ ...ws, athleteHistory: [history] }, pool, Gender.MEN).filter(
        r => r.name === HAMBLEN && r.event === '100 Breaststroke'
      );
    expect(run(workspace({ officialTeamScores: undefined }))).toHaveLength(1);
    expect(run(workspace())).toHaveLength(0);
    expect(run(workspace({}, { relayLegsAllowTimeTrials: true }))[0]?.relayLegTimeTrial).toBe(true);
  });
});

describe('the relay-leg swap ranking', () => {
  // HSU's Aiden Killackey, re-labelled as a post-meet 50 Free: numbered past the program, no flag, no
  // "Time Trial" in the label. Gavin Kock leaves the 4x50 Free Relay A; Killackey's 20.80 is the fast swim.
  const HSU = 'Henderson State University';
  const killackey = fixture.menResults.find(r => r.name === 'Aiden Killackey' && r.isTimeTrial === true) as SwimmerResult;
  const postMeet: SwimmerResult = {
    ...killackey,
    id: 'synthetic-post-meet-50-free',
    isTimeTrial: false,
    event: 'Event 939 Men 50 Yard Freestyle',
    roundSwam: 'A Final',
    time: '20.80',
    finalsTime: '20.80',
  };
  const settings = (extra: Partial<ScoringSettings>): ScoringSettings => ({
    ...NSISC_PRESET_SETTINGS,
    scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
    ...extra,
  });
  const swapsOf = (over: Partial<Workspace>, extra: Partial<ScoringSettings> = {}) => {
    const s = settings(extra);
    const ws = {
      ...workspace({ menResults: [...fixture.menResults, postMeet], relayLegOverrides: [], deletedSwimmers: [{ name: 'Gavin Kock', gender: Gender.MEN }], ...over }, s),
    } as Workspace;
    return rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: s }).swaps.filter(
      x => x.inAthlete === 'Aiden Killackey'
    );
  };

  it('offers the post-meet swim when the meet states no boundary (the defect)', () => {
    const swaps = swapsOf({ officialTeamScores: undefined });
    expect(swaps.map(x => x.inTime)).toStrictEqual(['20.80']);
  });

  it('does not offer it once the boundary is on officialTeamScores', () => {
    expect(swapsOf({})).toStrictEqual([]);
  });

  it('counts it as a candidate only when the boundary lets it through (the offer side)', () => {
    // A swap with no points gain is not surfaced, so the surfaced list alone cannot show the offer side.
    // The candidates evaluated can: a post-meet swim past the boundary adds none.
    const evaluated = (over: Partial<Workspace>, rows: SwimmerResult[]) => {
      const s = settings({});
      const ws = workspace({ menResults: rows, relayLegOverrides: [], deletedSwimmers: [{ name: 'Gavin Kock', gender: Gender.MEN }], ...over }, s);
      return rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: s }).candidatesEvaluated;
    };
    const without = evaluated({}, fixture.menResults);
    expect(evaluated({}, [...fixture.menResults, postMeet])).toBe(without);
    expect(evaluated({ officialTeamScores: undefined }, [...fixture.menResults, postMeet])).toBeGreaterThan(without);
  });

  it('offers it, labelled, when the coach opts in', () => {
    const swaps = swapsOf({}, { relayLegsAllowTimeTrials: true });
    expect(swaps.length).toBeGreaterThan(0);
    expect(swaps.every(x => x.inFromTimeTrial === true)).toBe(true);
  });
});

describe('the relay builder autofill', () => {
  // The B relay's breaststroke leg is vacant; the pool is Delta State's individuals without Neill Mauss.
  const pool = menResults.filter(r => !r.isRelay && r.team === DSU && r.name !== MAUSS);
  const relayLegs = menResults
    .filter(r => r.isRelay === true && r.team === DSU)
    .map(r =>
      r.event === M_400MEDLEY && r.roundSwam === 'B Final' && r.relayLegIndex === BREAST_LEG
        ? { ...r, relayLegVacant: true, name: '—' }
        : r
    );
  const fillOf = (ws: Workspace) =>
    buildRelaysFromIndividualLineup(ws, Gender.MEN, DSU, pool, relayLegs).find(
      o => o.relayEntryKey === RELAY_B_KEY && o.legIndex === BREAST_LEG
    );

  it('names the event 939 swimmer when the meet states no boundary (the defect)', () => {
    expect(fillOf(workspace({ officialTeamScores: undefined, relayLegOverrides: [] }))?.assigneeName).toBe(HAMBLEN);
  });

  it('names the fastest swimmer with a program swim once the boundary is stated', () => {
    const fill = fillOf(workspace({ relayLegOverrides: [] }));
    expect(fill?.assigneeName).toBeDefined();
    expect(fill?.assigneeName).not.toBe(HAMBLEN);
  });

  it('names the event 939 swimmer, as a labelled time trial, when the coach opts in', () => {
    expect(fillOf(workspace({ relayLegOverrides: [] }, { relayLegsAllowTimeTrials: true }))?.assigneeName).toBe(HAMBLEN);
  });
});
