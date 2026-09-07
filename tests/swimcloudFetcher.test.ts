/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the Track B politeness wrapper (`packages/swimcloud/src/fetcher.ts`).
 *
 * `SwimCloudPoliteFetcher` is exercised entirely against a fake
 * `SwimCloudRawFetcher` — nothing here launches a browser or touches a
 * network. That's deliberate: this suite proves the *policy* (denylist, rate
 * limiting, cache read-through, immutable-final) is correct, independent of
 * whether the real Playwright-backed fetcher can pass SwimCloud's Cloudflare
 * challenge, which nothing in this repo has verified yet — see
 * `packages/swimcloud/src/playwrightFetcher.ts`'s file header.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemorySwimCloudCache,
  SwimCloudFinalEntryImmutableError,
  SwimCloudForbiddenUrlError,
  SwimCloudPoliteFetcher,
  SwimCloudUnfetchableUrlError,
  type SwimCloudPoliteFetcherClock,
  type SwimCloudRawFetchResult,
  type SwimCloudRawFetcher,
} from '@omniswim/swimcloud';

/** A raw fetcher that returns canned responses and records every call it received. */
class FakeRawFetcher implements SwimCloudRawFetcher {
  readonly calls: string[] = [];
  private nextResponse: SwimCloudRawFetchResult = { html: '<div>fake</div>', httpStatus: 200 };

  setNextResponse(response: SwimCloudRawFetchResult): void {
    this.nextResponse = response;
  }

  async fetchRaw(url: string): Promise<SwimCloudRawFetchResult> {
    this.calls.push(url);
    return this.nextResponse;
  }
}

/** A fully deterministic clock: time only advances when the test tells it to. */
function fakeClock(startMs = 0): SwimCloudPoliteFetcherClock & { advance(ms: number): void; sleeps: number[] } {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance(ms: number) {
      now += ms;
    },
    sleeps,
  };
}

describe('SwimCloudPoliteFetcher — the robots.txt denylist', () => {
  it('refuses to issue a request for a forbidden path, before touching the raw fetcher', async () => {
    const raw = new FakeRawFetcher();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    await expect(
      fetcher.fetch('https://www.swimcloud.com/api/teams/633/', { track: 'playwright' }),
    ).rejects.toThrow(SwimCloudForbiddenUrlError);
    expect(raw.calls).toHaveLength(0);
  });

  it('refuses every one of the four documented disallowed paths', async () => {
    const raw = new FakeRawFetcher();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below
    const forbidden = [
      'https://www.swimcloud.com/api/teams/',
      'https://www.swimcloud.com/jsonapi/teams/',
      'https://www.swimcloud.com/team/633/facilities/',
      'https://www.swimcloud.com/tz_detect/',
    ];
    for (const url of forbidden) {
      await expect(fetcher.fetch(url, { track: 'playwright' })).rejects.toThrow(SwimCloudForbiddenUrlError);
    }
    expect(raw.calls).toHaveLength(0);
  });

  it('rejects a malformed or unrecognized URL without calling the raw fetcher', async () => {
    const raw = new FakeRawFetcher();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    await expect(
      fetcher.fetch('https://www.swimcloud.com/team/not-a-number/', { track: 'playwright' }),
    ).rejects.toThrow(SwimCloudUnfetchableUrlError);
    await expect(fetcher.fetch('https://example.com/team/633/', { track: 'playwright' })).rejects.toThrow(
      SwimCloudUnfetchableUrlError,
    );
    expect(raw.calls).toHaveLength(0);
  });
});

describe('SwimCloudPoliteFetcher — rate limiting', () => {
  it('does not sleep before the first request', async () => {
    const raw = new FakeRawFetcher();
    const clock = fakeClock();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 3000, clock });

    await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright' });
    expect(clock.sleeps).toHaveLength(0);
  });

  it('sleeps out the remaining delay when a second request arrives too soon', async () => {
    const raw = new FakeRawFetcher();
    const clock = fakeClock();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 3000, clock });

    await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright' });
    clock.advance(1000); // only 1s has passed of the required 3s
    await fetcher.fetch('https://www.swimcloud.com/team/704/', { track: 'playwright' });

    expect(clock.sleeps).toEqual([2000]);
  });

  it('does not sleep at all once enough real time has already elapsed', async () => {
    const raw = new FakeRawFetcher();
    const clock = fakeClock();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 3000, clock });

    await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright' });
    clock.advance(5000); // more than the minimum delay has already passed
    await fetcher.fetch('https://www.swimcloud.com/team/704/', { track: 'playwright' });

    expect(clock.sleeps).toHaveLength(0);
  });

  it('a cache hit never advances or consults the rate limiter', async () => {
    const raw = new FakeRawFetcher();
    const clock = fakeClock();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 3000, clock });

    await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright', cache, markAs: 'final' });
    clock.advance(1); // nowhere near the delay
    const second = await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright', cache });

    expect(second.source).toBe('cache');
    expect(clock.sleeps).toHaveLength(0);
    expect(raw.calls).toHaveLength(1); // only the first, real fetch
  });
});

