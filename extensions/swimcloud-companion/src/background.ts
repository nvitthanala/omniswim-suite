/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Omniswim SwimCloud Companion — background service worker.
 *
 * Per `plans/2026-09-08/03-extension-crawler.md`'s "Where the crawl loop
 * actually runs": the content script (`content.js` for Track A, `crawler.js`
 * for Track A′) owns the crawl loop and fetches SwimCloud pages itself,
 * same-origin, no extra permission needed. This worker's job is deliberately
 * narrow — the things that DO need extension-level privilege:
 *
 *   1. Relay each fetched page on to the local app's capture-store HTTP route
 *      (`POST http://127.0.0.1:{PORT}/api/swimcloud/captures/{id}/pages`),
 *      which is cross-origin from the SwimCloud page and needs the
 *      `host_permissions` entry this manifest grants for `127.0.0.1`.
 *   2. Open and update the capture record on that same host.
 *   3. Read an existing capture back, so a restarted crawl can skip pages the
 *      store already holds instead of re-fetching them from SwimCloud.
 *   4. Own the `chrome.downloads` fallback for when a POST fails (the app
 *      isn't running, wrong port, …) so a page is never silently lost.
 *
 * This file never runs the crawl itself, never decides pacing, and never
 * parses page content — see that design doc section for why the split is
 * deliberate.
 *
 * ## Why this is TypeScript, bundled, and no longer hand-written JS
 *
 * It used to carry its own copy of the capture-id rule (`captureIdGuess`),
 * duplicating `captureIdForSubject`. The two agreed only by construction: the
 * team-with-season branch is not reachable yet, so nothing exercised it, and a
 * change to the real rule would have made every page POST target a capture id
 * nobody had opened — a 404, a silent fall-through to `chrome.downloads`, and
 * no server-store integration at all, with no test to catch it. The rule now
 * lives once, in `packages/swimcloud/src/entities.ts` (Node-free by design, so
 * both this worker and the app's Node process can import it), and `build.mjs`
 * bundles this file into `../background.js` the same way it bundles the crawl
 * loop into `../crawler.js`.
 */

import { captureIdForSubject } from '@omniswim/swimcloud/entities';
import type { SwimCloudCaptureSubject } from '@omniswim/swimcloud/entities';
import { errorText } from './backgroundRoundTrip';

const DEFAULT_PORT = 3000;

/**
 * Deadline for one localhost request. `fetch` has no timeout of its own, and a
 * connection that is accepted and then stalls — a half-started app, a port
 * answered by something that is not this app — would otherwise leave the
 * worker's promise pending forever, which is what the content script sees as a
 * dead message channel.
 */
const LOCAL_REQUEST_TIMEOUT_MS = 8_000;
const CAPTURE_TOKEN_HEADER = 'X-Omniswim-Capture-Token';
const OPTIONS_KEYS = {
  token: 'omniswimPairingToken',
  port: 'omniswimAppPort',
} as const;

/* -------------------------------------------------------------------------- */
/* Message shapes — the content script's half is `./crawler-content.ts`        */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `captureStore.ts`'s `SwimCloudCaptureTeamDiscovery`, field for
 * field, and is passed through to the route verbatim. Declared locally for the
 * same reason `./captureResume.ts` declares its page-ref shape locally: that
 * module is Node-hosted and cannot be imported here.
 */
export interface SwimCloudCrawlTeamDiscovery {
  readonly source: 'topteams' | 'meet-root-links-fallback';
  readonly genders: readonly string[];
  readonly teamIds: readonly string[];
  readonly completeness: 'unproven' | 'verified-complete-for-this-capture' | 'user-confirmed';
}

interface OpenCaptureMessage {
  readonly type: 'omniswim-swimcloud-open-capture';
  readonly subject: SwimCloudCaptureSubject;
  /**
   * The number of pages the crawl has committed to so far. Sent more than once
   * per crawl on purpose: the first send is the page-1 floor (team count × 2),
   * and a second send carries the real total once every team's page 1 has
   * revealed its pagination. The route treats every field as a partial update,
   * so the later, larger number simply replaces the floor.
   */
  readonly plannedPageCount: number;
  readonly teamDiscovery?: SwimCloudCrawlTeamDiscovery;
}

interface MarkCaptureMessage {
  readonly type: 'omniswim-swimcloud-mark-capture';
  readonly subject: SwimCloudCaptureSubject;
  readonly completeness: 'partial' | 'every-planned-page-fetched' | 'failed';
}

interface ReadCaptureMessage {
  readonly type: 'omniswim-swimcloud-read-capture';
  readonly subject: SwimCloudCaptureSubject;
}

interface RelayPageMessage {
  readonly type: 'omniswim-swimcloud-relay-page';
  readonly subject: SwimCloudCaptureSubject;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly httpStatus?: number;
  readonly html: string;
}

/** What {@link readCapture} answers with. */
export interface ReadCaptureResponse {
  readonly captureId: string;
  /**
   * Whether the local app answered at all. `false` covers "not paired", "app
   * not running" and "server errored" alike — three different reasons for the
   * same consequence: this run knows nothing about what is already stored, so
   * it must plan as if nothing is. Deliberately distinct from
   * {@link found}: "the app says there is no such capture" is a fact, "we
   * could not ask" is not.
   */
  readonly available: boolean;
  /** True only when the app returned a capture record for this subject. */
  readonly found: boolean;
  /** The record exactly as the app returned it. Validated by the content script, not here. */
  readonly capture?: unknown;
}

interface RelayPageResponse {
  readonly relayed: boolean;
  readonly via: 'http' | 'downloads';
  readonly error?: string;
}

interface FlushDownloadsMessage {
  readonly type: 'omniswim-swimcloud-flush-downloads';
  readonly subject: SwimCloudCaptureSubject;
}

interface FlushDownloadsResponse {
  readonly flushed: boolean;
  readonly pageCount: number;
  readonly filename?: string;
  readonly error?: string;
}

/* -------------------------------------------------------------------------- */
/* Options and HTTP                                                            */
/* -------------------------------------------------------------------------- */

interface CaptureOptions {
  readonly token: string;
  readonly port: number;
}

async function loadOptions(): Promise<CaptureOptions> {
  const stored = await chrome.storage.local.get([OPTIONS_KEYS.token, OPTIONS_KEYS.port]);
  const token = stored[OPTIONS_KEYS.token];
  const port = Number(stored[OPTIONS_KEYS.port]);
  return {
    token: typeof token === 'string' ? token : '',
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
  };
}

function captureBase(port: number): string {
  return `http://127.0.0.1:${port}/api/swimcloud/captures`;
}

interface JsonResult {
  readonly ok: boolean;
  readonly status: number;
  readonly json?: unknown;
}

/** One bounded localhost request. Always settles; never leaves a pending `fetch`. */
async function requestJson(url: string, init: RequestInit): Promise<JsonResult> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), LOCAL_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, json };
  } finally {
    clearTimeout(deadline);
  }
}

