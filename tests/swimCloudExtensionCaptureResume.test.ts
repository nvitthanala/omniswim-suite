/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the extension's cross-session resume logic
 * (`extensions/swimcloud-companion/src/captureResume.ts`).
 *
 * The bug these pin: before this, `runCrawl()` started every run with an empty
 * `fetchedUrls` set, so closing the tab mid-crawl — or clicking the 5xx
 * **Retry** button — re-requested every already-successful page from
 * SwimCloud. `plans/2026-09-08/03-extension-crawler.md` claimed the opposite
 * ("the store's cache read-through... skips every URL already on disk"), and
 * `plans/2026-09-06/01-legal-and-access-strategy.md` treats repeat traffic
 * against SwimCloud as the thing to minimise.
 *
 * No `chrome.*`, no DOM, no network — the HTTP call itself lives in
 * `background.ts` and is covered by the manual checklist, not by a faked
 * `fetch`.
 */

import { describe, expect, it } from 'vitest';
import { planMeetTeamSwims } from '@omniswim/swimcloud/crawlPlan';
import {
  alreadyCapturedUrls,
  partitionResumableSteps,
  readStoredCapture,
  storedPageIsAlreadyCaptured,
} from '../extensions/swimcloud-companion/src/captureResume';

/** A real capture record's page-ref shape, as `swimcloudCaptureRoutes.ts` writes it. */
function pageRef(canonicalUrl: string, outcome: string) {
  return { canonicalUrl, resourceKind: 'meetTeamSwims', outcome, retrievedAt: '2026-09-08T00:00:00.000Z' };
}

describe('storedPageIsAlreadyCaptured', () => {
  it("is true only for 'ok' — the one outcome with stored bytes", () => {
    expect(storedPageIsAlreadyCaptured({ canonicalUrl: 'u', outcome: 'ok' })).toBe(true);
  });

  it('is false for every recorded-but-empty outcome', () => {
    // `putPage` is called with `entry: undefined` for all of these, so the
    // store holds a ref and no HTML. Skipping one would drop a page from the
    // capture while making it look complete.
    for (const outcome of ['http-error', 'forbidden', 'skipped', 'canceled']) {
      expect(storedPageIsAlreadyCaptured({ canonicalUrl: 'u', outcome })).toBe(false);
    }
  });

  it('is false for an outcome value this build has never heard of', () => {
    expect(storedPageIsAlreadyCaptured({ canonicalUrl: 'u', outcome: 'partially-ok' })).toBe(false);
  });
});

describe('readStoredCapture', () => {
  it('reads a well-formed record', () => {
    const record = readStoredCapture({
      captureId: 'meet-356467',
      subject: { kind: 'meet', meetId: '356467' },
      pages: [pageRef('https://www.swimcloud.com/results/356467/team/58/swims/?gender=M', 'ok')],
    });
    expect(record?.captureId).toBe('meet-356467');
    expect(record?.pages).toHaveLength(1);
    expect(record?.pages[0].outcome).toBe('ok');
  });

  it('keeps the descriptive facets when the record carries them', () => {
    const record = readStoredCapture({
      captureId: 'meet-356467',
      pages: [{ ...pageRef('u', 'ok'), teamId: '58', gender: 'M', page: 3 }],
    });
    expect(record?.pages[0]).toEqual({
      canonicalUrl: 'u',
      outcome: 'ok',
      teamId: '58',
      gender: 'M',
      page: 3,
    });
  });

  it('returns undefined rather than an empty record for anything unrecognisable', () => {
    // "we could not read the reply" and "the capture holds no pages" must not
    // collapse into the same value — the first means crawl everything.
    expect(readStoredCapture(undefined)).toBeUndefined();
    expect(readStoredCapture(null)).toBeUndefined();
    expect(readStoredCapture('meet-356467')).toBeUndefined();
    expect(readStoredCapture([])).toBeUndefined();
    expect(readStoredCapture({ captureId: 'meet-1' })).toBeUndefined();
    expect(readStoredCapture({ captureId: '', pages: [] })).toBeUndefined();
    expect(readStoredCapture({ pages: [] })).toBeUndefined();
  });

  it('drops a page ref it cannot read instead of repairing it', () => {
    const record = readStoredCapture({
      captureId: 'meet-356467',
      pages: [
        pageRef('good', 'ok'),
        { outcome: 'ok' },
        { canonicalUrl: 'no-outcome' },
        { canonicalUrl: 'numeric-outcome', outcome: 200 },
        'not-an-object',
      ],
    });
    expect(record?.pages.map((p) => p.canonicalUrl)).toEqual(['good']);
  });

  it('reads an opened-but-empty capture as a real record with no pages', () => {
    const record = readStoredCapture({ captureId: 'meet-356467', pages: [] });
    expect(record).toEqual({ captureId: 'meet-356467', pages: [] });
  });
});

