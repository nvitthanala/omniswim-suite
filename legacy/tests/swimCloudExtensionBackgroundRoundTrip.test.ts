/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the extension's bounded background round trips
 * (`extensions/swimcloud-companion/src/backgroundRoundTrip.ts`).
 *
 * ## The bug these pin
 *
 * A live crawl of meet 379295 froze immediately after the coach confirmed the
 * team list and never moved again: no error, no console message, no progress,
 * no timeout. The panel sat on the confirmation text while the crawl awaited a
 * `chrome.runtime.sendMessage` round trip that could never settle.
 *
 * The mechanism is specific to Manifest V3 message passing. A background
 * listener that returns `true` promises the sender an asynchronous response.
 * If it then never calls `sendResponse` — because the handler's promise
 * rejected before `.then(sendResponse)` could run — the sender's callback is
 * simply never invoked. `chrome.runtime.lastError` is not set. There is no
 * rejection to catch and no deadline to expire. The `await` waits for the life
 * of the tab.
 *
 * `sendWithTimeout` is the fix expressed as a testable function: **a round trip
 * that never answers must become a `timeout` value, not a pending promise.**
 * The first test below is the one that would have caught the live hang — it
 * passes a `send` that never settles, exactly as the broken worker behaved, and
 * asserts the call still resolves.
 *
 * What these tests do NOT cover, stated plainly for the same reason every
 * worklog in this initiative states it: the `chrome.runtime` glue itself. There
 * is no `chrome.*` shim or headless-extension harness in this repo, so
 * "`background.ts`'s listener really does call `sendResponse` on a throwing
 * handler in a real Chrome service worker" stays a line on
 * `plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md`, not an assertion here.
 */

import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_ROUND_TRIP_TIMEOUT_MS,
  PAGE_FETCH_TIMEOUT_MS,
  RELAY_FAILURE_STOP_THRESHOLD,
  RELAY_ROUND_TRIP_TIMEOUT_MS,
  classifyRelayFailureStreak,
  createFetchDeadline,
  errorText,
  isRoundTripOk,
  roundTripFailureText,
  sendWithTimeout,
  type RoundTripTimers,
} from '../extensions/swimcloud-companion/src/backgroundRoundTrip';

/**
 * Timers whose deadline fires only when the test says so. Nothing here waits on
 * a real clock, so a "10 second timeout" test costs nothing.
 */
