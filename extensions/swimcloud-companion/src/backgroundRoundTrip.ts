/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bounded round trips to the background service worker.
 *
 * ## Why this module exists
 *
 * `chrome.runtime.sendMessage(message, callback)` has exactly two outcomes the
 * caller can observe: the callback runs with a response, or the callback runs
 * with `chrome.runtime.lastError` set. It has **no third outcome for "the
 * worker never answered"**. If the background listener returns `true` — the
 * Manifest V3 promise that a response is coming — and then never calls
 * `sendResponse`, the callback is simply never invoked. A content script that
 * `await`s that message waits forever: no rejection, no timeout, no console
 * error. The crawl panel freezes on whatever line it last rendered and a coach
 * watching it has no way to tell a stalled crawl from a slow one.
 *
 * That is not hypothetical. Every handler in `./background.ts` used to be
 * `handler(message).then(sendResponse)` with no `.catch`, over functions that
 * did work (`await loadOptions()`, `captureIdForSubject(...)`, `btoa(...)`)
 * *outside* their own `try` blocks. Any throw on those lines rejected the
 * promise, skipped the `.then`, and left the message channel open and silent
 * for the rest of the tab's life.
 *
 * So: no `chrome.runtime.sendMessage` on the crawl's critical path is awaited
 * unbounded. Every one goes through {@link sendWithTimeout}, which always
 * settles — `ok`, `timeout` or `error` — and the caller decides what a failure
 * degrades to. A visibly degraded crawl is recoverable. A silent one is not.
 *
 * Pure by construction: the timers are injected, `send` is any thunk returning
 * a promise, and nothing here touches `chrome.*`, the DOM, or the network. That
 * is what makes "a round trip that never answers becomes a timeout, not a
 * hang" a unit test (`tests/swimCloudExtensionBackgroundRoundTrip.test.ts`)
 * rather than something only a live meet can prove.
 */

/**
 * Budget for the small bookkeeping messages: opening the capture record,
 * marking it, reading it back. Each is one localhost round trip behind a
 * `chrome.storage.local` read. Generous enough to absorb a Manifest V3 service
 * worker cold start (Chrome tears the worker down after ~30s idle, and the
 * team-confirmation checklist is exactly the kind of pause that outlasts it),
 * short enough that a coach sees the panel move rather than wondering.
 */
export const BACKGROUND_ROUND_TRIP_TIMEOUT_MS = 10_000;

/**
 * Budget for relaying one fetched page. Larger than the bookkeeping budget on
 * purpose: this message carries a whole SwimCloud page of HTML through the
 * structured clone, and the worker then POSTs it to the local app or writes it
 * through `chrome.downloads`.
 */
export const RELAY_ROUND_TRIP_TIMEOUT_MS = 30_000;

/**
 * Budget for one same-origin `fetch()` of a SwimCloud page. `fetch` has no
 * built-in timeout: a server that accepts the connection and then stalls the
 * response body leaves the promise pending indefinitely, which is the other
 * unbounded wait on the crawl's critical path.
 */
export const PAGE_FETCH_TIMEOUT_MS = 30_000;

/** Consecutive relay failures the crawl tolerates before it stops and says so. */
export const RELAY_FAILURE_STOP_THRESHOLD = 3;

/**
 * The three ways a bounded round trip can end. Deliberately a value, not an
 * exception: `timeout` and `error` are ordinary, expected outcomes here (app
 * not running, worker asleep, coach never pasted the pairing token), and every
 * call site has a defined degraded behaviour for them.
 */
export type BackgroundRoundTrip<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'error'; readonly message: string };

/** Injected so a test can fire the timeout without waiting for a real one. */
export interface RoundTripTimers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: RoundTripTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** A thrown value as a human-readable string, without ever throwing itself. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

/**
 * Run one round trip under a deadline. Always settles, exactly once.
 *
 * A `send` that rejects becomes `error`. A `send` that throws synchronously
 * becomes `error`. A `send` that never settles becomes `timeout` — and the
 * abandoned promise is left to whatever it does later; a late answer can no
 * longer resolve this call, because the result is latched.
 */
