/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The fetch queue (D7 section 3, decisions Q, W, C). It runs in the isolated-world overlay with its own
 * `fetch`, never in the bridge, so the page never sees the responses. It sends every `200` it trusts to
 * the docked panel as raw text and parses nothing for storage.
 *
 * It fails loudly. Any sign of a challenge, a refusal, a redirect or a rate limit it cannot ride out
 * stops the WHOLE run. It never delivers a body it did not classify, never skips a target, and never
 * retries a 403. Every request, retries included, starts at least 3000 ms after the previous one
 * started. One run at a time holds a Web Lock. All time, waiting, network and posting come in through
 * `FetchQueueDeps`, so a test needs no clock and no network.
 */
import { FETCH_BASE_BACKOFF_MS, FETCH_LOCK_NAME, FETCH_MAX_BACKOFF_MS, FETCH_MAX_RETRIES, FETCH_MIN_DELAY_MS, fetchPathFor, roundTripPath } from '../shared/fetchProtocol';
import type { FetchFeature, FetchTarget } from '../shared/fetchProtocol';
import type { FetchEndMessage, FetchItemMessage, FetchProgressMessage, FetchStopReason, FetchStopped } from '../shared/panelProtocol';

/** What the classifier reads from a response. `body` is the text of a `200`, else null. */
export interface FetchResponseView {
  readonly status: number;
  /** The final URL after redirects, as `Response.url` reports it. */
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  /** The page origin the request was made from, such as `https://www.swimcloud.com`. */
  readonly origin: string;
  readonly body: string | null;
}

export type FetchVerdict =
  | { readonly kind: 'deliver'; readonly finalPath: string; readonly contentType: string; readonly body: string }
  | { readonly kind: 'retry'; readonly waitMs: number; readonly detail: string }
  | { readonly kind: 'stop'; readonly reason: FetchStopReason; readonly status: number; readonly detail: string };

const stop = (reason: FetchStopReason, status: number, detail: string): FetchVerdict => ({ kind: 'stop', reason, status, detail });

/**
 * `Retry-After` as milliseconds from now, or undefined when the header says nothing usable. Copied from
 * legacy/extensions/swimcloud-companion/src/rateLimitBackoff.ts:73 (`parseRetryAfterMs`). Delta-seconds are integers only,
 * and an HTTP-date must contain a letter, because `Date.parse('1.5')` is a real date and would turn a malformed value into a zero wait.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  const text = header?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!/[a-z]/i.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** The query as sorted `key=value` pairs, so two orders of the same query compare equal. */
