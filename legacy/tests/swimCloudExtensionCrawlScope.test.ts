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
  crawlScopeFloorPagesPerTeam,
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

  it('plans the swimmer-times pass when widened, and fetches every page the narrow crawl never did', () => {
    const widened = planScopedMeetCrawl({
      meetId: MEET,
      teamIds: TEAMS,
      scope: defaultSwimCloudCrawlScope(),
    });
    // Declined 2026-09-20; planned again 2026-09-22 against the times JSON.
    expect(widened.plansSwimmerTimes).toBe(true);
    expect(widened.declinedNeedingRenderedDom).toStrictEqual([]);

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

  it('never goes blank, and omits the skipped clause when a scope skips nothing', () => {
    // The original case here asserted the "every pass is planned" wording for
    // the default scope. That branch is unreachable as of 2026-09-20: the only
    // scope that skips nothing is `everything`, and it now always declines the
    // swimmer-times pass, so it always has something to report. The branch is
    // kept in the formatter as defensive code for the day that pass becomes
    // fetchable again; what is asserted here is the part that is still true and
    // still matters -- a scope skipping nothing must not claim it skipped
    // something, and no scope may produce an empty row.
    const note = formatCrawlScopeNote(defaultSwimCloudCrawlScope());
    expect(note.length).toBeGreaterThan(0);
    expect(note).not.toContain('not fetched by this crawl');
  });

  it('says every pass is planned under "everything", swimmer times included', () => {
    const note = formatCrawlScopeNote(defaultSwimCloudCrawlScope());
    expect(note).toContain('every pass is planned');
    expect(note).not.toContain('cannot be fetched');
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

describe('formatCrawlVolumeFloorLineForScope — a meet that publishes its own event index', () => {
  it('counts the events and stops counting the swims pages', () => {
    // 4 teams, 57 events. Event-first fetches the 57 event pages and NONE of
    // the 8 swims page-1s, so the floor is 57 and not 8, and not 65.
    //
    // Both halves of that matter. Leaving the swims pages in would overstate
    // the crawl by teamCount*2 — which is exactly the saving event-first
    // delivers, so the estimate would hide the thing it exists to show.
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('meet-results'), 57);
    expect(line).toContain('at least 57 requests');
    expect(line).toContain("all 57 of this meet's events");
    expect(line).not.toContain("page 1 of each team's swims");
  });

  it('stops calling the event count an unknown, because it is now known', () => {
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('meet-results'), 57);
    expect(line).not.toContain('one page per distinct event is added');
    expect(line).not.toContain('extra swims pages appear');
  });

  it('adds the rosters on the wider scope, and still drops the swims pages', () => {
    // 4 teams: 57 event pages + 8 roster pages = 65.
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('everything'), 57);
    expect(line).toContain('at least 65 requests');
    expect(line).toContain("each team's roster");
    expect(line).not.toContain("page 1 of each team's swims");
  });

  it('falls back to the swims-derived estimate when no page carried an index', () => {
    // Zero is "no discovery page printed one", not "this meet has no events".
    // The crawl then runs exactly as it did before, and so must the estimate.
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('meet-results'), 0);
    expect(line).toContain('at least 8 requests');
    expect(line).toContain("page 1 of each team's swims");
    expect(line).toContain('one page per distinct event is added');
  });

  it('ignores a known event count on a scope that does not fetch event pages', () => {
    // roster-and-season-bests plans no meetEvent pass, so the meet's event
    // count is not a cost it is about to pay.
    const line = formatCrawlVolumeFloorLineForScope(4, MIN_DELAY_MS, scope('roster-and-season-bests'), 57);
    expect(line).not.toContain("all 57 of this meet's events");
    expect(line).toContain('at least 8 requests');
  });
});

describe('crawlScopeFloorPagesPerTeam — event list already known', () => {
  it('drops the swims pages, matching what planScopedMeetCrawl plans', () => {
    // The two must agree. If the estimate counts pages the planner will not
    // plan, the coach is quoted a crawl that does not happen.
    expect(crawlScopeFloorPagesPerTeam(scope('meet-results'))).toBe(2);
    expect(crawlScopeFloorPagesPerTeam(scope('meet-results'), { eventListAlreadyKnown: true })).toBe(0);
    expect(crawlScopeFloorPagesPerTeam(scope('everything'))).toBe(4);
    expect(crawlScopeFloorPagesPerTeam(scope('everything'), { eventListAlreadyKnown: true })).toBe(2);
  });

  it('agrees with planScopedMeetCrawl on the actual swims step count', () => {
    // The assertion that keeps the two in step rather than merely looking
    // similar: same scope, same flag, and the planner's own output.
    for (const id of ['meet-results', 'everything'] as const) {
      const s = scope(id);
      const planned = planScopedMeetCrawl({
        meetId: MEET,
        teamIds: TEAMS,
        scope: s,
        eventListAlreadyKnown: true,
      });
      expect(planned.swimsSteps).toStrictEqual([]);
      expect(crawlScopeFloorPagesPerTeam(s, { eventListAlreadyKnown: true }) * TEAMS.length).toBe(
        planned.swimsSteps.length + planned.rosterSteps.length,
      );
    }
  });
});
