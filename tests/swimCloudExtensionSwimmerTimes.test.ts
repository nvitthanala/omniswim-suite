/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the swimmer-times leg of a meet crawl
 * (`extensions/swimcloud-companion/src/swimmerTimes.ts`): the roster-rows-to-
 * swimmer-ids reduction, the accounting that makes the resulting count
 * explainable, and the failure policy that is deliberately more forgiving than
 * the crawl's main error table.
 *
 * The URL template itself is **not** re-implemented here — `planMeetSwimmerTimes`
 * in `packages/swimcloud/src/crawlPlan.ts` owns it. The first block below still
 * checks the URL the extension actually fetches against the `<link
 * rel="canonical">` on the one real archived capture, because that is the URL
 * the pool issues hundreds of times and a silent drift in it would produce
 * hundreds of quiet 404s during a meet.
 *
 * Not covered here, and not faked: whether the fetched HTML parses into
 * anything. This module fetches and relays bytes; parsing swimmer-times pages
 * is `packages/swimcloud`'s job and has its own tests.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SWIMMER_TIMES_CONCURRENCY,
  SWIMMER_TIMES_STAGGER_MS,
  classifySwimmerTimesOutcome,
  collectSwimmerIds,
  planSwimmerTimesSteps,
} from '../extensions/swimcloud-companion/src/swimmerTimes';
import { partitionResumableSteps } from '../extensions/swimcloud-companion/src/captureResume';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MEET_ID = '356467';

describe('the URL the pool actually fetches', () => {
  it('fetches the JSON the times page renders from, as the real page requested it', () => {
    // The template is verbatim from the user's times-endpoint report for
    // swimmer 1330318 (2026-09-22). This is the exact string
    // `runSwimmerTimesPass` hands to `fetch()`.
    const plan = planSwimmerTimesSteps(MEET_ID, [[{ swimCloudSwimmerId: '1330318', name: 'Avery Henke' }]]);
    expect(plan.steps[0].canonicalUrl).toBe('https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/');
    expect(plan.steps[0].resourceKind).toBe('swimmerFastestTimes');
  });

  it('is a leaf page: the real capture carries no pagination widget to follow', () => {
    // Why the pool plans exactly one fetch per swimmer and no page range. This
    // is what the one archived capture shows, not a claim about every swimmer.
    // A capture that ever does paginate must make this test fail rather than be
    // quietly under-fetched.
    const html = readFileSync(join(fixturesDir, 'swimcloud-real-swimmer-times-1472365.html'), 'utf8');
    expect(html).not.toContain('c-pagination');
  });
});