describe('alreadyCapturedUrls', () => {
  it('is empty when there is no stored capture', () => {
    expect(alreadyCapturedUrls(undefined).size).toBe(0);
  });

  it("holds only the 'ok' pages' canonical URLs", () => {
    const record = readStoredCapture({
      captureId: 'meet-356467',
      pages: [pageRef('a', 'ok'), pageRef('b', 'http-error'), pageRef('c', 'ok'), pageRef('d', 'canceled')],
    });
    const urls = alreadyCapturedUrls(record);
    expect([...urls].sort()).toEqual(['a', 'c']);
  });
});

describe('partitionResumableSteps', () => {
  it('splits a real plan into what to fetch and what is already stored, keeping plan order', () => {
    const steps = planMeetTeamSwims({
      meetId: '356467',
      teamIds: ['58', '59'],
      knownTotalPages: { '58:M': 3, '58:F': 1, '59:M': 1, '59:F': 1 },
    });
    expect(steps).toHaveLength(6);

    const captured = new Set([steps[0].canonicalUrl, steps[2].canonicalUrl, steps[5].canonicalUrl]);
    const { toFetch, alreadyCaptured } = partitionResumableSteps(steps, captured);

    expect(toFetch.map((s) => s.canonicalUrl)).toEqual([
      steps[1].canonicalUrl,
      steps[3].canonicalUrl,
      steps[4].canonicalUrl,
    ]);
    expect(alreadyCaptured.map((s) => s.canonicalUrl)).toEqual([
      steps[0].canonicalUrl,
      steps[2].canonicalUrl,
      steps[5].canonicalUrl,
    ]);
    // Nothing is lost or duplicated: a skipped page still counts toward the
    // crawl's progress, so the two halves must cover the plan exactly once.
    expect(toFetch.length + alreadyCaptured.length).toBe(steps.length);
  });

  it('fetches the whole plan when the store holds nothing', () => {
    const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'] });
    const { toFetch, alreadyCaptured } = partitionResumableSteps(steps, new Set());
    expect(toFetch).toEqual(steps);
    expect(alreadyCaptured).toEqual([]);
  });

  it('fetches nothing when a completed crawl is re-run', () => {
    const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58', '59'] });
    const captured = new Set(steps.map((s) => s.canonicalUrl));
    const { toFetch, alreadyCaptured } = partitionResumableSteps(steps, captured);
    expect(toFetch).toEqual([]);
    expect(alreadyCaptured).toHaveLength(steps.length);
  });

  it('ignores a stored URL that is not in this plan', () => {
    // A previous crawl of the same meet may have included a team the coach has
    // since unchecked. Its pages stay in the store and simply do not match.
    const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'] });
    const captured = new Set(['https://www.swimcloud.com/results/356467/team/999/swims/?gender=M']);
    const { toFetch, alreadyCaptured } = partitionResumableSteps(steps, captured);
    expect(toFetch).toEqual(steps);
    expect(alreadyCaptured).toEqual([]);
  });

  it('matches on the planner’s own canonical URLs, end to end', () => {
    // The store keys pages by `classifySwimCloudUrl`'s canonicalUrl, and the
    // planner emits that same string — this is the join that makes resume
    // work at all, so it is asserted against a real record shape rather than
    // hand-built URLs.
    const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'] });
    const record = readStoredCapture({
      captureId: 'meet-356467',
      pages: steps.map((s) => pageRef(s.canonicalUrl, 'ok')),
    });
    const { toFetch } = partitionResumableSteps(steps, alreadyCapturedUrls(record));
    expect(toFetch).toEqual([]);
  });

  describe('with { forceRefetch: true }', () => {
    // The whole point of a refresh crawl: a coach re-running the personal-bests
    // pass on a team whose store already holds every one of those pages must
    // still re-fetch all of them, not skip a plan that is fully "already
    // captured". This is `P9`'s refresh feature's one behavioral change.
    it('fetches every planned page even when the store already holds all of them', () => {
      const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58', '59'] });
      const captured = new Set(steps.map((s) => s.canonicalUrl));

      const { toFetch, alreadyCaptured } = partitionResumableSteps(steps, captured, { forceRefetch: true });

      expect(toFetch).toEqual(steps);
      expect(alreadyCaptured).toEqual([]);
    });

    it('still fetches every page when nothing at all is stored', () => {
      const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'] });
      const { toFetch, alreadyCaptured } = partitionResumableSteps(steps, new Set(), { forceRefetch: true });
      expect(toFetch).toEqual(steps);
      expect(alreadyCaptured).toEqual([]);
    });

    it('does not mutate the ordinary (non-forced) behaviour of the same call site', () => {
      // An explicit `{}` and an omitted third argument must agree — a caller
      // that upgrades to pass options for one branch must not accidentally
      // change behaviour for every other branch that still omits them.
      const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'] });
      const captured = new Set([steps[0].canonicalUrl]);
      const withDefaultOptions = partitionResumableSteps(steps, captured, {});
      const withNoOptions = partitionResumableSteps(steps, captured);
      expect(withDefaultOptions).toEqual(withNoOptions);
    });
  });
});
