/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The swimmer-times leg of a meet crawl, as pure functions.
 *
 * A meet capture answers "who swam what, here". A roster answers "who is on
 * this program". Neither answers "what has this swimmer done this season",
 * which is what a coach comparing entries actually needs — that lives on
 * `/swimmer/{id}/times/`, one small static page per swimmer. This module turns
 * a set of parsed rosters into the exact list of those pages to fetch, and
 * carries the two constants that govern how fast the fetch pool is allowed to
 * go.
 *
 * ## What is here and what is not
 *
 * The URL is **not** built here. `planMeetSwimmerTimes` in
 * `packages/swimcloud/src/crawlPlan.ts` owns the `/swimmer/{id}/times/`
 * template, the "no gender, no season_id, no page" rules behind it, and the
 * dedupe by swimmer id, all pinned against the real capture archived as
 * `tests/fixtures/swimcloud-real-swimmer-times-1472365.html`. This module calls
 * it. A second copy of that template living in the extension is exactly the
 * mistake `./background.ts`'s header documents about the old hand-copied
 * capture-id rule: two implementations that agree only by construction, until
 * one changes.
 *
 * What this module adds is the part the planner does not have and should not:
 * the reduction from *roster rows* to *swimmer ids*, and the arithmetic that
 * makes the resulting count explainable on the panel.
 */

import { planMeetSwimmerTimes, type SwimCloudCrawlStep } from '@omniswim/swimcloud/crawlPlan';
import type { SwimCloudMeetId, SwimCloudSwimmerId } from '@omniswim/swimcloud/entities';

/* -------------------------------------------------------------------------- */
/* Pacing constants — the whole of the deliberate relaxation, in two numbers    */
/* -------------------------------------------------------------------------- */

/**
 * Simultaneous in-flight swimmer-times fetches. Three, not unbounded.
 *
 * Why a pool at all: the sequential crawl fetches one page every 3 s, so a meet
 * with 412 rostered swimmers is 412 × 3 s ≈ 21 minutes of swimmer-times pages
 * alone, on top of the team-swims crawl. Almost all of that is dead air — the
 * pages are small and static and the client is idle between them.
 *
 * Why three: it is enough to keep the link busy while one request is in flight
 * (the point of the exercise) and small enough that the pattern is still a
 * person's browser doing several things at once, not a scraper opening a
 * connection pool. It is a fixed cap, never scaled to the swimmer count — a
 * bigger meet gets a longer crawl, not a wider one.
 *
 * This applies to **swimmer-times pages only**. Team-swims and roster pages
 * keep the sequential 3 s pacing; see `./boundedFetchPool.ts` for the full
 * argument and the constraint it relaxes.
 */
export const SWIMMER_TIMES_CONCURRENCY = 3;

/**
 * Minimum gap between the *start* of one swimmer-times fetch and the next.
 *
 * Without this, the pool would fire {@link SWIMMER_TIMES_CONCURRENCY} requests
 * in the same millisecond every time a lane freed up, which is a burst — the
 * exact shape `plans/2026-09-06/01-legal-and-access-strategy.md` treats as the
 * difference between "one coach's tool" and "a bulk scraper". With it, the
 * pool's steady-state request rate has a hard ceiling of one per 400 ms
 * regardless of how fast SwimCloud answers.
 *
 * 400 ms is chosen so the two limits agree instead of one masking the other:
 * three lanes against a page that answers in roughly a second sustain about
 * three requests a second, and a 400 ms floor holds the pool to 2.5, so the
 * stagger — the thing that is actually about politeness — is the binding
 * constraint rather than a formality.
 *
 * Stated plainly, because it is a real change and not a free one: this is
 * ~7.5× the sequential request rate for this category of page. It is not
 * risk-free. It is bounded, it is confined to leaf pages that carry no
 * meet-results data, and the core capture is unaffected either way.
 */
export const SWIMMER_TIMES_STAGGER_MS = 400;

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The only part of `parseTeamRosterHtml`'s `SwimCloudAthlete` this module
 * reads. Structural on purpose: a real `SwimCloudAthlete[]` satisfies it, and
 * a test can build one from two fields instead of the whole entity.
 */
export interface SwimCloudRosterAthleteRef {
  /**
   * Absent when the roster row carried no `/swimmer/{id}/` link. That is a real
   * roster row for a real athlete with no SwimCloud profile link on this page —
   * it is counted, never invented a URL for.
   */
  readonly swimCloudSwimmerId?: SwimCloudSwimmerId;
  readonly name?: string;
}

/**
 * The full swimmer-times plan for a meet, with the arithmetic that explains it.
 *
 * The counts are not decoration. `rosterRowsSeen` minus `withoutSwimmerId`
 * minus `duplicates` is exactly `steps.length`, so a coach looking at
 * "412 swimmers" on the panel can be told why it is not the 431 rows the
 * rosters listed. A plan that just returned the array would make an
 * under-fetch (every row on one roster missing its profile link, say) look
 * identical to a small meet.
 */
export interface SwimCloudSwimmerTimesPlan {
  /** One `swimmerTimes` step per swimmer, from `planMeetSwimmerTimes`. */
  readonly steps: readonly SwimCloudCrawlStep[];
  /** Roster rows across every parsed roster, including ones that yielded no step. */
  readonly rosterRowsSeen: number;
  /** Rows whose roster cell carried no `/swimmer/{id}/` link. */
  readonly withoutSwimmerId: number;
  /** Rows naming a swimmer id already seen on an earlier roster. */
  readonly duplicates: number;
}

