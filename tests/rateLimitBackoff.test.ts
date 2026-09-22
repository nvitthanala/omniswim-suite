/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A 429 is not a 404, and the crawler used to treat them the same.
 *
 * There was no rate-limit handling anywhere in the extension: a throttled page
 * was filed as `http-error` and never requested again. The archived crawl shows
 * what that cost — its pooled pass took **111 of 184** requests as HTTP 429 and
 * lost every one of those pages with no retry.
 *
 * The current sequential pacing is not throttled (50 of 50, then 51 of 51 event
 * pages, all clean), so this is insurance rather than a fix for an observed
 * failure. That shapes every test here: the load-bearing assertions are the
 * ones proving this can only ever make the crawl *slower*, and that it cannot
 * park indefinitely on one page.
 */

import { describe, expect, it } from 'vitest';
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_RATE_LIMIT_RETRIES,
  decideRateLimitRetry,
  formatRateLimitWaitLine,
  parseRetryAfterMs,
} from '../extensions/swimcloud-companion/src/rateLimitBackoff';

const NOW = Date.parse('2026-09-22T06:00:00.000Z');

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('120', NOW)).toBe(120_000);
    expect(parseRetryAfterMs('  30  ', NOW)).toBe(30_000);
    expect(parseRetryAfterMs('0', NOW)).toBe(0);
  });

  it('reads an HTTP-date, which is the other legal shape', () => {
    expect(parseRetryAfterMs('Tue, 22 Sep 2026 06:00:45 GMT', NOW)).toBe(45_000);
  });

  it('never returns a negative wait for a date already past', () => {
    // A clock skew or a slow response can put the named time behind us. A
    // negative wait would flow into a setTimeout as an immediate retry, which
    // is the opposite of what the header asked for.
    expect(parseRetryAfterMs('Tue, 22 Sep 2026 05:59:00 GMT', NOW)).toBe(0);
  });

  it('returns undefined for anything it cannot read, rather than guessing', () => {
    for (const header of [null, undefined, '', '   ', 'soon', '1.5', '-5', 'NaN']) {
      expect(parseRetryAfterMs(header, NOW), String(header)).toBeUndefined();
    }
  });
});

describe('decideRateLimitRetry', () => {
  it('honours the delay the server named', () => {
    const d = decideRateLimitRetry(1, '30', NOW);
    expect(d).toStrictEqual({ action: 'retry', waitMs: 30_000, fromRetryAfter: true });
  });

  it('never retries sooner than the crawl would have fetched anyway', () => {
    // The load-bearing one. Being told "too fast" must never produce a request
    // quicker than the 3 s pacing that has never been throttled. A server
    // offering 1 s does not get taken up on it.
    const d = decideRateLimitRetry(1, '1', NOW);
    expect(d.action).toBe('retry');
    expect(d.action === 'retry' && d.waitMs).toBe(BASE_BACKOFF_MS);
  });

  it('backs off exponentially when the server names nothing', () => {
    expect(decideRateLimitRetry(1, null, NOW)).toStrictEqual({
      action: 'retry',
      waitMs: 3000,
      fromRetryAfter: false,
    });
    expect(decideRateLimitRetry(2, null, NOW)).toMatchObject({ waitMs: 6000 });
    expect(decideRateLimitRetry(3, null, NOW)).toMatchObject({ waitMs: 12_000 });
  });

  it('gives up rather than parking the crawl for an hour', () => {
    // A server may legitimately say "come back in an hour". Honouring that
    // literally leaves a coach staring at a frozen panel during a meet. The
    // page is reported as not served, which is the same outcome as before the
    // retry existed — but with the reason named.
    const d = decideRateLimitRetry(1, '3600', NOW);
    expect(d.action).toBe('give-up');
    expect(d.action === 'give-up' && d.reason).toContain('3600s');
  });

  it('stops after a bounded number of attempts', () => {
    const d = decideRateLimitRetry(MAX_RATE_LIMIT_RETRIES + 1, null, NOW);
    expect(d.action).toBe('give-up');
    // And the attempt before it still retries, so the bound is the bound and
    // not an off-by-one that retries once too few.
    expect(decideRateLimitRetry(MAX_RATE_LIMIT_RETRIES, null, NOW).action).toBe('retry');
  });

  it('never waits longer than the cap, however many attempts', () => {
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const d = decideRateLimitRetry(attempt, null, NOW);
      if (d.action === 'retry') expect(d.waitMs).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });

  it('bounds the total time one page can hold the crawl', () => {
    // 3 + 6 + 12 seconds. A crawl that spends longer than that on a single URL
    // has stopped being something a coach can watch, and the page is reported
    // either way.
    let total = 0;
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const d = decideRateLimitRetry(attempt, null, NOW);
      if (d.action === 'retry') total += d.waitMs;
    }
    expect(total).toBe(21_000);
  });
});

describe('formatRateLimitWaitLine', () => {
  it('says the crawl is waiting, not stuck', () => {
    const line = formatRateLimitWaitLine('https://www.swimcloud.com/results/356467/event/26/', {
      action: 'retry',
      waitMs: 6000,
      fromRetryAfter: false,
    });
    expect(line).toContain('Rate-limited');
    expect(line).toContain('6s');
    expect(line).toContain('has not stalled');
  });

  it('distinguishes the server naming a delay from us choosing one', () => {
    const asked = formatRateLimitWaitLine('u', { action: 'retry', waitMs: 9000, fromRetryAfter: true });
    const chose = formatRateLimitWaitLine('u', { action: 'retry', waitMs: 9000, fromRetryAfter: false });
    expect(asked).toContain('SwimCloud asked for');
    expect(chose).toContain('backing off');
    expect(asked).not.toBe(chose);
  });

  it('passes a give-up reason through verbatim', () => {
    expect(formatRateLimitWaitLine('u', { action: 'give-up', reason: 'because' })).toBe('because');
  });
});
