/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The extension half of crawl scopes:
 * `extensions/swimcloud-companion/src/captureResume.ts` (what a re-crawl
 * refetches) and `.../src/progress.ts` (what the panel promises before the
 * coach commits).
 *
 * ## The case this file exists for
 *
 * Resume across a *widening* scope change. A coach crawls a meet as "Meet
 * results only", gets a capture that honestly reports
 * `'every-planned-page-fetched'`, and later re-crawls the same meet as
 * "Everything". If resume were decided from the recorded scope — "this capture
 * is complete, skip it" — the roster and swimmer-times pages would be skipped
 * forever and the second crawl would be a no-op that reported success. That is
 * the subtlest way this feature could go wrong, and the reason
 * `captureResume.ts` decides per canonical URL, from stored bytes, and reads
 * the recorded scope for panel text only.
 *
 * No `chrome.*`, no DOM, no network — same discipline as
 * `swimCloudExtensionCaptureResume.test.ts`, which this file sits beside.
 */

import { describe, expect, it } from 'vitest';
import {
  crawlScopeRecordFor,
  defaultSwimCloudCrawlScope,
  passesNewlyPlannedBy,
  planMeetTeamRosters,
  planScopedMeetCrawl,
  swimCloudCrawlScope,
  type SwimCloudCrawlScopeId,
} from '@omniswim/swimcloud/crawlPlan';
import {
  alreadyCapturedUrls,
  decideResumeFromRoundTrip,
  partitionResumableSteps,
  readStoredCapture,
} from '../extensions/swimcloud-companion/src/captureResume';
import { planSwimmerTimesSteps } from '../extensions/swimcloud-companion/src/swimmerTimes';
import {
  crawlPassLabel,
  formatCrawlScopeNote,
  formatCrawlVolumeFloorLineForScope,
} from '../extensions/swimcloud-companion/src/progress';

const MEET = '356467';
const TEAMS = ['58', '412'] as const;
const MIN_DELAY_MS = 3000;

function scope(id: SwimCloudCrawlScopeId) {
  return swimCloudCrawlScope(id);
}

/** A stored page ref in the shape `swimcloudCaptureRoutes.ts` writes. */
function pageRef(canonicalUrl: string, resourceKind: string) {
  return {
    canonicalUrl,
    resourceKind,
    outcome: 'ok',
    retrievedAt: '2026-09-20T00:00:00.000Z',
  };
}

/**
 * The stored record a finished "meet results only" crawl leaves behind: every
 * swims page it planned, no roster page, no swimmer-times page, and a
 * `crawlScope` saying that was the plan.
 */
function meetResultsOnlyCapture() {
  const plan = planScopedMeetCrawl({
    meetId: MEET,
    teamIds: TEAMS,
    scope: scope('meet-results'),
    // Two pages of swims for one team+gender, so the record holds a page 2 as
    // well — the pages a resumed crawl really does skip.
    knownTotalPages: { '58:M': 2 },
  });
  return {
    captureId: `meet-${MEET}`,
    subject: { kind: 'meet', meetId: MEET },
    completeness: 'every-planned-page-fetched',
    pages: plan.swimsSteps.map((step) => pageRef(step.canonicalUrl, 'meetTeamSwims')),
    crawlScope: crawlScopeRecordFor(scope('meet-results')),
  };
}

/* ========================================================================== */
/* The stored scope is read, and read honestly                                */
/* ========================================================================== */

