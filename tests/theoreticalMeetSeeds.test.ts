/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase B4 part 1: `buildTheoreticalMeetSeeds` (packages/manager/src/lib/theoreticalMeetSeeds.ts).
 *
 * ## Fixtures and their provenance
 *
 * - Rosters: the real, trimmed roster pages `tests/fixtures/swimcloud/team-412-roster-gender-{M,F}-page.html`
 *   (Ouachita Baptist University, D2) and `team-10002824-roster-gender-F-page.html` (University of West
 *   Florida, D2), parsed by the real `parseTeamRosterHtml`. Team 10002824 fields no men's program; its men's
 *   page is the real "No rosters found" page and is used for the empty-roster case.
 * - Times: `tests/fixtures/profile_fastest_times-1330318.json`, the real swimmer-times response the driver
 *   tests also use. The driver harness serves it for every swimmer id, so these tests do the same: every
 *   athlete gets that body, parsed by the real `parseSwimmerFastestTimesJson` under the athlete's own id and
 *   converted by the real `swimCloudSwimmerTimesToHistoricalSwims`. The body's owner is not what is checked.
 *   The seeds are checked against values read straight from the file (see GOLDEN_SCY).
 * - Constructed (and said so where used): an athlete moved onto a second roster to make a duplicate id, and
 *   a swimmer's real swims filtered to one course or one event.
 */
import { describe, expect, it } from 'vitest';

