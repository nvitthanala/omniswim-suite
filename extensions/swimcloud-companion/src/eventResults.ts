/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The per-event-results leg of a meet crawl, as pure functions.
 *
 * A team's swims list answers "who swam what, here". It does **not** answer
 * "which round was that" — it has no round or session column at all — and a
 * swimmer who made finals appears on it twice with nothing to tell the two rows
 * apart. That answer lives on `/results/{meetId}/event/{n}/`, one page per
 * event, holding every round as its own `<caption>`-labelled table plus the
 * real meet `Score` for its finals swims. This module turns a set of parsed
 * swims lists into the exact list of those pages to fetch, and carries the two
 * constants that govern how fast the fetch pool is allowed to go.
 *
 * ## What is here and what is not
 *
 * The URL is **not** built here. `planMeetEventResults` in
 * `packages/swimcloud/src/crawlPlan.ts` owns the `/results/{meetId}/event/{n}/`
 * template and the dedupe by event reference, pinned against the real capture
 * archived as `tests/fixtures/swimcloud-real-meet-event-356467-event26.html`.
 * This module calls it. Same rule `./swimmerTimes.ts` follows, for the same
 * reason: a second copy of a URL template living in the extension is two
 * implementations that agree only by construction.
 *
 * What this module adds is the reduction the planner does not have and should
 * not: from *swims-list rows* to *event references*, and the arithmetic that
 * makes the resulting count explainable on the panel.
 *
 * ## Why the count is so much smaller than it looks
 *
 * One event page covers **every team in the field**, both sides of the bracket
 * and both rounds. A 40-team meet's swims lists reference the same 42 event
 * pages over and over; fetching one per team would be 1,680 requests for 42
 * pages' worth of facts. The dedupe here is not an optimisation, it is the
 * difference between a pass that finishes and one that does not.
 */

import { planMeetEventResults, type SwimCloudCrawlStep } from '@omniswim/swimcloud/crawlPlan';
import type { SwimCloudMeetId } from '@omniswim/swimcloud/entities';

/* -------------------------------------------------------------------------- */
/* Pacing constants                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Simultaneous in-flight event-results fetches. Three — the same number
 * `SWIMMER_TIMES_CONCURRENCY` uses, and deliberately not a new one.
 *
 * The argument for a pool at all is in `./boundedFetchPool.ts` and is not
 * re-litigated here. What is worth stating is why this pass gets the *same*
 * cap rather than a wider one: the two passes run one after the other, so the
 * cap is the peak request depth this extension ever reaches either way, and
 * that peak is the number a request-pattern check would see. Widening it for
 * one pass would raise that peak for the whole crawl.
 *
 * The counts also do not argue for it. A big championship meet's program is
 * 40-odd numbered events plus a handful of unnumbered time-trial pages — call
 * it 60 pages, both genders included, because an event page is already one
 * gender's event. At the 400 ms floor below that is about 24 seconds. The
 * swimmer-times pass, at 400+ pages, is the one that takes minutes; this pass
 * is not the bottleneck and does not need to be treated as one.
 */
export const EVENT_RESULTS_CONCURRENCY = 3;

/**
 * Minimum gap between the *start* of one event-results fetch and the next.
 *
 * Same 400 ms as the swimmer-times pass, for the reason set out on
 * `SWIMMER_TIMES_STAGGER_MS`: without a stagger the pool fires
 * {@link EVENT_RESULTS_CONCURRENCY} requests in the same millisecond every time
 * a lane frees, which is a burst, and a burst is the shape
 * `plans/2026-09-06/01-legal-and-access-strategy.md` draws the line at.
 *
 * **Not lowered, and the reason is on file rather than assumed.** OQ-5 in
 * `docs/reference/SWIMCLOUD_CAPTURE_STATE.json` records the one genuinely open
 * question about this extension's traffic — whether SwimCloud's anti-automation
 * detection can distinguish `fetch()` bursts from a loaded page — and notes
 * that only a real crawl can answer it. Removing the politeness floor to save
 * seconds on a pass that already takes under a minute would spend the one thing
 * that question is about, for nothing.
 */
export const EVENT_RESULTS_STAGGER_MS = 400;

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The only part of `parseTeamMeetSwimsHtml`'s `SwimCloudTeamMeetSwim` this
 * module reads. Structural on purpose: a real `SwimCloudTeamMeetSwim[]`
 * satisfies it, and a test can build one from one field instead of the whole
 * entity.
 */
export interface SwimCloudSwimEventRef {
  readonly event: {
    /**
     * SwimCloud's `/event/{n}/` reference, from the row's own time link.
     *
     * Absent when the row carried no such link (`missing-swim-link`). That is a
     * real row for a real swim whose results page this capture cannot name — it
     * is counted, never invented a URL for.
     */
    readonly eventRef?: string;
  };
}

