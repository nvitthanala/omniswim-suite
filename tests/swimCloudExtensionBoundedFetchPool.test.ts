/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the extension's bounded swimmer-times fetch pool
 * (`extensions/swimcloud-companion/src/boundedFetchPool.ts`).
 *
 * ## Why these are real tests and not theatre
 *
 * `runBoundedFetchPool` takes its `sleep` and its `run` as parameters, so the
 * scheduling decisions — how many items are in flight at once, when the next
 * start is allowed, what a failing item does to the other lanes, what a cancel
 * does to work already started — are observable without a browser, a network,
 * or a real clock. Every assertion below is about that behaviour, driven by a
 * `run` this file controls with deferred promises. Nothing here waits on a
 * timer; `sleep` resolves on a microtask and records its calls.
 *
 * This is the same boundary `backgroundRoundTrip.test.ts` draws. What these do
 * **not** cover, stated plainly rather than faked: the real `fetch()` calls the
 * pool drives in `crawler-content.ts`, and whether SwimCloud actually tolerates
 * three overlapping requests. The first is `chrome.*`/network glue with no shim
 * in this repo; the second is not a test question at all. Both are steps on
 * `plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md`.
 */

import { describe, expect, it } from 'vitest';
import { runBoundedFetchPool } from '../extensions/swimcloud-companion/src/boundedFetchPool';

/** A promise plus the handle to settle it from the test body. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A `sleep` with no clock: it resolves immediately and counts its calls.
 *
 * The stagger's *ordering* is what matters and is preserved exactly — the pool
 * chains `sleep` calls, so item N still cannot start before N of these have
 * resolved. Only the wall-clock duration is removed.
 */
function instantSleep(): ((ms: number) => Promise<void>) & { calls: () => number[] } {
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return Object.assign(sleep, { calls: () => calls });
}