async function postJson(url: string, token: string, body: unknown): Promise<JsonResult> {
  return requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [CAPTURE_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body),
  });
}

async function getJson(url: string, token: string): Promise<JsonResult> {
  return requestJson(url, { headers: { [CAPTURE_TOKEN_HEADER]: token } });
}

/* -------------------------------------------------------------------------- */
/* Capture record                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fields this worker forwards to `POST /api/swimcloud/captures`. Every one is
 * a partial update on that route: an omitted field keeps whatever the stored
 * record holds, so a progress ping cannot wipe a `plannedPageCount` or a
 * `teamDiscovery` an earlier request established.
 */
interface CaptureUpdate {
  readonly completeness?: string;
  readonly plannedPageCount?: number;
  readonly track?: string;
  readonly teamDiscovery?: SwimCloudCrawlTeamDiscovery;
}

/**
 * Open or update the capture record. Returns the server's captureId, or
 * undefined on failure.
 *
 * The whole body is inside the `try`, `loadOptions()` included. It used to sit
 * outside, which meant a `chrome.storage.local` failure rejected this promise —
 * and the message listener's `.then(sendResponse)` then never ran, so the
 * content script's `await` on the message hung for the life of the tab. Every
 * function this worker reaches from a message handler is total for that reason.
 */
