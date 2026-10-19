/**
 * E1 (2026-10-16): where a SwimCloud import's scored program ends.
 *
 * A SwimCloud event page prints its program number but not where the scored
 * program stops. Without that, post-meet time trials score in computed mode
 * (meet 356467 under NSISC: +57 men, +134 women). The boundary now comes from
 * the user's scoring settings, else from a published conference program on
 * record for the same meet, else it is unknown with a warning. It is never a
 * number the code made up.
 *
 * Fixtures are synthetic pages shaped like the real ones (see
 * `tests/eventFirstImport.test.ts`). The program under test is the in-code GLVC
 * one, not the gitignored PDF, so these tests run on every machine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { CONFERENCE_PROGRAMS, GLVC_2025_26_PROGRAM } from '../packages/core/src/data/relayPrograms';
import { resolveScoredProgramBoundary } from '../packages/core/src/lib/scoredProgramBoundary';
import { calculatePoints } from '../packages/core/src/lib/utils';
import { applySwimCloudRows } from '../packages/matrix/src/lib/swimCloudMeetImportBridge';
import type { SwimCloudMeetEventResultsParse } from '../packages/swimcloud/src/parser';

const GLVC_DATES = GLVC_2025_26_PROGRAM.meetDates;

describe('resolveScoredProgramBoundary', () => {
  const ws = (over: Partial<Workspace> = {}) => ({ conference: 'GLVC', ...over }) as Pick<Workspace, 'conference' | 'scoringSettings'>;

  it('takes the last event number of the program on record when the meet matches', () => {
    const result = resolveScoredProgramBoundary({ workspace: ws(), meetStartDate: '2026-02-10', meetEndDate: '2026-02-14' });
    expect(result).toMatchObject({
      status: 'known',
      scoredEventNumberMax: 42,
      origin: 'conference-program',
      sourceId: GLVC_2025_26_PROGRAM.sourceId,
    });
  });

  it('matches the spelled-out conference name as well as the abbreviation', () => {
    const result = resolveScoredProgramBoundary({
      workspace: ws({ conference: 'Great Lakes Valley Conference' }),
      meetStartDate: '2026-02-12',
    });
    expect(result.status).toBe('known');
  });

  it('prefers a number the scoring settings state over any program', () => {
    const result = resolveScoredProgramBoundary({
      workspace: ws({ scoringSettings: { scoredEventNumberMax: 30 } as Workspace['scoringSettings'] }),
      meetStartDate: '2026-02-10',
    });
    expect(result).toMatchObject({ status: 'known', scoredEventNumberMax: 30, origin: 'scoring-setting' });
  });

  it('is unknown for NSISC, which has no numbered program on record', () => {
    const result = resolveScoredProgramBoundary({
      workspace: ws({ conference: 'NSISC' }),
      meetStartDate: '2026-02-17',
      meetEndDate: '2026-02-21',
    });
    expect(result).toMatchObject({ status: 'unknown', reason: 'no-program-on-record' });
    expect(result.status === 'unknown' && result.warning).toMatch(/NSISC/);
  });

  it('is unknown, not 42, when the meet is not the one the program describes', () => {
    const inFuture = resolveScoredProgramBoundary({ workspace: ws(), meetStartDate: '2027-02-09', meetEndDate: '2027-02-13' });
    expect(inFuture).toMatchObject({ status: 'unknown', reason: 'meet-outside-program-dates' });
    // A meet that starts inside the window and runs past it is not the same meet either.
    const straddle = resolveScoredProgramBoundary({ workspace: ws(), meetStartDate: '2026-02-13', meetEndDate: '2026-02-20' });
    expect(straddle).toMatchObject({ status: 'unknown', reason: 'meet-outside-program-dates' });
  });

  it('is unknown when the page states no date, or no conference is set', () => {
    expect(resolveScoredProgramBoundary({ workspace: ws() })).toMatchObject({ status: 'unknown', reason: 'meet-date-unknown' });
    expect(resolveScoredProgramBoundary({ workspace: ws(), meetStartDate: 'Feb 10' })).toMatchObject({
      status: 'unknown',
      reason: 'meet-date-unknown',
    });
    expect(resolveScoredProgramBoundary({ workspace: { conference: undefined }, meetStartDate: '2026-02-10' })).toMatchObject({
      status: 'unknown',
      reason: 'no-conference',
    });
  });

  it('matches whole words only', () => {
    const result = resolveScoredProgramBoundary({ workspace: ws({ conference: 'GLVCX Sectional' }), meetStartDate: '2026-02-10' });
    expect(result).toMatchObject({ status: 'unknown', reason: 'no-program-on-record' });
  });

  it('reads its dates from the archived manifest, not from memory', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', 'data', 'relay-programs', 'sources', 'manifest.json'), 'utf8'),
    ) as { sources: { id: string; meetDates: string }[] };
    for (const program of CONFERENCE_PROGRAMS) {
      const source = manifest.sources.find(s => s.id === program.sourceId);
      expect(source, `${program.sourceId} must be in the manifest`).toBeDefined();
      expect(source!.meetDates).toBe(`${program.meetDates.start} to ${program.meetDates.end}`);
    }
  });

  it('uses the highest numbered event of the program, whatever order it is listed in', () => {
    const last = Math.max(...GLVC_2025_26_PROGRAM.events.map(e => e.eventNumber));
    const result = resolveScoredProgramBoundary({ workspace: ws(), meetStartDate: '2026-02-10' });
    expect(result.status === 'known' && result.scoredEventNumberMax).toBe(last);
    expect(last).toBe(42);
  });
});

/* -------------------------------------------------------------------------- */
/* Through applySwimCloudRows: the rows are marked, or the coach is told       */
/* -------------------------------------------------------------------------- */

