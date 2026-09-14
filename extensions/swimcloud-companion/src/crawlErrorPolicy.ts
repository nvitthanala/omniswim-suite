/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure error-handling policy for the crawl loop, exactly matching the table
 * in `plans/2026-09-08/03-extension-crawler.md`'s "Error handling" section.
 * No network, no DOM — a plain function from an outcome to an action, so the
 * table itself is a unit test rather than something only a live crawl proves.
 */

export type SwimCloudCrawlPageOutcomeKind = 'http-status' | 'network-error';

export interface SwimCloudCrawlPageOutcome {
  readonly kind: SwimCloudCrawlPageOutcomeKind;
  /** Present when `kind === 'http-status'`. */
  readonly httpStatus?: number;
}

export type SwimCloudCrawlAction =
  /** Record the outcome against this page and move on to the next step. */
  | { readonly action: 'continue' }
  /**
   * Stop the whole crawl immediately. `retryable: false` means no retry is
   * offered at all (403/challenge, network error); `retryable: true` means a
   * single manual Retry is offered (5xx).
   */
  | { readonly action: 'stop'; readonly message: string; readonly retryable: boolean };

/**
 * The exact message text from the design doc's error table — kept as one
 * named constant so the content script and this policy can never drift on
 * wording.
 */
export const SWIMCLOUD_CHALLENGE_MESSAGE =
  'SwimCloud returned a challenge. Open the page in a tab, pass it, then Resume.';

/**
 * Decide what the crawl loop does with one fetched page's outcome.
 *
 * | Condition | Action |
 * | --- | --- |
 * | 403 | stop, not retryable, challenge message |
 * | 404 | continue (recorded as `http-error`) |
 * | 5xx | stop, retryable (one manual retry) |
 * | network error | stop, not retryable |
 * | anything else (2xx/3xx/other 4xx) | continue |
 */
export function classifyCrawlPageOutcome(outcome: SwimCloudCrawlPageOutcome): SwimCloudCrawlAction {
  if (outcome.kind === 'network-error') {
    return {
      action: 'stop',
      retryable: false,
      message: 'A network error stopped the crawl. Resume when the connection is back.',
    };
  }

  const status = outcome.httpStatus;
  if (status === 403) {
    return { action: 'stop', retryable: false, message: SWIMCLOUD_CHALLENGE_MESSAGE };
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return {
      action: 'stop',
      retryable: true,
      message: `SwimCloud returned HTTP ${status}. Retry once, or Cancel to keep what was already captured.`,
    };
  }
  return { action: 'continue' };
}