import { parseTeamRosterHtml, parseSwimmerFastestTimesJson } from '../packages/swimcloud/src/parser';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import { swimCloudSwimmerTimesToHistoricalSwims } from '../packages/manager/src/lib/swimCloudImportBridge';
import {
  ALL_TIME_BEST_CAVEAT,
  RANKED_ON_ESTIMATE_CAVEAT,
  RELAYS_EXCLUDED_CAVEAT,
  THEORETICAL_MEET_COURSES,
  TOTAL_CAP_CAVEAT,
  TheoreticalMeetError,
  buildTheoreticalMeetSeeds,
  theoreticalSeedRowId,
  type TheoreticalMeetAthleteInput,
  type TheoreticalMeetInput,
  type TheoreticalMeetTeamInput,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { Gender, type HistoricalSwim, type ScoringSettings, type Workspace } from '../packages/core/src/types';
import { GENERIC_TOP16_SETTINGS, NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';
import { buildPsychExpectedRows, buildPsychProjectedBundle, hasPsychData } from '../packages/core/src/lib/psychProjection';
import { SWIMMER_BODY, rosterPage } from './helpers/multiTeamDriverHarness';

/* -------------------------------------------------------------------------- */
/* Real inputs                                                                 */
/* -------------------------------------------------------------------------- */

const RETRIEVED = '2026-10-03T12:00:00.000Z';

function rosterOf(team: string, gender: 'M' | 'F'): { teamName: string | undefined; athletes: readonly SwimCloudAthlete[] } {
  const parsed = parseTeamRosterHtml(rosterPage(team, gender), {
    sourceUrl: `https://www.swimcloud.com/team/${team}/roster/?gender=${gender}`,
    retrievedAt: RETRIEVED,
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error('roster fixture does not parse');
  return { teamName: parsed.data.teamName, athletes: parsed.data.athletes };
}

/**
 * The real parser and converter over the real response, attributed to one roster athlete.
 *
 * The response names its owner (swimmer 1330318) in every row, and the parser drops rows of another
 * swimmer, so it is parsed under its own id. The pairing with the roster athlete is the caller's, as in
 * the driver (an id join); here every athlete is paired with this one real response.
 */
function swimsFor(athlete: SwimCloudAthlete, teamName: string, gender: Gender): HistoricalSwim[] {
  if (athlete.swimCloudSwimmerId === undefined) throw new Error('fixture athlete has no id');
  const parsed = parseSwimmerFastestTimesJson(SWIMMER_BODY, {
    sourceUrl: 'https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/',
    retrievedAt: RETRIEVED,
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  const converted = swimCloudSwimmerTimesToHistoricalSwims({ ...parsed.data, name: athlete.name }, { team: teamName, gender, retrievedAt: RETRIEVED });
  if (!converted.ok) throw new Error(converted.message);
  return [...converted.swims];
}

const OBU_M = rosterOf('412', 'M');
const OBU_F = rosterOf('412', 'F');
const UWF_F = rosterOf('10002824', 'F');
const UWF_M = rosterOf('10002824', 'M');
const OBU = 'Ouachita Baptist University';
const UWF = 'University of West Florida';

function withTimes(athletes: readonly SwimCloudAthlete[], teamName: string, gender: Gender, take?: number): TheoreticalMeetAthleteInput[] {
  return athletes.slice(0, take).map((athlete, i) => ({
    athlete,
    swims: swimsFor(athlete, teamName, gender),
    captureId: `capture-${teamName}-${i}`,
    retrievedAt: RETRIEVED,
  }));
}

const team = (
  teamName: string,
  gender: Gender,
  athletes: TheoreticalMeetAthleteInput[],
  rosterSeasonId: string | null = '29'
): TheoreticalMeetTeamInput => ({ teamName, gender, athletes, ...(rosterSeasonId === null ? {} : { rosterSeasonId }) });

/** 412 men (first 8), 412 women (first 6), West Florida women (first 6). All real athletes. */
function threeTeams(): TheoreticalMeetTeamInput[] {
  return [
    team(OBU, Gender.MEN, withTimes(OBU_M.athletes, OBU, Gender.MEN, 8)),
    team(OBU, Gender.WOMEN, withTimes(OBU_F.athletes, OBU, Gender.WOMEN, 6)),
    team(UWF, Gender.WOMEN, withTimes(UWF_F.athletes, UWF, Gender.WOMEN, 6)),
  ];
}

const meet = (over: Partial<TheoreticalMeetInput> = {}): TheoreticalMeetInput => ({
  meetId: 'ws-tm-1',
  course: 'SCY',
  scoringSettings: GENERIC_TOP16_SETTINGS,
  teams: threeTeams(),
  ...over,
});

/** SCY seeds of swimmer 1330318, read straight from tests/fixtures/profile_fastest_times-1330318.json. */
const GOLDEN_SCY: Record<string, string> = {
  '50 Free SCY': '20.99',
  '100 Free SCY': '45.39',
  '200 Free SCY': '1:41.29',
  '500 Free SCY': '4:56.06',
  '1000 Free SCY': '10:33.23',
  '1650 Free SCY': '18:15.50',
  '100 Back SCY': '49.58',
  '200 Back SCY': '1:49.63',
  '100 Breast SCY': '54.09',
  '200 Breast SCY': '2:00.93',
  '100 Fly SCY': '49.29',
  '200 Fly SCY': '2:04.21',
  '200 IM SCY': '1:49.77',
  '400 IM SCY': '4:09.18',
};
/** LCM seeds of the same swimmer, as recorded. */
const GOLDEN_LCM: Record<string, string> = {
  '50 Free LCM': '24.20',
  '100 Free LCM': '56.15',
  '200 Free LCM': '1:59.46',
  '400 Free LCM': '4:48.31',
  '800 Free LCM': '10:01.10',
  '1500 Free LCM': '18:18.30',
  '100 Back LCM': '59.86',
  '200 Back LCM': '2:13.59',
  '100 Breast LCM': '1:06.02',
  '200 Breast LCM': '2:25.44',
  '100 Fly LCM': '57.32',
  '200 Fly LCM': '2:28.94',
  '200 IM LCM': '2:14.00',
  '400 IM LCM': '4:52.50',
};

const rowsOf = (seeds: ReturnType<typeof buildTheoreticalMeetSeeds>, teamName: string, gender: Gender) =>
  seeds.rows.filter(r => r.team === teamName && r.gender === gender);

/* -------------------------------------------------------------------------- */
/* The real inputs are what the tests think they are                           */
/* -------------------------------------------------------------------------- */

describe('fixtures', () => {
  it('parse to the rosters the tests rely on', () => {
    expect(OBU_M.teamName).toBe(OBU);
    expect(OBU_M.athletes.length).toBe(39);
    expect(OBU_F.athletes.length).toBe(23);
    expect(UWF_F.teamName).toBe(UWF);
    expect(UWF_F.athletes.length).toBe(27);
    expect(UWF_M.athletes.length).toBe(0);
  });

  it('give every athlete exactly the SCY and LCM swims in the real file', () => {
    const swims = swimsFor(OBU_M.athletes[0], OBU, Gender.MEN);
    const scy = Object.fromEntries(swims.filter(s => s.timeType === 'SCY' && s.isExtractedSplit !== true).map(s => [s.event, s.time]));
    for (const [event, time] of Object.entries(GOLDEN_SCY)) expect(scy[event]).toBe(time);
    const lcm = Object.fromEntries(swims.filter(s => s.timeType === 'LCM').map(s => [s.event, s.time]));
    for (const [event, time] of Object.entries(GOLDEN_LCM)) expect(lcm[event]).toBe(time);
  });
});

/* -------------------------------------------------------------------------- */
/* Seeds: course, absence, provenance                                          */
/* -------------------------------------------------------------------------- */

describe('seeds are all-time bests in the meet course only', () => {
  const seeds = buildTheoreticalMeetSeeds(meet());

  it('makes only SCY rows, with the recorded time, for the whole offered program', () => {
    expect(seeds.rows.length).toBe(20 * 14);
    for (const row of seeds.rows) {
      expect(row.event.endsWith(' SCY')).toBe(true);
      expect(row.time).toBe(GOLDEN_SCY[row.event]);
      expect(row.isPsychSheet).toBe(true);
      expect(row.isRelay).toBe(false);
      expect(row.roundSwam).toBe('Psych Sheet');
      expect(row.points).toBe(0);
      expect(seeds.sources.get(row.id)?.course).toBe('SCY');
    }
  });

  it('makes no row for an event the swimmer has no usable seed in, and says what it left out', () => {
    const noRows = new Set(['50 Breast SCY', '50 Fly SCY', '100 IM SCY']);
    expect(seeds.rows.some(r => noRows.has(r.event))).toBe(false);
    const first = seeds.report.teams[0].eventsChosenPerSwimmer[0];
    // 50 Breast and 50 Fly are extracted splits (not races). 100 IM and 50 Back are not in the championship program.
    expect([...first.unofferedSeeds].sort()).toEqual(['100 IM SCY', '50 Back SCY', '50 Breast SCY', '50 Fly SCY']);
  });

  it('makes no row for an event a real swimmer skipped', () => {
    const athlete = OBU_M.athletes[0];
    const swims = swimsFor(athlete, OBU, Gender.MEN).filter(s => s.event !== '200 Fly SCY');
    const out = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims }])] }));
    expect(out.rows.length).toBe(13);
    expect(out.rows.some(r => r.event === '200 Fly SCY')).toBe(false);
  });

  it('never uses a swim whose course is unknown, and says so', () => {
    const athlete = OBU_M.athletes[0];
    const swims = swimsFor(athlete, OBU, Gender.MEN).map(s => (s.event === '100 Free SCY' ? { ...s, timeType: undefined } : s));
    const out = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims }])] }));
    expect(out.rows.some(r => r.event === '100 Free SCY')).toBe(false);
    expect(out.report.teams[0].caveats.join(' ')).toMatch(/no recorded course/);
  });

  it('carries provenance on every row: swimmer id, capture id, retrieval time, the swim as recorded', () => {
    expect(seeds.sources.size).toBe(seeds.rows.length);
    const row = rowsOf(seeds, OBU, Gender.MEN)[0];
    const src = seeds.sources.get(row.id)!;
    expect(src.swimCloudSwimmerId).toBe(OBU_M.athletes[0].swimCloudSwimmerId);
    expect(src.captureId).toBe(`capture-${OBU}-0`);
    expect(src.retrievedAt).toBe(RETRIEVED);
    expect(src.sourceEvent).toBe(row.event);
    expect(src.seasonId).toBeDefined();
  });

  it('carries team, name and class year as the roster printed them', () => {
    const row = rowsOf(seeds, OBU, Gender.MEN)[0];
    expect(row.name).toBe(OBU_M.athletes[0].name);
    expect(row.classYear).toBe(OBU_M.athletes[0].classYear);
    expect(row.team).toBe(OBU);
    expect(seeds.psychMenResults.length).toBe(8 * 14);
    expect(seeds.psychWomenResults.length).toBe(12 * 14);
    expect(seeds.psychMenResults.every(r => r.gender === Gender.MEN)).toBe(true);
  });

  it('writes UNKNOWN for a class year the roster did not state', () => {
    const athlete = { ...OBU_M.athletes[0], classYear: 'unknown' as const };
    const out = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims: swimsFor(athlete, OBU, Gender.MEN) }])] }));
    expect(out.rows[0].classYear).toBe('UNKNOWN');
  });

  it('restricts to the meet program when one is given', () => {
    const out = buildTheoreticalMeetSeeds(meet({ meetProgram: new Set(['100 Freestyle', '200 Freestyle']) }));
    expect(new Set(out.rows.map(r => r.event))).toEqual(new Set(['100 Free SCY', '200 Free SCY']));
  });
});