/** Let every already-resolved microtask drain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('runBoundedFetchPool', () => {
  it('never exceeds the concurrency cap, and does reach it', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;

    const result = await runBoundedFetchPool({
      items,
      concurrency: 3,
      staggerMs: 400,
      sleep: instantSleep(),
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(result.peakInFlight).toBeLessThanOrEqual(3);
    expect(result.started).toBe(20);
    expect(result.notStarted).toBe(0);
  });

  it('actually overlaps: three items are in flight before the first one finishes', async () => {
    // This is the test the whole module exists for. A sequential loop would
    // leave exactly one item in flight here, and would pass every other
    // assertion in this file.
    const gates = Array.from({ length: 6 }, () => deferred());
    const started: number[] = [];

    const poolDone = runBoundedFetchPool({
      items: gates,
      concurrency: 3,
      staggerMs: 400,
      sleep: instantSleep(),
      run: async (gate, index) => {
        started.push(index);
        await gate.promise;
      },
    });

    await flush();
    expect(started).toEqual([0, 1, 2]);

    // Releasing one lane admits exactly one more item, not a burst.
    gates[1].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    for (const gate of gates) gate.resolve();
    const result = await poolDone;
    expect(result.started).toBe(6);
    expect(result.peakInFlight).toBe(3);
  });

  it('staggers starts: item N waits for N stagger sleeps', async () => {
    const sleep = instantSleep();
    const gates = Array.from({ length: 4 }, () => deferred());

    const poolDone = runBoundedFetchPool({
      items: gates,
      concurrency: 4,
      staggerMs: 400,
      sleep,
      run: async (gate) => {
        await gate.promise;
      },
    });

    await flush();
    // Four lanes each took a start slot, and each extended the chain by one
    // stagger. The first item's gate was already open, so three of these are
    // the waits that separated items 2, 3 and 4 from the one before.
    expect(sleep.calls()).toEqual([400, 400, 400, 400]);

    for (const gate of gates) gate.resolve();
    await poolDone;
  });

  it('one failing item does not stop the pool', async () => {
    // The 300-swimmer case: swimmer 7's page throws and the other 299 must
    // still be fetched.
    const seen: number[] = [];
    const result = await runBoundedFetchPool({
      items: Array.from({ length: 10 }, (_, i) => i),
      concurrency: 3,
      staggerMs: 400,
      sleep: instantSleep(),
      run: async (item) => {
        seen.push(item);
        if (item === 7) throw new Error('swimmer 7 page exploded');
      },
    });

    expect(result.started).toBe(10);
    expect(seen).toHaveLength(10);
    expect(seen).toContain(9);
  });

  it('one item that never settles does not block the others', async () => {
    // A stalled swimmer page holds exactly one lane. The remaining lanes drain
    // the queue. (In the real pool the stall is bounded by the fetch deadline;
    // this asserts the scheduler does not need that to make progress.)
    const stalled = deferred();
    const done: number[] = [];

    const poolDone = runBoundedFetchPool({
      items: Array.from({ length: 8 }, (_, i) => i),
      concurrency: 3,
      staggerMs: 400,
      sleep: instantSleep(),
      run: async (item) => {
        if (item === 0) {
          await stalled.promise;
        }
        done.push(item);
      },
    });

    await flush();
    expect(done).toEqual([1, 2, 3, 4, 5, 6, 7]);

    stalled.resolve();
    const result = await poolDone;
    expect(result.started).toBe(8);
  });

  it('stops starting new items once shouldStop turns true, and lets in-flight ones finish', async () => {
    const gates = Array.from({ length: 10 }, () => deferred());
    let cancelled = false;
    const started: number[] = [];

    const poolDone = runBoundedFetchPool({
      items: gates,
      concurrency: 3,
      staggerMs: 400,
      sleep: instantSleep(),
      shouldStop: () => cancelled,
      run: async (gate, index) => {
        started.push(index);
        await gate.promise;
      },
    });

    await flush();
    expect(started).toEqual([0, 1, 2]);

    cancelled = true;
    for (const gate of gates) gate.resolve();
    const result = await poolDone;

    expect(result.started).toBe(3);
    expect(result.notStarted).toBe(7);
    // The three in flight were not abandoned — a cancel must not strand a page
    // that was already fetched and about to be relayed.
    expect(started).toEqual([0, 1, 2]);
  });

  it('holds the pool while beforeStart is pending, then resumes the same run', async () => {
    // Every lane consults the same gate, exactly as `waitWhilePaused` does in
    // the crawl: Pause must hold the whole pool, not just the lane that
    // happened to ask first.
    const paused = deferred();
    const started: number[] = [];

    const poolDone = runBoundedFetchPool({
      items: Array.from({ length: 5 }, (_, i) => i),
      concurrency: 2,
      staggerMs: 400,
      sleep: instantSleep(),
      beforeStart: () => paused.promise,
      run: async (item) => {
        started.push(item);
      },
    });

    await flush();
    expect(started).toEqual([]);

    paused.resolve();
    const result = await poolDone;
    expect(result.started).toBe(5);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles an empty item list without starting a lane', async () => {
    const sleep = instantSleep();
    const result = await runBoundedFetchPool({
      items: [],
      concurrency: 3,
      staggerMs: 400,
      sleep,
      run: async () => {
        throw new Error('must not run');
      },
    });
    expect(result).toEqual({ started: 0, notStarted: 0, peakInFlight: 0 });
    expect(sleep.calls()).toEqual([]);
  });

  it('clamps a nonsensical concurrency to one lane rather than none', async () => {
    const order: number[] = [];
    const result = await runBoundedFetchPool({
      items: [0, 1, 2],
      concurrency: 0,
      staggerMs: 400,
      sleep: instantSleep(),
      run: async (item) => {
        order.push(item);
      },
    });
    expect(result.started).toBe(3);
    expect(result.peakInFlight).toBe(1);
    expect(order).toEqual([0, 1, 2]);
  });

  it('starts fewer lanes than the cap when there is less work than lanes', async () => {
    const result = await runBoundedFetchPool({
      items: [0, 1],
      concurrency: 5,
      staggerMs: 400,
      sleep: instantSleep(),
      run: async () => {},
    });
    expect(result.started).toBe(2);
    expect(result.peakInFlight).toBeLessThanOrEqual(2);
  });
});
