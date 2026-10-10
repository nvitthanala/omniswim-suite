/**
 * The pure view model of the "Build theoretical meet" dialog: capture grouping and eligibility, the
 * stale hint, one sentence per error code, scoring choices, event-order choices, and the preview rows.
 * Preview rows are checked against the data layer's own report over the committed fixtures.
 */
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import type { SwimmerResult, Workspace } from '../packages/core/src/types';
import { TheoreticalCaptureError } from '../packages/manager/src/lib/theoreticalMeetFromCaptures';
import { TheoreticalMeetError } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { TheoreticalWorkspaceError, THEORETICAL_MEET_LABEL } from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import {
  CAPTURE_ERROR_SENTENCES,
  CaptureApiError,
  SEED_ERROR_SENTENCES,
  STALE_CAPTURE_DAYS,
  WORKSPACE_ERROR_SENTENCES,
  buildScoringChoices,
  combineCaptureResults,
  createBlockers,
  describeCaptureAge,
  describeDrift,
  describeTheoreticalError,
  eventOrderChoices,
  groupCaptures,
  pruneSelection,
  resolveScoringChoice,
  selectableCaptureIds,
  type CaptureListRecord,
} from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import { buildMeet, readTeamCapture } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetFlow';
import { CAPTURE_IDS, fakeCaptureApi, fixtureRecords } from './theoreticalMeetUiFixtures';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function record(overrides: Partial<CaptureListRecord> & { captureId: string }): CaptureListRecord {
  return {
    subject: { kind: 'team', teamId: '1', season: '2026-2027' },
    completeness: 'every-planned-page-fetched',
    plannedPageCount: 3,
    pages: [
      { canonicalUrl: 'https://x/roster', resourceKind: 'teamRoster', retrievedAt: iso(2), outcome: 'ok' },
      { canonicalUrl: 'https://x/a', resourceKind: 'swimmerFastestTimes', retrievedAt: iso(2), outcome: 'ok' },
      { canonicalUrl: 'https://x/b', resourceKind: 'swimmerFastestTimes', retrievedAt: iso(3), outcome: 'ok' },
    ],
    ...overrides,
  };
}

describe('capture age and the stale hint', () => {
  it('states the age and gives no hint up to the limit', () => {
    const age = describeCaptureAge(iso(STALE_CAPTURE_DAYS), NOW);
    expect(age.ageDays).toBe(30);
    expect(age.ageText).toBe('Captured 30 days ago.');
    expect(age.staleHint).toBeNull();
  });

  it('hints past the limit, and the hint names the age', () => {
    const age = describeCaptureAge(iso(STALE_CAPTURE_DAYS + 1), NOW);
    expect(age.staleHint).toContain('31 days old');
    expect(age.ageText).toBe('Captured 31 days ago.');
  });

  it('says today and 1 day in the singular', () => {
    expect(describeCaptureAge(iso(0), NOW).ageText).toBe('Captured today.');
    expect(describeCaptureAge(iso(1), NOW).ageText).toBe('Captured 1 day ago.');
  });

  it('does not invent an age when no time is recorded', () => {
    const age = describeCaptureAge(undefined, NOW);
    expect(age).toEqual({ capturedOn: null, ageDays: null, ageText: 'Capture time not recorded.', staleHint: null });
    expect(describeCaptureAge('not a date', NOW).ageDays).toBeNull();
  });
});

