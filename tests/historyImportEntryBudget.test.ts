/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A history import spends a swimmer's remaining entries the way
 * `countSwimmerEntries` counts them: a time trial is not an entry (user ruling
 * 2026-09-21), and two spellings joined by an alias link are one swimmer
 * (docs/INVARIANTS.md item 6).
 *
 * Two defects, found 2026-10-01 by the bug-hunter pass, fixed the same day. Both
 * lived in `countExistingEntries` (historyImportRoster.ts), a second entry counter
 * that had drifted from `countSwimmerEntries`. It now calls `countSwimmerEntries`
 * for the loaded meet's result rows and resolves aliases for plan and recruit rows:
 *
 * 1. It charged a time-trial row as one more entry. Measured on the local real
 *    workspace (`data/meets.json`, not committed): Justin Oulette (Ouachita Baptist)
 *    holds 6 of 7 entries plus a 200 Breaststroke time trial.
 * 2. It compared raw normalized names, with no alias resolver, so recruit rows
 *    stored under the alias spelling were not charged. The real workspace holds
 *    exactly this shape (meet rows as "Cam Mask", recruit rows as "Camden Mask").
 *
 * Fixtures below are synthetic: invented teams, names and times.
 */
import { describe, expect, it } from 'vitest';
import {
  ClassYear,
  Gender,
  type HistoricalSwim,
  type Recruit,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { countSwimmerEntries } from '../packages/core/src/lib/swimmerEntryLimits';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';
import { buildAliasResolver } from '../packages/core/src/lib/athleteAliases';

const TEAM = 'Alpha University';
const MATES = ['Bo Bee', 'Cy Cee', 'Di Dee'];

function individual(id: string, name: string, event: string, time: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id,
    rank: 1,
    name,
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

function relay(prefix: string, swimmer: string, event: string, clock: string): SwimmerResult[] {
  const legs = [swimmer, ...MATES];
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

/** Four individual events and two relays: 6 of 7. */
function sixEntries(name: string): SwimmerResult[] {
  return [
    individual(`${name}-1`, name, 'Event 15 Men 400 Yard IM', '4:14.81'),
    individual(`${name}-2`, name, 'Event 26 Men 100 Yard Breaststroke', '55.16'),
    individual(`${name}-3`, name, 'Event 28 Men 200 Yard Butterfly', '2:00.72'),
    individual(`${name}-4`, name, 'Event 39 Men 200 Yard Breaststroke', '2:01.43'),
    ...relay(`${name}-r1`, name, 'Event 11 Men 4x50 Yard Medley Relay', '1:29.58'),
    ...relay(`${name}-r2`, name, 'Event 20 Men 4x100 Yard Medley Relay', '3:16.45'),
  ];
}

/** A teammate's row, so the loaded meet contests the 200 Backstroke the import brings. */
const BACKSTROKE_FIELD = individual('field-1', 'Bo Bee', 'Event 30 Men 200 Yard Backstroke', '1:52.00');

function workspace(menResults: SwimmerResult[], extra: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-import-budget',
    name: 'import budget probe',
    createdAt: 0,
    menResults,
    womenResults: [],
    sourceMenResults: menResults,
    sourceWomenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    historySources: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    athleteHistory: [],
    ...extra,
  } as unknown as Workspace;
}

function swim(name: string, event: string, time: string): HistoricalSwim {
  return {
    name,
    team: TEAM,
    gender: Gender.MEN,
    event,
    time,
    timeType: 'SCY',
    source: 'swimcloud',
    meet: 'Synthetic Invite',
    date: '2026-01-01',
  } as HistoricalSwim;
}

describe('importHistoryToRoster: a time trial is not an entry', () => {
  const NAME = 'Jay Oak';
  const incoming = [swim(NAME, '200 Backstroke', '1:50.00')];

  it('adds the 7th entry for a swimmer at 6 of 7 (control)', () => {
    const ws = workspace([...sixEntries(NAME), BACKSTROKE_FIELD]);
    expect(countSwimmerEntries(ws.menResults ?? [], TEAM, Gender.MEN, NAME).total).toBe(6);
    expect(importHistoryToRoster(ws, incoming, { team: TEAM, gender: Gender.MEN }).summary.lineupEntriesAdded).toBe(1);
  });

  it('still adds the 7th entry when the swimmer also swam a time trial', () => {
    const tt = individual('tt-1', NAME, 'Event 101 Men 200 Yard Breaststroke Time Trial', '2:00.54', {
      isTimeTrial: true,
      roundSwam: 'Time Trial',
    });
    const ws = workspace([...sixEntries(NAME), tt, BACKSTROKE_FIELD]);
    // The entry-limit module agrees there is room: the time trial is skipped.
    expect(countSwimmerEntries(ws.menResults ?? [], TEAM, Gender.MEN, NAME).total).toBe(6);
    expect(importHistoryToRoster(ws, incoming, { team: TEAM, gender: Gender.MEN }).summary.lineupEntriesAdded).toBe(1);
  });
});

describe('importHistoryToRoster: two linked spellings are one swimmer against the cap', () => {
  const CANONICAL = 'Cam Mask';
  const ALIAS = 'Camden Mask';

  /** Three individual events and two relays under the canonical spelling: 5. */
  const meetRows: SwimmerResult[] = [
    individual('c1', CANONICAL, 'Event 6 Men 200 Yard IM', '1:56.87'),
    individual('c2', CANONICAL, 'Event 26 Men 100 Yard Breaststroke', '55.52'),
    individual('c3', CANONICAL, 'Event 39 Men 200 Yard Breaststroke', '2:02.69'),
    ...relay('cr1', CANONICAL, 'Event 11 Men 4x50 Yard Medley Relay', '1:30.00'),
    ...relay('cr2', CANONICAL, 'Event 20 Men 4x100 Yard Medley Relay', '3:20.00'),
    individual('f1', 'Bo Bee', 'Event 8 Men 50 Yard Freestyle', '20.50'),
    individual('f2', 'Bo Bee', 'Event 35 Men 100 Yard Freestyle', '45.50'),
    individual('f3', 'Bo Bee', 'Event 13 Men 100 Yard Butterfly', '50.00'),
    individual('f4', 'Bo Bee', 'Event 24 Men 100 Yard Backstroke', '50.00'),
  ];

  /** Two more events as recruit rows: 7 of 7 in total. */
  function recruits(spelling: string): Recruit[] {
    const row = (id: string, event: string, time: string): Recruit => ({
      id,
      name: spelling,
      team: TEAM,
      event,
      time,
      gender: Gender.MEN,
      classYear: ClassYear.JR,
      timeType: 'SCY',
      source: 'swimcloud',
    });
    return [row('rc1', '50 Freestyle', '23.35'), row('rc2', '100 Freestyle', '52.55')];
  }

  const link = {
    id: 'link-1',
    gender: Gender.MEN,
    team: TEAM,
    canonicalName: CANONICAL,
    aliasName: ALIAS,
    source: 'manual' as const,
    status: 'active' as const,
  };

  const incoming = [swim(ALIAS, '100 Butterfly', '50.90'), swim(ALIAS, '100 Backstroke', '52.00')];

  /** The swimmer's projected total after the import, both spellings merged. */
  function totalAfterImport(recruitSpelling: string): { before: number; after: number; added: number } {
    const ws = workspace(meetRows, { recruits: recruits(recruitSpelling), athleteAliases: [link] });
    const total = (w: Workspace) => {
      const bundle = buildScoringBundle({
        workspace: w,
        gender: Gender.MEN,
        removeSeniors: false,
        applyWhatIf: true,
        scorerRosterOverrides: w.scorerRosterOverrides,
      });
      return countSwimmerEntries(bundle.allResults, TEAM, Gender.MEN, CANONICAL, buildAliasResolver(w)).total ?? 0;
    };
    const res = importHistoryToRoster(ws, incoming, { team: TEAM, gender: Gender.MEN });
    return { before: total(ws), after: total({ ...ws, ...res.patch }), added: res.summary.lineupEntriesAdded };
  }

  it('adds nothing when the recruit rows carry the canonical spelling (control)', () => {
    expect(totalAfterImport(CANONICAL)).toEqual({ before: 7, after: 7, added: 0 });
  });

  it('adds nothing when the recruit rows carry the linked alias spelling', () => {
    expect(totalAfterImport(ALIAS)).toEqual({ before: 7, after: 7, added: 0 });
  });
});
