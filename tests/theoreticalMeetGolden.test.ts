/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase U1 golden: three real crawled teams, from stored pages to Standings.
 *
 * ```
 * fake deps over a real capture store
 *   -> theoreticalMeetFromCaptures
 *   -> buildTheoreticalMeetSeeds   (SCY, conference NSISC, the NSISC preset)
 *   -> buildTheoreticalMeetWorkspace
 *   -> buildScoringSnapshot        (the pure function behind useWorkspaceScoring)
 * ```
 *
 * ## Fixtures
 *
 * `tests/fixtures/theoretical-meet/` is a trimmed copy of the three real browser-extension captures
 * `team-412-2026-2027`, `team-58-2026-2027` and `team-48-2026-2027` (Ouachita Baptist University, Henderson
 * State University, Delta State University), taken 2026-10-04. The store layout is the app's own
 * (`captures/*.json`, `pages/*.json`), so the real `parseSwimCloudCapture` route function runs over it.
 *
 * - Both roster pages of each team (men, women) are kept whole. The page header, navigation and footer and
 *   every script are removed (they held the account holder's name and a form secret). The roster card, the
 *   table and the filter form with the season select are untouched. `manifest.json` records each page's
 *   original and trimmed hash and size. The generator checked that the roster parse is identical before and
 *   after the trim.
 * - Of each team's real times responses (77, 60 and 36), 12 are kept: 6 per gender. The rule is in
 *   `manifest.json`: up to 2 special cases first (a diver, an altitude-adjusted swimmer, a self-reported
 *   time), then roster order. The real responses are byte-for-byte as served. The full set is 5 MB.
 * - Every roster athlete without a kept response is, to this test, an athlete with no times captured.
 * - The capture records are real, with `plannedPageCount` set to the kept page count and a note saying so.
 *
 * Nothing about a competition value is typed in here except the published NCAA place table, which the
 * hand-computed expectations use.
 *
 * The last block runs the same chain over ALL the real data and asserts invariants only. It skips when the
 * git-ignored captures are not on this machine.
 */
import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSystemSwimCloudCaptureStore } from '../packages/swimcloud/src/captureStore';
import { parseTeamRosterHtml } from '../packages/swimcloud/src/parser';
import { classifySwimCloudUrl } from '../packages/swimcloud/src/urlClassifier';
import { parseSwimCloudCapture } from '../apps/shell/lib/swimcloudCaptureRoutes';
import { Gender } from '../packages/core/src/types';
import type { SwimmerResult, Workspace } from '../packages/core/src/types';
import { presetIdForConference, settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine';
import { hasPrelimsData } from '../packages/core/src/lib/prelimsProjection';
import { convertTimeToSeconds } from '../packages/core/src/lib/utils';
import { theoreticalMeetFromCaptures, type TheoreticalCaptureDeps, type TheoreticalMeetFromCapturesResult } from '../packages/manager/src/lib/theoreticalMeetFromCaptures';
import { buildTheoreticalMeetSeeds, type TheoreticalMeetSeeds } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { buildTheoreticalMeetWorkspace, isTheoreticalMeet, theoreticalEventOrderFromMeetResults, type TheoreticalMeetWorkspaceBuild } from '../packages/manager/src/lib/theoreticalMeetWorkspace';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(here, 'fixtures', 'theoretical-meet');
const REAL_ROOT = resolve(here, '..', 'data', 'swimcloud-captures');
const CAPTURE_IDS = ['team-412-2026-2027', 'team-58-2026-2027', 'team-48-2026-2027'];
const TEAMS = ['Ouachita Baptist University', 'Henderson State University', 'Delta State University'];
const WORKSPACE_ID = 'ws-theoretical-golden';
const CREATED_AT = 1_760_000_000_000;

/** The published NCAA place table the NSISC preset scores individual places with. */
const NCAA_TABLE = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

/* -------------------------------------------------------------------------- */
/* The chain                                                                   */
/* -------------------------------------------------------------------------- */

function depsOver(root: string): TheoreticalCaptureDeps {
  const store = new FileSystemSwimCloudCaptureStore(root);
  return {
    listCaptures: async () => store.listCaptures(),
    parseCapture: async captureId => {
      const record = await store.getCapture(captureId);
      if (record === undefined) throw new Error(`no capture ${captureId}`);
      return parseSwimCloudCapture(store, record);
    },
    readRosterPageHtml: async (_captureId, canonicalUrl) => (await store.readPage(canonicalUrl))?.html,
  };
}

type Chain = {
  captures: TheoreticalMeetFromCapturesResult;
  seeds: TheoreticalMeetSeeds;
  built: TheoreticalMeetWorkspaceBuild;
};

async function runChain(root: string): Promise<Chain> {
  const presetId = presetIdForConference('NSISC');
  if (presetId === null) throw new Error('no preset for NSISC');
  const scoringSettings = settingsForBuiltInScoringPreset(presetId);
  const captures = await theoreticalMeetFromCaptures(CAPTURE_IDS, depsOver(root));
  const seeds = buildTheoreticalMeetSeeds({ meetId: WORKSPACE_ID, course: 'SCY', scoringSettings, conference: 'NSISC', teams: captures.teams });
  const built = buildTheoreticalMeetWorkspace({ workspaceId: WORKSPACE_ID, createdAt: CREATED_AT, seeds, scoringSettings, conference: 'NSISC' });
  return { captures, seeds, built };
}

const asWorkspace = (b: TheoreticalMeetWorkspaceBuild): Workspace => b.payload as unknown as Workspace;
const resultsOf = (b: TheoreticalMeetWorkspaceBuild, gender: Gender): SwimmerResult[] => (gender === Gender.MEN ? b.payload.menResults : b.payload.womenResults);
const baselineOf = (b: TheoreticalMeetWorkspaceBuild, gender: Gender) => buildScoringSnapshot(asWorkspace(b), gender, false).baseline;

/** Places and points of one event, from the seed times alone and the published table. Ties share the mean. */
function handPoints(times: readonly string[]): number[] {
  const seconds = times.map(convertTimeToSeconds);
  const order = seconds.map((_, i) => i).sort((a, b) => seconds[a] - seconds[b]);
  const out: number[] = new Array(times.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && seconds[order[end + 1]] === seconds[order[start]]) end += 1;
    const size = end - start + 1;
    let sum = 0;
    for (let place = start; place <= end; place += 1) sum += NCAA_TABLE[place] ?? 0;
    for (let k = start; k <= end; k += 1) out[order[k]] = sum / size;
    start = end + 1;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Golden: the committed fixtures                                              */
/* -------------------------------------------------------------------------- */

describe('theoretical meet from three real captures (committed, trimmed fixtures)', async () => {
  const chain = await runChain(FIXTURE_ROOT);
  const { captures, seeds, built } = chain;

  it('reads six teams, one per team and gender, named by their roster pages, with the real season id', () => {
    expect(captures.teams.map(t => [t.teamName, t.gender, t.rosterStatus, t.rosterSeasonId])).toEqual([
      [TEAMS[0], Gender.MEN, 'parsed', '30'],
      [TEAMS[0], Gender.WOMEN, 'parsed', '30'],
      [TEAMS[1], Gender.MEN, 'parsed', '30'],
      [TEAMS[1], Gender.WOMEN, 'parsed', '30'],
      [TEAMS[2], Gender.MEN, 'parsed', '30'],
      [TEAMS[2], Gender.WOMEN, 'parsed', '30'],
    ]);
    // The fixture captures are complete for their trimmed plan and every stored page hashes to its record.
    expect(captures.captures.map(c => [c.driftedPages, c.unverifiedPages])).toEqual([[[], 0], [[], 0], [[], 0]]);
    // The only thing the parse says is that dives are kept as judged scores (6, 4 and 12 dive rows).
    expect(captures.captures.map(c => c.parseWarnings.byCode)).toEqual([{ 'diving-score-not-a-time': 6 }, { 'diving-score-not-a-time': 4 }, { 'diving-score-not-a-time': 12 }]);
    expect(captures.warnings).toEqual([
      'team-412-2026-2027: The capture parse reported 6 warning(s): diving-score-not-a-time x6.',
      'team-58-2026-2027: The capture parse reported 4 warning(s): diving-score-not-a-time x4.',
      'team-48-2026-2027: The capture parse reported 12 warning(s): diving-score-not-a-time x12.',
    ]);
    expect(captures.teams.every(t => t.pagesPresent === t.pagesPlanned && t.pagesPlanned === 14)).toBe(true);
  });

  it('the three teams appear in the Standings, for men and for women', () => {
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      const baseline = baselineOf(built, gender);
      expect(baseline.sortedTeams.map(t => t.teamName).sort()).toEqual([...TEAMS].sort());
      const projected = buildScoringSnapshot(asWorkspace(built), gender, false).projected;
      expect(projected.sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual(baseline.sortedTeams.map(t => [t.teamName, t.totalPoints]));
    }
  });

  it('every team total equals the sum of the points of its scored rows', () => {
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      const baseline = baselineOf(built, gender);
      expect(baseline.allScored.length).toBe(resultsOf(built, gender).length);
      for (const team of baseline.sortedTeams) {
        const sum = baseline.allScored.filter(r => r.team === team.teamName).reduce((total, r) => total + (typeof r.points === 'number' ? r.points : 0), 0);
        expect(team.totalPoints, `${team.teamName} ${gender}`).toBe(sum);
        expect(team.totalPoints).toBeGreaterThan(0);
      }
    }
  });

  it('pins the standings of the fixture subset (men and women, NSISC rules, individual events only)', () => {
    // Pinned from the first run over these fixtures, after the 50 Free hand check below. A change here
    // means the pages, the parse, the seed rules, the ranking or the scoring moved.
    expect(baselineOf(built, Gender.MEN).sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual([
      [TEAMS[1], 602],
      [TEAMS[0], 437],
      [TEAMS[2], 278],
    ]);
    expect(baselineOf(built, Gender.WOMEN).sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual([
      [TEAMS[2], 540.5],
      [TEAMS[1], 537],
      [TEAMS[0], 395.5],
    ]);
  });

  it('50 Free: the points are the NSISC place table applied to the seed order, computed here by hand', () => {
    // 50 Free is the first event in program order, so the 18-scorer pool is empty when it is scored and every
    // place from 1 to 16 earns the table value. Women have an exact tie at 26.51 (places 10 and 10).
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      const rows = resultsOf(built, gender).filter(r => r.event === '50 Free SCY');
      expect(rows.length).toBeGreaterThan(8);
      const expected = handPoints(rows.map(r => r.time));
      const scored = new Map(baselineOf(built, gender).allScored.map(r => [r.id, r.points]));
      rows.forEach((row, i) => expect(scored.get(row.id), `${gender} ${row.name} ${row.time}`).toBe(expected[i]));
    }
    const womenTimes = resultsOf(built, Gender.WOMEN).filter(r => r.event === '50 Free SCY').map(r => r.time);
    expect(new Set(womenTimes).size).toBeLessThan(womenTimes.length);
    // Men: 9 swimmers, so places 1 to 9 are 20, 17, 16, 15, 14, 13, 12, 11, 9 with no tie.
    expect(resultsOf(built, Gender.MEN).filter(r => r.event === '50 Free SCY').map(r => r.points)).toEqual([20, 17, 16, 15, 14, 13, 12, 11, 9]);
    // Women: 15 swimmers, the tie shares (7 + 6) / 2 = 6.5.
    expect(resultsOf(built, Gender.WOMEN).filter(r => r.event === '50 Free SCY').map(r => r.points)).toEqual([20, 17, 16, 15, 14, 13, 12, 11, 9, 6.5, 6.5, 5, 4, 3, 2]);
  });

  it('no row reads as a prelims swim: the prelims-vs-finals view is empty and every total is the finals total', () => {
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      expect(hasPrelimsData(resultsOf(built, gender)), gender).toBe(false);
      const snap = buildScoringSnapshot(asWorkspace(built), gender, false);
      expect(snap.prelimsProjected.sortedTeams, gender).toEqual([]);
      expect(snap.projected.sortedTeams.map(t => t.totalPoints)).toEqual(snap.baseline.sortedTeams.map(t => t.totalPoints));
    }
  });

  it('rows carry the meet shape: ranked, banded, not psych, no pdfPoints', () => {
    for (const row of [...built.payload.menResults, ...built.payload.womenResults]) {
      expect(row.isPsychSheet).toBeUndefined();
      expect(row.pdfPoints).toBeUndefined();
      expect(row.roundSwam).toMatch(/^(A Final|B Final|C Final)$/);
      expect(row.rank).toBeGreaterThan(0);
      expect(row.id.startsWith(`tmres|${WORKSPACE_ID}|`)).toBe(true);
    }
    expect(built.payload.menResults.length + built.payload.womenResults.length).toBe(seeds.rows.length);
  });

  it('an athlete with no times captured is in the report and in no row', () => {
    const store = new FileSystemSwimCloudCaptureStore(FIXTURE_ROOT);
    return (async () => {
      let checked = 0;
      for (const captureId of CAPTURE_IDS) {
        const record = (await store.getCapture(captureId))!;
        const keptIds = new Set(
          record.pages
            .map(p => classifySwimCloudUrl(p.canonicalUrl))
            .flatMap(c => (c.outcome === 'fetchable' && c.resource.kind === 'swimmerFastestTimes' ? [c.resource.swimmerId] : []))
        );
        for (const page of record.pages.filter(p => p.resourceKind === 'teamRoster')) {
          const html = (await store.readPage(page.canonicalUrl))!.html;
          const roster = parseTeamRosterHtml(html, { sourceUrl: page.canonicalUrl, retrievedAt: page.retrievedAt, track: 'browser-extension' });
          if (!roster.ok) throw new Error('fixture roster does not parse');
          const gender = roster.data.gender as Gender;
          const report = seeds.report.teams.find(t => t.teamName === roster.data.teamName && t.gender === gender)!;
          const rows = resultsOf(built, gender).filter(r => r.team === roster.data.teamName);
          const noTimesIds = new Set(report.athletesWithNoTimes.map(a => a.swimCloudSwimmerId));
          for (const athlete of roster.data.athletes) {
            if (keptIds.has(athlete.swimCloudSwimmerId as string)) continue;
            checked += 1;
            expect(noTimesIds.has(athlete.swimCloudSwimmerId), `${athlete.name} is in athletesWithNoTimes`).toBe(true);
            expect(rows.some(r => r.name === athlete.name), `${athlete.name} has no row`).toBe(false);
          }
          expect(report.athletesWithNoTimes.length).toBe(roster.data.athletes.filter(a => !keptIds.has(a.swimCloudSwimmerId as string)).length);
        }
      }
      expect(checked).toBeGreaterThan(100);
    })();
  });

  it('a diver whose every swim is a dive is in the report and in no row', () => {
    const report = seeds.report.teams.find(t => t.teamName === TEAMS[0] && t.gender === Gender.MEN)!;
    expect(report.athletesWithNoSeedInMeetCourse.map(a => [a.name, a.reason])).toEqual([['Carson Powers', 'diving_not_supported']]);
    expect(built.payload.menResults.some(r => r.name === 'Carson Powers')).toBe(false);
  });

  it('an event nobody is seeded in yields no scored rows and is not on the event axis', () => {
    // No man in the subset has a 200 Back SCY seed. A 100 IM is in some swimmers' real times, but it is not
    // a program event and the seed builder offers it to nobody.
    for (const event of ['200 Back SCY', '100 IM SCY']) {
      expect(built.payload.menResults.some(r => r.event === event), event).toBe(false);
      const baseline = baselineOf(built, Gender.MEN);
      expect(baseline.allScored.some(r => r.event === event)).toBe(false);
      expect(baseline.events).not.toContain(event);
      expect(baseline.visibleEvents).not.toContain(event);
    }
    // Every event that has rows is on the axis.
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      const withRows = new Set(resultsOf(built, gender).map(r => r.event));
      expect(new Set(baselineOf(built, gender).visibleEvents)).toEqual(withRows);
    }
  });

  it('marks the workspace theoretical and keeps provenance for every row', () => {
    expect(isTheoreticalMeet(asWorkspace(built))).toBe(true);
    expect(built.payload.name).toBe(`Theoretical meet: 3 teams (${TEAMS.join(', ')})`);
    expect(built.payload.conference).toBe('NSISC');
    expect(built.sources.size).toBe(seeds.rows.length);
    for (const source of built.sources.values()) {
      expect(CAPTURE_IDS).toContain(source.captureId);
      expect(source.retrievedAt).toBeTruthy();
      expect(source.course).toBe('SCY');
    }
    expect(built.caveats.join('\n')).toMatch(/Relays are not included/);
  });

  it('is deterministic: a second run over the same pages gives the same payload', async () => {
    const again = await runChain(FIXTURE_ROOT);
    expect(JSON.stringify(again.built.payload)).toBe(JSON.stringify(built.payload));
  });
});