/* -------------------------------------------------------------------------- */
/* Absent is not zero                                                          */
/* -------------------------------------------------------------------------- */

describe('no times captured is reported apart from no usable seed', () => {
  const athletes = OBU_M.athletes.slice(0, 4);
  const lcmOnly = swimsFor(athletes[2], OBU, Gender.MEN).filter(s => s.timeType === 'LCM');
  const input = meet({
    teams: [
      team(OBU, Gender.MEN, [
        { athlete: athletes[0], swims: undefined },
        { athlete: athletes[1], swims: swimsFor(athletes[1], OBU, Gender.MEN) },
        { athlete: athletes[2], swims: lcmOnly },
        { athlete: athletes[3], swims: [] },
      ]),
    ],
  });
  const out = buildTheoreticalMeetSeeds(input);
  const report = out.report.teams[0];

  it('lists the athlete with no times page as noTimesCaptured, not as a seed-less athlete', () => {
    expect(report.athletesWithNoTimes).toEqual([{ name: athletes[0].name, swimCloudSwimmerId: athletes[0].swimCloudSwimmerId }]);
    expect(report.athletesWithNoSeedInMeetCourse.some(a => a.name === athletes[0].name)).toBe(false);
  });

  it('lists a captured page with nothing in the meet course, and an empty page, as no seed in course', () => {
    expect(report.athletesWithNoSeedInMeetCourse).toEqual([
      { name: athletes[2].name, swimCloudSwimmerId: athletes[2].swimCloudSwimmerId, reason: 'no_swim_in_meet_course' },
      { name: athletes[3].name, swimCloudSwimmerId: athletes[3].swimCloudSwimmerId, reason: 'no_swim_in_meet_course' },
    ]);
  });

  it('makes rows for the one athlete who has seeds, and none (not a zero row) for the others', () => {
    expect(out.rows.length).toBe(14);
    expect(new Set(out.rows.map(r => r.name))).toEqual(new Set([athletes[1].name]));
    expect(report.rowsCreated).toBe(14);
    expect(out.rows.every(r => r.time !== '' && r.time !== '0' && r.time !== 'NT')).toBe(true);
  });

  it('reports an athlete whose only in-course swims are outside the program', () => {
    const athlete = athletes[0];
    const only100Im = swimsFor(athlete, OBU, Gender.MEN).filter(s => s.event === '100 IM SCY');
    expect(only100Im.length).toBe(1);
    const res = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims: only100Im }])] }));
    expect(res.rows.length).toBe(0);
    expect(res.report.teams[0].athletesWithNoSeedInMeetCourse[0].reason).toBe('no_event_in_program');
  });

  it('says so for an empty roster (the real "No rosters found" page) rather than returning silence', () => {
    const res = buildTheoreticalMeetSeeds(meet({ teams: [team(UWF, Gender.MEN, [])] }));
    expect(res.rows.length).toBe(0);
    expect(res.report.teams[0].caveats.join(' ')).toMatch(/lists no athletes/);
  });
});

