/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Crawl scopes — `packages/swimcloud/src/crawlPlan.ts`.
 *
 * A meet crawl used to run four passes over every team with no way to ask for
 * fewer. Measured against the real archived capture in
 * `data/swimcloud-captures/captures/meet-356467.json` (4 teams, 234 pages),
 * the `swimmerTimes` pass alone is 184 of those pages — 78.6% of everything
 * fetched — and none of it is needed to score the meet's results. Scopes let a
 * coach decline a pass before the first request.
 *
 * ## What these tests are guarding
 *
 * Two things, and the second is the dangerous one.
 *
 * 1. That a scope plans the passes it says it plans, and only those. A scope
 *    that quietly kept fetching swimmer times would make the feature a lie.
 * 2. That a narrowed capture stays *distinguishable* from a full one. This is
 *    the silent-empty failure `CLAUDE.md` names as this repo's most expensive:
 *    a meet-results capture legitimately reports `'every-planned-page-fetched'`
 *    while holding zero roster pages, and any consumer that reads only that
 *    field will show an empty roster list that reads as "this meet has no
 *    rostered swimmers". The three-valued `capturePlannedPassStatus` is what
 *    makes that impossible, and `'not-recorded'` — the real capture on disk
 *    today — is the value that must never collapse into either of the others.
 *
 * Pure throughout: no network, no fixture bytes, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID,
  SWIMCLOUD_CRAWL_PASSES,
  SWIMCLOUD_CRAWL_PASS_PREREQUISITE,
  SWIMCLOUD_CRAWL_SCOPES,
  capturePlannedPassStatus,
  classifySwimCloudUrl,
  crawlScopeDependencyGaps,
  crawlScopeFloorPagesPerTeam,
  crawlScopePlansPass,
  crawlScopeRecordFor,
  defaultSwimCloudCrawlScope,
  mergeCaptureCrawlScopes,
  orderCrawlPasses,
  passesNewlyPlannedBy,
  passesOutsideCrawlScope,
  planMeetTeamRosters,
  planMeetTeamSwims,
  planScopedMeetCrawl,
  readSwimCloudCrawlPass,
  readSwimCloudCrawlScopeId,
  swimCloudCrawlScope,
  type SwimCloudCrawlPass,
  type SwimCloudCrawlScope,
  type SwimCloudCrawlScopeId,
} from '@omniswim/swimcloud';

const MEET = '356467';
/** The four teams the real archived capture actually crawled. */
const TEAMS = ['58', '412', '48', '10002824'] as const;

function scope(id: SwimCloudCrawlScopeId): SwimCloudCrawlScope {
  return swimCloudCrawlScope(id);
}

/* ========================================================================== */
/* The scope table                                                            */
/* ========================================================================== */

