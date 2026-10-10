/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Applying a scoring theory respects the NSISC 7-entry TOTAL cap — individual
 * events and relays together (user decision 2026-07-19) — and counts entries
 * the way `countSwimmerEntries` does.
 *
 * Two defects, found 2026-10-01 by the bug-hunter pass, fixed the same day. The
 * cases below pin the fix:
 *
 * 1. Relays were not counted. `buildTheoryApplyContext` (scoringTheory.ts) compared
 *    the total cap with the swimmer's INDIVIDUAL events only, so a swimmer at 7 of 7
 *    (3 individual + 4 relay legs) received 4 more planned entries. The theory now
 *    measures the total cap against `countSwimmerEntries` plus planned entries.
 * 2. A time trial was counted. `existingIndividualEvents` kept the time trial's own
 *    HyTek label. The meet-result side now goes through `countSwimmerEntries`.
 *
 * Fixtures are synthetic: invented names and times.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type HistoricalSwim, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';
import { applyScoringTheory, parseScoringTheory } from '../packages/core/src/lib/scoringTheory';
import { countSwimmerEntries, swimmerExceedsEntryLimits } from '../packages/core/src/lib/swimmerEntryLimits';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';

const TEAM = 'Alpha University';
const ANN = 'Ann Able';
const MATES = ['Bo Bee', 'Cy Cee', 'Di Dee'];

function individual(id: string, event: string, time: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id,
    rank: 1,
    name: ANN,
    classYear: 'JR',
    team: TEAM,
    time,
    finalsTime: time,
    points: 0,
    event,
    gender: Gender.MEN,
    roundSwam: 'A Final',
    ...extra,
  } as SwimmerResult;
}

function relay(prefix: string, event: string, clock: string): SwimmerResult[] {
  const legs = [ANN, ...MATES];
  return legs.map((name, i) => ({
    id: `${prefix}-${i}`,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time: clock,
    finalsTime: clock,
    relayTeamTime: clock,
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
  })) as SwimmerResult[];
}

const THREE_INDIVIDUAL = [
  individual('i1', 'Event 4 Men 50 Yard Freestyle', '20.10'),
  individual('i2', 'Event 10 Men 100 Yard Freestyle', '45.10'),
  individual('i3', 'Event 16 Men 200 Yard Freestyle', '1:39.00'),
];

const FOUR_RELAYS = [
  ...relay('r1', 'Event 1 Men 200 Yard Freestyle Relay', '1:20.00'),
  ...relay('r2', 'Event 2 Men 400 Yard Medley Relay', '3:15.00'),
  ...relay('r3', 'Event 3 Men 800 Yard Freestyle Relay', '6:40.00'),
  ...relay('r4', 'Event 5 Men 400 Yard Freestyle Relay', '2:58.00'),
];

const TIME_TRIAL = individual('tt1', 'Event 100 Men 100 Yard Breaststroke Time Trial', '58.00', {
  isTimeTrial: true,
  roundSwam: 'Time Trial',
});

function history(event: string, time: string): HistoricalSwim {
  return { name: ANN, team: TEAM, gender: Gender.MEN, event, time, timeType: 'SCY', source: 'paste' } as HistoricalSwim;
}

function workspace(menResults: SwimmerResult[]): Workspace {
  return {
    id: 'ws-theory-cap',
    name: 'theory cap probe',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    historySources: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    athleteHistory: [
      history('500 Freestyle', '4:30.00'),
      history('100 Butterfly', '49.00'),
      history('200 Individual Medley', '1:50.00'),
      history('100 Backstroke', '50.00'),
    ],
  } as unknown as Workspace;
}

/** Ann's four history events, written the way a coach writes a theory file. */
const THEORY = parseScoringTheory(['Scoring team possibilities', `${ANN} (500, 1fly, 2im, 1back)`].join('\n'));
const SETTINGS = mergeScoringSettings(NSISC_PRESET_SETTINGS, { conference: 'NSISC' });

function applyAndCount(menResults: SwimmerResult[]) {
  const ws = workspace(menResults);
  const result = applyScoringTheory(ws, THEORY, { team: TEAM, gender: Gender.MEN });
  const projected = buildWhatIfResults({ workspace: { ...ws, ...result.patch }, gender: Gender.MEN, removeSeniors: false });
  const counts = countSwimmerEntries(projected, TEAM, Gender.MEN, ANN);
  return { result, counts, over: swimmerExceedsEntryLimits(counts, SETTINGS) };
}

describe('applyScoringTheory under the NSISC 7-entry total cap', () => {
  it('fills a swimmer with no relays up to exactly 7 entries (control)', () => {
    const { result, counts, over } = applyAndCount(THREE_INDIVIDUAL);
    expect(result.summary.entriesAdded).toBe(4);
    expect(counts.total).toBe(7);
    expect(over.totalOver).toBe(false);
  });

  it('adds nothing for a swimmer already at 7 of 7 through relay legs', () => {
    const { result, counts, over } = applyAndCount([...THREE_INDIVIDUAL, ...FOUR_RELAYS]);
    expect({ added: result.summary.entriesAdded, total: counts.total, totalOver: over.totalOver }).toEqual({
      added: 0,
      total: 7,
      totalOver: false,
    });
  });

  it('a time trial does not use up one of the 7 entries', () => {
    const { result, counts } = applyAndCount([...THREE_INDIVIDUAL, TIME_TRIAL]);
    expect({ added: result.summary.entriesAdded, total: counts.total }).toEqual({ added: 4, total: 7 });
  });
});