/* -------------------------------------------------------------------------- */
/* Entry caps                                                                  */
/* -------------------------------------------------------------------------- */

describe('entries follow the scoring rules', () => {
  const perSwimmer = (out: ReturnType<typeof buildTheoreticalMeetSeeds>) => {
    const counts = new Map<string, number>();
    for (const r of out.rows) counts.set(`${r.team}|${r.gender}|${r.name}`, (counts.get(`${r.team}|${r.gender}|${r.name}`) ?? 0) + 1);
    return [...counts.values()];
  };

  it('NSISC: 7 total, per-type 999, so exactly 7 individual rows each', () => {
    expect(NSISC_PRESET_SETTINGS.maxTotalEntriesPerSwimmer).toBe(7);
    const out = buildTheoreticalMeetSeeds(meet({ scoringSettings: NSISC_PRESET_SETTINGS }));
    expect(out.rows.length).toBe(20 * 7);
    expect(new Set(perSwimmer(out))).toEqual(new Set([7]));
    expect(out.report.teams[0].caveats).toContain(TOTAL_CAP_CAVEAT);
  });

  it('NSISC: the 7 are the 7 strongest events, and the other 7 are listed as left out by the cap', () => {
    const out = buildTheoreticalMeetSeeds(meet({ scoringSettings: NSISC_PRESET_SETTINGS, teams: [team(OBU, Gender.MEN, withTimes(OBU_M.athletes, OBU, Gender.MEN, 1))] }));
    const swimmer = out.report.teams[0].eventsChosenPerSwimmer[0];
    expect(swimmer.events.length).toBe(14);
    expect(swimmer.events.filter(e => e.chosen).map(e => e.event)).toEqual([
      '100 Breast SCY',
      '200 IM SCY',
      '200 Breast SCY',
      '100 Free SCY',
      '100 Fly SCY',
      '100 Back SCY',
      '200 Back SCY',
    ]);
    expect(swimmer.events.slice(7).every(e => !e.chosen && e.notChosenReason === 'entry_cap')).toBe(true);
    expect(swimmer.events.every(e => (e.rowId !== undefined) === e.chosen)).toBe(true);
    expect(new Set(swimmer.events.filter(e => e.chosen).map(e => e.rowId))).toEqual(new Set(out.rows.map(r => r.id)));
  });

  it('a per-type individual cap of 3 gives 3 rows each', () => {
    const settings: ScoringSettings = { ...GENERIC_TOP16_SETTINGS, maxIndividualEntriesPerSwimmer: 3 };
    const out = buildTheoreticalMeetSeeds(meet({ scoringSettings: settings }));
    expect(out.rows.length).toBe(20 * 3);
    expect(new Set(perSwimmer(out))).toEqual(new Set([3]));
    // No total cap in these settings, so no total-cap caveat.
    expect(out.report.caveats).not.toContain(TOTAL_CAP_CAVEAT);
  });

  it('the tighter of a per-type cap and a total cap wins', () => {
    const a = buildTheoreticalMeetSeeds(meet({ scoringSettings: { ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: 4 } }));
    expect(new Set(perSwimmer(a))).toEqual(new Set([4]));
    const b = buildTheoreticalMeetSeeds(meet({ scoringSettings: { ...GENERIC_TOP16_SETTINGS, maxIndividualEntriesPerSwimmer: 9, maxTotalEntriesPerSwimmer: 2 } }));
    expect(new Set(perSwimmer(b))).toEqual(new Set([2]));
  });

  it('a team with no known division is ranked on raw time and says so', () => {
    const swims = (a: SwimCloudAthlete) => swimsFor(a, 'Nowhere University', Gender.MEN);
    const a = OBU_M.athletes[0];
    const out = buildTheoreticalMeetSeeds(meet({ scoringSettings: NSISC_PRESET_SETTINGS, teams: [team('Nowhere University', Gender.MEN, [{ athlete: a, swims: swims(a) }])] }));
    const chosen = out.report.teams[0].eventsChosenPerSwimmer[0].events.filter(e => e.chosen);
    expect(chosen.every(e => e.rankBasis === 'time')).toBe(true);
    expect(out.report.teams[0].caveats.join(' ')).toMatch(/ranked by raw time/);
    // The known D2 team is ranked against the published cut.
    const known = buildTheoreticalMeetSeeds(meet({ scoringSettings: NSISC_PRESET_SETTINGS, teams: [team(OBU, Gender.MEN, [{ athlete: a, swims: swimsFor(a, OBU, Gender.MEN) }])] }));
    expect(known.report.teams[0].eventsChosenPerSwimmer[0].events.some(e => e.rankBasis === 'cut_distance')).toBe(true);
    expect(known.report.teams[0].caveats.join(' ')).not.toMatch(/ranked by raw time/);
  });
});