describe('collectSwimmerIds', () => {
  it('reduces roster rows to ids in first-seen order', () => {
    const collected = collectSwimmerIds([
      [
        { swimCloudSwimmerId: '11', name: 'A' },
        { swimCloudSwimmerId: '12', name: 'B' },
      ],
      [{ swimCloudSwimmerId: '13', name: 'C' }],
    ]);

    expect(collected.swimmerIds).toEqual(['11', '12', '13']);
    expect(collected.rosterRowsSeen).toBe(3);
    expect(collected.withoutSwimmerId).toBe(0);
    expect(collected.duplicates).toBe(0);
  });

  it('counts a swimmer on two rosters once', () => {
    // The stated data error: a program's men's and women's roster pages both
    // listing the same athlete. Also covers a mid-season transfer showing up on
    // two teams' rosters. Two pages for one swimmer would be a wasted request
    // and an inflated count on the panel.
    const collected = collectSwimmerIds([
      [{ swimCloudSwimmerId: '11' }, { swimCloudSwimmerId: '12' }],
      [{ swimCloudSwimmerId: '12' }, { swimCloudSwimmerId: '13' }],
    ]);

    expect(collected.swimmerIds).toEqual(['11', '12', '13']);
    expect(collected.rosterRowsSeen).toBe(4);
    expect(collected.duplicates).toBe(1);
  });

  it('counts a roster row with no profile link instead of inventing an id for it', () => {
    // `parseTeamRosterHtml` emits `missing-athlete-link` for a row that names a
    // real athlete with no `/swimmer/{id}/` anchor. There is no id to fetch, and
    // guessing one would be exactly the fabrication `CLAUDE.md` forbids. The
    // count is what keeps "412 swimmers from 431 rows" explainable.
    const collected = collectSwimmerIds([
      [{ name: 'No link on this row' }, { swimCloudSwimmerId: '', name: 'Empty id' }, { swimCloudSwimmerId: '9' }],
    ]);

    expect(collected.swimmerIds).toEqual(['9']);
    expect(collected.rosterRowsSeen).toBe(3);
    expect(collected.withoutSwimmerId).toBe(2);
  });

  it('accounts for every roster row exactly once', () => {
    const collected = collectSwimmerIds([
      [{ swimCloudSwimmerId: '1' }, { name: 'no id' }, { swimCloudSwimmerId: '2' }],
      [{ swimCloudSwimmerId: '2' }, { swimCloudSwimmerId: '3' }, { name: 'no id either' }],
    ]);
    expect(collected.swimmerIds.length + collected.withoutSwimmerId + collected.duplicates).toBe(
      collected.rosterRowsSeen,
    );
  });

  it('is empty, not undefined, for rosters that listed nobody', () => {
    const collected = collectSwimmerIds([[], []]);
    expect(collected.swimmerIds).toEqual([]);
    expect(collected.rosterRowsSeen).toBe(0);
  });
});

describe('planSwimmerTimesSteps', () => {
  it('carries the collection counts through alongside the planned steps', () => {
    const plan = planSwimmerTimesSteps(MEET_ID, [
      [{ swimCloudSwimmerId: '11' }, { name: 'no link' }],
      [{ swimCloudSwimmerId: '11' }, { swimCloudSwimmerId: '12' }],
    ]);

    expect(plan.steps.map((s) => s.canonicalUrl)).toEqual([
      'https://www.swimcloud.com/api/swimmers/11/profile_fastest_times/',
      'https://www.swimcloud.com/api/swimmers/12/profile_fastest_times/',
    ]);
    expect(plan.rosterRowsSeen).toBe(4);
    expect(plan.withoutSwimmerId).toBe(1);
    expect(plan.duplicates).toBe(1);
    // The identity the panel's explanation line depends on.
    expect(plan.steps.length + plan.withoutSwimmerId + plan.duplicates).toBe(plan.rosterRowsSeen);
  });

  it('records the meet the crawl belongs to on every step', () => {
    // A swimmer-times URL is not meet-scoped. The step still carries the meet so
    // the relayed page stays attributable to one capture subject.
    const plan = planSwimmerTimesSteps(MEET_ID, [[{ swimCloudSwimmerId: '11' }]]);
    expect(plan.steps[0].meetId).toBe(MEET_ID);
  });

  it('plans nothing when no roster row carried a profile link', () => {
    const plan = planSwimmerTimesSteps(MEET_ID, [[{ name: 'a' }, { name: 'b' }]]);
    expect(plan.steps).toEqual([]);
    expect(plan.rosterRowsSeen).toBe(2);
    expect(plan.withoutSwimmerId).toBe(2);
  });
});