describe('SwimCloudPoliteFetcher — cache read-through', () => {
  it('a fresh fetch with no cache configured still succeeds and is marked network-sourced', async () => {
    const raw = new FakeRawFetcher();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below
    const result = await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright' });
    expect(result.source).toBe('network');
    expect(raw.calls).toEqual(['https://www.swimcloud.com/team/633/']);
  });

  it('a fresh fetch defaults to provisional unless markAs asserts final', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    const provisional = await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright', cache });
    expect(provisional.status).toBe('provisional');

    const final = await fetcher.fetch('https://www.swimcloud.com/team/704/', {
      track: 'playwright',
      cache,
      markAs: 'final',
    });
    expect(final.status).toBe('final');
  });

  it('a provisional cache entry is served without hitting the network by default', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    await fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache });
    const second = await fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache });

    expect(second.source).toBe('cache');
    expect(raw.calls).toHaveLength(1);
  });

  it('forceRefresh re-fetches a provisional entry', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    raw.setNextResponse({ html: '<div>day 1, in progress</div>', httpStatus: 200 });
    await fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache });

    raw.setNextResponse({ html: '<div>day 2, more results posted</div>', httpStatus: 200 });
    const refreshed = await fetcher.fetch('https://www.swimcloud.com/results/193735/', {
      track: 'playwright',
      cache,
      forceRefresh: true,
    });

    expect(refreshed.source).toBe('network');
    expect(refreshed.html).toContain('day 2');
    expect(raw.calls).toHaveLength(2);
  });

  it('a final cache entry is served on every ordinary call, never re-fetched', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    await fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache, markAs: 'final' });
    const second = await fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache });

    expect(second.source).toBe('cache');
    expect(second.status).toBe('final');
    expect(raw.calls).toHaveLength(1);
  });

  it('forceRefresh against a final entry throws rather than silently ignoring the flag or silently refetching', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    await fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache, markAs: 'final' });

    await expect(
      fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache, forceRefresh: true }),
    ).rejects.toThrow(SwimCloudFinalEntryImmutableError);
    expect(raw.calls).toHaveLength(1); // the immutability check never reached the network
  });

  it('deleting a final entry makes the URL fetchable again', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    const first = await fetcher.fetch('https://www.swimcloud.com/results/193735/', {
      track: 'playwright',
      cache,
      markAs: 'final',
    });
    await cache.delete(first.canonicalUrl);

    const second = await fetcher.fetch('https://www.swimcloud.com/results/193735/', { track: 'playwright', cache });
    expect(second.source).toBe('network');
    expect(raw.calls).toHaveLength(2);
  });

  it('writes through the cache under the classifier canonical URL, not the caller-supplied one', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    // Two spellings of the same resource: no scheme, no trailing slash.
    await fetcher.fetch('swimcloud.com/team/633', { track: 'playwright', cache });
    const second = await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright', cache });

    expect(second.source).toBe('cache');
    expect(raw.calls).toHaveLength(1);
  });
});

describe('SwimCloudPoliteFetcher — the returned parse context', () => {
  it('hands back a context ready for parseTeamRosterHtml/parseMeetResultsHtml, network path', async () => {
    const raw = new FakeRawFetcher();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    const result = await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright' });

    expect(result.context.sourceUrl).toBe(result.canonicalUrl);
    expect(result.context.track).toBe('playwright');
    expect(() => new Date(result.context.retrievedAt).toISOString()).not.toThrow();
  });

  it('hands back a context matching the original capture, cache path', async () => {
    const raw = new FakeRawFetcher();
    const cache = new InMemorySwimCloudCache();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 0 }); // rate limiting has its own describe block below

    const first = await fetcher.fetch('https://www.swimcloud.com/team/633/', {
      track: 'browser-extension',
      cache,
    });
    const second = await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright', cache });

    // The context reflects when/how the page was actually captured, not the
    // track of the call that happened to hit the cache.
    expect(second.context.track).toBe('browser-extension');
    expect(second.context.retrievedAt).toBe(first.context.retrievedAt);
  });
});

describe('SwimCloudPoliteFetcher — one instance rate-limits across every URL it fetches', () => {
  it('the delay is instance-wide, not per-URL', async () => {
    const raw = new FakeRawFetcher();
    const clock = fakeClock();
    const fetcher = new SwimCloudPoliteFetcher(raw, { minDelayMs: 3000, clock });

    await fetcher.fetch('https://www.swimcloud.com/team/633/', { track: 'playwright' });
    clock.advance(500);
    await fetcher.fetch('https://www.swimcloud.com/swimmer/3646504/', { track: 'playwright' }); // a different URL entirely

    expect(clock.sleeps).toEqual([2500]);
  });
});