function sortedQuery(u: URL): string {
  return [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&');
}

const TITLE_JUST_A_MOMENT = /<title[^>]*>\s*Just a moment/i;
const SEASON_SELECT = /<select\b[^>]*\bname\s*=\s*["']season_id["']/i;
const SEASON_HEADING = /<h[1-6]\b[^>]*\bclass\s*=\s*["'][^"']*\bc-title\b[^"']*["'][^>]*>\s*Season\b/i;
const NO_ROSTERS = /No rosters found/i;

/** Why a team-window `200` is not the simulator JSON, or null when it is `{swimmers: [], relays: []}`. */
function windowProblem(contentType: string, body: string): string | null {
  if (contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') return `content type is "${contentType}", not application/json`;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return 'the body is not JSON';
  }
  const v = json as { swimmers?: unknown; relays?: unknown } | null;
  if (typeof json !== 'object' || json === null || Array.isArray(json) || !Array.isArray(v?.swimmers) || !Array.isArray(v?.relays)) return 'the JSON is not {swimmers: [], relays: []}';
  return null;
}

/**
 * Why a roster `200` is not a SwimCloud roster page, or null when it is one (precedent:
 * legacy/extensions/swimcloud-companion/src/multiTeamDriver.ts:374 `looksLikeChallengePage`). A real page prints the season select and
 * either a "Season ..." card heading or the "No rosters found" empty state. The invisible-check loader that normal pages carry
 * (`/cdn-cgi/challenge-platform/...`) is NOT a challenge. Only `_cf_chl_opt` is.
 */
function rosterProblem(body: string): string | null {
  if (TITLE_JUST_A_MOMENT.test(body)) return 'the page title is "Just a moment"';
  if (body.includes('_cf_chl_opt')) return 'the page carries _cf_chl_opt';
  if (!SEASON_SELECT.test(body)) return 'the page has no season_id select';
  if (!SEASON_HEADING.test(body) && !NO_ROSTERS.test(body)) return 'the page has neither a "Season ..." heading nor "No rosters found"';
  return null;
}

/**
 * Decide what one response means. Pure. `attempt` is how many 429 retries this target has already used (0 for the first request).
 * The rules run in this order: the `cf-mitigated: challenge` header on ANY status (a Cloudflare challenge is usually a 403, and the
 * coach must be told to pass the check, so the architect ruled on 2026-11-05 that the header beats the 403 row of D7 section 3), then
 * 403, 429, 5xx, any other non-200, a redirect, and last the body checks.
 */
export function classifyFetchResponse(target: FetchTarget, r: FetchResponseView, nowMs: number, attempt: number): FetchVerdict {
  const { status } = r;
  if (r.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') return stop('challenge', status, 'the response carries cf-mitigated: challenge');
  if (status === 403) return stop('forbidden', status, 'SwimCloud answered 403');
  if (status === 429) {
    if (attempt >= FETCH_MAX_RETRIES) return stop('rate-limited', status, `SwimCloud answered 429 ${attempt + 1} times for one request`);
    const asked = parseRetryAfterMs(r.headers.get('retry-after'), nowMs);
    // The header wins, floored at the pacing step and capped at the longest wait: legacy rateLimitBackoff.ts:139-145 gives up past the cap.
    if (asked !== undefined && asked > FETCH_MAX_BACKOFF_MS) return stop('rate-limited', status, `SwimCloud asked for ${Math.round(asked / 1000)} s, longer than the ${FETCH_MAX_BACKOFF_MS / 1000} s cap`);
    const waitMs = asked !== undefined ? Math.max(FETCH_BASE_BACKOFF_MS, asked) : Math.min(FETCH_BASE_BACKOFF_MS * 2 ** attempt, FETCH_MAX_BACKOFF_MS);
    return { kind: 'retry', waitMs, detail: asked !== undefined ? 'Retry-After' : 'backoff' };
  }
  if (status >= 500 && status < 600) return stop('server-error', status, `SwimCloud answered ${status}`);
  if (status !== 200) return stop('unexpected-status', status, `SwimCloud answered ${status}`);

  const want = new URL(fetchPathFor(target), r.origin);
  let got: URL;
  try {
    got = new URL(r.url);
  } catch {
    return stop('redirected', status, 'the final URL is not a URL');
  }
  if (got.origin !== want.origin || got.pathname !== want.pathname || sortedQuery(got) !== sortedQuery(want)) {
    return stop('redirected', status, `asked for ${want.pathname}, got ${got.origin === want.origin ? got.pathname : 'another origin'}`);
  }
  const contentType = r.headers.get('content-type') ?? '';
  if (r.body === null) return stop('unexpected-status', status, 'no body was read for a 200');
  const why = target.kind === 'team-window' ? windowProblem(contentType, r.body) : rosterProblem(r.body);
  if (why) return stop('challenge', status, why);
  return { kind: 'deliver', finalPath: got.pathname + got.search, contentType, body: r.body };
}

/** The slice of `Response` the queue reads. */
export type FetchedResponse = Pick<Response, 'status' | 'url' | 'headers' | 'text'>;

/** The slice of `navigator.locks` the queue uses. Absent means `lock-unavailable`. */
export interface FetchLocks {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<T>): Promise<T>;
}

/**
 * When the last request of this tab started, in `now()` units. One object per tab, shared by every run, so two runs in a row keep the
 * 3000 ms gap. `null` until the first request.
 */
export interface FetchPacer {
  lastStart: number | null;
}
export const newFetchPacer = (): FetchPacer => ({ lastStart: null });

export interface FetchQueueDeps {
  fetch(input: string, init: RequestInit): Promise<FetchedResponse>;
  /** Resolve after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** A monotonic clock in milliseconds. All pacing and backoff arithmetic uses it. */
  now(): number;
  /** Wall-clock milliseconds since the epoch. Used only for `fetchedAt` and for an HTTP-date `Retry-After`. */
  wallNow(): number;
  readonly pacer: FetchPacer;
  locks: FetchLocks | undefined;
  /** The page origin the requests go to. */
  origin: string;
  post(message: FetchProgressMessage | FetchItemMessage | FetchEndMessage): void;
}

export interface FetchRun {
  readonly runId: string;
  readonly feature: FetchFeature;
  readonly targets: readonly FetchTarget[];
}

/** The init every request uses: a plain GET, no custom headers (D7 section 3), plus the run's abort signal so a cancel reaches a request in flight. */
const requestInit = (signal: AbortSignal): RequestInit => ({ method: 'GET', credentials: 'same-origin', redirect: 'follow', cache: 'default', signal });

/** Holding the lock for the pacing gap is not cancellable: the gap protects SwimCloud, not the user. */
const NEVER_ABORTED = new AbortController().signal;

/** Settle with `work`, or reject at once when `signal` aborts, even if `work` ignores the signal. The abandoned `work` cannot raise an unhandled rejection. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const onAbort = (): void => reject(new Error('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** The text a cancel gives: the string passed to `abort()`, else "cancelled". */
const cancelDetail = (signal: AbortSignal): string => (typeof signal.reason === 'string' ? signal.reason : 'cancelled');

/**
 * Run every target in order, one request at a time. Posts `fetch-progress` before each request, `fetch-item` for each trusted 200 and
 * exactly one `fetch-end`, which it also returns. A target the module did not build is refused before any request. Cancelling (`signal`)
 * stops the run at once, even with a request in flight: the answer to that request is dropped, not delivered.
 *
 * Pacing outlives the run. `deps.pacer` keeps the last request start for the whole tab, and the run keeps the Web Lock until that start
 * is 3000 ms old, so neither a second run in this tab nor another tab can start inside the gap.
 */
export async function runFetchQueue(run: FetchRun, deps: FetchQueueDeps, signal: AbortSignal): Promise<FetchEndMessage> {
  const { runId } = run;
  const end = (delivered: number, stopped: FetchStopped | null): FetchEndMessage => {
    const message: FetchEndMessage = { kind: 'fetch-end', runId, delivered, stopped };
    deps.post(message);
    return message;
  };
  const stoppedAt = (reason: FetchStopReason, index: number, status: number, detail: string): FetchStopped => ({ reason, index, status, detail });

  const paths: string[] = [];
  for (const [index, target] of run.targets.entries()) {
    const path = roundTripPath(target);
    if (path === null) return end(0, stoppedAt('refused', index, 0, 'the target is not a path this module builds'));
    paths.push(path);
  }
  if (paths.length === 0) return end(0, null);
  if (!deps.locks) return end(0, stoppedAt('lock-unavailable', 0, 0, 'navigator.locks is not available'));
  if (signal.aborted) return end(0, stoppedAt('cancelled', 0, 0, cancelDetail(signal)));

  const { pacer } = deps;
  const cancelled = (index: number, delivered: number, status = 0): FetchEndMessage => end(delivered, stoppedAt('cancelled', index, status, cancelDetail(signal)));
  const run1 = async (): Promise<FetchEndMessage> => {
    let delivered = 0;
    let notBefore = 0; // earliest start a 429 allows
    for (const [index, target] of run.targets.entries()) {
      const path = paths[index]!;
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) return cancelled(index, delivered);
        const before = deps.now();
        const waitMs = Math.max(0, Math.max(pacer.lastStart === null ? before : pacer.lastStart + FETCH_MIN_DELAY_MS, notBefore) - before);
        deps.post({ kind: 'fetch-progress', runId, index, waitMs, why: attempt > 0 ? 'rate-limited' : index === 0 ? 'start' : 'pacing' });
        if (waitMs > 0) await deps.sleep(waitMs, signal);
        if (signal.aborted) return cancelled(index, delivered);

        pacer.lastStart = deps.now();
        let view: FetchResponseView;
        try {
          view = await abortable(
            (async (): Promise<FetchResponseView> => {
              const response = await deps.fetch(path, requestInit(signal));
              const challenged = response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge';
              const body = response.status === 200 && !challenged ? await response.text() : null;
              return { status: response.status, url: response.url, headers: response.headers, origin: deps.origin, body };
            })(),
            signal,
          );
        } catch (error) {
          return signal.aborted ? cancelled(index, delivered) : end(delivered, stoppedAt('network', index, 0, error instanceof Error ? error.message : String(error)));
        }
        if (signal.aborted) return cancelled(index, delivered, view.status);

        const nowMs = deps.now();
        const wallMs = deps.wallNow();
        const verdict = classifyFetchResponse(target, view, wallMs, attempt);
        if (verdict.kind === 'stop') return end(delivered, stoppedAt(verdict.reason, index, verdict.status, verdict.detail));
        if (verdict.kind === 'retry') {
          notBefore = nowMs + verdict.waitMs;
          continue;
        }
        deps.post({ kind: 'fetch-item', runId, index, path, finalPath: verdict.finalPath, contentType: verdict.contentType, body: verdict.body, fetchedAt: new Date(wallMs).toISOString() });
        delivered += 1;
        break;
      }
    }
    return end(delivered, null);
  };
  /** The run, then the wait that keeps the lock until the last request is 3000 ms old. Runs even when the run threw. */
  const execute = async (): Promise<FetchEndMessage> => {
    try {
      return await run1();
    } finally {
      const wait = pacer.lastStart === null ? 0 : pacer.lastStart + FETCH_MIN_DELAY_MS - deps.now();
      if (wait > 0) await deps.sleep(wait, NEVER_ABORTED);
    }
  };

  let entered = false;
  try {
    return await deps.locks.request(FETCH_LOCK_NAME, { ifAvailable: true }, (lock) => {
      entered = true;
      return lock ? execute() : Promise.resolve(end(0, stoppedAt('lock-held', 0, 0, 'another OmniSwim tab is fetching')));
    });
  } catch (error) {
    // A failure inside the run is a bug and must surface. Only the lock manager refusing to run the callback is `lock-unavailable`.
    if (entered) throw error;
    return end(0, stoppedAt('lock-unavailable', 0, 0, error instanceof Error ? error.message : String(error)));
  }
}
