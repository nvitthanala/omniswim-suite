/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase U1a: `theoreticalMeetFromCaptures`
 * (packages/manager/src/lib/theoreticalMeetFromCaptures.ts).
 *
 * ## Where the values come from
 *
 * Rosters, the season table and the times are real SwimCloud pages that other
 * test files already use, run through the real parsers:
 * - `tests/fixtures/swimcloud/team-412-roster-gender-{M,F}-page.html` (Ouachita Baptist University),
 * - `tests/fixtures/swimcloud/team-10002824-roster-gender-M-page.html`, the real "No rosters found" page
 *   (the University of West Florida fields no men's program),
 * - `tests/fixtures/swimcloud/team-412-roster-gender-F-season-form.html`, the real season select,
 * - `tests/fixtures/profile_fastest_times-1330318.json`, a real swimmer-times response.
 *
 * What is constructed, and said so: the capture records (page lists, completeness, plan counts) and the
 * pairing of one real times response with a roster athlete's id. The full pipeline over a real capture is
 * `tests/theoreticalMeetGolden.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSwimmerFastestTimesJson, parseTeamRosterHtml } from '../packages/swimcloud/src/parser';
import type { SwimCloudRosterParse, SwimCloudSwimmerTimesParse } from '../packages/swimcloud/src/parser';
import { Gender } from '../packages/core/src/types';
import { GENERIC_TOP16_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import {
  TheoreticalCaptureError,
  theoreticalMeetFromCaptures,
  type TheoreticalCaptureDeps,
  type TheoreticalCapturePageRef,
  type TheoreticalCaptureParse,
  type TheoreticalCaptureRecord,
} from '../packages/manager/src/lib/theoreticalMeetFromCaptures';
import { buildTheoreticalMeetSeeds } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { SWIMMER_BODY, rosterPage } from './helpers/multiTeamDriverHarness';

const here = dirname(fileURLToPath(import.meta.url));
const SEASON_FORM = readFileSync(join(here, 'fixtures', 'swimcloud', 'team-412-roster-gender-F-season-form.html'), 'utf8');
const RETRIEVED = '2026-10-04T12:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* Real parses                                                                 */
/* -------------------------------------------------------------------------- */

function rosterParse(team: string, gender: 'M' | 'F'): SwimCloudRosterParse {
  const parsed = parseTeamRosterHtml(rosterPage(team, gender), {
    sourceUrl: `https://www.swimcloud.com/team/${team}/roster/?gender=${gender}`,
    retrievedAt: RETRIEVED,
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error('roster fixture does not parse');
  return parsed.data;
}

const OBU_M = rosterParse('412', 'M');
const OBU_F = rosterParse('412', 'F');
const UWF_M_EMPTY = rosterParse('10002824', 'M');