export function sendWithTimeout<T>(
  send: () => Promise<T>,
  timeoutMs: number,
  timers: RoundTripTimers = DEFAULT_TIMERS,
): Promise<BackgroundRoundTrip<T>> {
  return new Promise<BackgroundRoundTrip<T>>((resolve) => {
    let settled = false;
    let handle: unknown;
    const finish = (trip: BackgroundRoundTrip<T>): void => {
      if (settled) return;
      settled = true;
      try {
        timers.clearTimeout(handle);
      } catch {
        // A timer handle this module did not create is not worth failing over.
      }
      resolve(trip);
    };

    handle = timers.setTimeout(() => finish({ kind: 'timeout', timeoutMs }), timeoutMs);

    let started: Promise<T>;
    try {
      started = send();
    } catch (error) {
      finish({ kind: 'error', message: errorText(error) });
      return;
    }
    void Promise.resolve(started).then(
      (value) => finish({ kind: 'ok', value }),
      (error) => finish({ kind: 'error', message: errorText(error) }),
    );
  });
}

/** Narrowing helper, so call sites read as a check rather than a string compare. */
export function isRoundTripOk<T>(trip: BackgroundRoundTrip<T>): trip is { kind: 'ok'; value: T } {
  return trip.kind === 'ok';
}

/**
 * One sentence for the panel explaining a failed round trip.
 *
 * `label` names what was being attempted in the coach's terms ("Opening the
 * capture record"), never the message type. The point of the sentence is that
 * *something visible happens*: the previous behaviour for every one of these
 * outcomes was an unchanged panel.
 */
export function roundTripFailureText(label: string, trip: BackgroundRoundTrip<unknown>): string {
  if (trip.kind === 'ok') return '';
  if (trip.kind === 'timeout') {
    const seconds = Math.max(1, Math.round(trip.timeoutMs / 1000));
    return `${label} timed out after ${seconds}s. Is the Omniswim app running, and is the pairing token saved in the extension's options?`;
  }
  return `${label} failed: ${trip.message}`;
}

export interface RelayFailureVerdict {
  readonly action: 'continue' | 'stop';
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * What a run of failed page relays means for the crawl.
 *
 * One failure is worth saying out loud and continuing — the crawl's job is to
 * get pages off SwimCloud once, politely, and losing the relay of a single
 * page is not a reason to re-request the other sixty. A *streak* is different:
 * it means the worker or the app is gone, every remaining page will be lost the
 * same way, and continuing burns SwimCloud requests for nothing. Stop, keep
 * what landed, and offer Retry.
 */
export function classifyRelayFailureStreak(
  consecutiveFailures: number,
  threshold: number = RELAY_FAILURE_STOP_THRESHOLD,
): RelayFailureVerdict {
  if (consecutiveFailures >= threshold) {
    return {
      action: 'stop',
      retryable: true,
      message: `${consecutiveFailures} pages in a row could not be handed to the Omniswim app. Stopping so the rest are not fetched and lost. Check that the app is running and the pairing token is saved, then Retry.`,
    };
  }
  return { action: 'continue', message: '', retryable: false };
}

/**
 * A deadline for one `fetch()`, as an `AbortSignal` plus the cleanup that
 * cancels the deadline when the fetch wins the race.
 *
 * Built from `AbortController` and `setTimeout` rather than
 * `AbortSignal.timeout()` so it works on any target this bundle is compiled
 * for, and so a test can drive it with injected timers.
 */
export interface FetchDeadline {
  readonly signal: AbortSignal;
  readonly cancel: () => void;
  /** True once the deadline actually fired, so a caller can distinguish it from any other abort. */
  readonly expired: () => boolean;
}

export function createFetchDeadline(timeoutMs: number, timers: RoundTripTimers = DEFAULT_TIMERS): FetchDeadline {
  const controller = new AbortController();
  let fired = false;
  const handle = timers.setTimeout(() => {
    fired = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      try {
        timers.clearTimeout(handle);
      } catch {
        // See sendWithTimeout: a bad handle is not worth failing a crawl over.
      }
    },
    expired: () => fired,
  };
}
