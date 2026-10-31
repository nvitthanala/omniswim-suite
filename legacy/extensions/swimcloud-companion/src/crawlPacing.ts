/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The sequential pacing floor, in one place.
 *
 * Every page this crawl fetches one at a time (team pages, roster pages) starts
 * at least this many milliseconds after the previous request started, per
 * `plans/2026-09-08/03-extension-crawler.md` "Pacing and politeness": do not
 * lower it for the extension. `crawler-content.ts` and `multiTeamDriver.ts` both
 * read this constant, so the single-meet crawl and the multi-team crawl cannot
 * drift apart. `rateLimitBackoff.ts` `BASE_BACKOFF_MS` is deliberately equal to it.
 */
export const MIN_DELAY_MS = 3000;