describe('SWIMCLOUD_CRAWL_SCOPES', () => {
  /**
   * Snapshotted by value, not derived from the table under test. If a pass is
   * ever added to or removed from a scope, this is the line that has to change
   * by hand — which is the point. A coach picking "Meet results only" is
   * picking a number of hours; the set of passes behind that label is not
   * something to let drift.
   */
  const EXPECTED: Readonly<Record<SwimCloudCrawlScopeId, readonly SwimCloudCrawlPass[]>> = {
    'meet-results': ['meetTeamSwims', 'meetEvent'],
    'roster-and-season-bests': ['teamRoster', 'swimmerTimes'],
    everything: ['meetTeamSwims', 'meetEvent', 'teamRoster', 'swimmerTimes'],
  };

  it('offers exactly the three ids the panel renders radios for', () => {
    expect(SWIMCLOUD_CRAWL_SCOPES.map((s) => s.id)).toStrictEqual([
      'meet-results',
      'roster-and-season-bests',
      'everything',
    ]);
  });

  for (const [id, passes] of Object.entries(EXPECTED) as Array<
    [SwimCloudCrawlScopeId, readonly SwimCloudCrawlPass[]]
  >) {
    it(`"${id}" plans exactly ${passes.join(' + ')}`, () => {
      expect(scope(id).passes).toStrictEqual(passes);
      // Stated twice, from both directions, because "plans these" and "skips
      // the rest" are what two different parts of the UI read.
      for (const pass of SWIMCLOUD_CRAWL_PASSES) {
        expect(crawlScopePlansPass(scope(id), pass)).toBe(passes.includes(pass));
      }
      expect(passesOutsideCrawlScope(scope(id))).toStrictEqual(
        SWIMCLOUD_CRAWL_PASSES.filter((pass) => !passes.includes(pass)),
      );
    });
  }

  it('lists every scope\'s passes in canonical order', () => {
    for (const s of SWIMCLOUD_CRAWL_SCOPES) {
      expect(orderCrawlPasses(s.passes)).toStrictEqual(s.passes);
    }
  });

  it('gives every scope a label and a summary that names what it skips', () => {
    for (const s of SWIMCLOUD_CRAWL_SCOPES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.summary.length).toBeGreaterThan(0);
      if (passesOutsideCrawlScope(s).length > 0) {
        expect(s.summary.toLowerCase()).toContain('skip');
      }
    }
  });

  it('has no scope that plans a pass without the pass it is planned from', () => {
    // A scope planning `swimmerTimes` without `teamRoster` would plan zero
    // swimmer pages and then report every planned page as fetched — the
    // silent empty, wearing a success badge.
    for (const s of SWIMCLOUD_CRAWL_SCOPES) {
      expect(crawlScopeDependencyGaps(s)).toStrictEqual([]);
    }
    // The check itself has teeth: an incoherent scope really is reported.
    expect(
      crawlScopeDependencyGaps({
        id: 'meet-results',
        label: 'x',
        summary: 'x',
        passes: ['swimmerTimes'],
      }),
    ).toStrictEqual(['swimmerTimes']);
    expect(SWIMCLOUD_CRAWL_PASS_PREREQUISITE.swimmerTimes).toBe('teamRoster');
    expect(SWIMCLOUD_CRAWL_PASS_PREREQUISITE.meetEvent).toBe('meetTeamSwims');
  });

  it('counts only the passes whose page total is knowable before fetching', () => {
    // `meetEvent` and `swimmerTimes` contribute nothing: their page counts do
    // not exist until a swims list or a roster has been parsed. Quoting a
    // guess for them is what the floor line exists to avoid.
    expect(crawlScopeFloorPagesPerTeam(scope('meet-results'))).toBe(2);
    expect(crawlScopeFloorPagesPerTeam(scope('roster-and-season-bests'))).toBe(2);
    expect(crawlScopeFloorPagesPerTeam(scope('everything'))).toBe(4);
  });

  it('throws rather than defaulting when asked for an id it does not define', () => {
    expect(() => swimCloudCrawlScope('nope' as SwimCloudCrawlScopeId)).toThrow(/no scope is defined/);
  });
});

describe('the default scope', () => {
  it('is "everything" — an unchosen scope changes nothing about today\'s crawl', () => {
    expect(DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID).toBe('everything');
    expect(defaultSwimCloudCrawlScope().passes).toStrictEqual(SWIMCLOUD_CRAWL_PASSES);
    expect(passesOutsideCrawlScope(defaultSwimCloudCrawlScope())).toStrictEqual([]);
  });
});

/* ========================================================================== */
/* planScopedMeetCrawl — the gate the crawl loop actually runs through        */
/* ========================================================================== */