describe('readStoredCapture — the crawlScope field', () => {
  it('reads a recorded scope off the stored record', () => {
    const stored = readStoredCapture(meetResultsOnlyCapture());
    expect(stored?.crawlScope).toStrictEqual({
      latestScopeId: 'meet-results',
      plannedPasses: ['meetTeamSwims', 'meetEvent'],
    });
  });

  it('leaves the scope absent for a record that carries none', () => {
    // The real 234-page capture in `data/swimcloud-captures/` is this shape.
    // Absent must stay absent: a default here would stamp a full-crawl claim
    // on a record that never made one.
    const record = meetResultsOnlyCapture() as Record<string, unknown>;
    delete record.crawlScope;
    expect(readStoredCapture(record)?.crawlScope).toBeUndefined();
  });

  it('drops an unreadable scope rather than half-reading it', () => {
    for (const junk of [
      { latestScopeId: 'not-a-scope', plannedPasses: ['teamRoster'] },
      { latestScopeId: 'everything' },
      { latestScopeId: 'everything', plannedPasses: 'teamRoster' },
      'everything',
      42,
    ]) {
      const record = { ...meetResultsOnlyCapture(), crawlScope: junk };
      expect(readStoredCapture(record)?.crawlScope).toBeUndefined();
    }
  });

  it('drops a pass name this build has never heard of, keeping the rest', () => {
    const record = {
      ...meetResultsOnlyCapture(),
      crawlScope: { latestScopeId: 'everything', plannedPasses: ['teamRoster', 'meetVideo'] },
    };
    expect(readStoredCapture(record)?.crawlScope?.plannedPasses).toStrictEqual(['teamRoster']);
  });

  it('surfaces the stored scope on the resume decision, and never as a skip instruction', () => {
    const decision = decideResumeFromRoundTrip({
      kind: 'ok',
      response: { available: true, found: true, capture: meetResultsOnlyCapture() },
    });
    expect(decision.degradation).toBe('none');
    expect(decision.storedScope?.latestScopeId).toBe('meet-results');
    // Every skip in the set is a URL with bytes behind it. Nothing was skipped
    // on the strength of the scope record.
    expect(decision.alreadyCaptured.size).toBe(meetResultsOnlyCapture().pages.length);
  });

  it('reports no stored scope when the app could not be reached', () => {
    for (const trip of [
      { kind: 'timeout' },
      { kind: 'error', message: 'worker asleep' },
    ] as const) {
      expect(decideResumeFromRoundTrip(trip).storedScope).toBeUndefined();
    }
  });
});

/* ========================================================================== */
/* Resume across a scope change — the case that must not silently no-op       */
/* ========================================================================== */

describe('re-crawling a narrowed capture under a wider scope', () => {
  const stored = readStoredCapture(meetResultsOnlyCapture());
  const alreadyCaptured = alreadyCapturedUrls(stored);

  it('re-fetches every roster page, because the store holds bytes for none of them', () => {
    const widened = planScopedMeetCrawl({
      meetId: MEET,
      teamIds: TEAMS,
      scope: defaultSwimCloudCrawlScope(),
    });
    const partition = partitionResumableSteps(widened.rosterSteps, alreadyCaptured);

    expect(widened.rosterSteps).toStrictEqual(planMeetTeamRosters({ meetId: MEET, teamIds: TEAMS }));
    expect(widened.rosterSteps.length).toBe(TEAMS.length * 2);
    // The whole point: not one roster page is treated as already done.
    expect(partition.alreadyCaptured).toStrictEqual([]);
    expect(partition.toFetch).toStrictEqual(widened.rosterSteps);
  });

  it('runs the swimmer-times pass the narrow crawl declined', () => {
    const widened = planScopedMeetCrawl({
      meetId: MEET,
      teamIds: TEAMS,
      scope: defaultSwimCloudCrawlScope(),
    });
    expect(widened.plansSwimmerTimes).toBe(true);

    // Rosters the re-crawl would parse on this run. Their swimmer-times pages
    // were never fetched, so every one of them is still to fetch.
    const plan = planSwimmerTimesSteps(MEET, [
      [{ swimCloudSwimmerId: '111' }, { swimCloudSwimmerId: '222' }],
      [{ swimCloudSwimmerId: '333' }],
    ]);
    const partition = partitionResumableSteps(plan.steps, alreadyCaptured);
    expect(plan.steps).toHaveLength(3);
    expect(partition.toFetch).toHaveLength(3);
    expect(partition.alreadyCaptured).toStrictEqual([]);
  });

  it('still skips the swims pages the narrow crawl did fetch', () => {
    // The saving a resume is supposed to make is unchanged by the widening:
    // the pages that are on disk stay on disk.
    const widened = planScopedMeetCrawl({
      meetId: MEET,
      teamIds: TEAMS,
      scope: defaultSwimCloudCrawlScope(),
      knownTotalPages: { '58:M': 2 },
    });
    const partition = partitionResumableSteps(widened.swimsSteps, alreadyCaptured);
    expect(partition.toFetch).toStrictEqual([]);
    expect(partition.alreadyCaptured).toHaveLength(widened.swimsSteps.length);
    expect(widened.swimsSteps.length).toBe(TEAMS.length * 2 + 1);
  });

  it('tells the coach what the widening adds, before they commit to the wait', () => {
    expect(passesNewlyPlannedBy(stored?.crawlScope, defaultSwimCloudCrawlScope())).toStrictEqual([
      'teamRoster',
      'swimmerTimes',
    ]);
  });

  it('adds nothing when the same narrow scope is re-run', () => {
    expect(passesNewlyPlannedBy(stored?.crawlScope, scope('meet-results'))).toStrictEqual([]);
  });

  it('treats a capture with no recorded scope as having planned nothing yet', () => {
    // Not as "probably everything". The pages on disk are still what decides
    // the fetching; this only governs what the panel offers to add.
    const record = meetResultsOnlyCapture() as Record<string, unknown>;
    delete record.crawlScope;
    const scopeless = readStoredCapture(record);
    expect(passesNewlyPlannedBy(scopeless?.crawlScope, defaultSwimCloudCrawlScope())).toStrictEqual([
      'meetTeamSwims',
      'meetEvent',
      'teamRoster',
      'swimmerTimes',
    ]);
    // And its stored pages are still skipped on their own merit.
    expect(alreadyCapturedUrls(scopeless).size).toBe(meetResultsOnlyCapture().pages.length);
  });
});

