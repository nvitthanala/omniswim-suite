/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Learning, rather than hardcoding, the request a swimmer's times page makes
 * for its own data.
 *
 * ## The problem this solves
 *
 * `/swimmer/{id}/times/` builds its table in the browser. Fetching it returns a
 * 15-17 KB shell — measured on all 73 of the stored pages that returned HTTP
 * 200 — carrying nothing but a mount point:
 *
 *     <div id="swimmer-profile-times"
 *          data-swimmer-id="1028842"
 *          data-season-ids="[30, 29, 28, 27, 26, 25, 24, 23, 22]">
 *
 * and a loader for `/media/webpack/swimmerProfileTimes/index.{hash}.js`. That
 * bundle then requests the times from somewhere. Fetching the page will never
 * return them, at any pacing.
 *
 * ## Why the endpoint is discovered and never written down
 *
 * The obvious move is to read the bundle, find the URL, and put it in a
 * constant. Two reasons not to:
 *
 * 1. A hashed bundle can change its endpoint on any deploy, and a constant
 *    would then fetch a 404 on every swimmer — silently, since this pipeline
 *    treats a missing page as a missing page.
 * 2. `CLAUDE.md` is explicit that nothing about a source is written into a
 *    `.ts` file on inference. The endpoint the page actually calls is a fact
 *    about the page, so it comes from observing the page.
 *
 * So the endpoint is read out of the **Resource Timing** entries the browser
 * already recorded for a page the coach is looking at. No request is
 * intercepted, no script is injected into the page, and no new extension
 * permission is needed: `performance.getEntriesByType('resource')` lists every
 * URL the page fetched, `initiatorType` included, and a content script shares
 * the page's `performance` timeline.
 *
 * It also means discovery only ever happens on a page a human opened, which is
 * the rule `plans/STATE.md` sets for this site: touching it is "a deliberate
 * human-present action, never an automated one".
 *
 * ## Unverified, and honest about it
 *
 * **No observation has been made yet.** The endpoint's shape, its method, and
 * its response format are all unknown, and nothing here guesses at them. This
 * module decides which observed requests are *candidates* and how to turn one
 * into a reusable template; it does not claim to know what SwimCloud serves.
 * {@link swimmerTimesEndpointReport} is written to be pasted back, so the first
 * run answers the question with evidence.
 */

/** The swimmer-id placeholder a template carries. */
export const SWIMMER_ID_PLACEHOLDER = '{swimmerId}';

/**
 * The part of a `PerformanceResourceTiming` this module reads.
 *
 * Narrowed to two fields so the logic is testable without a browser, a DOM, or
 * a real page load. The content script passes the real entries straight in.
 */
export interface ObservedPageRequest {
  /** The absolute URL, as Resource Timing records it. */
  readonly name: string;
  /** `'fetch'`, `'xmlhttprequest'`, `'script'`, `'link'`, `'img'`, … */
  readonly initiatorType: string;
}

/** One request that could be the times endpoint, with the template it implies. */
export interface SwimmerTimesEndpointCandidate {
  /** The URL as observed, verbatim. */
  readonly url: string;
  /**
   * {@link url} with every occurrence of the swimmer's id replaced by
   * {@link SWIMMER_ID_PLACEHOLDER}.
   *
   * This is the only generalization performed, and it is performed only
   * because the id was found in the URL — see
   * {@link discoverSwimmerTimesEndpoints} on why a URL without it is rejected
   * rather than templated.
   */
  readonly template: string;
  readonly initiatorType: string;
}

/** Hosts a candidate may live on. A data request to anywhere else is somebody else's. */
const SWIMCLOUD_HOSTS: ReadonlySet<string> = new Set(['www.swimcloud.com', 'swimcloud.com']);

/**
 * `initiatorType` values that mean "the page asked for data", as opposed to
 * "the browser loaded an asset".
 *
 * `'xmlhttprequest'` is included because the page ships jQuery and sets up a
 * CSRF cookie for `jQuery.ajax` — a real inline script on the stored shell does
 * exactly that — so an older code path may well use XHR rather than `fetch`.
 */
const DATA_INITIATORS: ReadonlySet<string> = new Set(['fetch', 'xmlhttprequest']);

/** Extensions that are assets whatever their initiator says. Defence in depth, not the primary filter. */
const ASSET_SUFFIX = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|map)$/i;