describe('groupCaptures', () => {
  it('groups by team, newest season first, with the numbers the capture holds', () => {
    const groups = groupCaptures(
      [
        record({ captureId: 'team-1-2025-2026', subject: { kind: 'team', teamId: '1', season: '2025-2026' } }),
        record({ captureId: 'team-1-2026-2027' }),
        record({ captureId: 'team-2-2026-2027', subject: { kind: 'team', teamId: '2', season: '2026-2027' } }),
      ],
      NOW
    );
    expect(groups.map(g => [g.teamId, g.title, g.rows.map(r => r.season)])).toEqual([
      ['1', 'Team 1', ['2026-2027', '2025-2026']],
      ['2', 'Team 2', ['2026-2027']],
    ]);
    const row = groups[0].rows[0];
    expect(row).toMatchObject({ status: 'ready', blockedReason: null, pagesStored: 3, pagesPlanned: 3, swimmersCaptured: 2, staleHint: null });
    expect(row.coverageText).toBe('3 of 3 planned pages stored. 2 swimmers with times.');
    expect(row.capturedOn).toBe(iso(2).slice(0, 10));
  });

  it('leaves a meet capture out', () => {
    const groups = groupCaptures([record({ captureId: 'meet-9', subject: { kind: 'meet', meetId: '9' } })], NOW);
    expect(groups).toEqual([]);
  });

  it('blocks a capture that is not finished, and says why', () => {
    const inProgress = groupCaptures([record({ captureId: 'a', completeness: 'in-progress' })], NOW)[0].rows[0];
    expect(inProgress.status).toBe('blocked');
    expect(inProgress.blockedReason).toMatch(/still running/);
    const partial = groupCaptures([record({ captureId: 'b', completeness: 'partial', plannedPageCount: 10 })], NOW)[0].rows[0];
    expect(partial.blockedReason).toMatch(/7 planned pages not stored/);
    const failed = groupCaptures([record({ captureId: 'c', completeness: 'failed' })], NOW)[0].rows[0];
    expect(failed.blockedReason).toMatch(/failed/);
    const empty = groupCaptures([record({ captureId: 'd', pages: [] })], NOW)[0].rows[0];
    expect(empty.status).toBe('blocked');
  });

  it('shows the stale hint on an old capture and counts only pages that were stored ok', () => {
    const old = record({
      captureId: 'old',
      pages: [
        { canonicalUrl: 'https://x/roster', resourceKind: 'teamRoster', retrievedAt: iso(45), outcome: 'ok' },
        { canonicalUrl: 'https://x/a', resourceKind: 'swimmerFastestTimes', retrievedAt: iso(44), outcome: 'http-error' },
      ],
    });
    const row = groupCaptures([old], NOW)[0].rows[0];
    expect(row.staleHint).toContain('45 days old');
    expect(row.swimmersCaptured).toBe(0);
    expect(row.pagesStored).toBe(1);
  });

  it('keeps ready ids selectable and prunes the rest from a selection', () => {
    const groups = groupCaptures([record({ captureId: 'ok' }), record({ captureId: 'busy', completeness: 'in-progress' })], NOW);
    expect(selectableCaptureIds(groups)).toEqual(['ok']);
    expect(pruneSelection(['busy', 'ok', 'gone'], groups)).toEqual(['ok']);
  });

  it('reads the three fixture captures as ready team captures', async () => {
    const groups = groupCaptures(await fixtureRecords(), Date.parse('2026-10-05T00:00:00Z'));
    expect(groups.map(g => g.teamId)).toEqual(['48', '58', '412']);
    expect(groups.every(g => g.rows.every(r => r.status === 'ready' && r.staleHint === null))).toBe(true);
  });
});

