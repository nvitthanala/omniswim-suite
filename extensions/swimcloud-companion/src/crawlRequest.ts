/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helpers turning a `SwimCloudCrawlStep` (from
 * `@omniswim/swimcloud/crawlPlan`) into what the content-script crawl loop
 * actually needs to do next. No network, no DOM, no `chrome.*` — this is the
 * one slice of the crawl loop that can be unit-tested without a browser, per
 * `plans/2026-09-08/03-extension-crawler.md`'s "what you cannot fully verify"
 * section.
 */

import type { SwimCloudCrawlStep } from '@omniswim/swimcloud/crawlPlan';

/** What the loop needs to issue one fetch: the URL and what kind of page it expects back. */
export interface SwimCloudCrawlFetchRequest {
  readonly url: string;
  readonly resourceKind: SwimCloudCrawlStep['resourceKind'];
}

/**
 * A step's canonical URL and resource kind, as a fetch request. Trivial on
 * its own — the point of factoring it out is that the crawl loop always goes
 * through this one function to turn a plan step into a request, rather than
 * reading `step.canonicalUrl` in N different places that could drift if the
 * step shape ever changes.
 */
export function crawlStepToFetchRequest(step: SwimCloudCrawlStep): SwimCloudCrawlFetchRequest {
  return { url: step.canonicalUrl, resourceKind: step.resourceKind };
}

/**
 * Drop any step whose canonical URL is already in `fetchedUrls` — a page
 * already relayed this crawl (or served from a previous session's capture,
 * once known) is never re-requested. Order of the remaining steps is
 * preserved, which is what keeps a resumed crawl deterministic.
 */
export function stepsStillNeeded(
  steps: readonly SwimCloudCrawlStep[],
  fetchedUrls: ReadonlySet<string>,
): readonly SwimCloudCrawlStep[] {
  return steps.filter((step) => !fetchedUrls.has(step.canonicalUrl));
}

/**
 * Union team ids discovered across two `topteams`/meet-root fetches (one per
 * gender), preserving first-seen order. A team fielding both genders shows up
 * once, not twice — the crawl plans men-then-women for it either way.
 */
export function unionTeamIds(a: readonly string[], b: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...a, ...b]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