/**
 * Turn every parsed roster into the ordered list of swimmer-times pages to
 * fetch, plus the counts that explain its size.
 *
 * Order is first-seen across the rosters in the order they were fetched, which
 * is `planMeetTeamRosters`'s order (team by team, men then women), so two runs
 * of the same crawl produce the same fetch sequence and a diff of two captures
 * is meaningful.
 *
 * **Deduplication is by swimmer id, across all rosters, not within one.** The
 * same swimmer can legitimately appear twice: SwimCloud lists a program's
 * roster per gender, and a school whose two rosters overlap — a data error on
 * their side, a swimmer recorded on both lists — would otherwise be fetched
 * twice, and would inflate the swimmer count the panel reports. The same
 * applies across teams, for an athlete who transferred mid-season and appears
 * on two programs' rosters. `planMeetSwimmerTimes` dedupes by id as well; this
 * function counts the duplicates it removes, which is the part the panel needs
 * and a URL planner has no business knowing about.
 */
export function planSwimmerTimesSteps(
  meetId: SwimCloudMeetId,
  rosters: readonly (readonly SwimCloudRosterAthleteRef[])[],
): SwimCloudSwimmerTimesPlan {
  const collected = collectSwimmerIds(rosters);
  return {
    steps: planMeetSwimmerTimes({ meetId, swimmerIds: collected.swimmerIds }),
    rosterRowsSeen: collected.rosterRowsSeen,
    withoutSwimmerId: collected.withoutSwimmerId,
    duplicates: collected.duplicates,
  };
}

/** {@link planSwimmerTimesSteps} without the URLs — see {@link collectSwimmerIds}. */
export interface SwimCloudSwimmerIdCollection {
  readonly swimmerIds: readonly SwimCloudSwimmerId[];
  readonly rosterRowsSeen: number;
  readonly withoutSwimmerId: number;
  readonly duplicates: number;
}

/**
 * The roster-rows-to-swimmer-ids half of {@link planSwimmerTimesSteps}, with no
 * URL planning.
 *
 * Exported for the roster pass, which needs the running distinct-swimmer count
 * for its progress line *while the rosters are still being read* and has no
 * business planning URLs to get it. Same reduction, one implementation — a
 * second count that walked the rosters its own way could disagree with the plan
 * the pass actually runs, and the panel would be quietly wrong about the size of
 * the work ahead.
 */
export function collectSwimmerIds(
  rosters: readonly (readonly SwimCloudRosterAthleteRef[])[],
): SwimCloudSwimmerIdCollection {
  const seen = new Set<string>();
  const swimmerIds: SwimCloudSwimmerId[] = [];
  let rosterRowsSeen = 0;
  let withoutSwimmerId = 0;
  let duplicates = 0;

  for (const roster of rosters) {
    for (const athlete of roster) {
      rosterRowsSeen += 1;
      const swimmerId = athlete.swimCloudSwimmerId;
      if (swimmerId === undefined || swimmerId.length === 0) {
        // A real roster row for a real athlete with no profile link on this
        // page. There is no id to fetch and one is never invented.
        withoutSwimmerId += 1;
        continue;
      }
      if (seen.has(swimmerId)) {
        duplicates += 1;
        continue;
      }
      seen.add(swimmerId);
      swimmerIds.push(swimmerId);
    }
  }

  return { swimmerIds, rosterRowsSeen, withoutSwimmerId, duplicates };
}

/* -------------------------------------------------------------------------- */
/* Failure policy for this category                                            */
/* -------------------------------------------------------------------------- */

export type SwimCloudSwimmerTimesVerdict =
  /** Record the outcome against this page; the pool carries on. */
  | { readonly action: 'record-and-continue' }
  /**
   * Record the outcome and start no further swimmer-times fetches. Pages
   * already in flight still finish and are still relayed; nothing already
   * captured is affected.
   */
  | { readonly action: 'record-and-stop-phase'; readonly message: string };

/**
 * What one swimmer-times page's outcome means for the pool.
 *
 * Deliberately **more forgiving than `classifyCrawlPageOutcome`**, and for a
 * stated reason. That table stops the whole crawl on a 5xx or a network error,
 * because a team-swims page is load-bearing: a meet capture missing one is a
 * capture with a hole in the results. A swimmer-times page is not. It is one
 * leaf page of one athlete's history, and losing it costs that athlete's
 * history and nothing else — so a timeout, a 404 (a swimmer whose profile is
 * gone), a 5xx or a dropped connection is recorded against that page and the
 * other 299 carry on. One slow swimmer must not be able to end the phase.
 *
 * **403 is the exception, and it is not a judgement call.**
 * `plans/2026-09-08/03-extension-crawler.md`'s error table makes 403 the one
 * unconditional stop: *"Stop the entire crawl immediately. No retry, no backoff
 * loop. Retrying a challenge in a loop is precisely the bulk-scraper behavior
 * `01-legal-and-access-strategy.md` §4 draws the line at."* A challenge is not
 * a property of one swimmer's page — it is the site refusing this session — so
 * "carry on with the other 299" would mean issuing 299 more requests into a
 * challenge, from a pool that is already the fastest thing this crawl does.
 * The phase stops. The crawl's own earlier work is already captured and is not
 * discarded.
 */
export function classifySwimmerTimesOutcome(outcome: {
  readonly kind: 'http-status' | 'network-error';
  readonly httpStatus?: number;
}): SwimCloudSwimmerTimesVerdict {
  if (outcome.kind === 'http-status' && outcome.httpStatus === 403) {
    return {
      action: 'record-and-stop-phase',
      message:
        'SwimCloud returned a challenge on a swimmer page. Stopping the swimmer-times pass; the meet results already captured are unaffected. Open the page in a tab, pass the challenge, then Retry.',
    };
  }
  return { action: 'record-and-continue' };
}