describe('planScopedMeetCrawl', () => {
  it('under the default scope, emits exactly what the ungated planners always did', () => {
    // The behaviour-preservation test. `everything` must not be "close to"
    // the old crawl; it must be the old crawl, step for step.
    const plan = planScopedMeetCrawl({ meetId: MEET, teamIds: TEAMS, scope: defaultSwimCloudCrawlScope() });
    expect(plan.swimsSteps).toStrictEqual(planMeetTeamSwims({ meetId: MEET, teamIds: TEAMS }));
    expect(plan.rosterSteps).toStrictEqual(planMeetTeamRosters({ meetId: MEET, teamIds: TEAMS }));
    expect(plan.plansEventResults).toBe(true);
    expect(plan.plansSwimmerTimes).toBe(true);
  });

  it('passes knownTotalPages through unchanged under the default scope', () => {
    const knownTotalPages = { '58:M': 7, '412:F': 3 };
    const plan = planScopedMeetCrawl({
      meetId: MEET,
      teamIds: TEAMS,
      scope: defaultSwimCloudCrawlScope(),
      knownTotalPages,
    });
    expect(plan.swimsSteps).toStrictEqual(planMeetTeamSwims({ meetId: MEET, teamIds: TEAMS, knownTotalPages }));
    expect(plan.swimsSteps.length).toBeGreaterThan(TEAMS.length * 2);
  });

  it('"meet-results" plans the swims pass and the event pass, and nothing else', () => {
    const plan = planScopedMeetCrawl({ meetId: MEET, teamIds: TEAMS, scope: scope('meet-results') });
    expect(plan.swimsSteps).toStrictEqual(planMeetTeamSwims({ meetId: MEET, teamIds: TEAMS }));
    expect(plan.rosterSteps).toStrictEqual([]);
    expect(plan.plansEventResults).toBe(true);
    expect(plan.plansSwimmerTimes).toBe(false);
    // Stated as a resource-kind claim too: not one roster URL is emitted.
    expect(plan.swimsSteps.some((step) => step.resourceKind === 'teamRoster')).toBe(false);
  });

  it('"roster-and-season-bests" plans the roster pass and the swimmer pass, and nothing else', () => {
    const plan = planScopedMeetCrawl({
      meetId: MEET,
      teamIds: TEAMS,
      scope: scope('roster-and-season-bests'),
    });
    expect(plan.swimsSteps).toStrictEqual([]);
    expect(plan.rosterSteps).toStrictEqual(planMeetTeamRosters({ meetId: MEET, teamIds: TEAMS }));
    expect(plan.plansEventResults).toBe(false);
    expect(plan.plansSwimmerTimes).toBe(true);
  });

  it('ignores knownTotalPages for a scope that declined the swims pass', () => {
    // The crawl loop calls this twice, the second time with page counts it
    // learned. A scope that declined the swims pass must not acquire one on
    // the second call just because a count showed up.
    const plan = planScopedMeetCrawl({
      meetId: MEET,
      teamIds: TEAMS,
      scope: scope('roster-and-season-bests'),
      knownTotalPages: { '58:M': 7 },
    });
    expect(plan.swimsSteps).toStrictEqual([]);
  });

  it('every emitted URL still classifies as the kind its step claims', () => {
    for (const s of SWIMCLOUD_CRAWL_SCOPES) {
      const plan = planScopedMeetCrawl({ meetId: MEET, teamIds: TEAMS, scope: s });
      for (const step of [...plan.swimsSteps, ...plan.rosterSteps]) {
        const classification = classifySwimCloudUrl(step.canonicalUrl);
        expect(classification.outcome).toBe('fetchable');
        if (classification.outcome === 'fetchable') {
          expect(classification.resource.kind).toBe(step.resourceKind);
        }
      }
    }
  });

  it('throws on an incoherent scope rather than planning zero pages for it', () => {
    expect(() =>
      planScopedMeetCrawl({
        meetId: MEET,
        teamIds: TEAMS,
        scope: { id: 'meet-results', label: 'x', summary: 'x', passes: ['swimmerTimes'] },
      }),
    ).toThrow(/without the pass each one is planned from/);
  });

  it('plans nothing at all for an empty team list, for every scope', () => {
    for (const s of SWIMCLOUD_CRAWL_SCOPES) {
      const plan = planScopedMeetCrawl({ meetId: MEET, teamIds: [], scope: s });
      expect(plan.swimsSteps).toStrictEqual([]);
      expect(plan.rosterSteps).toStrictEqual([]);
    }
  });
});

/* ========================================================================== */
/* Re-measuring the archived capture, per scope                               */
/* ========================================================================== */

describe('the four-team archived meet, per scope', () => {
  /**
   * The real page counts from `data/swimcloud-captures/captures/meet-356467.json`,
   * by resource kind. Snapshotted here so a drift in the archived capture
   * breaks this test rather than quietly invalidating the speedup the scope
   * feature is sold on. That capture predates the per-event pass, so it holds
   * zero `meetEvent` pages — recorded as the zero it is, never back-filled
   * with an estimate.
   */
  const ARCHIVED_PAGES_BY_KIND = {
    meetTeamSwims: 42,
    meetEvent: 0,
    teamRoster: 8,
    swimmerTimes: 184,
  } as const satisfies Record<SwimCloudCrawlPass, number>;

  const totalOf = (s: SwimCloudCrawlScope): number =>
    s.passes.reduce((sum, pass) => sum + ARCHIVED_PAGES_BY_KIND[pass], 0);

  it('sums to the 234 pages the capture actually holds', () => {
    expect(totalOf(scope('everything'))).toBe(234);
  });

  it('shows meet-results as 42 of those 234 pages, and rosters+bests as 192', () => {
    expect(totalOf(scope('meet-results'))).toBe(42);
    expect(totalOf(scope('roster-and-season-bests'))).toBe(192);
    // The claim the feature rests on: swimmer times alone is over three
    // quarters of a full crawl, and declining it is where the hours go.
    expect(ARCHIVED_PAGES_BY_KIND.swimmerTimes / 234).toBeGreaterThan(0.78);
  });
});

/* ========================================================================== */
/* What a capture records, and what an older one does not                     */
/* ========================================================================== */

describe('crawlScopeRecordFor', () => {
  it('records the scope that ran and the passes it planned, in canonical order', () => {
    expect(crawlScopeRecordFor(scope('meet-results'))).toStrictEqual({
      latestScopeId: 'meet-results',
      plannedPasses: ['meetTeamSwims', 'meetEvent'],
    });
  });
});

