/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Exhibition swims, from the SwimCloud fastest-times JSON to the theoretical meet.
 *
 * ```
 * row.exhibition === true
 *   -> SwimCloudPersonalBestSwim.isExhibition   (packages/swimcloud/src/parser.ts)
 *   -> HistoricalSwim.isExhibition              (swimCloudImportBridge.ts)
 *   -> survives mergeHistoryIndex and a JSON round trip
 *   -> theoretical seeds: labelled, counted, optionally excluded
 * ```
 *
 * ## Fixtures
 *
 * `tests/fixtures/profile_fastest_times-1330318.json` is the real response (swimmer 1330318, a man). It
 * holds exactly one exhibition row: 2025-10-10, Little Rock Fall Invite, 100 IM SCY, 53.27. Every other
 * row says `exhibition: false`. The 100 IM is not in the standard championship program, so it seeds only
 * when the meet program names it. The tests build that program from the canonical labels of the real
 * events plus the 100 IM.
 *
 * Rosters are the real trimmed Ouachita Baptist roster page (team 412, men). Constructed inputs are said
 * so where used: a row with the field removed or set to a non-boolean, and swims built to show a tie or a
 * slower official swim in the same event.
 */
import { describe, expect, it } from 'vitest';

import { parseSwimmerFastestTimesJson, parseTeamRosterHtml } from '../packages/swimcloud/src/parser';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import { swimCloudSwimmerTimesToHistoricalSwims } from '../packages/manager/src/lib/swimCloudImportBridge';
import {
  TheoreticalMeetError,
  buildTheoreticalMeetSeeds,
  exhibitionExcludedCaveat,
  exhibitionIncludedCaveat,
  type TheoreticalMeetInput,
  type TheoreticalMeetSeeds,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { buildTheoreticalMeetWorkspace } from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import { Gender, type HistoricalSwim } from '../packages/core/src/types';
import { GENERIC_TOP16_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { canonicalMeetEventLabel, mergeHistoryIndex } from '../packages/core/src/lib/athleteHistory';
import { SWIMMER_BODY, rosterPage } from './helpers/multiTeamDriverHarness';

const RETRIEVED = '2026-10-03T12:00:00.000Z';
const OBU = 'Ouachita Baptist University';
const CONTEXT = {
  sourceUrl: 'https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/',
  retrievedAt: RETRIEVED,
  track: 'browser-extension' as const,
};

type Row = Record<string, unknown>;
const RAW_ROWS = JSON.parse(SWIMMER_BODY) as Row[];

function parseBody(body: string) {
  const parsed = parseSwimmerFastestTimesJson(body, CONTEXT);
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return parsed.data;
}

function swimsOf(body: string, name = 'Test Swimmer', gender = Gender.MEN): HistoricalSwim[] {
  const converted = swimCloudSwimmerTimesToHistoricalSwims({ ...parseBody(body), name }, { team: OBU, gender, retrievedAt: RETRIEVED });
  if (!converted.ok) throw new Error(converted.message);
  return [...converted.swims];
}

const obuMen = ((): readonly SwimCloudAthlete[] => {
  const parsed = parseTeamRosterHtml(rosterPage('412', 'M'), {
    sourceUrl: 'https://www.swimcloud.com/team/412/roster/?gender=M',
    retrievedAt: RETRIEVED,
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error('roster fixture does not parse');
  return parsed.data.athletes;
})();

/* -------------------------------------------------------------------------- */
/* E2: the parser                                                              */
/* -------------------------------------------------------------------------- */

describe('parser: exhibition on the real fastest-times fixture', () => {
  it('the file holds exactly one exhibition row, and the parser flags exactly that swim', () => {
    expect(RAW_ROWS.filter(r => r['exhibition'] === true)).toHaveLength(1);
    const flagged = parseBody(SWIMMER_BODY).personalBests.filter(p => p.isExhibition === true);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ eventLabel: '100 IM SCY', time: '53.27', date: '2025-10-10', seasonId: '29' });
  });

  it('never writes the flag on any other row (the key is absent, not false)', () => {
    const others = parseBody(SWIMMER_BODY).personalBests.filter(p => !(p.eventLabel === '100 IM SCY' && p.time === '53.27'));
    expect(others.length).toBeGreaterThan(30);
    for (const p of others) expect('isExhibition' in p).toBe(false);
  });

  it('constructed: a missing field, false, and non-boolean values are not flagged', () => {
    const rows = RAW_ROWS.map(r => ({ ...r }));
    const exhibitionIndex = rows.findIndex(r => r['exhibition'] === true);
    // Constructed variants on rows the real file marks `false`.
    const plain = rows.map((r, i) => i).filter(i => i !== exhibitionIndex && rows[i]['stroke'] !== 'H' && rows[i]['eventstroke'] !== 'H');
    delete rows[plain[0]]['exhibition']; // field missing
    rows[plain[1]]['exhibition'] = 'true'; // string
    rows[plain[2]]['exhibition'] = 1; // number
    rows[plain[3]]['exhibition'] = null; // null
    const data = parseBody(JSON.stringify(rows));
    const flagged = data.personalBests.filter(p => 'isExhibition' in p);
    expect(flagged.map(p => `${p.eventLabel} ${p.time}`)).toEqual(['100 IM SCY 53.27']);
  });
});

/* -------------------------------------------------------------------------- */
/* E3: the converter and the merges                                            */
/* -------------------------------------------------------------------------- */

describe('converter and merge survival', () => {
  it('carries isExhibition: true onto exactly the one HistoricalSwim, and no other swim has the key', () => {
    const swims = swimsOf(SWIMMER_BODY);
    const flagged = swims.filter(s => s.isExhibition === true);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ event: '100 IM SCY', time: '53.27', timeType: 'SCY' });
    expect(swims.filter(s => 'isExhibition' in s)).toHaveLength(1);
  });

  it('mergeHistoryIndex keeps the flag on the swim it keeps', () => {
    const swims = swimsOf(SWIMMER_BODY);
    const merged = mergeHistoryIndex([], swims);
    expect(merged.filter(s => s.isExhibition === true).map(s => s.event)).toEqual(['100 IM SCY']);
    // Constructed: a slower official 100 IM already stored; the faster exhibition swim wins and keeps its flag.
    const official: HistoricalSwim = { ...swims.find(s => s.isExhibition === true)!, time: '55.00' };
    delete (official as { isExhibition?: boolean }).isExhibition;
    const again = mergeHistoryIndex([official], swims);
    const im = again.filter(s => s.event === '100 IM SCY');
    expect(im).toHaveLength(1);
    expect(im[0]).toMatchObject({ time: '53.27', isExhibition: true });
    // And the other way round: an official swim that is faster than the exhibition one wins without the flag.
    const fasterOfficial: HistoricalSwim = { ...official, time: '52.00' };
    const other = mergeHistoryIndex(swims, [fasterOfficial]).filter(s => s.event === '100 IM SCY');
    expect(other).toHaveLength(1);
    expect(other[0].time).toBe('52.00');
    expect('isExhibition' in other[0]).toBe(false);
  });

  it('survives the JSON the workspace persists (positional rows, passthrough schema)', () => {
    const round = JSON.parse(JSON.stringify(swimsOf(SWIMMER_BODY))) as HistoricalSwim[];
    expect(round.filter(s => s.isExhibition === true)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* E4/E5: the seed builder                                                     */
/* -------------------------------------------------------------------------- */

/** Canonical labels of the real SCY events plus the 100 IM, so the exhibition 100 IM can seed. */
const PROGRAM = new Set(
  ['50 Free', '100 Free', '200 Free', '500 Free', '1000 Free', '1650 Free', '100 Back', '200 Back', '100 Breast', '200 Breast', '100 Fly', '200 Fly', '200 IM', '400 IM', '100 IM']
    .map(label => canonicalMeetEventLabel(`${label} SCY`))
    .filter((l): l is string => l !== null)
);
const NO_CAP = { ...GENERIC_TOP16_SETTINGS, maxIndividualEntriesPerSwimmer: 999 };

function menTeam(count: number, swimsFor: (a: SwimCloudAthlete) => HistoricalSwim[] | undefined = a => swimsOf(SWIMMER_BODY, a.name)) {
  return {
    teamName: OBU,
    gender: Gender.MEN,
    rosterStatus: 'parsed' as const,
    rosterSeasonId: '29',
    athletes: obuMen.slice(0, count).map((athlete, i) => ({ athlete, swims: swimsFor(athlete), captureId: `cap-${i}`, retrievedAt: RETRIEVED })),
  };
}

const meet = (over: Partial<TheoreticalMeetInput> = {}): TheoreticalMeetInput => ({
  meetId: 'ws-tm-ex',
  course: 'SCY',
  scoringSettings: NO_CAP,
  meetProgram: PROGRAM,
  teams: [menTeam(2)],
  ...over,
});

const eventsOf = (seeds: TheoreticalMeetSeeds) => seeds.rows.map(r => r.event);

describe('seed builder: include (the default)', () => {
  const seeds = buildTheoreticalMeetSeeds(meet());
  const team = seeds.report.teams[0];

  it('seeds the exhibition 100 IM and counts it', () => {
    expect(eventsOf(seeds).filter(e => e === '100 IM SCY')).toHaveLength(2);
    expect(team.rowsCreated).toBe(30);
    expect(team.exhibitionSeedsUsed).toBe(2);
    expect(team.exhibitionEventsExcluded).toBe(0);
  });

  it("an unset option behaves as 'include'", () => {
    const explicit = buildTheoreticalMeetSeeds(meet({ exhibitionSeeds: 'include' }));
    expect(explicit.rows).toEqual(seeds.rows);
    expect(explicit.report).toEqual(seeds.report);
  });

  it('marks isExhibition on the chosen candidate and on the row source, and nowhere else', () => {
    for (const swimmer of team.eventsChosenPerSwimmer) {
      const flagged = swimmer.events.filter(e => e.isExhibition === true);
      expect(flagged.map(e => [e.event, e.time, e.chosen])).toEqual([['100 IM SCY', '53.27', true]]);
      expect(swimmer.events.filter(e => 'isExhibition' in e && e.isExhibition !== true)).toEqual([]);
      expect(swimmer.excludedExhibitionEvents).toBeUndefined();
    }
    const flaggedRows = seeds.rows.filter(r => seeds.sources.get(r.id)?.isExhibition === true);
    expect(flaggedRows.map(r => r.event)).toEqual(['100 IM SCY', '100 IM SCY']);
    for (const r of seeds.rows) {
      if (r.event !== '100 IM SCY') expect('isExhibition' in (seeds.sources.get(r.id) as object)).toBe(false);
      expect(r.isExhibition).toBeUndefined(); // the scoring row is a plain seed, never an exhibition row
    }
  });

  it('adds the team caveat, and the meet caveat with the all-team total', () => {
    expect(team.caveats).toContain('2 of 30 seeds come from exhibition swims (not scored in their meet). They are included.');
    expect(team.caveats).toContain(exhibitionIncludedCaveat(2, 30));
    expect(seeds.report.caveats).toContain('All teams: 2 of 30 seeds come from exhibition swims (not scored in their meet). They are included.');
  });

  it('the meet total adds up across two teams of the same numbers', () => {
    const two = buildTheoreticalMeetSeeds(
      meet({ teams: [menTeam(2), { ...menTeam(2), teamName: 'Henderson State University', athletes: obuMen.slice(2, 4).map((athlete, i) => ({ athlete, swims: swimsOf(SWIMMER_BODY, athlete.name), captureId: `h-${i}` })) }] })
    );
    expect(two.report.teams.map(t => t.exhibitionSeedsUsed)).toEqual([2, 2]);
    expect(two.report.caveats).toContain(`All teams: ${exhibitionIncludedCaveat(4, 60)}`);
  });

  it('says nothing when the program does not offer the exhibition event (the standard program has no 100 IM)', () => {
    const standard = buildTheoreticalMeetSeeds(meet({ meetProgram: null }));
    expect(standard.report.teams[0].exhibitionSeedsUsed).toBe(0);
    expect(eventsOf(standard)).not.toContain('100 IM SCY');
    expect(standard.report.caveats.some(c => /exhibition/i.test(c))).toBe(false);
  });
});

describe("seed builder: exhibitionSeeds 'exclude'", () => {
  const included = buildTheoreticalMeetSeeds(meet());
  const excluded = buildTheoreticalMeetSeeds(meet({ exhibitionSeeds: 'exclude' }));
  const team = excluded.report.teams[0];

  it('drops the exhibition event: it has NO seed, and nothing replaces it', () => {
    expect(eventsOf(excluded)).not.toContain('100 IM SCY');
    expect(team.rowsCreated).toBe(28);
    expect(team.exhibitionSeedsUsed).toBe(0);
    expect(team.exhibitionEventsExcluded).toBe(2);
    expect(team.eventsChosenPerSwimmer.map(s => s.excludedExhibitionEvents)).toEqual([['100 IM SCY'], ['100 IM SCY']]);
  });

  it('every other row is identical to the include build', () => {
    expect(excluded.rows).toEqual(included.rows.filter(r => r.event !== '100 IM SCY'));
    for (const r of excluded.rows) expect('isExhibition' in (excluded.sources.get(r.id) as object)).toBe(false);
  });

  it('adds the excluded caveat at team and meet level', () => {
    expect(team.caveats).toContain(exhibitionExcludedCaveat(2));
    expect(team.caveats.some(c => c.includes('are included'))).toBe(false);
    expect(excluded.report.caveats).toContain(`All teams: ${exhibitionExcludedCaveat(2)}`);
    expect(exhibitionExcludedCaveat(2)).toContain('NO seed');
  });

  it('excluding changes nothing when the exhibition event is not in the program, and says nothing', () => {
    const noProgram = buildTheoreticalMeetSeeds(meet({ meetProgram: null, exhibitionSeeds: 'exclude' }));
    expect(noProgram.report.teams[0].exhibitionEventsExcluded).toBe(0);
    expect(noProgram.report.caveats.some(c => /exhibition/i.test(c))).toBe(false);
  });

  it('a swimmer whose only swim is the exhibition one has no seed and the report names the dropped event', () => {
    const only = (a: SwimCloudAthlete) => swimsOf(SWIMMER_BODY, a.name).filter(s => s.event === '100 IM SCY');
    expect(only(obuMen[0])).toHaveLength(1);
    const incl = buildTheoreticalMeetSeeds(meet({ teams: [menTeam(1, only)] }));
    expect(eventsOf(incl)).toEqual(['100 IM SCY']);
    const excl = buildTheoreticalMeetSeeds(meet({ teams: [menTeam(1, only)], exhibitionSeeds: 'exclude' }));
    expect(excl.rows).toHaveLength(0);
    expect(excl.report.teams[0].athletesWithNoSeedInMeetCourse).toEqual([
      expect.objectContaining({ name: obuMen[0].name, reason: 'all_seeds_exhibition_excluded', excludedExhibitionEvents: ['100 IM SCY'] }),
    ]);
  });

  it('constructed: exhibition swims only in an event outside the meet program give no_event_in_program, not all_seeds_exhibition_excluded', () => {
    // The reason is keyed on the exhibition-seeded events the program would have offered. A swimmer whose only
    // swims are exhibition swims in an event the meet does not hold would get no seed with the swims back in
    // either, so the exhibition rule is not the cause.
    const exhibitionSwim: HistoricalSwim = {
      name: 'x',
      team: OBU,
      gender: Gender.MEN,
      event: '1000 Free SCY',
      time: '9:50.00',
      timeType: 'SCY',
      source: 'swimcloud',
      isExhibition: true,
    };
    const program = new Set([...PROGRAM].filter(e => e !== canonicalMeetEventLabel('1000 Free SCY')));
    expect(program.size).toBe(PROGRAM.size - 1);
    const out = buildTheoreticalMeetSeeds(meet({ teams: [menTeam(1, () => [exhibitionSwim])], meetProgram: program, exhibitionSeeds: 'exclude' }));
    expect(out.rows).toHaveLength(0);
    const [noSeed] = out.report.teams[0].athletesWithNoSeedInMeetCourse;
    expect(noSeed).toMatchObject({ name: obuMen[0].name, reason: 'no_event_in_program' });
    expect(noSeed).not.toHaveProperty('excludedExhibitionEvents');
    expect(out.report.teams[0].exhibitionEventsExcluded).toBe(0);
  });

  it('rejects an unknown mode loudly', () => {
    try {
      buildTheoreticalMeetSeeds(meet({ exhibitionSeeds: 'drop' as never }));
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TheoreticalMeetError);
      expect((e as TheoreticalMeetError).code).toBe('invalid-input');
    }
  });
});

describe('seed builder: constructed ties and a slower official swim', () => {
  const swim = (time: string, exhibition: boolean): HistoricalSwim => ({
    name: 'x',
    team: OBU,
    gender: Gender.MEN,
    event: '100 Free SCY',
    time,
    timeType: 'SCY',
    source: 'swimcloud',
    ...(exhibition ? { isExhibition: true } : {}),
  });
  const run = (swims: HistoricalSwim[], mode?: 'include' | 'exclude') =>
    buildTheoreticalMeetSeeds(meet({ teams: [menTeam(1, () => swims)], ...(mode === undefined ? {} : { exhibitionSeeds: mode }) }));

  it('the same event and time on an exhibition and an official swim is backed by the official swim: not labelled', () => {
    const out = run([swim('45.00', true), swim('45.00', false)]);
    expect(out.rows).toHaveLength(1);
    expect(out.report.teams[0].exhibitionSeedsUsed).toBe(0);
    expect(out.sources.get(out.rows[0].id)).not.toHaveProperty('isExhibition');
  });

  it("'exclude' falls to a slower official swim in the same event, and that is not a dropped event", () => {
    const out = run([swim('44.00', true), swim('45.00', false)], 'exclude');
    expect(out.rows.map(r => r.time)).toEqual(['45.00']);
    expect(out.report.teams[0].exhibitionEventsExcluded).toBe(0);
    expect(out.report.caveats.some(c => /exhibition/i.test(c))).toBe(false);
  });

  it("'include' seeds the faster exhibition swim and labels it", () => {
    const out = run([swim('44.00', true), swim('45.00', false)]);
    expect(out.rows.map(r => r.time)).toEqual(['44.00']);
    expect(out.report.teams[0].exhibitionSeedsUsed).toBe(1);
  });
});

describe('workspace builder carries the exhibition facts through', () => {
  it('keeps the seed caveats (with the exhibition line) and the provenance flag; rows stay plain scored swims', () => {
    const seeds = buildTheoreticalMeetSeeds(meet());
    const build = buildTheoreticalMeetWorkspace({ workspaceId: 'ws-tm-ex', createdAt: 1_760_000_000_000, seeds, scoringSettings: NO_CAP });
    expect(build.caveats).toContain('All teams: 2 of 30 seeds come from exhibition swims (not scored in their meet). They are included.');
    expect(build.caveats).toContain(exhibitionIncludedCaveat(2, 30));
    const flagged = [...build.sources.entries()].filter(([, s]) => s.isExhibition === true);
    expect(flagged).toHaveLength(2);
    expect(flagged.every(([id]) => id.endsWith(encodeURIComponent('100 IM SCY')))).toBe(true);
    for (const r of [...build.payload.menResults, ...build.payload.womenResults]) expect(r.isExhibition).toBeUndefined();
    expect(build.report.teams[0].exhibitionSeedsUsed).toBe(2);
  });
});