/** The real times response, parsed under its own id (1330318). */
function timesParse(): SwimCloudSwimmerTimesParse {
  const parsed = parseSwimmerFastestTimesJson(SWIMMER_BODY, {
    sourceUrl: 'https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/',
    retrievedAt: RETRIEVED,
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return parsed.data;
}

/** The real response, pointed at another swimmer id (a constructed pairing of two real things). */
const timesFor = (swimmerId: string): SwimCloudSwimmerTimesParse => ({ ...timesParse(), swimCloudSwimmerId: swimmerId });

/* -------------------------------------------------------------------------- */
/* Constructed capture records                                                 */
/* -------------------------------------------------------------------------- */

const rosterRef = (teamId: string, gender: 'M' | 'F', over: Partial<TheoreticalCapturePageRef> = {}): TheoreticalCapturePageRef => ({
  canonicalUrl: `https://www.swimcloud.com/team/${teamId}/roster/?gender=${gender}&page=1&season_id=29&sort=name`,
  resourceKind: 'teamRoster',
  gender,
  teamId,
  retrievedAt: RETRIEVED,
  outcome: 'ok',
  ...over,
});

const timesRef = (swimmerId: string, over: Partial<TheoreticalCapturePageRef> = {}): TheoreticalCapturePageRef => ({
  canonicalUrl: `https://www.swimcloud.com/api/swimmers/${swimmerId}/profile_fastest_times/`,
  resourceKind: 'swimmerFastestTimes',
  retrievedAt: '2026-10-04T12:05:00.000Z',
  outcome: 'ok',
  ...over,
});

function record(over: Partial<TheoreticalCaptureRecord> = {}): TheoreticalCaptureRecord {
  const pages = over.pages ?? [rosterRef('412', 'M'), rosterRef('412', 'F')];
  return {
    captureId: 'team-412-2025-2026',
    subject: { kind: 'team', teamId: '412', season: '2025-2026' },
    completeness: 'every-planned-page-fetched',
    plannedPageCount: pages.length,
    pages,
    ...over,
  };
}

type Fixture = {
  records?: TheoreticalCaptureRecord[];
  parse?: Partial<TheoreticalCaptureParse>;
  html?: string | undefined;
  withHtmlDep?: boolean;
};

function deps(f: Fixture = {}): TheoreticalCaptureDeps {
  const records = f.records ?? [record()];
  return {
    listCaptures: async () => records,
    parseCapture: async captureId => ({
      captureId,
      rosters: [OBU_M, OBU_F],
      swimmerTimes: [],
      ...f.parse,
    }),
    ...(f.withHtmlDep === false ? {} : { readRosterPageHtml: async () => ('html' in f ? f.html : SEASON_FORM) }),
  };
}

const run = (f: Fixture = {}, ids: string[] = ['team-412-2025-2026']) => theoreticalMeetFromCaptures(ids, deps(f));

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TheoreticalCaptureError) return error.code;
    throw error;
  }
  return 'no-error';
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('theoreticalMeetFromCaptures: the happy path over real roster pages', () => {
  it('makes one team per gender with the name the roster page states', async () => {
    const result = await run();
    expect(result.teams.map(t => [t.teamName, t.gender, t.rosterStatus])).toEqual([
      ['Ouachita Baptist University', Gender.MEN, 'parsed'],
      ['Ouachita Baptist University', Gender.WOMEN, 'parsed'],
    ]);
    expect(result.teams[0].athletes.map(a => a.athlete.name)).toEqual(OBU_M.athletes.map(a => a.name));
    expect(result.teams[1].athletes.map(a => a.athlete.name)).toEqual(OBU_F.athletes.map(a => a.name));
    expect(result.teams.every(t => t.captureId === 'team-412-2025-2026' && t.retrievedAt === RETRIEVED)).toBe(true);
  });

  it('reads the roster season id from the page\'s own season table, for the subject\'s label', async () => {
    const result = await run();
    // The real season form lists 2025-2026 as 29 (read here, not computed).
    expect(result.teams.map(t => t.rosterSeasonId)).toEqual(['29', '29']);
  });

  it('the output is accepted by the seed builder as it stands', async () => {
    const id = OBU_M.athletes[0].swimCloudSwimmerId as string;
    const result = await run({
      records: [record({ pages: [rosterRef('412', 'M'), rosterRef('412', 'F'), timesRef(id)] })],
      parse: { swimmerTimes: [timesFor(id)] },
    });
    const seeds = buildTheoreticalMeetSeeds({ meetId: 'ws-1', course: 'SCY', scoringSettings: GENERIC_TOP16_SETTINGS, teams: result.teams });
    expect(seeds.report.teams).toHaveLength(2);
    expect(seeds.rows.length).toBeGreaterThan(0);
    expect(seeds.rows.every(r => r.gender === Gender.MEN)).toBe(true);
    expect(seeds.sources.get(seeds.rows[0].id)?.captureId).toBe('team-412-2025-2026');
    // The athlete's own page stamp rode along as the swim's source time.
    expect(seeds.sources.get(seeds.rows[0].id)?.retrievedAt).toBe('2026-10-04T12:05:00.000Z');
  });
});

