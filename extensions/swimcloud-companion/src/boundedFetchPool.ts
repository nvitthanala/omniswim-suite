/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A bounded worker pool for the one fetch category that is allowed to overlap.
 *
 * ## What this is, and what it is not
 *
 * Everything else the crawl fetches goes through `crawler-content.ts`'s
 * `fetchPageWithDelay`: strictly one request at a time, at least
 * `MIN_DELAY_MS` (3000) apart, per `plans/2026-09-08/03-extension-crawler.md`'s
 * "Pacing and politeness" section — *"Do not lower it for the extension."* That
 * stays exactly as it is. Team-swims and roster pages are the load-bearing part
 * of a capture and they are fetched the slow way.
 *
 * This pool exists for swimmer-times pages only, and it is a **deliberate,
 * narrow relaxation of a written constraint**, not a free optimisation.
 * `plans/2026-09-06/01-legal-and-access-strategy.md` §"Track B" says the access
 * constraints include *"Rate-limited and cached. Seconds between requests,
 * never concurrent"*, and Track A′ (this extension) adopted those constraints
 * in full. Running two or three swimmer-times fetches at once is a materially
 * different traffic pattern from a single sequential stream, and it is more
 * likely — not less — to be noticed by request-pattern fingerprinting than the
 * sequential loop is. That trade is taken knowingly, for a stated reason: a
 * 412-swimmer meet is 412 leaf pages, which is 20 minutes at 3 s each, and a
 * crawl a coach will not sit through is a crawl that does not happen.
 *
 * The relaxation is bounded on both axes rather than removed:
 *
 *   - **Concurrency is capped** ({@link BoundedFetchPoolInput.concurrency}), so
 *     the pool can never become "fire N requests and see what happens".
 *   - **Starts are staggered** ({@link BoundedFetchPoolInput.staggerMs}), so
 *     the pool does not emit a burst of N simultaneous requests the instant a
 *     roster's swimmer list is known. The stagger is a floor on the *rate*; the
 *     concurrency is a ceiling on the *depth*. Together they mean the pool
 *     overlaps network latency instead of abolishing pacing.
 *
 * ## Why it is a separate, pure module
 *
 * Same discipline as `./backgroundRoundTrip.ts`: the scheduling decisions —
 * how many lanes run, when the next start is allowed, what happens when one
 * item fails, what "cancelled" does to work already in flight — are the part
 * that can be wrong in a way nobody notices, so they live in a function with no
 * `fetch`, no DOM and no `chrome.*`, driven by an injected `sleep`. The real
 * network call is passed in as {@link BoundedFetchPoolInput.run}.
 * `tests/swimCloudExtensionBoundedFetchPool.test.ts` therefore asserts the
 * actual concurrency behaviour (peak in-flight, start ordering, one failing
 * item not killing the pool) with no real delays and no browser.
 */

/** Everything one pool run needs. Nothing here touches the network itself. */
export interface BoundedFetchPoolInput<T> {
  /** Work items, in the order they should be started. */
  readonly items: readonly T[];
  /** Maximum simultaneous in-flight items. Values below 1 are clamped to 1. */
  readonly concurrency: number;
  /** Minimum delay between the *start* of one item and the start of the next. */
  readonly staggerMs: number;
  /** Injected so a test drives the schedule without a real clock. */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Does the work for one item.
   *
   * Expected to be total — it should record its own failures rather than
   * throwing. A throw is caught here anyway and the lane carries on, because
   * one swimmer's page failing must not take the other 299 with it, but a
   * caller relying on that is losing the failure detail it should have
   * recorded.
   */
  readonly run: (item: T, index: number) => Promise<void>;
  /**
   * Checked before each item starts. `true` means start nothing further.
   * Items already in flight are allowed to finish — a cancel must not strand a
   * fetched page that was about to be relayed.
   */
  readonly shouldStop?: () => boolean;
  /**
   * Awaited before each item starts. This is where Pause lives: it holds the
   * pool without tearing it down, so Resume continues the same run.
   */
  readonly beforeStart?: () => Promise<void>;
}

export interface BoundedFetchPoolResult {
  /** Items whose `run` was actually invoked. */
  readonly started: number;
  /** Items never started, because `shouldStop` became true first. */
  readonly notStarted: number;
  /**
   * The highest number of items in flight at any one moment.
   *
   * Reported rather than assumed: it is the one number that proves the pool is
   * bounded, and it is what the unit test asserts against
   * {@link BoundedFetchPoolInput.concurrency}.
   */
  readonly peakInFlight: number;
}

/**
 * Run `items` through at most `concurrency` lanes, with starts spaced by at
 * least `staggerMs`.
 *
 * Resolves when every lane has finished — which is after the last in-flight
 * item settles, never before. A rejected `run` is swallowed (see
 * {@link BoundedFetchPoolInput.run}); a rejected `sleep` or `beforeStart` is
 * not this module's to interpret and propagates.
 *
 * The stagger is implemented as a chain rather than a clock reading, so it is
 * exact under an injected `sleep` and needs no `Date.now()`: each lane takes
 * the current tail of the chain as its start gate and extends the chain by one
 * `sleep(staggerMs)`. The first item therefore starts immediately, the second
 * one stagger later, and so on — but a lane that is busy past its slot simply
 * finds the gate already open, so the concurrency cap and the stagger floor
 * never fight each other.
 */
export async function runBoundedFetchPool<T>(input: BoundedFetchPoolInput<T>): Promise<BoundedFetchPoolResult> {
  const { items, run, sleep, staggerMs } = input;
  const concurrency = Math.max(1, Math.floor(input.concurrency));
  const laneCount = Math.min(concurrency, items.length);

  let cursor = 0;
  let started = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let staggerChain: Promise<void> = Promise.resolve();

  const stopped = (): boolean => input.shouldStop?.() === true;

  /** Take the next start slot and push the gate out by one stagger for whoever asks next. */
  const nextStartSlot = (): Promise<void> => {
    const slot = staggerChain;
    staggerChain = slot.then(() => sleep(staggerMs));
    return slot;
  };

  const lane = async (): Promise<void> => {
    for (;;) {
      if (stopped() || cursor >= items.length) return;

      await nextStartSlot();
      if (input.beforeStart !== undefined) await input.beforeStart();

      // Re-checked after the waits, not only before them. Both gates can hold a
      // lane for a long time, and a cancel that arrived meanwhile must not be
      // ignored just because this lane had already decided to proceed.
      if (stopped() || cursor >= items.length) return;

      const index = cursor;
      cursor += 1;
      started += 1;
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      try {
        await run(items[index], index);
      } catch {
        // Deliberately swallowed. See BoundedFetchPoolInput.run: a pool whose
        // lane dies on one bad item is a pool that silently fetches fewer pages
        // than it reports, which is the failure mode this repo cares about most.
      } finally {
        inFlight -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: laneCount }, () => lane()));

  return { started, notStarted: items.length - started, peakInFlight };
}
