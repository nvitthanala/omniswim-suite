/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One crawl at a time, across every tab.
 *
 * The meet crawl and the multi-team crawl each pace their own requests, but two
 * crawls (or the same crawl in two tabs) would add their traffic together and
 * break the "one request, 3 s apart" rule. Both buttons take this lock for the
 * whole run. It is the Web Locks API, `navigator.locks`, which is shared by every
 * tab of the same origin (`www.swimcloud.com`).
 *
 * Pure: the lock manager is injected, so a test passes a fake one. A missing lock
 * manager refuses the run. The check cannot be made, so the crawl does not start.
 */

/** The lock's name. Both crawls use it. */
export const CRAWL_LOCK_NAME = 'omniswim-swimcloud-crawl';

/** The part of `LockManager` this module uses. */
export interface CrawlLockManager {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export type CrawlLockResult<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false; readonly message: string };

export const CRAWL_LOCK_HELD_MESSAGE =
  'Another SwimCloud crawl is running (in this tab or another). Wait for it to finish, or close it, then try again. Two crawls at once would break the pacing.';

export const CRAWL_LOCK_UNAVAILABLE_MESSAGE =
  'This browser cannot check whether another crawl is running, so the crawl does not start. Use a current version of Chrome.';

/**
 * Run `run` while holding the crawl lock. Resolves `{ acquired: false }` at once
 * when another crawl holds it. The lock is released when `run` settles, even if it throws.
 */
export async function withCrawlLock<T>(locks: CrawlLockManager | undefined, run: () => Promise<T>): Promise<CrawlLockResult<T>> {
  if (locks === undefined) return { acquired: false, message: CRAWL_LOCK_UNAVAILABLE_MESSAGE };
  return locks.request(CRAWL_LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (lock === null || lock === undefined) return { acquired: false as const, message: CRAWL_LOCK_HELD_MESSAGE };
    return { acquired: true as const, value: await run() };
  });
}