describe('theoreticalMeetFromCaptures: times are undefined, [] or parse_failed, never confused', () => {
  const first = OBU_M.athletes[0].swimCloudSwimmerId as string;
  const second = OBU_M.athletes[1].swimCloudSwimmerId as string;
  const third = OBU_M.athletes[2].swimCloudSwimmerId as string;

  it('a parsed page gives swims, a page with no usable swim gives [], a page that did not parse gives parse_failed, no page gives undefined', async () => {
    const emptyPage: SwimCloudSwimmerTimesParse = { ...timesFor(second), personalBests: [], rowCount: 0 };
    const result = await run({
      records: [record({ pages: [rosterRef('412', 'M'), rosterRef('412', 'F'), timesRef(first), timesRef(second), timesRef(third)] })],
      // `third` has a page record and no parse: the page did not parse.
      parse: { swimmerTimes: [timesFor(first), emptyPage] },
    });
    const men = result.teams[0].athletes;
    expect(men[0].swims?.length).toBeGreaterThan(0);
    expect(men[0].swimsStatus).toBeUndefined();
    expect(men[0].swims?.every(s => s.name === OBU_M.athletes[0].name && s.team === 'Ouachita Baptist University' && s.gender === Gender.MEN)).toBe(true);
    expect(men[1].swims).toEqual([]);
    expect(men[1].swimsStatus).toBeUndefined();
    expect(men[2].swims).toBeUndefined();
    expect(men[2].swimsStatus).toBe('parse_failed');
    expect(men[3].swims).toBeUndefined();
    expect(men[3].swimsStatus).toBeUndefined();
    // The builder reports the four apart.
    const seeds = buildTheoreticalMeetSeeds({ meetId: 'ws-1', course: 'SCY', scoringSettings: GENERIC_TOP16_SETTINGS, teams: result.teams });
    const report = seeds.report.teams[0];
    expect(report.athletesWithTimesParseFailed.map(a => a.swimCloudSwimmerId)).toEqual([third]);
    expect(report.athletesWithNoSeedInMeetCourse.map(a => [a.swimCloudSwimmerId, a.reason])).toEqual([[second, 'no_usable_swim']]);
    expect(report.athletesWithNoTimes).toHaveLength(OBU_M.athletes.length - 3);
  });

  it('a times page recorded with a non-ok outcome counts as no times, and says so', async () => {
    const result = await run({
      records: [record({ pages: [rosterRef('412', 'M'), rosterRef('412', 'F'), timesRef(first, { outcome: 'http-error' })] })],
    });
    expect(result.teams[0].athletes[0].swims).toBeUndefined();
    expect(result.teams[0].athletes[0].swimsStatus).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(/1 swimmer times page\(s\) were recorded with a non-ok outcome/);
  });

  it('a parsed times page that matches no roster athlete is reported, not used', async () => {
    const result = await run({ parse: { swimmerTimes: [timesFor('999999999')] } });
    expect(result.teams.every(t => t.athletes.every(a => a.swims === undefined))).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/1 parsed swimmer times page\(s\) match no athlete/);
  });
});