async function registerOrUpdateCapture(
  subject: SwimCloudCaptureSubject,
  extra: CaptureUpdate,
): Promise<string | undefined> {
  try {
    const { token, port } = await loadOptions();
    if (!token) return undefined;
    const result = await postJson(captureBase(port), token, { subject, ...extra });
    const json = result.json;
    if (result.ok && typeof json === 'object' && json !== null && 'captureId' in json) {
      const captureId = (json as { captureId?: unknown }).captureId;
      if (typeof captureId === 'string') return captureId;
    }
  } catch {
    // App not running, or a network error — the caller falls back to
    // chrome.downloads for pages; the capture record itself is best-effort
    // bookkeeping and has nothing to fall back to.
  }
  return undefined;
}

/**
 * Read an existing capture record so a restarted crawl can skip what is
 * already stored.
 *
 * A 404 is `{ available: true, found: false }` — the app answered, and its
 * answer is "no such capture", which is the normal first-crawl case. Anything
 * else that goes wrong is `available: false`: the crawl then plans every page,
 * which is slower and correct, rather than skipping pages on the strength of a
 * reply it could not read.
 */
async function readCapture(subject: SwimCloudCaptureSubject): Promise<ReadCaptureResponse> {
  let captureId = '';
  try {
    captureId = captureIdForSubject(subject);
    const { token, port } = await loadOptions();
    if (!token) return { captureId, available: false, found: false };
    // withEventRefs=1 asks the app to also derive which events the STORED swims
    // pages name. Without it a re-crawl of a complete capture collects no event
    // references at all -- resume skips the swims pages, so nothing is parsed
    // this run -- and the event-results pass plans nothing, leaving every
    // prelims/finals pair unresolved. The app can see bytes the crawler cannot.
    const result = await getJson(`${captureBase(port)}/${captureId}?withEventRefs=1`, token);
    if (result.status === 404) return { captureId, available: true, found: false };
    if (!result.ok || result.json === undefined) return { captureId, available: false, found: false };
    return { captureId, available: true, found: true, capture: result.json };
  } catch {
    return { captureId, available: false, found: false };
  }
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

/** Relay one fetched page. Falls back to chrome.downloads if the POST fails for any reason. */
async function relayPage(message: RelayPageMessage): Promise<RelayPageResponse> {
  let captureId = '';
  try {
    const { token, port } = await loadOptions();
    captureId = captureIdForSubject(message.subject);
    const payload = {
      omniswimSwimCloudCapture: 2,
      subject: message.subject,
      sourceUrl: message.sourceUrl,
      retrievedAt: message.retrievedAt,
      track: 'browser-extension',
      ...(message.httpStatus === undefined ? {} : { httpStatus: message.httpStatus }),
      html: message.html,
    };

    if (token) {
      try {
        const result = await postJson(`${captureBase(port)}/${captureId}/pages`, token, payload);
        if (result.ok) {
          return { relayed: true, via: 'http' };
        }
      } catch {
        // Fall through to the downloads fallback below.
      }
    }
  } catch (error) {
    // Reaching here means the options read or the capture-id rule threw. The
    // page's bytes are still in hand, so still try to write them out.
    return { relayed: false, via: 'downloads', error: errorText(error) };
  }

  return downloadFallback(captureId, message);
}

/**
 * chrome.downloads fallback — accumulate, don't download per page.
 *
 * A meet-sized crawl relaying 200+ pages through a broken pairing used to mean
 * 200+ separate `chrome.downloads.download()` calls, each surfacing its own
 * browser download notification — a coach watching a real crawl saw a wall of
 * popups with no indication anything had gone wrong until they checked their
 * Downloads folder. Found 2026-09-09 against a real 234-page crawl.
 *
 * The fix: every fallback page is written to `chrome.storage.local` under its
 * own key (see {@link fallbackPageKey}), and a small per-capture index tracks
 * which keys exist — appending to that index is one small, cheap write, not a
 * rewrite of a growing multi-megabyte array on every single page. Nothing is
 * downloaded until {@link flushDownloads} is called, once, at the end of the
 * crawl (or on cancel) — turning N popups into exactly one file.
 *
 * `chrome.storage.local`'s default quota is 10 MB; a 200+ page crawl can
 * exceed that (pages run ~200 KB each), so `manifest.json` requests
 * `unlimitedStorage` specifically for this path. Storage, not an in-memory
 * array, is the accumulator on purpose: this worker is a Manifest V3 service
 * worker, which Chrome can terminate at any point between messages, and an
 * in-memory buffer holding an hour's worth of fallback pages would be gone
 * with it. A `chrome.storage.local.set` per page is durable across exactly
 * that restart.
 *
 * Every step is inside the `try`, including the `JSON.stringify`. A whole
 * SwimCloud page of HTML can throw on its own serialization (a `RangeError`
 * on a very large string, most obviously); a throw here used to reject
 * `relayPage`, which skipped the listener's `.then(sendResponse)` and
 * stranded the content script's `await` forever.
 */
async function downloadFallback(captureId: string, message: RelayPageMessage): Promise<RelayPageResponse> {
  try {
    const entry: FallbackPageEntry = {
      omniswimSwimCloudCapture: 2,
      subject: message.subject,
      sourceUrl: message.sourceUrl,
      retrievedAt: message.retrievedAt,
      track: 'browser-extension',
      httpStatus: message.httpStatus,
      html: message.html,
    };
    await appendFallbackPage(captureId, entry);
    return { relayed: true, via: 'downloads' };
  } catch (error) {
    return { relayed: false, via: 'downloads', error: errorText(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Fallback accumulator — one file per capture, not one file per page          */
/* -------------------------------------------------------------------------- */

interface FallbackPageEntry {
  readonly omniswimSwimCloudCapture: 2;
  readonly subject: SwimCloudCaptureSubject;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly track: 'browser-extension';
  readonly httpStatus?: number;
  readonly html: string;
}

function fallbackIndexKey(captureId: string): string {
  return `omniswimFallbackIndex:${captureId}`;
}

function fallbackPageKey(captureId: string, n: number): string {
  return `omniswimFallbackPage:${captureId}:${n}`;
}

async function appendFallbackPage(captureId: string, entry: FallbackPageEntry): Promise<void> {
  const indexKey = fallbackIndexKey(captureId);
  const stored = await chrome.storage.local.get([indexKey]);
  const existingKeys: string[] = Array.isArray(stored[indexKey]) ? stored[indexKey] : [];
  const nextKey = fallbackPageKey(captureId, existingKeys.length);
  // The page write and the index update are two separate `set` calls, not one
  // atomic operation — `chrome.storage.local` offers no transaction across
  // keys. Writing the page first means the worst case of a restart between
  // the two calls is an orphaned page entry never listed by the index (safe,
  // just wasted quota) rather than an index entry pointing at a page that was
  // never actually written (which `flushDownloads` would then read as
  // `undefined` and silently drop from the combined file).
  await chrome.storage.local.set({ [nextKey]: entry });
  await chrome.storage.local.set({ [indexKey]: [...existingKeys, nextKey] });
}

/**
 * Combine every buffered fallback page for one capture into a single
 * download, then clear the accumulator. Called once by the content script at
 * crawl completion or cancellation — never per page.
 *
 * Answers `{ flushed: true, pageCount: 0 }`, not an error, when nothing was
 * ever buffered (the normal case for a healthy, paired crawl) — there is
 * nothing wrong with a capture that never needed its fallback.
 */
async function flushDownloads(captureId: string): Promise<FlushDownloadsResponse> {
  const indexKey = fallbackIndexKey(captureId);
  try {
    const stored = await chrome.storage.local.get([indexKey]);
    const keys: string[] = Array.isArray(stored[indexKey]) ? stored[indexKey] : [];
    if (keys.length === 0) {
      return { flushed: true, pageCount: 0 };
    }

    const pagesById = await chrome.storage.local.get(keys);
    // A key the index lists but storage has no value for (the orphan case
    // `appendFallbackPage`'s comment describes, or a value that failed to
    // round-trip through storage) is skipped, not fabricated as an empty
    // page — the combined file holds only pages that genuinely have bytes.
    const pages = keys.map((key) => pagesById[key]).filter((page): page is FallbackPageEntry => page !== undefined);

    const combined = JSON.stringify(
      { omniswimSwimCloudCaptureBundle: 1, captureId, pageCount: pages.length, pages },
      null,
      2,
    );
    const dataUrl = `data:application/json;base64,${btoa(unescape(encodeURIComponent(combined)))}`;
    const filename = `omniswim-swimcloud-captures/${captureId}/combined-capture.json`;
    await chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'uniquify', saveAs: false });

    await chrome.storage.local.remove([...keys, indexKey]);
    return { flushed: true, pageCount: pages.length, filename };
  } catch (error) {
    return { flushed: false, pageCount: 0, error: errorText(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Message routing                                                             */
/* -------------------------------------------------------------------------- */

function messageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * The handlers, keyed by message type. Each returns the response body; none of
 * them is allowed to be the thing that decides whether a response is sent.
 */
const HANDLERS: Readonly<Record<string, (message: unknown) => Promise<unknown>>> = {
  'omniswim-swimcloud-open-capture': async (message) => {
    const open = message as OpenCaptureMessage;
    const captureId = await registerOrUpdateCapture(open.subject, {
      completeness: 'in-progress',
      plannedPageCount: open.plannedPageCount,
      track: 'browser-extension',
      ...(open.teamDiscovery === undefined ? {} : { teamDiscovery: open.teamDiscovery }),
    });
    return { captureId };
  },
  'omniswim-swimcloud-mark-capture': async (message) => {
    const mark = message as MarkCaptureMessage;
    return { captureId: await registerOrUpdateCapture(mark.subject, { completeness: mark.completeness }) };
  },
  'omniswim-swimcloud-read-capture': async (message) =>
    readCapture((message as ReadCaptureMessage).subject),
  'omniswim-swimcloud-relay-page': async (message) => relayPage(message as RelayPageMessage),
  'omniswim-swimcloud-flush-downloads': async (message) => {
    const flush = message as FlushDownloadsMessage;
    return flushDownloads(captureIdForSubject(flush.subject));
  },
};

/**
 * One listener, one rule: **a handler that returns `true` must eventually call
 * `sendResponse` on every path, including the ones that throw.**
 *
 * This is the fix for the crawl hang. The previous shape was
 * `handler(message).then(sendResponse)` per message type, with no `.catch`. A
 * rejection anywhere inside a handler skipped the `.then`, so `sendResponse`
 * was never called — and Chrome has no failure mode for that. The listener had
 * already returned `true`, promising the content script an answer; the callback
 * passed to `chrome.runtime.sendMessage` simply never fired, `lastError` was
 * never set, and the content script's `await` on that message never settled.
 * The crawl panel then sat unchanged forever with no error anywhere: a silent
 * hang inside a coach's browser during a live meet.
 *
 * So the dispatch is wrapped once, here, rather than trusting four handlers to
 * each be individually total. `respond` is latched so a late resolution after
 * an error cannot double-send, and `sendResponse` itself is guarded because
 * calling it on a channel the other side has already abandoned throws.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = messageType(message);
  if (type === undefined) return undefined;
  const handler = HANDLERS[type];
  if (handler === undefined) return undefined;

  let settled = false;
  const respond = (value: unknown): void => {
    if (settled) return;
    settled = true;
    try {
      sendResponse(value);
    } catch {
      // The content script's tab is gone, or the channel closed first. There is
      // nothing left to tell, and throwing here would take the worker with it.
    }
  };

  void (async () => {
    try {
      respond(await handler(message));
    } catch (error) {
      respond({ error: errorText(error) });
    }
  })();

  return true; // Keep the message channel open for the async response.
});