/* -------------------------------------------------------------------------- */
/* Page bytes, the route's stamps, and an overwritten page                     */
/* -------------------------------------------------------------------------- */

describe('the parse route stamps each stored page with the hash of the bytes it read', () => {
  it('every page of a committed fixture capture hashes to its record, and the stamp carries the entry write time', async () => {
    const store = new FileSystemSwimCloudCaptureStore(FIXTURE_ROOT);
    for (const captureId of CAPTURE_IDS) {
      const record = (await store.getCapture(captureId))!;
      const response = await parseSwimCloudCapture(store, record);
      expect(response.storedPages).toHaveLength(14);
      for (const stamp of response.storedPages) {
        const ref = record.pages.find(page => page.canonicalUrl === stamp.canonicalUrl)!;
        const html = (await store.readPage(stamp.canonicalUrl))!.html;
        expect(stamp.contentSha256).toBe(createHash('sha256').update(html, 'utf8').digest('hex'));
        expect(stamp.contentSha256, stamp.canonicalUrl).toBe(ref.sha256);
        expect(stamp.entryRetrievedAt).toBe(ref.retrievedAt);
      }
    }
  });

  it('a page overwritten by another capture is reported as drifted, with the new write time, end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omniswim-theoretical-drift-'));
    try {
      cpSync(FIXTURE_ROOT, dir, { recursive: true });
      const store = new FileSystemSwimCloudCaptureStore(dir);
      const record = (await store.getCapture('team-58-2026-2027'))!;
      const mensRoster = record.pages.find(p => p.resourceKind === 'teamRoster' && p.gender === 'M')!;
      const original = (await store.readPage(mensRoster.canonicalUrl))!;
      // A later crawl of the same URL (another capture) writes the same page with other bytes.
      await store.upsertCapture({ ...record, captureId: 'team-58-other', subject: { kind: 'team', teamId: '58' }, pages: [], notes: [] });
      const later = '2026-10-09T08:00:00.000Z';
      await store.putPage('team-58-other', { ...original, html: original.html + '<!-- a later edit -->', retrievedAt: later }, { ...mensRoster, retrievedAt: later });
      const result = await theoreticalMeetFromCaptures(CAPTURE_IDS, depsOver(dir));
      const hsu = result.captures.find(c => c.captureId === 'team-58-2026-2027')!;
      expect(hsu.driftedPages).toEqual([mensRoster.canonicalUrl]);
      expect(result.captures.filter(c => c.captureId !== 'team-58-2026-2027').every(c => c.driftedPages.length === 0)).toBe(true);
      expect(result.warnings.join('\n')).toMatch(/team-58-2026-2027: page-bytes-drifted: /);
      const men = result.teams.find(t => t.captureId === 'team-58-2026-2027' && t.gender === Gender.MEN)!;
      expect(men.retrievedAt).toBe(later);
      expect(men.warnings.join('\n')).toMatch(/page-bytes-drifted/);
      // The overwrite kept the old bytes in the archive.
      expect(readdirSync(join(dir, 'pages-superseded'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a supplied event order, from the real 2026 NSISC results, on the fixtures', () => {
  const real = JSON.parse(readFileSync(join(here, 'fixtures', 'nsisc-2026-relay-leg-event-matching.json'), 'utf8')) as { menResults: SwimmerResult[] };

  it('is applied to the rows and flagged, and the small fixture field does not fill the 18-scorer pool, so no total moves', async () => {
    const presetId = presetIdForConference('NSISC') as string;
    const scoringSettings = settingsForBuiltInScoringPreset(presetId);
    const captures = await theoreticalMeetFromCaptures(CAPTURE_IDS, depsOver(FIXTURE_ROOT));
    const seeds = buildTheoreticalMeetSeeds({ meetId: WORKSPACE_ID, course: 'SCY', scoringSettings, conference: 'NSISC', teams: captures.teams });
    const eventOrder = theoreticalEventOrderFromMeetResults(real.menResults);
    expect(eventOrder[0]).toBe('1000 Freestyle');
    const supplied = buildTheoreticalMeetWorkspace({ workspaceId: WORKSPACE_ID, createdAt: CREATED_AT, seeds, scoringSettings, conference: 'NSISC', eventOrder });
    expect(supplied.eventOrderSource).toBe('supplied');
    expect(supplied.payload.menResults[0].event).toBe('1000 Free SCY');
    expect(supplied.warnings).toEqual([]);
    // 12 swimmers per team never fill the pool, so the totals match the default order exactly.
    expect(baselineOf(supplied, Gender.MEN).sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual(
      baselineOf(buildTheoreticalMeetWorkspace({ workspaceId: WORKSPACE_ID, createdAt: CREATED_AT, seeds, scoringSettings, conference: 'NSISC' }), Gender.MEN).sortedTeams.map(t => [t.teamName, t.totalPoints])
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The committed fixtures hold no account data                                 */
/* -------------------------------------------------------------------------- */

describe('the committed fixtures are scrubbed', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(FIXTURE_ROOT);

  it('holds no script, form secret, login time, e-mail address or logout form', () => {
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/<script/i);
      expect(text, file).not.toMatch(/csrf/i);
      expect(text, file).not.toMatch(/last_login/i);
      expect(text, file).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(text, file).not.toMatch(/logout/i);
      expect(text, file).not.toMatch(/user-initals/i);
    }
  });

  it('stays under 1.5 MB', () => {
    const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
    expect(total).toBeLessThan(1_500_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Optional: all the real data, invariants only                                */
/* -------------------------------------------------------------------------- */

const realPresent = CAPTURE_IDS.every(id => existsSync(join(REAL_ROOT, 'captures', `${id}.json`)));

describe.skipIf(!realPresent)('theoretical meet from ALL the real captures (local data, invariants only)', async () => {
  const { captures, seeds, built } = realPresent ? await runChain(REAL_ROOT) : ({} as Chain);

  it('builds without throwing, with three teams and positive totals for each gender', () => {
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      const baseline = baselineOf(built, gender);
      expect(baseline.sortedTeams).toHaveLength(3);
      for (const team of baseline.sortedTeams) expect(team.totalPoints).toBeGreaterThan(0);
    }
  });

  it('every roster athlete is accounted for in exactly one place', () => {
    for (const team of captures.teams) {
      const report = seeds.report.teams.find(t => t.teamName === team.teamName && t.gender === team.gender)!;
      const accounted =
        report.eventsChosenPerSwimmer.length +
        report.athletesWithNoTimes.length +
        report.athletesWithTimesParseFailed.length +
        report.athletesWithNoSeedInMeetCourse.length +
        report.duplicateAcrossTeams.length;
      expect(accounted, `${team.teamName} ${team.gender}`).toBe(team.athletes.length);
    }
  });

  it('event order moves the Henderson men total the way the 2026 NSISC measurement says', () => {
    const presetId = presetIdForConference('NSISC') as string;
    const scoringSettings = settingsForBuiltInScoringPreset(presetId);
    const real = JSON.parse(readFileSync(join(here, 'fixtures', 'nsisc-2026-relay-leg-event-matching.json'), 'utf8')) as { menResults: SwimmerResult[] };
    const realOrder = theoreticalEventOrderFromMeetResults(real.menResults);
    const program = ['50 Freestyle', '100 Freestyle', '200 Freestyle', '500 Freestyle', '1000 Freestyle', '1650 Freestyle', '100 Backstroke', '200 Backstroke', '100 Breaststroke', '200 Breaststroke', '100 Butterfly', '200 Butterfly', '200 Individual Medley', '400 Individual Medley'];
    const hsu = (eventOrder?: readonly string[]): number => {
      const b = buildTheoreticalMeetWorkspace({ workspaceId: WORKSPACE_ID, createdAt: CREATED_AT, seeds, scoringSettings, conference: 'NSISC', ...(eventOrder === undefined ? {} : { eventOrder }) });
      return baselineOf(b, Gender.MEN).sortedTeams.find(t => t.teamName === TEAMS[1])!.totalPoints;
    };
    // The architect measured 931 (program order), 997 (real 2026 order, +66) and 897 (program order reversed, -34).
    expect(hsu()).toBe(931);
    expect(hsu(realOrder)).toBe(997);
    expect(hsu([...program].reverse())).toBe(897);
  });

  it('no row reads as a prelims swim, and the totals are the finals totals (472 rows of the men are past the B bracket)', () => {
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      expect(hasPrelimsData(resultsOf(built, gender)), gender).toBe(false);
      const snap = buildScoringSnapshot(asWorkspace(built), gender, false);
      expect(snap.prelimsProjected.sortedTeams).toEqual([]);
      expect(snap.baseline.sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual(snap.projected.sortedTeams.map(t => [t.teamName, t.totalPoints]));
    }
    const cFinal = built.payload.menResults.filter(r => r.roundSwam === 'C Final');
    expect(cFinal.length).toBeGreaterThan(400);
    expect(baselineOf(built, Gender.MEN).sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual([[TEAMS[1], 931], [TEAMS[0], 566.5], [TEAMS[2], 507.5]]);
    expect(baselineOf(built, Gender.WOMEN).sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual([[TEAMS[0], 786], [TEAMS[1], 661.5], [TEAMS[2], 645.5]]);
  });

  it('every row id is unique, every row has provenance, and totals match the rows', () => {
    const rows = [...built.payload.menResults, ...built.payload.womenResults];
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    expect(built.sources.size).toBe(rows.length);
    for (const gender of [Gender.MEN, Gender.WOMEN]) {
      const baseline = baselineOf(built, gender);
      for (const team of baseline.sortedTeams) {
        const sum = baseline.allScored.filter(r => r.team === team.teamName).reduce((total, r) => total + (typeof r.points === 'number' ? r.points : 0), 0);
        expect(team.totalPoints).toBe(sum);
      }
    }
  });
});