function eventParse(args: { eventRef: string; printedNumber: string; startDate?: string; endDate?: string }): SwimCloudMeetEventResultsParse {
  const { eventRef, printedNumber, startDate, endDate } = args;
  // One swimmer and one distance per page, so no two pages share an event.
  const distance = eventRef === '26' ? 100 : 200;
  return {
    swimCloudMeetId: '999',
    eventRef,
    meetName: 'Test Championships',
    meet: {
      swimCloudMeetId: '999',
      name: 'Test Championships',
      format: 'unknown',
      ruleset: 'unknown',
      course: 'SCY',
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
    },
    event: {
      eventId: `999:event:${eventRef}`,
      swimCloudMeetId: '999',
      eventRef,
      label: `${distance} Breast`,
      kind: 'individual',
      course: 'SCY',
      gender: 'Men',
      distance,
      stroke: 'Breast',
    },
    gender: 'Men',
    genderLabel: 'Men',
    eventIndex: [{ eventRef, label: `${distance} Breast Men`, printedNumber, status: 'Scored' }],
    rounds: [
      {
        round: 'Timed Finals',
        pointsColumn: 'none',
        rowCount: 1,
        swims: [
          {
            swimKey: `999:swim:${eventRef}`,
            entry: {
              entryId: `999:swim:${eventRef}:entry`,
              eventId: `999:event:${eventRef}`,
              athleteName: `Test Swimmer ${eventRef}`,
              swimCloudSwimmerId: eventRef,
              swimCloudTeamId: '58',
              teamName: 'Henderson State',
            },
            result: { resultId: `r${eventRef}`, entryId: 'e', eventId: `999:event:${eventRef}`, place: 1, finalTime: '58.00' },
            exhibition: false,
            relayLeadoff: false,
            cutStandards: [],
          },
        ],
      },
    ],
    rowCount: 1,
  } as unknown as SwimCloudMeetEventResultsParse;
}

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return { id: 'ws', name: 'ws', menResults: [], womenResults: [], recruits: [], createdAt: 0, ...over };
}

async function runImport(workspace: Workspace, pages: SwimCloudMeetEventResultsParse[]) {
  const patches: Partial<Workspace>[] = [];
  const result = await applySwimCloudRows([], workspace, patch => void patches.push(patch), {
    eventResults: pages,
    resolveKeepRecruits: () => true,
  });
  return { result, rows: (patches[0]?.menResults ?? []) as SwimmerResult[] };
}