describe('describeTheoreticalError', () => {
  it('has a plain sentence for every capture, seed and workspace code, and keeps the builder text', () => {
    for (const [code, sentence] of Object.entries(CAPTURE_ERROR_SENTENCES)) {
      const problem = describeTheoreticalError(new TheoreticalCaptureError(code as never, 'builder text'));
      expect(problem).toEqual({ code, message: sentence, detail: 'builder text', retryable: false });
      expect(sentence.length).toBeGreaterThan(20);
    }
    for (const [code, sentence] of Object.entries(SEED_ERROR_SENTENCES)) {
      expect(describeTheoreticalError(new TheoreticalMeetError(code as never, 'builder text')).message).toBe(sentence);
    }
    for (const [code, sentence] of Object.entries(WORKSPACE_ERROR_SENTENCES)) {
      expect(describeTheoreticalError(new TheoreticalWorkspaceError(code as never, 'builder text')).message).toBe(sentence);
    }
  });

  it('names the four codes the brief singles out in plain words', () => {
    expect(SEED_ERROR_SENTENCES['name-collision-in-team']).toMatch(/same name/);
    expect(SEED_ERROR_SENTENCES['course-not-supported']).toMatch(/Only short course yards/);
    expect(SEED_ERROR_SENTENCES['invalid-scoring-settings']).toMatch(/Pick a scoring preset/);
    expect(SEED_ERROR_SENTENCES['roster-status-required']).toMatch(/roster is empty/);
  });

  it('marks the network and server failures as retryable and data failures as not', () => {
    expect(describeTheoreticalError(new CaptureApiError(0, 'no server')).retryable).toBe(true);
    expect(describeTheoreticalError(new CaptureApiError(500, 'boom')).retryable).toBe(true);
    expect(describeTheoreticalError(new CaptureApiError(404, 'gone')).code).toBe('capture-routes-unavailable');
    expect(describeTheoreticalError(new CaptureApiError(404, 'gone')).retryable).toBe(false);
    expect(describeTheoreticalError(new Error('plain')).code).toBe('unknown');
  });

  it('turns an unknown code of a known class into a safe generic sentence, never an empty one', () => {
    const problem = describeTheoreticalError(new TheoreticalMeetError('not-a-code' as never, 'x'));
    expect(problem.message.length).toBeGreaterThan(10);
  });
});

describe('scoring and event order choices', () => {
  it('offers built-in presets with their own tables and binds a conference only when the app maps it back', () => {
    const choices = buildScoringChoices();
    expect(choices.length).toBeGreaterThan(3);
    const nsisc = choices.find(c => c.id === 'nsisc');
    expect(nsisc?.conference).toBe('NSISC');
    // No choice is preselected by this module: it returns options only.
    expect(choices.every(c => c.label.length > 0 && c.citation.length > 0)).toBe(true);
    // A preset that names several conferences binds none.
    expect(choices.filter(c => c.conference !== undefined).map(c => c.conference)).toContain('NSISC');
    expect(resolveScoringChoice('nsisc').conference).toBe('NSISC');
    expect(resolveScoringChoice('nsisc').settings.maxIndividualEntriesPerSwimmer).toBeGreaterThan(0);
  });

  it('refuses an id it did not offer', () => {
    expect(() => resolveScoringChoice('made-up')).toThrow(/not offered/);
  });

  it('offers a loaded meet for its event order only when its rows carry event numbers', () => {
    const row = (event: string): SwimmerResult => ({ id: event, name: 'A', team: 'T', event, time: '50.00', rank: 1 }) as unknown as SwimmerResult;
    const real = { id: 'w1', name: 'Real meet', menResults: [row('Event 2 Men 100 Yard Freestyle'), row('Event 1 Men 200 Yard Freestyle')], womenResults: [], loadedMeet: { pdfFilename: 'm.pdf', uploadedAt: 1 } };
    const noNumbers = { id: 'w2', name: 'No numbers', menResults: [row('100 Freestyle')], womenResults: [], loadedMeet: { pdfFilename: 'n.pdf', uploadedAt: 1 } };
    const theoretical = { id: 'w3', name: 'Theory', menResults: [row('Event 1 Men 50 Yard Freestyle')], womenResults: [], loadedMeet: { pdfFilename: THEORETICAL_MEET_LABEL, meetLabel: THEORETICAL_MEET_LABEL, uploadedAt: 1 } };
    const choices = eventOrderChoices([real, noNumbers, theoretical] as unknown as Workspace[]);
    expect(choices).toEqual([{ workspaceId: 'w1', name: 'Real meet', eventCount: 2 }]);
  });
});