/* -------------------------------------------------------------------------- */
/* One swimmer, one team                                                       */
/* -------------------------------------------------------------------------- */

describe('a swimmer on two rosters enters once, for the first team given', () => {
  // Constructed: a real 412 athlete placed on the West Florida women's list too, as a transfer would be.
  const moved: SwimCloudAthlete = { ...OBU_F.athletes[0], gender: Gender.WOMEN };
  const build = (first: 'OBU' | 'UWF') => {
    const obu = team(OBU, Gender.WOMEN, withTimes(OBU_F.athletes, OBU, Gender.WOMEN, 3));
    const uwf = team(UWF, Gender.WOMEN, [{ athlete: moved, swims: swimsFor(moved, UWF, Gender.WOMEN) }, ...withTimes(UWF_F.athletes, UWF, Gender.WOMEN, 2)]);
    return buildTheoreticalMeetSeeds(meet({ teams: first === 'OBU' ? [obu, uwf] : [uwf, obu] }));
  };

  it('makes the rows under the first team only, and reports the second team with both names', () => {
    const out = build('OBU');
    const movedRows = out.rows.filter(r => r.name === moved.name);
    expect(movedRows.length).toBe(14);
    expect(new Set(movedRows.map(r => r.team))).toEqual(new Set([OBU]));
    expect(out.report.teams[0].duplicateAcrossTeams).toEqual([]);
    expect(out.report.teams[1].duplicateAcrossTeams).toEqual([
      { name: moved.name, swimCloudSwimmerId: moved.swimCloudSwimmerId, enteredForTeam: OBU, skippedForTeam: UWF },
    ]);
    expect(out.report.teams[1].rowsCreated).toBe(2 * 14);
  });

  it('follows the order given: swap the teams and the other team keeps the swimmer', () => {
    const out = build('UWF');
    expect(new Set(out.rows.filter(r => r.name === moved.name).map(r => r.team))).toEqual(new Set([UWF]));
    expect(out.report.teams[1].duplicateAcrossTeams).toEqual([
      { name: moved.name, swimCloudSwimmerId: moved.swimCloudSwimmerId, enteredForTeam: UWF, skippedForTeam: OBU },
    ]);
  });

  it('does not merge two names that match when there is no shared id', () => {
    const noId = (a: SwimCloudAthlete): SwimCloudAthlete => {
      const copy: { -readonly [K in keyof SwimCloudAthlete]: SwimCloudAthlete[K] } = { ...a };
      delete copy.swimCloudSwimmerId;
      return copy;
    };
    const a = noId(OBU_F.athletes[0]);
    const b = noId(OBU_F.athletes[0]);
    const swims = (name: string, teamName: string) => swimsFor({ ...OBU_F.athletes[0], name }, teamName, Gender.WOMEN);
    const out = buildTheoreticalMeetSeeds(
      meet({
        teams: [
          team(OBU, Gender.WOMEN, [{ athlete: a, swims: swims(a.name, OBU) }, { athlete: b, swims: swims(b.name, OBU) }]),
          team(UWF, Gender.WOMEN, [{ athlete: a, swims: swims(a.name, UWF) }]),
        ],
      })
    );
    expect(out.report.teams.every(t => t.duplicateAcrossTeams.length === 0)).toBe(true);
    expect(out.rows.length).toBe(3 * 14);
    expect(new Set(out.rows.map(r => r.id)).size).toBe(out.rows.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Ids                                                                         */
/* -------------------------------------------------------------------------- */

describe('row ids', () => {
  const seeds = buildTheoreticalMeetSeeds(meet());

  it('are unique across teams, genders and events', () => {
    expect(new Set(seeds.rows.map(r => r.id)).size).toBe(seeds.rows.length);
  });

  it('are stable: the same input gives the same ids in the same order', () => {
    const again = buildTheoreticalMeetSeeds(meet());
    expect(again.rows.map(r => r.id)).toEqual(seeds.rows.map(r => r.id));
    expect(again.rows).toEqual(seeds.rows);
  });

  it('change with the meet id, so two workspaces never share a psych row id', () => {
    const other = buildTheoreticalMeetSeeds(meet({ meetId: 'ws-tm-2' }));
    const ids = new Set(seeds.rows.map(r => r.id));
    expect(other.rows.some(r => ids.has(r.id))).toBe(false);
  });

  it('can be predicted from the parts', () => {
    const row = rowsOf(seeds, OBU, Gender.MEN)[0];
    expect(row.id).toBe(
      theoreticalSeedRowId({ meetId: 'ws-tm-1', gender: Gender.MEN, teamName: OBU, swimmerKey: `sc:${OBU_M.athletes[0].swimCloudSwimmerId}`, event: row.event })
    );
  });

  it('stay unique for two athletes of one name and no id on one roster', () => {
    const noId = { ...OBU_M.athletes[0] } as { -readonly [K in keyof SwimCloudAthlete]: SwimCloudAthlete[K] };
    delete noId.swimCloudSwimmerId;
    const swims = swimsFor(OBU_M.athletes[0], OBU, Gender.MEN);
    const out = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete: noId, swims }, { athlete: noId, swims }])] }));
    expect(out.rows.length).toBe(28);
    expect(new Set(out.rows.map(r => r.id)).size).toBe(28);
  });
});

