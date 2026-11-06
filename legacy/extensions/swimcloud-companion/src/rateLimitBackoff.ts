/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What to do when SwimCloud answers HTTP 429.
 *
 * ## Why this exists
 *
 * Until now there was no 429 handling anywhere in this extension. A throttled
 * page was simply a page that never arrived, filed as `http-error` alongside a
 * 404 — and the two mean opposite things. A 404 is "this page does not exist,
 * stop asking". A 429 is "this page exists, you asked too fast, ask again in a
 * moment". Treating the second as the first throws away data the site was
 * willing to give.
 *
 * The archived crawl of meet 356467 shows both halves of the problem. Its
 * pooled pass — three lanes, 400 ms apart — took **111 of 184** requests as
 * HTTP 429, and every one of those pages was lost with no retry. The two
 * sequential passes at 3000 ms were 50 of 50 clean, and a later run fetched
 * 51 of 51 event pages clean at the same pacing.
 *
 * So this is insurance, not a fix for a failure the current pacing produces.
 * That is deliberate, and it is why **nothing here speeds anything up**: the
 * concurrency and stagger constants are untouched, and every path below only
 * ever waits *longer* than the crawl already would.
 *
 * ## Why the wait is capped, and what happens past the cap
 *
 * A server is allowed to say "come back in an hour". Honouring that literally
 * would leave a coach staring at a frozen panel through a meet. Past
 * {@link MAX_BACKOFF_MS} this stops retrying and reports the page as not
 * served, which is the same honest outcome as before — but now with the reason
 * named, rather than a bare `http-error`.
 */

/** The status this module is about. */
export const RATE_LIMITED_STATUS = 429;

/**
 * How many times one page is re-requested after a 429 before it is given up on.
 *
 * Three, not more. Each attempt costs its own wait, so the worst case is
 * already about a minute on one page; a crawl that spends longer than that on a
 * single URL has stopped being a crawl the coach can watch. The page is
 * reported, not silently dropped, so nothing is lost by stopping.
 */
export const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * The floor for a backoff wait, and the crawl's own sequential pacing.
 *
 * Deliberately equal to `MIN_DELAY_MS` in `crawler-content.ts`: a retry must
 * never be quicker than an ordinary request, or the response to being told
 * "too fast" would be to go faster than the pacing that was never throttled.
 */
export const BASE_BACKOFF_MS = 3000;

/** The longest this will wait for one retry. See the module header. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * `Retry-After` as milliseconds from now, or `undefined` when the header says
 * nothing usable.
 *
 * The header comes in two shapes and both are real: delta-seconds (`120`) and
 * an HTTP-date (`Wed, 21 Oct 2026 07:28:00 GMT`). A date in the past yields
 * `0`, not a negative wait.
 *
 * Anything unparseable returns `undefined` so the caller falls back to
 * exponential backoff. A malformed header is not a reason to hammer the server,
 * and it is not a reason to guess a number either.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;

  // Delta-seconds. Integer only, per RFC 9110 — "1.5" is not a valid value and
  // is not rounded into one here.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // An HTTP-date always carries letters — a month name, a day name, and a zone
  // ("Tue, 22 Sep 2026 06:00:45 GMT"). Requiring one is not cosmetic:
  // `Date.parse` accepts a bare "1.5" and yields a real timestamp, so without
  // this guard a malformed delta-seconds value became a date in 2001 and the
  // wait silently collapsed to zero — an immediate retry against a server that
  // had just said "too fast", which is the one thing this module must never do.
  if (!/[a-z]/i.test(trimmed)) return undefined;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** What {@link decideRateLimitRetry} concluded. */
export type RateLimitDecision =
  | {
      readonly action: 'retry';
      /** How long to wait first. Never below {@link BASE_BACKOFF_MS}. */
      readonly waitMs: number;
      /** True when the server named the delay itself rather than it being computed. */
      readonly fromRetryAfter: boolean;
    }
  | {
      readonly action: 'give-up';
      /** Shown verbatim on the panel. Says which of the two reasons applies. */
      readonly reason: string;
    };

/**
 * Whether to re-request a rate-limited page, and how long to wait first.
 *
 * `attempt` is how many times this URL has already been fetched, so the first
 * 429 arrives with `attempt === 1`.
 *
 * ## The server's number wins, until it is unreasonable
 *
 * A `Retry-After` is the site telling us exactly what it wants, and guessing
 * over the top of it would be rude and worse-informed. So it is honoured — but
 * only up to {@link MAX_BACKOFF_MS}, past which the page is given up on rather
 * than parking the crawl. A `Retry-After` *shorter* than
 * {@link BASE_BACKOFF_MS} is raised to it: the site may be willing to take a
 * request sooner, but this crawler's own pacing floor is the one number the
 * evidence supports, and going below it after being throttled is the wrong
 * direction.
 *
 * With no usable header, the wait doubles per attempt from the base: 3 s, 6 s,
 * 12 s.
 */
export function decideRateLimitRetry(
  attempt: number,
  retryAfterHeader: string | null | undefined,
  nowMs: number,
): RateLimitDecision {
  if (attempt >= MAX_RATE_LIMIT_RETRIES + 1) {
    return {
      action: 'give-up',
      reason: `SwimCloud rate-limited this page ${attempt} times. It is recorded as not served rather than retried further.`,
    };
  }

  const fromHeader = parseRetryAfterMs(retryAfterHeader, nowMs);
  if (fromHeader !== undefined) {
    if (fromHeader > MAX_BACKOFF_MS) {
      return {
        action: 'give-up',
        reason: `SwimCloud asked for a ${Math.round(fromHeader / 1000)}s wait, which is longer than this crawl will hold for one page. It is recorded as not served.`,
      };
    }
    return { action: 'retry', waitMs: Math.max(BASE_BACKOFF_MS, fromHeader), fromRetryAfter: true };
  }

  const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return { action: 'retry', waitMs: Math.min(MAX_BACKOFF_MS, backoff), fromRetryAfter: false };
}

/** One line for the panel, so a coach sees a paused crawl rather than a stuck one. */
export function formatRateLimitWaitLine(url: string, decision: RateLimitDecision): string {
  if (decision.action === 'give-up') return decision.reason;
  const seconds = Math.round(decision.waitMs / 1000);
  const source = decision.fromRetryAfter ? 'SwimCloud asked for' : 'backing off';
  return `Rate-limited on ${url} — ${source} ${seconds}s, then retrying. The crawl has not stalled.`;
}