/**
 * Every observed request that could be the times endpoint for this swimmer.
 *
 * ## The filters, and why each one is there
 *
 * - **Initiator must be `fetch` or `xmlhttprequest`.** A `script` or `link`
 *   entry is the bundle itself, not its data.
 * - **Host must be SwimCloud's.** Sentry, Google Analytics and Chartbeat all
 *   appear on this page and all make real data requests. None of them is the
 *   times endpoint.
 * - **URL must contain the swimmer's id.** This is the filter that makes the
 *   result *usable* rather than merely plausible. A URL with no id in it cannot
 *   be turned into a request for a different swimmer, so keeping it would
 *   produce a template that fetches the same swimmer forever — and reporting it
 *   as the endpoint would be worse than reporting nothing. A page that turns
 *   out to pass the id in a POST body will therefore yield no candidate here,
 *   and that silence is the correct answer: this module cannot see bodies.
 * - **Not an asset extension.** Belt and braces.
 *
 * Returns every match, in observed order, rather than picking one. Choosing
 * between two plausible endpoints is not a decision this module has evidence to
 * make; a caller reports them and a human reads them.
 */
export function discoverSwimmerTimesEndpoints(
  entries: readonly ObservedPageRequest[],
  swimmerId: string,
): readonly SwimmerTimesEndpointCandidate[] {
  if (swimmerId.length === 0) return [];
  const out: SwimmerTimesEndpointCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!DATA_INITIATORS.has(entry.initiatorType)) continue;

    let parsed: URL;
    try {
      parsed = new URL(entry.name);
    } catch {
      // A relative or malformed entry name. Resource Timing gives absolute
      // URLs, so this should not happen; skipping is safer than assuming a
      // base.
      continue;
    }
    if (!SWIMCLOUD_HOSTS.has(parsed.host)) continue;
    if (ASSET_SUFFIX.test(parsed.pathname)) continue;
    if (!entry.name.includes(swimmerId)) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);

    out.push({
      url: entry.name,
      template: entry.name.split(swimmerId).join(SWIMMER_ID_PLACEHOLDER),
      initiatorType: entry.initiatorType,
    });
  }

  return out;
}

/**
 * A discovered template turned back into a URL for one swimmer.
 *
 * `undefined` when the template carries no placeholder, which means it was
 * never generalizable and using it would re-request the swimmer it was
 * discovered on. Returning `undefined` rather than the template itself is the
 * difference between "no data for this swimmer" and "the same swimmer's data
 * filed under everyone else's name".
 */
export function swimmerTimesUrlFromTemplate(template: string, swimmerId: string): string | undefined {
  if (!template.includes(SWIMMER_ID_PLACEHOLDER)) return undefined;
  if (swimmerId.length === 0) return undefined;
  if (!/^\d+$/.test(swimmerId)) return undefined;
  return template.split(SWIMMER_ID_PLACEHOLDER).join(swimmerId);
}

/** What {@link swimmerTimesEndpointReport} was given. */
export interface SwimmerTimesEndpointObservation {
  /** The page the entries were observed on. */
  readonly pageUrl: string;
  /** From the mount point's `data-swimmer-id`. */
  readonly swimmerId: string;
  /** From the mount point's `data-season-ids`, verbatim. Recorded because the endpoint may well want one. */
  readonly seasonIds?: string;
  readonly candidates: readonly SwimmerTimesEndpointCandidate[];
  /** How many resource entries were considered, so "none found" can be told from "nothing was recorded". */
  readonly entriesSeen: number;
}

/**
 * The observation as a block of text for a human to read and paste back.
 *
 * Deliberately a report rather than an automatic capability. Until a real
 * observation exists, nothing in this repo knows whether the times endpoint is
 * a GET with the swimmer in its path, a POST with it in a body, or a GraphQL
 * call — and a crawl built on a guess about that would fetch nothing while
 * reporting success, which is the exact failure mode the swimmer-times pass
 * already had.
 */
export function swimmerTimesEndpointReport(observation: SwimmerTimesEndpointObservation): string {
  const lines = [
    'SwimCloud swimmer-times endpoint observation',
    `page:        ${observation.pageUrl}`,
    `swimmer id:  ${observation.swimmerId}`,
    ...(observation.seasonIds === undefined ? [] : [`season ids:  ${observation.seasonIds}`]),
    `requests seen: ${observation.entriesSeen}`,
    '',
  ];

  if (observation.candidates.length === 0) {
    lines.push(
      observation.entriesSeen === 0
        ? 'No resource timing entries were recorded. The page may have loaded before the extension, or the buffer was cleared — reload the page with the extension already installed.'
        : 'No request to SwimCloud carried this swimmer\'s id. The page may pass the id in a POST body, which resource timing cannot show. Read the Network tab directly and send the request URL plus its payload.',
    );
    return lines.join('\n');
  }

  lines.push(`${observation.candidates.length} candidate request(s):`);
  for (const candidate of observation.candidates) {
    lines.push(`  [${candidate.initiatorType}] ${candidate.url}`);
    lines.push(`      template: ${candidate.template}`);
  }
  return lines.join('\n');
}