/* ========================================================================== */
/* The pre-flight estimate                                                    */
/* ========================================================================== */

describe('formatCrawlVolumeFloorLineForScope', () => {
  it('quotes half the structural pages for meet results only', () => {
    // 4 teams: 8 swims page-1s instead of 8 swims + 8 rosters.
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('meet-results'));
    expect(line).toContain('at least 8 requests');
    expect(line).toContain('Meet results only');
    expect(line).not.toContain("each team's roster");
    expect(line).toContain('Skipped by this scope:');
    expect(line).toContain(crawlPassLabel('swimmerTimes'));
  });

  it('quotes the full structural floor for everything, and skips nothing', () => {
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, defaultSwimCloudCrawlScope());
    expect(line).toContain('at least 16 requests');
    expect(line).not.toContain('Skipped by this scope:');
    expect(line).toContain('one page per rostered swimmer');
  });

  it('never promises swimmer pages a rosters-only-declining scope will not fetch', () => {
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('meet-results'));
    expect(line).not.toContain('one page per rostered swimmer');
  });

  it('moves when the scope moves — the whole reason the line is rendered', () => {
    const narrow = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('meet-results'));
    const wide = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, defaultSwimCloudCrawlScope());
    expect(narrow).not.toBe(wide);
  });

  it('quotes the roster floor, and no swims pages, for rosters and season bests', () => {
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('roster-and-season-bests'));
    expect(line).toContain('at least 8 requests');
    expect(line).toContain("each team's roster");
    expect(line).not.toContain("page 1 of each team's swims");
  });
});

/* ========================================================================== */
/* The line that stays up for the whole crawl                                 */
/* ========================================================================== */

describe('formatCrawlScopeNote', () => {
  it('names every pass a narrowed crawl will not ask for', () => {
    const note = formatCrawlScopeNote(scope('meet-results'));
    expect(note).toContain('Meet results only');
    expect(note).toContain(crawlPassLabel('teamRoster'));
    expect(note).toContain(crawlPassLabel('swimmerTimes'));
    // Says the absence is the plan, so a capture holding no rosters an hour
    // later is not read as a meet whose teams have no rosters.
    expect(note).toContain('never asks for them');
  });

  it('says so out loud when nothing is skipped, rather than going blank', () => {
    const note = formatCrawlScopeNote(defaultSwimCloudCrawlScope());
    expect(note.length).toBeGreaterThan(0);
    expect(note).toContain('every pass is planned');
  });

  it('gives every scope a non-empty note', () => {
    for (const id of ['meet-results', 'roster-and-season-bests', 'everything'] as const) {
      expect(formatCrawlScopeNote(scope(id)).length).toBeGreaterThan(0);
    }
  });
});

describe('crawlPassLabel', () => {
  it('names all four passes in words a coach reads', () => {
    expect(crawlPassLabel('meetTeamSwims')).toBe('team swims at this meet');
    expect(crawlPassLabel('meetEvent')).toBe('per-event round pages');
    expect(crawlPassLabel('teamRoster')).toBe('team rosters');
    expect(crawlPassLabel('swimmerTimes')).toBe('swimmer personal bests');
  });
});