function controllableTimers(): RoundTripTimers & { fire: () => void; cleared: () => boolean } {
  let pending: (() => void) | undefined;
  let wasCleared = false;
  return {
    setTimeout: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeout: () => {
      wasCleared = true;
      pending = undefined;
    },
    fire: () => {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    cleared: () => wasCleared,
  };
}

describe('sendWithTimeout', () => {
  it('resolves with a timeout when the round trip never answers — the live hang', async () => {
    // This `send` is the broken background worker: a listener that returned
    // `true`, promising a response, and then never called `sendResponse`. The
    // promise it hands back never settles and never rejects.
    const timers = controllableTimers();
    const neverAnswers = () => new Promise<string>(() => {});

    const tripPromise = sendWithTimeout(neverAnswers, 10_000, timers);
    timers.fire();
    const trip = await tripPromise;

    expect(trip).toEqual({ kind: 'timeout', timeoutMs: 10_000 });
    expect(isRoundTripOk(trip)).toBe(false);
  });

  it('resolves with the value when the worker answers', async () => {
    const timers = controllableTimers();
    const trip = await sendWithTimeout(async () => ({ captureId: 'meet-379295' }), 10_000, timers);
    expect(trip).toEqual({ kind: 'ok', value: { captureId: 'meet-379295' } });
    expect(isRoundTripOk(trip)).toBe(true);
  });

  it('cancels its deadline once the worker answers, so no stray timer survives', async () => {
    const timers = controllableTimers();
    await sendWithTimeout(async () => 'done', 10_000, timers);
    expect(timers.cleared()).toBe(true);
  });

  it('turns a rejected round trip into an error outcome, never a throw', async () => {
    const timers = controllableTimers();
    // What `chrome.runtime.lastError` looks like by the time it reaches here:
    // "Could not establish connection. Receiving end does not exist." is the
    // real message a torn-down Manifest V3 service worker produces.
    const trip = await sendWithTimeout(
      async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      10_000,
      timers,
    );
    expect(trip).toEqual({
      kind: 'error',
      message: 'Could not establish connection. Receiving end does not exist.',
    });
  });

  it('turns a synchronous throw in the sender into an error outcome', async () => {
    const timers = controllableTimers();
    const trip = await sendWithTimeout(
      () => {
        throw new Error('chrome.runtime is undefined');
      },
      10_000,
      timers,
    );
    expect(trip).toEqual({ kind: 'error', message: 'chrome.runtime is undefined' });
  });

  it('latches: a late answer after a timeout cannot re-settle the call', async () => {
    const timers = controllableTimers();
    let answer: ((value: string) => void) | undefined;
    const trip = sendWithTimeout(() => new Promise<string>((resolve) => (answer = resolve)), 10_000, timers);

    timers.fire();
    expect(await trip).toEqual({ kind: 'timeout', timeoutMs: 10_000 });

    // The worker finally wakes up and answers. The already-resolved promise
    // must not change, and nothing may throw.
    answer?.('too late');
    expect(await trip).toEqual({ kind: 'timeout', timeoutMs: 10_000 });
  });

  it('latches the other way too: a timer that fires after an answer changes nothing', async () => {
    const timers = controllableTimers();
    const trip = sendWithTimeout(async () => 'answered', 10_000, timers);
    expect(await trip).toEqual({ kind: 'ok', value: 'answered' });
    timers.fire(); // A stale deadline. Cleared already, but prove it is harmless.
    expect(await trip).toEqual({ kind: 'ok', value: 'answered' });
  });

  it('keeps every deadline finite and ordered by how much work the message carries', () => {
    // A relay carries a whole page of HTML plus a localhost POST; the
    // bookkeeping messages carry a few fields. Both must be finite — that is
    // the property that matters — and the relay must get the longer budget.
    expect(Number.isFinite(BACKGROUND_ROUND_TRIP_TIMEOUT_MS)).toBe(true);
    expect(BACKGROUND_ROUND_TRIP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RELAY_ROUND_TRIP_TIMEOUT_MS).toBeGreaterThan(BACKGROUND_ROUND_TRIP_TIMEOUT_MS);
    expect(PAGE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('roundTripFailureText', () => {
  it('says the app may not be running when a round trip times out', () => {
    const text = roundTripFailureText('Opening the capture record', { kind: 'timeout', timeoutMs: 10_000 });
    expect(text).toContain('Opening the capture record timed out after 10s');
    expect(text).toContain('pairing token');
  });

  it('quotes the underlying message on an error', () => {
    expect(roundTripFailureText('Relaying the page', { kind: 'error', message: 'port closed' })).toBe(
      'Relaying the page failed: port closed',
    );
  });

  it('says nothing about a round trip that worked', () => {
    expect(roundTripFailureText('Anything', { kind: 'ok', value: 1 })).toBe('');
  });

  it('never reports a sub-second timeout as "0s"', () => {
    expect(roundTripFailureText('X', { kind: 'timeout', timeoutMs: 200 })).toContain('after 1s');
  });
});

describe('classifyRelayFailureStreak', () => {
  it('continues after a single failed relay — one lost page is not a reason to stop', () => {
    expect(classifyRelayFailureStreak(1)).toEqual({ action: 'continue', message: '', retryable: false });
  });

  it('continues right up to the threshold', () => {
    const verdict = classifyRelayFailureStreak(RELAY_FAILURE_STOP_THRESHOLD - 1);
    expect(verdict.action).toBe('continue');
  });

  it('stops at the threshold and offers a retry', () => {
    const verdict = classifyRelayFailureStreak(RELAY_FAILURE_STOP_THRESHOLD);
    expect(verdict.action).toBe('stop');
    expect(verdict.retryable).toBe(true);
    expect(verdict.message).toContain('in a row');
  });

  it('stays stopped past the threshold', () => {
    expect(classifyRelayFailureStreak(RELAY_FAILURE_STOP_THRESHOLD + 5).action).toBe('stop');
  });

  it('never stops on a clean streak', () => {
    expect(classifyRelayFailureStreak(0).action).toBe('continue');
  });
});

describe('createFetchDeadline', () => {
  it('aborts its signal when the deadline fires, and says the deadline was why', () => {
    const timers = controllableTimers();
    const deadline = createFetchDeadline(30_000, timers);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.expired()).toBe(false);

    timers.fire();

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.expired()).toBe(true);
  });

  it('leaves the signal alone when cancelled first — the fetch won the race', () => {
    const timers = controllableTimers();
    const deadline = createFetchDeadline(30_000, timers);
    deadline.cancel();
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.expired()).toBe(false);
    expect(timers.cleared()).toBe(true);
  });
});

describe('errorText', () => {
  it('prefers an Error message', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('passes a non-empty string through', () => {
    expect(errorText('boom')).toBe('boom');
  });

  it('never throws on an odd thrown value', () => {
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText({ nope: true })).toBe('[object Object]');
    expect(errorText(new Error(''))).toBe('Error');
  });
});