describe('capturePlannedPassStatus', () => {
  const meetResults = crawlScopeRecordFor(scope('meet-results'));

  it('answers "planned" for a pass the recorded scope planned', () => {
    expect(capturePlannedPassStatus(meetResults, 'meetTeamSwims')).toBe('planned');
  });

  it('answers "not-planned" for a pass it declined', () => {
    expect(capturePlannedPassStatus(meetResults, 'teamRoster')).toBe('not-planned');
    expect(capturePlannedPassStatus(meetResults, 'swimmerTimes')).toBe('not-planned');
  });

  it('answers "not-recorded" — never "not-planned" — for a capture with no scope', () => {
    // This is the capture on disk today. "It holds no roster pages" and "it
    // never asked for roster pages" are not the same statement, and nothing
    // stored lets them be told apart. Collapsing this into either of the other
    // two answers is the bug this whole three-valued type exists to prevent.
    for (const pass of SWIMCLOUD_CRAWL_PASSES) {
      expect(capturePlannedPassStatus(undefined, pass)).toBe('not-recorded');
    }
  });
});

describe('mergeCaptureCrawlScopes', () => {
  it('unions the planned passes across crawls of the same capture', () => {
    // A capture is cumulative: pages merge by canonical URL across runs. A
    // meet-results crawl followed by a full one holds both sets, so only the
    // union is a true statement about the stored pages.
    const merged = mergeCaptureCrawlScopes(
      crawlScopeRecordFor(scope('meet-results')),
      crawlScopeRecordFor(scope('roster-and-season-bests')),
    );
    expect(merged.plannedPasses).toStrictEqual(SWIMCLOUD_CRAWL_PASSES);
    expect(merged.latestScopeId).toBe('roster-and-season-bests');
  });

  it('never un-plans a pass an earlier crawl already fetched', () => {
    const merged = mergeCaptureCrawlScopes(
      crawlScopeRecordFor(scope('everything')),
      crawlScopeRecordFor(scope('meet-results')),
    );
    expect(merged.plannedPasses).toStrictEqual(SWIMCLOUD_CRAWL_PASSES);
    expect(capturePlannedPassStatus(merged, 'swimmerTimes')).toBe('planned');
  });

  it('takes the incoming scope as the latest one', () => {
    const merged = mergeCaptureCrawlScopes(undefined, crawlScopeRecordFor(scope('meet-results')));
    expect(merged).toStrictEqual({
      latestScopeId: 'meet-results',
      plannedPasses: ['meetTeamSwims', 'meetEvent'],
    });
  });
});

describe('passesNewlyPlannedBy', () => {
  it('names what widening a capture\'s scope is about to add', () => {
    expect(
      passesNewlyPlannedBy(crawlScopeRecordFor(scope('meet-results')), scope('everything')),
    ).toStrictEqual(['teamRoster', 'swimmerTimes']);
  });

  it('adds nothing when the next scope is the same or narrower', () => {
    expect(passesNewlyPlannedBy(crawlScopeRecordFor(scope('everything')), scope('meet-results'))).toStrictEqual([]);
    expect(
      passesNewlyPlannedBy(crawlScopeRecordFor(scope('meet-results')), scope('meet-results')),
    ).toStrictEqual([]);
  });

  it('treats an unrecorded scope as having planned nothing yet', () => {
    expect(passesNewlyPlannedBy(undefined, scope('everything'))).toStrictEqual(SWIMCLOUD_CRAWL_PASSES);
  });
});

/* ========================================================================== */
/* Reading untrusted values                                                   */
/* ========================================================================== */

describe('readSwimCloudCrawlScopeId / readSwimCloudCrawlPass', () => {
  it('reads a known id and a known pass', () => {
    expect(readSwimCloudCrawlScopeId('meet-results')).toBe('meet-results');
    expect(readSwimCloudCrawlPass('swimmerTimes')).toBe('swimmerTimes');
  });

  it('answers undefined — never the default — for anything else', () => {
    // `undefined` means "not stated". A validator that fell back to
    // `'everything'` would stamp a full-crawl claim onto a record that never
    // made one.
    for (const junk of ['', 'everything ', 'EVERYTHING', 'meetResults', 42, null, undefined, {}, ['everything']]) {
      expect(readSwimCloudCrawlScopeId(junk)).toBeUndefined();
    }
    for (const junk of ['', 'meetRoster', 'teamrosters', 0, null, undefined, {}]) {
      expect(readSwimCloudCrawlPass(junk)).toBeUndefined();
    }
  });
});