describe('createBlockers', () => {
  const ok = { selectedCount: 2, scoringChoiceId: 'nsisc', problem: null, previewReady: true, creating: false };
  it('is empty when everything is ready', () => expect(createBlockers(ok)).toEqual([]));
  it('says what is missing, in order', () => {
    expect(createBlockers({ ...ok, selectedCount: 0, scoringChoiceId: null })).toEqual(['Pick at least one team.', 'Pick the scoring rules.']);
    expect(createBlockers({ ...ok, previewReady: false })).toEqual(['The teams are still being read.']);
    expect(createBlockers({ ...ok, creating: true })).toEqual(['The workspace is being created.']);
  });
  it('blocks on a builder error with its sentence', () => {
    const problem = describeTheoreticalError(new TheoreticalMeetError('name-collision-in-team', 'Two swimmers named A B'));
    expect(createBlockers({ ...ok, problem, previewReady: false })).toEqual([problem.message]);
  });
});

describe('drift wording', () => {
  it('words drifted and unchecked pages, and says nothing when there are none', () => {
    expect(describeDrift(0, 0)).toBeNull();
    expect(describeDrift(1, 0)).toBe('1 stored page changed after the crawl recorded it. The newer pages were used.');
    expect(describeDrift(2, 3)).toMatch(/2 stored pages changed.*3 stored pages could not be checked/);
  });
});

