/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the per-event-results leg of a meet crawl
 * (`extensions/swimcloud-companion/src/eventResults.ts`): the swims-rows-to-
 * event-references reduction, the accounting that makes the resulting count
 * explainable, the pacing constants, and the failure policy.
 *
 * The URL template itself is **not** re-implemented here —
 * `planMeetEventResults` in `packages/swimcloud/src/crawlPlan.ts` owns it and
 * `tests/swimcloudCrawlPlan.test.ts` pins it. The first block below still
 * checks the URL the extension actually fetches against the `<link
 * rel="canonical">` on the one real archived capture of this page type, because
 * a silent drift in it would produce a whole meet's worth of quiet 404s and an
 * import that quietly falls back to excluding every prelims/finals pair.
 *
 * Not covered here, and not faked: whether the fetched HTML parses into
 * anything. This module plans and the pool fetches; parsing an event page is
 * `packages/swimcloud`'s job and has its own tests against fixture F9.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_RESULTS_CONCURRENCY,
  EVENT_RESULTS_STAGGER_MS,
  classifyEventResultsOutcome,
  collectEventRefs,
  planEventResultsSteps,
  type SwimCloudSwimEventRef,
} from '../extensions/swimcloud-companion/src/eventResults';
import {
  SWIMMER_TIMES_CONCURRENCY,
  SWIMMER_TIMES_STAGGER_MS,
} from '../extensions/swimcloud-companion/src/swimmerTimes';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** One swims-list row, reduced to the one field this module reads. */
function swim(eventRef?: string): SwimCloudSwimEventRef {
  return { event: eventRef === undefined ? {} : { eventRef } };
}

describe('the URL this pass actually fetches', () => {
  it('matches the canonical URL on the one real archived event page', () => {
    const html = readFileSync(join(fixturesDir, 'swimcloud-real-meet-event-356467-event26.html'), 'utf8');
    const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html);
    if (canonical === null) throw new Error('fixture carries no <link rel="canonical">');

    const [step] = planEventResultsSteps('356467', [[swim('26')]]).steps;
    expect(step.canonicalUrl).toBe(canonical[1]);
  });
});

describe('collectEventRefs', () => {
  it('collapses a reference seen on many teams into one', () => {
    // The whole reason this pass is affordable. Three teams' lists, all naming
    // event 26; one page holds all three teams' swimmers in it.
    const collected = collectEventRefs([
      [swim('26'), swim('11')],
      [swim('26'), swim('11')],
      [swim('26'), swim('3')],
    ]);
    expect(collected.eventRefs).toStrictEqual(['26', '11', '3']);
    expect(collected.swimsSeen).toBe(6);
    expect(collected.duplicates).toBe(3);
    expect(collected.withoutEventRef).toBe(0);
  });

  it('counts a row with no event link rather than inventing a reference for it', () => {
    const collected = collectEventRefs([[swim('26'), swim(undefined), swim('')]]);
    expect(collected.eventRefs).toStrictEqual(['26']);
    expect(collected.withoutEventRef).toBe(2);
  });

  it('keeps first-seen order across pages so two runs fetch in the same sequence', () => {
    expect(collectEventRefs([[swim('42')], [swim('3')], [swim('42')], [swim('7')]]).eventRefs)
      .toStrictEqual(['42', '3', '7']);
  });

  it('accounts for every row it saw — the arithmetic the panel line depends on', () => {
    const pages = [
      [swim('26'), swim('26'), swim(undefined)],
      [swim('11'), swim('26'), swim('')],
    ];
    const collected = collectEventRefs(pages);
    expect(collected.swimsSeen - collected.withoutEventRef - collected.duplicates)
      .toBe(collected.eventRefs.length);
  });

  it('reports zeros for no pages at all, rather than failing', () => {
    expect(collectEventRefs([])).toStrictEqual({
      eventRefs: [],
      swimsSeen: 0,
      withoutEventRef: 0,
      duplicates: 0,
    });
  });
});

describe('planEventResultsSteps', () => {
  it('turns the collected references into meetEvent steps, counts intact', () => {
    const plan = planEventResultsSteps('356467', [[swim('26'), swim('26')], [swim('11')]]);
    expect(plan.steps.map(step => step.eventRef)).toStrictEqual(['26', '11']);
    expect(plan.steps.every(step => step.resourceKind === 'meetEvent')).toBe(true);
    expect(plan.steps.every(step => step.meetId === '356467')).toBe(true);
    expect(plan).toMatchObject({ swimsSeen: 3, duplicates: 1, withoutEventRef: 0 });
  });

  it('plans nothing when no row carried an event link', () => {
    // A real answer, not an error: the caller says so on the panel and the
    // import falls back to excluding duplicates, which is visible.
    expect(planEventResultsSteps('356467', [[swim(undefined), swim(undefined)]]).steps).toHaveLength(0);
  });
});

describe('pacing', () => {
  it('reuses the swimmer-times pool shape rather than inventing a wider one', () => {
    // Both pooled passes run one after the other, so the peak in-flight depth
    // this extension ever reaches is whichever of these is larger. Keeping them
    // equal keeps that peak at three. A change to either number should have to
    // argue with this test.
    expect(EVENT_RESULTS_CONCURRENCY).toBe(SWIMMER_TIMES_CONCURRENCY);
    expect(EVENT_RESULTS_STAGGER_MS).toBe(SWIMMER_TIMES_STAGGER_MS);
    expect(EVENT_RESULTS_CONCURRENCY).toBe(3);
    expect(EVENT_RESULTS_STAGGER_MS).toBe(400);
  });

  it('keeps a politeness floor at all — the stagger is never zero', () => {
    // OQ-5 in docs/reference/SWIMCLOUD_CAPTURE_STATE.json is explicitly open on
    // whether burst-shaped fetches are distinguishable from normal navigation.
    // Removing the floor spends the one thing that question is about.
    expect(EVENT_RESULTS_STAGGER_MS).toBeGreaterThan(0);
  });
});

describe('classifyEventResultsOutcome', () => {
  it('stops the whole pass on a 403, with no retry loop', () => {
    const verdict = classifyEventResultsOutcome({ kind: 'http-status', httpStatus: 403 });
    expect(verdict.action).toBe('record-and-stop-phase');
    if (verdict.action !== 'record-and-stop-phase') throw new Error('unreachable');
    expect(verdict.message).toContain('challenge');
  });

  it('carries on past a 404, a 5xx and a dropped connection', () => {
    // Losing one event page costs that event's round labels — the import
    // excludes those swims and names them — and must not take the other 41
    // with it.
    for (const status of [404, 500, 502, 503]) {
      expect(classifyEventResultsOutcome({ kind: 'http-status', httpStatus: status }).action)
        .toBe('record-and-continue');
    }
    expect(classifyEventResultsOutcome({ kind: 'network-error' }).action).toBe('record-and-continue');
  });

  it('treats a 200 as ordinary', () => {
    expect(classifyEventResultsOutcome({ kind: 'http-status', httpStatus: 200 }).action)
      .toBe('record-and-continue');
  });
});