/* -------------------------------------------------------------------------- */
/* Caveats                                                                     */
/* -------------------------------------------------------------------------- */

describe('the all-time-best caveat', () => {
  it('is present when seeds are older than the roster season (the real file spans seasons 21 to 29)', () => {
    const out = buildTheoreticalMeetSeeds(meet());
    for (const t of out.report.teams) expect(t.caveats.some(c => c.startsWith(ALL_TIME_BEST_CAVEAT))).toBe(true);
    expect(out.report.caveats.some(c => c.startsWith(ALL_TIME_BEST_CAVEAT))).toBe(true);
    expect(out.report.caveats).toContain(RELAYS_EXCLUDED_CAVEAT);
  });

  it('is present when the roster season is not known', () => {
    const swims = withTimes(OBU_M.athletes, OBU, Gender.MEN, 1);
    const out = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, swims, null)] }));
    expect(out.report.teams[0].caveats.join(' ')).toMatch(/overstate a swimmer who has since slowed.*not known/);
  });

  it('is present when a seed has no season id', () => {
    const athlete = OBU_M.athletes[0];
    const swims = swimsFor(athlete, OBU, Gender.MEN).map(s => {
      const { seasonId: _seasonId, ...rest } = s;
      return rest;
    });
    const out = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims }], '29')] }));
    expect(out.report.teams[0].caveats.some(c => c.startsWith(ALL_TIME_BEST_CAVEAT))).toBe(true);
  });

  it('is left out only when every seed is proven to be from the roster season or later', () => {
    const athlete = OBU_M.athletes[0];
    const swims = swimsFor(athlete, OBU, Gender.MEN).filter(s => s.seasonId === '29');
    expect(swims.length).toBeGreaterThan(0);
    const out = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims }], '29')] }));
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.report.teams[0].caveats.some(c => c.startsWith(ALL_TIME_BEST_CAVEAT))).toBe(false);
    // The same seeds against a later roster season are older again.
    const later = buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims }], '30')] }));
    expect(later.report.teams[0].caveats.some(c => c.startsWith(ALL_TIME_BEST_CAVEAT))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Course                                                                      */
/* -------------------------------------------------------------------------- */

describe('swapping the meet course changes the rows', () => {
  const scy = buildTheoreticalMeetSeeds(meet());
  const lcm = buildTheoreticalMeetSeeds(meet({ course: 'LCM' }));

  it('LCM makes LCM rows with the swim exactly as recorded, never a converted time', () => {
    expect(lcm.rows.length).toBe(20 * 14);
    for (const row of lcm.rows) {
      expect(row.event.endsWith(' LCM')).toBe(true);
      expect(row.time).toBe(GOLDEN_LCM[row.event]);
      expect(lcm.sources.get(row.id)?.course).toBe('LCM');
      expect(lcm.sources.get(row.id)?.sourceEvent).toBe(row.event);
    }
    // The 500 Free SCY slot is the 400 Free LCM swim; the SCY time must not appear on an LCM row.
    expect(lcm.rows.some(r => r.event === '400 Free LCM' && r.time === '4:48.31')).toBe(true);
    expect(lcm.rows.some(r => r.event.includes('SCY'))).toBe(false);
  });

  it('the two courses share no row id and no event label, and LCM says it ranked on an estimate', () => {
    const scyIds = new Set(scy.rows.map(r => r.id));
    expect(lcm.rows.some(r => scyIds.has(r.id))).toBe(false);
    expect(lcm.report.caveats).toContain(RANKED_ON_ESTIMATE_CAVEAT);
    expect(scy.report.caveats).not.toContain(RANKED_ON_ESTIMATE_CAVEAT);
  });

  it('SCM makes no row for a swimmer with no SCM swim, and lists them rather than staying silent', () => {
    const scm = buildTheoreticalMeetSeeds(meet({ course: 'SCM' }));
    expect(scm.rows.length).toBe(0);
    for (const t of scm.report.teams) {
      expect(t.athletesWithNoTimes.length).toBe(0);
      expect(t.athletesWithNoSeedInMeetCourse.every(a => a.reason === 'no_swim_in_meet_course')).toBe(true);
    }
    expect(scm.report.teams.map(t => t.athletesWithNoSeedInMeetCourse.length)).toEqual([8, 6, 6]);
  });

  it('knows exactly three courses', () => {
    expect([...THEORETICAL_MEET_COURSES]).toEqual(['SCY', 'LCM', 'SCM']);
  });
});

/* -------------------------------------------------------------------------- */
/* Fails loudly                                                                */
/* -------------------------------------------------------------------------- */

describe('bad input throws TheoreticalMeetError', () => {
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      if (e instanceof TheoreticalMeetError) return e.code;
      throw e;
    }
    return undefined;
  };
  const one = (over: Partial<TheoreticalMeetTeamInput> = {}) => ({ ...team(OBU, Gender.MEN, withTimes(OBU_M.athletes, OBU, Gender.MEN, 1)), ...over });

  it('a team gender the meet does not know', () => {
    expect(code(() => buildTheoreticalMeetSeeds(meet({ teams: [one({ gender: 'M' as unknown as Gender })] })))).toBe('unknown-team-gender');
    expect(code(() => buildTheoreticalMeetSeeds(meet({ teams: [one({ gender: undefined as unknown as Gender })] })))).toBe('unknown-team-gender');
  });

  it('a meet course that is not SCY, LCM or SCM', () => {
    expect(code(() => buildTheoreticalMeetSeeds(meet({ course: 'LCY' as never })))).toBe('unknown-course');
    expect(code(() => buildTheoreticalMeetSeeds(meet({ course: undefined as never })))).toBe('unknown-course');
  });

  it('scoring settings with no individual cap', () => {
    const { maxIndividualEntriesPerSwimmer: _drop, ...noCap } = NSISC_PRESET_SETTINGS;
    expect(code(() => buildTheoreticalMeetSeeds(meet({ scoringSettings: noCap as ScoringSettings })))).toBe('invalid-scoring-settings');
    expect(code(() => buildTheoreticalMeetSeeds(meet({ scoringSettings: undefined as never })))).toBe('invalid-scoring-settings');
  });

  it('a cap that is not a whole number of 1 or more', () => {
    for (const bad of [0, -1, 2.5, Number.NaN, '7' as unknown as number]) {
      expect(code(() => buildTheoreticalMeetSeeds(meet({ scoringSettings: { ...NSISC_PRESET_SETTINGS, maxTotalEntriesPerSwimmer: bad } })))).toBe('invalid-scoring-settings');
      expect(code(() => buildTheoreticalMeetSeeds(meet({ scoringSettings: { ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: bad } })))).toBe('invalid-scoring-settings');
    }
  });

  it('an athlete with no usable name', () => {
    for (const name of ['', '   ', undefined as unknown as string]) {
      const athlete = { ...OBU_M.athletes[0], name };
      expect(code(() => buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, [{ athlete, swims: undefined }])] })))).toBe('athlete-without-name');
    }
  });

  it('a roster athlete or a swim of the other gender', () => {
    const women = withTimes(OBU_F.athletes, OBU, Gender.WOMEN, 1);
    expect(code(() => buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.MEN, women)] })))).toBe('athlete-gender-mismatch');
    const athlete = { ...OBU_M.athletes[0] };
    const menSwims = swimsFor(athlete, OBU, Gender.MEN);
    expect(code(() => buildTheoreticalMeetSeeds(meet({ teams: [team(OBU, Gender.WOMEN, [{ athlete: { ...athlete, gender: 'unknown' }, swims: menSwims }])] })))).toBe('swim-gender-mismatch');
  });

  it('an empty meet id, an empty team name, and the same team twice', () => {
    expect(code(() => buildTheoreticalMeetSeeds(meet({ meetId: ' ' })))).toBe('invalid-input');
    expect(code(() => buildTheoreticalMeetSeeds(meet({ teams: [one({ teamName: '' })] })))).toBe('invalid-input');
    expect(code(() => buildTheoreticalMeetSeeds(meet({ teams: [one(), one({ teamName: ' ouachita baptist university ' })] })))).toBe('duplicate-team');
  });

  it('does not throw for the same team with the other gender', () => {
    expect(code(() => buildTheoreticalMeetSeeds(meet()))).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The rows feed the psych pipeline                                            */
/* -------------------------------------------------------------------------- */

describe('golden: the rows feed the existing psych pipeline', () => {
  const seeds = buildTheoreticalMeetSeeds(meet({ scoringSettings: NSISC_PRESET_SETTINGS }));
  const settings = mergeScoringSettings(NSISC_PRESET_SETTINGS);

  it('buildPsychExpectedRows takes every row, once, with a rank and points from the real tables', () => {
    const expected = buildPsychExpectedRows([...seeds.psychWomenResults], settings);
    expect(expected.length).toBe(seeds.psychWomenResults.length);
    expect(new Set(expected.map(r => r.team))).toEqual(new Set([OBU, UWF]));
    expect(expected.every(r => r.isPsychSheet === true && r.rank >= 1)).toBe(true);
    // 12 swimmers in one event: ranks run 1..12 with no gap.
    const hundredFree = expected.filter(r => r.event === '100 Free SCY');
    expect(hundredFree.length).toBe(12);
    expect(hundredFree.map(r => r.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(hundredFree.filter(r => Number(r.points) > 0).length).toBeGreaterThan(0);
  });

  it('buildPsychProjectedBundle scores a workspace holding the rows without throwing', () => {
    const workspace = {
      id: 'ws-tm-1',
      name: 'Theoretical',
      createdAt: 0,
      menResults: [],
      womenResults: [],
      recruits: [],
      scoringSettings: NSISC_PRESET_SETTINGS,
      psychMenResults: [...seeds.psychMenResults],
      psychWomenResults: [...seeds.psychWomenResults],
    } as unknown as Workspace;
    expect(hasPsychData(workspace)).toBe(true);
    const women = buildPsychProjectedBundle({ workspace, gender: Gender.WOMEN });
    const men = buildPsychProjectedBundle({ workspace, gender: Gender.MEN });
    expect(women.allResults.length).toBe(seeds.psychWomenResults.length);
    expect(men.allResults.length).toBe(seeds.psychMenResults.length);
    expect(women.sortedTeams.map(t => t.teamName).sort()).toEqual([OBU, UWF].sort());
    expect(men.sortedTeams.map(t => t.teamName)).toEqual([OBU]);
  });
});