/**
 * The full event-results plan for a meet, with the arithmetic that explains it.
 *
 * The counts are not decoration. `swimsSeen` minus `withoutEventRef` minus
 * `duplicates` is exactly `steps.length`, so a coach looking at "42 events" on
 * the panel can be told why it is not the 1,200 swims the lists held. A plan
 * that just returned the array would make an under-fetch — every row on one
 * team's list missing its time link, say — look identical to a small meet.
 */
export interface SwimCloudEventResultsPlan {
  /** One `meetEvent` step per distinct event reference, from `planMeetEventResults`. */
  readonly steps: readonly SwimCloudCrawlStep[];
  /** Swims-list rows across every parsed page, including ones that yielded no step. */
  readonly swimsSeen: number;
  /** Rows whose time cell carried no `/event/{n}/` link. */
  readonly withoutEventRef: number;
  /** Rows naming an event reference already seen. This is the large number, and it is the point — see the module header. */
  readonly duplicates: number;
}

/**
 * Turn every parsed swims list into the ordered list of event pages to fetch,
 * plus the counts that explain its size.
 *
 * Order is first-seen across the pages in the order they were fetched, which is
 * `planMeetTeamSwims`'s order (team by team, men then women, page 1 upward), so
 * two runs of the same crawl produce the same fetch sequence and a diff of two
 * captures is meaningful.
 */
export function planEventResultsSteps(
  meetId: SwimCloudMeetId,
  swimsPages: readonly (readonly SwimCloudSwimEventRef[])[],
): SwimCloudEventResultsPlan {
  const collected = collectEventRefs(swimsPages);
  return {
    steps: planMeetEventResults({ meetId, eventRefs: collected.eventRefs }),
    swimsSeen: collected.swimsSeen,
    withoutEventRef: collected.withoutEventRef,
    duplicates: collected.duplicates,
  };
}

/** {@link planEventResultsSteps} without the URLs — see {@link collectEventRefs}. */
export interface SwimCloudEventRefCollection {
  readonly eventRefs: readonly string[];
  readonly swimsSeen: number;
  readonly withoutEventRef: number;
  readonly duplicates: number;
}

/**
 * The swims-rows-to-event-references half of {@link planEventResultsSteps},
 * with no URL planning.
 *
 * Exported for the same reason `collectSwimmerIds` is: a caller that needs the
 * running distinct-event count *while the swims lists are still being read* has
 * no business planning URLs to get it, and a second count that walked the lists
 * its own way could disagree with the plan the pass actually runs.
 */
export function collectEventRefs(
  swimsPages: readonly (readonly SwimCloudSwimEventRef[])[],
): SwimCloudEventRefCollection {
  const seen = new Set<string>();
  const eventRefs: string[] = [];
  let swimsSeen = 0;
  let withoutEventRef = 0;
  let duplicates = 0;

  for (const page of swimsPages) {
    for (const swim of page) {
      swimsSeen += 1;
      const eventRef = swim.event.eventRef;
      if (eventRef === undefined || eventRef.length === 0) {
        withoutEventRef += 1;
        continue;
      }
      if (seen.has(eventRef)) {
        duplicates += 1;
        continue;
      }
      seen.add(eventRef);
      eventRefs.push(eventRef);
    }
  }

  return { eventRefs, swimsSeen, withoutEventRef, duplicates };
}

/* -------------------------------------------------------------------------- */
/* Failure policy for this category                                            */
/* -------------------------------------------------------------------------- */

export type SwimCloudEventResultsVerdict =
  /** Record the outcome against this page; the pool carries on. */
  | { readonly action: 'record-and-continue' }
  /**
   * Record the outcome and start no further event-results fetches. Pages
   * already in flight still finish and are still relayed; nothing already
   * captured is affected.
   */
  | { readonly action: 'record-and-stop-phase'; readonly message: string };

/**
 * What one event page's outcome means for the pool.
 *
 * The same policy `classifySwimmerTimesOutcome` applies, and for the same
 * reason: this is a leaf page. Losing one event page costs the round labels for
 * that one event — the import excludes those swims and says so, which is a
 * visible gap, not a corrupted capture — and it must not take the other 41 with
 * it. A 404 here is a real answer (an event id the swims list referenced that
 * SwimCloud does not serve a page for) and is recorded as one.
 *
 * **403 is the exception, and it is not a judgement call.**
 * `plans/2026-09-08/03-extension-crawler.md`'s error table makes 403 the one
 * unconditional stop: a challenge is the site refusing this session, not a
 * property of one page, so carrying on would mean firing the rest of the pass
 * into a challenge.
 */
export function classifyEventResultsOutcome(outcome: {
  readonly kind: 'http-status' | 'network-error';
  readonly httpStatus?: number;
}): SwimCloudEventResultsVerdict {
  if (outcome.kind === 'http-status' && outcome.httpStatus === 403) {
    return {
      action: 'record-and-stop-phase',
      message:
        'SwimCloud returned a challenge on an event results page. Stopping the event-results pass; the meet results already captured are unaffected, but prelims and finals cannot be told apart for the events not yet fetched. Open the page in a tab, pass the challenge, then Retry.',
    };
  }
  return { action: 'record-and-continue' };
}