describe('resuming the swimmer-times pass', () => {
  it('skips only the pages the store actually holds, and keeps both halves', () => {
    // Unlike a roster page — always re-read, because this run needs its content
    // in memory — a swimmer-times page's URL is knowable without its content, so
    // this is where a resumed crawl's saving on this pass lives.
    const plan = planSwimmerTimesSteps(MEET_ID, [
      [{ swimCloudSwimmerId: '11' }, { swimCloudSwimmerId: '12' }, { swimCloudSwimmerId: '13' }],
    ]);
    // An old rendered-page capture of swimmer 11 is a shell, not a stored
    // answer, so it must not count as already captured.
    const stored = new Set([
      'https://www.swimcloud.com/api/swimmers/12/profile_fastest_times/',
      'https://www.swimcloud.com/swimmer/11/times/',
    ]);

    const partition = partitionResumableSteps(plan.steps, stored);
    expect(partition.toFetch.map((s) => s.canonicalUrl)).toEqual([
      'https://www.swimcloud.com/api/swimmers/11/profile_fastest_times/',
      'https://www.swimcloud.com/api/swimmers/13/profile_fastest_times/',
    ]);
    expect(partition.alreadyCaptured).toHaveLength(1);
  });

  it('a refresh (forceRefetch) re-fetches every swimmer even when all are already captured', () => {
    // P9: refreshing one team's personal bests must actually re-fetch, not
    // silently no-op because resume sees every page already on disk.
    const plan = planSwimmerTimesSteps(MEET_ID, [
      [{ swimCloudSwimmerId: '11' }, { swimCloudSwimmerId: '12' }, { swimCloudSwimmerId: '13' }],
    ]);
    const stored = new Set(plan.steps.map((s) => s.canonicalUrl));

    const partition = partitionResumableSteps(plan.steps, stored, { forceRefetch: true });

    expect(partition.toFetch).toEqual(plan.steps);
    expect(partition.alreadyCaptured).toEqual([]);
  });
});

describe('classifySwimmerTimesOutcome', () => {
  it('carries on past a 404, a 5xx and a network error', () => {
    // The whole point of the pass: one swimmer's dead page must not cost the
    // other 299 their history. `classifyCrawlPageOutcome` stops the crawl on
    // the last two of these, and that is right for a results page.
    expect(classifySwimmerTimesOutcome({ kind: 'http-status', httpStatus: 404 }).action).toBe('record-and-continue');
    expect(classifySwimmerTimesOutcome({ kind: 'http-status', httpStatus: 500 }).action).toBe('record-and-continue');
    expect(classifySwimmerTimesOutcome({ kind: 'http-status', httpStatus: 503 }).action).toBe('record-and-continue');
    expect(classifySwimmerTimesOutcome({ kind: 'network-error' }).action).toBe('record-and-continue');
    expect(classifySwimmerTimesOutcome({ kind: 'http-status', httpStatus: 200 }).action).toBe('record-and-continue');
  });

  it('stops the pass on a 403, because a challenge is about the session and not the page', () => {
    // `03-extension-crawler.md`'s error table makes 403 the one unconditional
    // stop. Continuing would mean firing hundreds more requests into a
    // challenge from the fastest pass in the crawl — the bulk-scraper pattern
    // `01-legal-and-access-strategy.md` §4 draws the line at.
    const verdict = classifySwimmerTimesOutcome({ kind: 'http-status', httpStatus: 403 });
    expect(verdict.action).toBe('record-and-stop-phase');
    expect(verdict.action === 'record-and-stop-phase' && verdict.message).toContain('challenge');
  });
});

describe('pacing constants', () => {
  it('are bounded, and pinned', () => {
    // Pinned so a later "make it faster" edit has to argue with a test rather
    // than move a number. The tradeoff is documented on both constants.
    // Lowered 2026-09-22 from 3 lanes / 400 ms, which drew HTTP 429 on 111 of
    // 184 requests, when the pass moved to the robots-exempt /api/ endpoint.
    expect(SWIMMER_TIMES_CONCURRENCY).toBe(1);
    expect(SWIMMER_TIMES_STAGGER_MS).toBe(3000);
  });

  it('is never faster than the sequential passes', () => {
    const sequentialMinDelayMs = 3000;
    expect(SWIMMER_TIMES_STAGGER_MS).toBeGreaterThanOrEqual(sequentialMinDelayMs);
  });
});