describe('preview model over the committed fixtures', async () => {
  const records = await fixtureRecords();
  const api = fakeCaptureApi();
  const results: Record<string, Awaited<ReturnType<typeof readTeamCapture>>> = {};
  for (const id of CAPTURE_IDS) results[id] = await readTeamCapture(api, id, records);
  const built = buildMeet({ captureIds: CAPTURE_IDS, resultsByCaptureId: results, scoringChoiceId: 'nsisc' }, 'ws-view-test', 1_760_000_000_000);
  const { model, seeds } = built;

  it('reads one capture per call and never lists again', () => {
    expect(api.parseCalls).toEqual([...CAPTURE_IDS]);
    expect(api.listCalls).toBe(0);
  });

  it('has one row per team and gender, with the rows the report counted', () => {
    expect(model.teams.length).toBe(6);
    expect(model.teams.map(t => t.genderLabel)).toEqual(['Men', 'Women', 'Men', 'Women', 'Men', 'Women']);
    expect(model.teams.map(t => t.rowsCreated)).toEqual(seeds.report.teams.map(t => t.rowsCreated));
    expect(model.totalRows).toBe(seeds.report.totalRows);
    expect(model.teams.reduce((sum, t) => sum + t.rowsCreated, 0)).toBe(model.totalRows);
    expect(model.teamCount).toBe(3);
  });

  it('lists the report names, with diving moved out of the no-seed list', () => {
    for (const [index, team] of seeds.report.teams.entries()) {
      const row = model.teams[index];
      expect(row.athletesWithNoTimes).toEqual(team.athletesWithNoTimes.map(a => a.name));
      expect(row.divingExcluded).toEqual(team.athletesWithNoSeedInMeetCourse.filter(a => a.reason === 'diving_not_supported').map(a => a.name));
      expect(row.noSeedInCourse.length + row.divingExcluded.length).toBe(team.athletesWithNoSeedInMeetCourse.length);
      expect(row.swimmers.length).toBe(team.eventsChosenPerSwimmer.filter(s => s.events.some(e => e.chosen)).length);
    }
    // The trimmed fixtures keep 6 of each team's swimmers, so most of the roster has no times page.
    expect(model.teams.some(t => t.athletesWithNoTimes.length > 0)).toBe(true);
  });

  it('shows each chosen event once as a chip with the seed time from the report', () => {
    const first = model.teams.find(t => t.swimmers.length > 0)!;
    const swimmer = first.swimmers[0];
    expect(swimmer.chosen.length).toBeGreaterThan(0);
    const source = seeds.report.teams.flatMap(t => t.eventsChosenPerSwimmer).find(s => s.name === swimmer.name)!;
    expect(swimmer.chosen).toEqual(source.events.filter(e => e.chosen).map(e => ({ event: e.event, time: e.time, isExhibition: e.isExhibition === true, fillsRemovedSlot: false })));
    expect(new Set(swimmer.chosen.map(c => c.event)).size).toBe(swimmer.chosen.length);
  });

  it('shows every caveat of the report, relays not included, and the exhibition caveat, each once', () => {
    for (const caveat of built.build.caveats) expect(model.caveats).toContain(caveat);
    expect(model.caveats.some(c => /Relays are not included/.test(c))).toBe(true);
    expect(model.caveats.some(c => /Diving is not included/.test(c))).toBe(true);
    expect(model.caveats.some(c => /Events run in the standard program order/.test(c))).toBe(true);
    // The exhibition lines come from the report, not from a fixed string in the view.
    expect(model.caveats.some(c => /exhibition/i.test(c))).toBe(model.exhibitionSeedsUsed > 0);
    expect(new Set(model.caveats).size).toBe(model.caveats.length);
    expect(model.eventOrderSource).toBe('program-default');
  });

  it('words parse warnings as warnings and keeps them out of the caveats', () => {
    expect(model.warnings.length).toBeGreaterThan(0);
    expect(model.warnings.every(w => w.kind === 'other' || w.kind === 'drift')).toBe(true);
    expect(model.warnings.some(w => /diving-score-not-a-time/.test(w.text))).toBe(true);
  });

  it('carries the exhibition counts and tags from the report, and includes exhibition seeds by default', () => {
    const reported = seeds.report.teams.reduce((sum, t) => sum + t.exhibitionSeedsUsed, 0);
    expect(model.exhibitionSeedsUsed).toBe(reported);
    expect(model.exhibitionEventsExcluded).toBe(0);
    const tagged = model.teams.reduce((sum, t) => sum + t.swimmers.reduce((n, s) => n + s.chosen.filter(c => c.isExhibition).length, 0), 0);
    expect(tagged).toBe(reported);
    expect(model.teams.map(t => t.exhibitionSeedsUsed)).toEqual(seeds.report.teams.map(t => t.exhibitionSeedsUsed));
  });

  it('drops exhibition events when the switch is off, and says how many', () => {
    const off = buildMeet({ captureIds: CAPTURE_IDS, resultsByCaptureId: results, scoringChoiceId: 'nsisc', includeExhibition: false }, 'ws-view-test-3', 1);
    expect(off.model.exhibitionSeedsUsed).toBe(0);
    expect(off.model.exhibitionEventsExcluded).toBe(off.seeds.report.teams.reduce((sum, t) => sum + t.exhibitionEventsExcluded, 0));
    expect(off.model.totalRows).toBeLessThanOrEqual(model.totalRows);
    expect(off.model.teams.every(t => t.swimmers.every(s => s.chosen.every(c => !c.isExhibition)))).toBe(true);
  });

  it('refuses to combine when a capture has no result yet', () => {
    expect(() => combineCaptureResults([...CAPTURE_IDS], { [CAPTURE_IDS[0]]: results[CAPTURE_IDS[0]] })).toThrow(/has not been read yet/);
  });

  it('puts the first picked team first', () => {
    const reversed = buildMeet({ captureIds: [...CAPTURE_IDS].reverse(), resultsByCaptureId: results, scoringChoiceId: 'nsisc' }, 'ws-view-test-2', 1);
    expect(reversed.model.teams[0].teamName).toBe(model.teams[model.teams.length - 2].teamName);
  });

  it('builds a men and women pair with the Gender enum labels', () => {
    expect(new Set(model.teams.map(t => t.genderLabel))).toEqual(new Set([Gender.MEN, Gender.WOMEN]));
  });
});