describe('applySwimCloudRows marks time trials from a published program', () => {
  // Event 26 is inside the GLVC program, 938 is far above it.
  const pages = (startDate?: string, endDate?: string) => [
    eventParse({ eventRef: '26', printedNumber: '26', startDate, endDate }),
    eventParse({ eventRef: '938', printedNumber: '938', startDate, endDate }),
  ];
  const trialFlag = (rows: SwimmerResult[], eventRef: string) => rows.find(r => r.id === `999:swim:${eventRef}`)?.isTimeTrial;

  it('flags the swim above the program and keeps the program swim, with no warning', async () => {
    const { result, rows } = await runImport(
      workspaceWith({ conference: 'GLVC' }),
      pages(GLVC_DATES.start, GLVC_DATES.end),
    );
    expect(rows).toHaveLength(2);
    expect(trialFlag(rows, '938')).toBe(true);
    expect(trialFlag(rows, '26')).toBeUndefined();
    expect(result.scoredProgramBoundary).toMatchObject({ status: 'known', scoredEventNumberMax: 42, origin: 'conference-program' });
    expect(result.warnings).toEqual([]);
  });

  it('warns and marks nothing for NSISC, which has no program on record', async () => {
    const { result, rows } = await runImport(
      workspaceWith({ conference: 'NSISC' }),
      pages('2026-02-17', '2026-02-21'),
    );
    expect(rows).toHaveLength(2);
    expect(trialFlag(rows, '938')).toBeUndefined();
    expect(result.scoredProgramBoundary).toMatchObject({ status: 'unknown', reason: 'no-program-on-record' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/unknown/i);
  });

  it('warns for a GLVC meet from another year instead of borrowing 42', async () => {
    const { result, rows } = await runImport(
      workspaceWith({ conference: 'GLVC' }),
      pages('2027-02-09', '2027-02-13'),
    );
    expect(trialFlag(rows, '938')).toBeUndefined();
    expect(result.scoredProgramBoundary).toMatchObject({ status: 'unknown', reason: 'meet-outside-program-dates' });
    expect(result.warnings).toHaveLength(1);
  });

  it('uses the number the scoring settings state, with no warning', async () => {
    const { result, rows } = await runImport(
      workspaceWith({ conference: 'NSISC', scoringSettings: { scoredEventNumberMax: 42 } as Workspace['scoringSettings'] }),
      pages('2026-02-17', '2026-02-21'),
    );
    expect(trialFlag(rows, '938')).toBe(true);
    expect(trialFlag(rows, '26')).toBeUndefined();
    expect(result.scoredProgramBoundary).toMatchObject({ status: 'known', origin: 'scoring-setting' });
    expect(result.warnings).toEqual([]);
  });

  it('does not write the derived number into the workspace scoring settings', async () => {
    const patches: Partial<Workspace>[] = [];
    await applySwimCloudRows([], workspaceWith({ conference: 'GLVC' }), patch => void patches.push(patch), {
      eventResults: pages(GLVC_DATES.start, GLVC_DATES.end),
      resolveKeepRecruits: () => true,
    });
    expect(patches[0]?.scoringSettings?.scoredEventNumberMax).toBeUndefined();
  });

  it('reports no boundary when the call converted no event page', async () => {
    const result = await applySwimCloudRows([], workspaceWith({ conference: 'GLVC' }), () => undefined);
    expect(result.scoredProgramBoundary).toBeNull();
    expect(result.warnings).toEqual([]);
  });
});

describe('a flagged SwimCloud-labelled swim earns no team points', () => {
  const SETTINGS = {
    scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    scorerEligibilityMode: 'points_pool',
  } as never;
  const pointsFor = (rows: SwimmerResult[], eventRef: string) => {
    const scored = calculatePoints(rows, SETTINGS, {});
    return scored.filter(r => r.id === `999:swim:${eventRef}`).reduce((sum, r) => sum + Number(r.points ?? 0), 0);
  };

  it('scores the program swim, and scores the time trial only while it is unflagged', async () => {
    const pages = [
      eventParse({ eventRef: '26', printedNumber: '26', startDate: GLVC_DATES.start, endDate: GLVC_DATES.end }),
      eventParse({ eventRef: '938', printedNumber: '938', startDate: GLVC_DATES.start, endDate: GLVC_DATES.end }),
    ];
    const flagged = (await runImport(workspaceWith({ conference: 'GLVC' }), pages)).rows;
    const unflagged = (await runImport(workspaceWith({ conference: 'NSISC' }), pages)).rows;
    expect(pointsFor(flagged, '26')).toBe(20);
    expect(pointsFor(flagged, '938')).toBe(0);
    // The defect this closes: with no boundary the time trial wins outright.
    expect(pointsFor(unflagged, '938')).toBe(20);
    expect(Gender.MEN).toBe('Men');
  });
});
