/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `extensions/swimcloud-companion/src/crawlLock.ts`: one crawl at a time, across
 * tabs. A fake `navigator.locks` models `ifAvailable` and a lock held until the
 * callback's promise settles.
 */
import { describe, expect, it } from 'vitest';

import {
  CRAWL_LOCK_HELD_MESSAGE,
  CRAWL_LOCK_NAME,
  CRAWL_LOCK_UNAVAILABLE_MESSAGE,
  withCrawlLock,
  type CrawlLockManager,
} from '../extensions/swimcloud-companion/src/crawlLock';

function fakeLocks(): CrawlLockManager & { held: Set<string>; requests: string[] } {
  const held = new Set<string>();
  const requests: string[] = [];
  return {
    held,
    requests,
    async request<T>(name: string, _options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T> {
      requests.push(name);
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

describe('withCrawlLock', () => {
  it('runs and returns the value, then releases the lock', async () => {
    const locks = fakeLocks();
    const result = await withCrawlLock(locks, async () => 42);
    expect(result).toEqual({ acquired: true, value: 42 });
    expect(locks.requests).toEqual([CRAWL_LOCK_NAME]);
    expect(locks.held.size).toBe(0);
  });

  it('refuses a second run while the first holds the lock, and does not run it', async () => {
    const locks = fakeLocks();
    let release: () => void = () => undefined;
    const first = withCrawlLock(locks, () => new Promise<string>((resolve) => (release = () => resolve('first'))));
    let ran = false;
    const second = await withCrawlLock(locks, async () => {
      ran = true;
      return 'second';
    });
    expect(second).toEqual({ acquired: false, reason: 'held', message: CRAWL_LOCK_HELD_MESSAGE });
    expect(ran).toBe(false);
    release();
    expect(await first).toEqual({ acquired: true, value: 'first' });
    // After the first run ends, the lock is free again.
    expect(await withCrawlLock(locks, async () => 'third')).toEqual({ acquired: true, value: 'third' });
  });

  it('releases the lock when the run throws', async () => {
    const locks = fakeLocks();
    await expect(withCrawlLock(locks, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(locks.held.size).toBe(0);
  });

  it('refuses to start when the browser has no lock manager', async () => {
    let ran = false;
    const result = await withCrawlLock(undefined, async () => {
      ran = true;
    });
    expect(result).toEqual({ acquired: false, reason: 'unavailable', message: CRAWL_LOCK_UNAVAILABLE_MESSAGE });
    expect(ran).toBe(false);
  });

  it('names the held lock in plain words', () => {
    expect(CRAWL_LOCK_HELD_MESSAGE).toContain('Another SwimCloud crawl is running');
    expect(CRAWL_LOCK_NAME).toBe('omniswim-swimcloud-crawl');
  });
});