describe('theoreticalMeetFromCaptures: capture completeness is reported, never rounded up', () => {
  it('a partial capture is accepted and every team carries the counts', async () => {
    const pages = [rosterRef('412', 'M'), rosterRef('412', 'F')];
    const result = await run({ records: [record({ completeness: 'partial', plannedPageCount: 79, pages })] });
    expect(result.teams).toHaveLength(2);
    for (const team of result.teams) {
      expect(team.captureCompleteness).toBe('partial');
      expect(team.pagesPresent).toBe(2);
      expect(team.pagesPlanned).toBe(79);
      expect(team.warnings.join('\n')).toMatch(/is partial \(2 of 79 planned page\(s\) stored with outcome ok\)/);
    }
    expect(result.captures[0].warnings).toHaveLength(1);
  });

  it('an in-progress capture is accepted and flagged', async () => {
    const result = await run({ records: [record({ completeness: 'in-progress', plannedPageCount: 10 })] });
    expect(result.teams[0].warnings.join('\n')).toMatch(/still in progress \(2 of 10 planned page\(s\)/);
  });

  it('a capture that says it fetched every page but holds fewer is flagged', async () => {
    const result = await run({ records: [record({ plannedPageCount: 79 })] });
    expect(result.teams[0].warnings.join('\n')).toMatch(/says it fetched every planned page, but only 2 of 79/);
  });

  it('a complete capture carries no completeness warning', async () => {
    const result = await run();
    expect(result.teams.every(t => t.warnings.length === 0)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('a failed capture throws', async () => {
    expect(await codeOf(run({ records: [record({ completeness: 'failed' })] }))).toBe('capture-failed');
  });
});

describe('theoreticalMeetFromCaptures: the real "No rosters found" page', () => {
  const uwfCapture = (): Fixture => ({
    records: [
      record({
        captureId: 'team-10002824-2025-2026',
        subject: { kind: 'team', teamId: '10002824', season: '2025-2026' },
        pages: [rosterRef('10002824', 'M'), rosterRef('10002824', 'F')],
      }),
    ],
  });
  const uwfWomen = rosterParse('10002824', 'F');

  it('is a no_rosters_found team with no athletes, named from the capture\'s other roster page', async () => {
    expect(UWF_M_EMPTY.athletes).toHaveLength(0);
    expect(UWF_M_EMPTY.teamName).toBeUndefined();
    const result = await theoreticalMeetFromCaptures(['team-10002824-2025-2026'], {
      ...deps(uwfCapture()),
      parseCapture: async captureId => ({ captureId, rosters: [UWF_M_EMPTY, uwfWomen], swimmerTimes: [] }),
    });
    const [men, women] = result.teams;
    expect(men.rosterStatus).toBe('no_rosters_found');
    expect(men.athletes).toEqual([]);
    expect(men.gender).toBe(Gender.MEN);
    expect(men.teamName).toBe(uwfWomen.teamName);
    expect(men.warnings.join('\n')).toMatch(/comes from this capture's other roster page/);
    expect(women.rosterStatus).toBe('parsed');
    // The parsed sibling confirms the filter-letter reading, so no gender warning.
    expect(men.warnings.join('\n')).not.toMatch(/gender of this/);
    // The seed builder accepts it, and states the empty roster.
    const seeds = buildTheoreticalMeetSeeds({ meetId: 'ws-1', course: 'SCY', scoringSettings: GENERIC_TOP16_SETTINGS, teams: result.teams });
    expect(seeds.report.teams[0].caveats.join('\n')).toMatch(/no rosters found/i);
  });

  it('an empty page with no sibling to name it throws, it is not given a guessed name', async () => {
    const f = uwfCapture();
    f.records = [record({ captureId: 'team-10002824-2025-2026', subject: { kind: 'team', teamId: '10002824', season: '2025-2026' }, pages: [rosterRef('10002824', 'M')] })];
    expect(
      await codeOf(
        theoreticalMeetFromCaptures(['team-10002824-2025-2026'], {
          ...deps(f),
          parseCapture: async captureId => ({ captureId, rosters: [UWF_M_EMPTY], swimmerTimes: [] }),
        })
      )
    ).toBe('team-name-missing');
  });

  it('warns when nothing parsed confirms the gender read from the URL filter', async () => {
    const f = uwfCapture();
    f.records = [record({ captureId: 'team-10002824-2025-2026', subject: { kind: 'team', teamId: '10002824', season: '2025-2026' }, pages: [rosterRef('10002824', 'M'), rosterRef('10002824', 'F')] })];
    const emptyWomen: SwimCloudRosterParse = { swimCloudTeamId: '10002824', athletes: [], rowCount: 0 };
    // Both pages empty: neither states a name, so the name still throws first.
    expect(
      await codeOf(
        theoreticalMeetFromCaptures(['team-10002824-2025-2026'], {
          ...deps(f),
          parseCapture: async captureId => ({ captureId, rosters: [UWF_M_EMPTY, emptyWomen], swimmerTimes: [] }),
        })
      )
    ).toBe('team-name-missing');
  });
});

describe('theoreticalMeetFromCaptures: a roster page that is not an answer throws', () => {
  it('a parsed roster page with no team name throws', async () => {
    const nameless: SwimCloudRosterParse = { ...OBU_M, teamName: undefined };
    expect(await codeOf(run({ parse: { rosters: [nameless, OBU_F] } }))).toBe('team-name-missing');
  });

  it('a roster page that did not parse throws, it does not become an empty roster', async () => {
    expect(await codeOf(run({ parse: { rosters: [OBU_F] } }))).toBe('roster-page-unparsed');
  });

  it('a roster table with no rows is not the "No rosters found" page and throws', async () => {
    // A real roster parse (it states its team, gender and season) with its rows removed: the parser's
    // zero-data-rows answer, for example a wrong season filter.
    const noRows: SwimCloudRosterParse = { ...OBU_M, athletes: [], rowCount: 0 };
    expect(await codeOf(run({ parse: { rosters: [noRows, OBU_F] } }))).toBe('roster-table-empty');
  });

  it('a capture with no roster page throws', async () => {
    expect(await codeOf(run({ records: [record({ pages: [timesRef('1')] })] }))).toBe('no-roster-pages');
  });

  it('a printed gender that contradicts the URL filter throws', async () => {
    expect(await codeOf(run({ parse: { rosters: [OBU_F, OBU_M] } }))).toBe('roster-gender-contradiction');
  });

  it('two roster pages for one gender throw', async () => {
    const pages = [rosterRef('412', 'M'), rosterRef('412', 'M', { canonicalUrl: 'https://www.swimcloud.com/team/412/roster/?gender=M&page=2' })];
    expect(await codeOf(run({ records: [record({ pages })], parse: { rosters: [OBU_M, OBU_M] } }))).toBe('duplicate-roster-gender');
  });

  it('a roster page for another team id throws', async () => {
    expect(await codeOf(run({ parse: { rosters: [{ ...OBU_M, swimCloudTeamId: '999' }, OBU_F] } }))).toBe('team-id-mismatch');
  });

  it('a roster page that failed to fetch is reported and makes no team', async () => {
    const pages = [rosterRef('412', 'M'), rosterRef('412', 'F', { outcome: 'http-error' })];
    const result = await run({ records: [record({ pages })], parse: { rosters: [OBU_M] } });
    expect(result.teams.map(t => t.gender)).toEqual([Gender.MEN]);
    expect(result.warnings.join('\n')).toMatch(/was recorded with outcome http-error. No team was made/);
  });
});

describe('theoreticalMeetFromCaptures: the roster season id is never guessed', () => {
  const seasonOf = async (f: Fixture) => (await run(f)).teams.map(t => [t.rosterSeasonId, t.warnings.join(' | ')] as const);

  it('stays undefined, with a warning, when no page bytes are available', async () => {
    const [[id, warning]] = await seasonOf({ withHtmlDep: false });
    expect(id).toBeUndefined();
    expect(warning).toMatch(/No roster page bytes were available/);
  });

  it('stays undefined when the bytes are not stored', async () => {
    const [[id, warning]] = await seasonOf({ html: undefined });
    expect(id).toBeUndefined();
    expect(warning).toMatch(/bytes are not stored/);
  });

  it('stays undefined when the page has no season table', async () => {
    const [[id, warning]] = await seasonOf({ html: '<html><body>no form</body></html>' });
    expect(id).toBeUndefined();
    expect(warning).toMatch(/season table did not parse/);
  });

  it('stays undefined when the team\'s own table does not list the label', async () => {
    const records = [record({ subject: { kind: 'team', teamId: '412', season: '1999-2000' } })];
    // The page prints no recognised season label, so the subject's label is the only claim.
    const unlabelled = [{ ...OBU_M, season: undefined }, { ...OBU_F, season: undefined }];
    const [[id, warning]] = await seasonOf({ records, parse: { rosters: unlabelled } });
    expect(id).toBeUndefined();
    expect(warning).toMatch(/does not list 1999-2000/);
  });

  it('stays undefined when the subject has no season label', async () => {
    const records = [record({ subject: { kind: 'team', teamId: '412' } })];
    const [[id, warning]] = await seasonOf({ records });
    expect(id).toBeUndefined();
    expect(warning).toMatch(/no season label/);
  });

  it('stays undefined when the page URL asks for another season id than the table lists', async () => {
    const pages = [rosterRef('412', 'M', { canonicalUrl: 'https://www.swimcloud.com/team/412/roster/?gender=M&page=1&season_id=30&sort=name' }), rosterRef('412', 'F')];
    const result = await run({ records: [record({ pages })] });
    expect(result.teams[0].rosterSeasonId).toBeUndefined();
    expect(result.teams[0].warnings.join(' ')).toMatch(/asks for season_id=30, but its season table lists 2025-2026 as 29/);
    expect(result.teams[1].rosterSeasonId).toBe('29');
  });

  it('throws when the roster page prints another season than the capture is labelled', async () => {
    const other: SwimCloudRosterParse = { ...OBU_M, season: '2024-2025' };
    expect(await codeOf(run({ parse: { rosters: [other, OBU_F] } }))).toBe('season-label-mismatch');
  });
});

describe('theoreticalMeetFromCaptures: bad input', () => {
  it('rejects no ids, a repeated id, an unknown id and a meet capture', async () => {
    expect(await codeOf(run({}, []))).toBe('invalid-input');
    expect(await codeOf(run({}, ['team-412-2025-2026', 'team-412-2025-2026']))).toBe('invalid-input');
    expect(await codeOf(run({}, ['team-1-2025-2026']))).toBe('capture-not-found');
    const meet = record({ captureId: 'meet-1', subject: { kind: 'meet', meetId: '1' } });
    expect(await codeOf(run({ records: [meet] }, ['meet-1']))).toBe('capture-not-a-team');
  });

  it('rejects a parse that answers for another capture', async () => {
    expect(await codeOf(run({ parse: { captureId: 'team-other' } }))).toBe('malformed-capture');
  });

  it('keeps the capture order the ids were given in', async () => {
    const second = record({
      captureId: 'team-10002824-2025-2026',
      subject: { kind: 'team', teamId: '10002824', season: '2025-2026' },
      pages: [rosterRef('10002824', 'F')],
    });
    const women = rosterParse('10002824', 'F');
    const result = await theoreticalMeetFromCaptures(['team-10002824-2025-2026', 'team-412-2025-2026'], {
      ...deps({ records: [record(), second] }),
      parseCapture: async captureId =>
        captureId === 'team-412-2025-2026'
          ? { captureId, rosters: [OBU_M, OBU_F], swimmerTimes: [] }
          : { captureId, rosters: [women], swimmerTimes: [] },
    });
    expect(result.teams.map(t => t.captureId)).toEqual(['team-10002824-2025-2026', 'team-412-2025-2026', 'team-412-2025-2026']);
    expect(result.captures.map(c => c.captureId)).toEqual(['team-10002824-2025-2026', 'team-412-2025-2026']);
  });
});
