/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure resume logic: given whatever `GET /api/swimcloud/captures/{id}`
 * returned, decide which planned steps a restarted crawl may skip.
 *
 * Factored out of `./crawler-content.ts` for the same reason
 * `./crawlRequest.ts` and `./crawlErrorPolicy.ts` were — this is the part of
 * "don't re-fetch what's already on disk" that can be tested without a
 * browser, a server, or a `chrome.*` shim
 * (`tests/swimCloudExtensionCaptureResume.test.ts`).
 *
 * ## Why a validator and not a cast
 *
 * The record comes back over HTTP from a process this script does not control
 * and cannot version-lock against. A cast would let a shape change turn into
 * "no pages look captured" (harmless, just slow) or — far worse — into a
 * malformed ref being read as a skippable page, which silently drops a page
 * from the crawl. So {@link readStoredCapture} validates and drops what it
 * cannot read, and {@link storedPageIsAlreadyCaptured} is deliberately an
 * equality test against the single outcome that means *real bytes are stored*,
 * never a "not an error" test. `CLAUDE.md`'s "absent ≠ empty": an
 * unrecognisable record yields `undefined` (crawl everything), never an empty
 * skip set dressed up as a verified one.
 */

import {
  readSwimCloudCrawlPass,
  readSwimCloudCrawlScopeId,
  orderCrawlPasses,
  type SwimCloudCaptureCrawlScope,
  type SwimCloudCrawlPass,
  type SwimCloudCrawlStep,
} from '@omniswim/swimcloud/crawlPlan';

/**
 * The subset of `captureStore.ts`'s `SwimCloudCapturePageRef` this module
 * reads. Declared locally, field for field, rather than imported: that module
 * composes `./cache.ts`'s Node-only code and even a type-only import of it
 * fails `tsc` under this extension's `"types": []` config — the same
 * constraint `packages/matrix/src/components/SwimCloudCapturePicker.tsx`
 * documents for the identical reason.
 */
export interface SwimCloudStoredPageRef {
  readonly canonicalUrl: string;
  /** Mirrors `SwimCloudCapturePageOutcome`. Only `'ok'` means bytes are stored. */
  readonly outcome: string;
  readonly teamId?: string;
  readonly gender?: string;
  readonly page?: number;
}

/** The subset of `SwimCloudCaptureRecord` this module reads. */
export interface SwimCloudStoredCapture {
  readonly captureId: string;
  readonly pages: readonly SwimCloudStoredPageRef[];
  /**
   * What the stored record says about which passes earlier crawls planned, or
   * `undefined` when the record does not say.
   *
   * **Never used to decide what to skip.** Resume is decided per canonical URL
   * by {@link alreadyCapturedUrls}, which asks only whether real bytes are
   * stored — so a crawl widened from "meet results" to "everything" re-plans
   * the roster and swimmer-times pages automatically, because the store holds
   * no bytes for them and they were never in the skip set. Trusting a recorded
   * scope instead would be trusting a claim about a *plan* to decide what is on
   * *disk*, and a capture whose crawl died mid-pass would then have its
   * unfetched pages skipped forever.
   *
   * It is read for one thing only: so the panel can say what widening the scope
   * is about to add. See {@link passesNewlyPlannedBy}.
   */
  readonly crawlScope?: SwimCloudCaptureCrawlScope;
}

/**
 * Read a stored `crawlScope`, or `undefined` if the record does not carry a
 * readable one.
 *
 * Same validator-not-cast rule as the rest of this module, and the same
 * fail-safe direction: an unreadable scope reads as *not recorded*, which makes
 * a UI say "this capture does not record what it planned" rather than assert a
 * scope nobody wrote. An unknown pass string is dropped rather than kept, so a
 * future build's extra pass never reaches this one as a bare string.
 */
function readStoredCrawlScope(value: unknown): SwimCloudCaptureCrawlScope | undefined {
  if (!isRecordLike(value)) return undefined;
  const latestScopeId = readSwimCloudCrawlScopeId(value.latestScopeId);
  if (latestScopeId === undefined) return undefined;
  if (!Array.isArray(value.plannedPasses)) return undefined;
  const passes: SwimCloudCrawlPass[] = [];
  for (const raw of value.plannedPasses) {
    const pass = readSwimCloudCrawlPass(raw);
    if (pass !== undefined) passes.push(pass);
  }
  return { latestScopeId, plannedPasses: orderCrawlPasses(passes) };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True only for the one outcome whose page has real HTML behind it.
 *
 * `'http-error'`, `'forbidden'`, `'skipped'` and `'canceled'` are all recorded
 * attempts with **no stored bytes** — `swimcloudCaptureRoutes.ts` passes
 * `entry: undefined` to `putPage` for every one of them. Treating any of those
 * as "already captured" would skip a page the store does not hold, and the
 * capture would look complete while missing results. A 404 in particular is a
 * real fact worth recording (a team with no women's programme) *and* a page
 * with nothing in it; those two things are not in tension, and only the first
 * is a reason not to re-attempt it later.
 */
export function storedPageIsAlreadyCaptured(ref: SwimCloudStoredPageRef): boolean {
  return ref.outcome === 'ok';
}

/**
 * Read the server's capture JSON into the shape this module needs, or
 * `undefined` if it is not recognisably a capture record.
 *
 * A page ref missing a string `canonicalUrl` or a string `outcome` is dropped
 * rather than repaired — a ref this script cannot read is a page it must
 * re-fetch, which is the safe direction to fail in.
 */
export function readStoredCapture(value: unknown): SwimCloudStoredCapture | undefined {
  if (!isRecordLike(value)) return undefined;
  if (typeof value.captureId !== 'string' || value.captureId.length === 0) return undefined;
  if (!Array.isArray(value.pages)) return undefined;

  const pages: SwimCloudStoredPageRef[] = [];
  for (const raw of value.pages) {
    if (!isRecordLike(raw)) continue;
    if (typeof raw.canonicalUrl !== 'string' || raw.canonicalUrl.length === 0) continue;
    if (typeof raw.outcome !== 'string') continue;
    pages.push({
      canonicalUrl: raw.canonicalUrl,
      outcome: raw.outcome,
      ...(typeof raw.teamId === 'string' ? { teamId: raw.teamId } : {}),
      ...(typeof raw.gender === 'string' ? { gender: raw.gender } : {}),
      ...(typeof raw.page === 'number' && Number.isSafeInteger(raw.page) ? { page: raw.page } : {}),
    });
  }
  const crawlScope = readStoredCrawlScope(value.crawlScope);
  return {
    captureId: value.captureId,
    pages,
    ...(crawlScope === undefined ? {} : { crawlScope }),
  };
}

/** Canonical URLs the store already holds bytes for. Empty when there is no stored capture. */
export function alreadyCapturedUrls(capture: SwimCloudStoredCapture | undefined): ReadonlySet<string> {
  if (capture === undefined) return new Set<string>();
  return new Set(capture.pages.filter(storedPageIsAlreadyCaptured).map((p) => p.canonicalUrl));
}

export interface SwimCloudResumePartition {
  /** Steps the crawl must actually fetch, in plan order. */
  readonly toFetch: readonly SwimCloudCrawlStep[];
  /** Steps skipped because the store already holds their bytes, in plan order. */
  readonly alreadyCaptured: readonly SwimCloudCrawlStep[];
}

/**
 * Split a plan into what must be fetched and what a previous crawl already
 * captured.
 *
 * Both halves are returned, not just the first: a skipped page still counts
 * toward the crawl's progress and still gets said out loud on the panel. A
 * crawl that quietly fetched 8 of 66 pages and called itself done would be
 * indistinguishable from a broken one.
 *
 * This filters the planner's output rather than changing what the planner
 * emits — `crawlPlan.ts` stays a pure function of the meet and the team list,
 * with no knowledge of any store.
 */
export function partitionResumableSteps(
  steps: readonly SwimCloudCrawlStep[],
  alreadyCaptured: ReadonlySet<string>,
): SwimCloudResumePartition {
  const toFetch: SwimCloudCrawlStep[] = [];
  const skipped: SwimCloudCrawlStep[] = [];
  for (const step of steps) {
    (alreadyCaptured.has(step.canonicalUrl) ? skipped : toFetch).push(step);
  }
  return { toFetch, alreadyCaptured: skipped };
}

/* -------------------------------------------------------------------------- */
/* The resume round trip, as a value                                           */
/* -------------------------------------------------------------------------- */

/**
 * How the `omniswim-swimcloud-read-capture` round trip to the background
 * worker ended.
 *
 * `timeout` is a real, expected outcome, not a defensive afterthought: the
 * worker is a Manifest V3 service worker that Chrome tears down when idle, and
 * the reply travels through a message channel that has no failure mode of its
 * own for "the handler threw before answering". Modelling the timeout here is
 * what stops that case from being an unobservable hang in the content script.
 */
export type SwimCloudReadCaptureRoundTrip =
  | { readonly kind: 'ok'; readonly response: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Why a crawl is planning every page. `'none'` means nothing went wrong — the
 * app either had a record this run could read, or answered "no such capture",
 * which is the normal first-crawl case.
 */
export type SwimCloudResumeDegradation =
  | 'none'
  /** The worker never answered within the deadline. */
  | 'timed-out'
  /** The message channel itself failed (worker asleep, extension reloaded). */
  | 'errored'
  /** The worker answered, but with an error payload instead of a capture reply. */
  | 'worker-error-reply'
  /** The worker answered honestly that it could not reach the local app. */
  | 'app-unreachable'
  /** Something came back, but it is not a capture record this script can read. */
  | 'unreadable-reply';

export interface SwimCloudResumeDecision {
  /** Whether the local app answered at all. Mirrors `background.ts`'s `ReadCaptureResponse.available`. */
  readonly available: boolean;
  /** True only when the app returned a capture record for this subject. */
  readonly found: boolean;
  /** Canonical URLs whose bytes are already stored. Empty unless the reply was fully readable. */
  readonly alreadyCaptured: ReadonlySet<string>;
  /**
   * Event references the app derived from the swims pages it already holds.
   *
   * The crawl's event-results pass plans from the swims pages it parsed *this
   * run*, and resume skips a swims page whose bytes are already stored. A
   * re-crawl of a complete capture therefore collected nothing, planned no
   * `meetEvent` pages, and left every prelims/finals pair unresolved — while
   * reporting success, because it genuinely had nothing new to fetch.
   *
   * Only the app can see those stored bytes, so it parses them and sends the
   * references back. Empty when the app could not be asked, held no record, or
   * is an older build that does not send them; in every one of those cases the
   * run falls back to the references it gathers itself, which is what it did
   * before.
   */
  readonly storedEventRefs: readonly string[];
  readonly degradation: SwimCloudResumeDegradation;
  /**
   * What the stored capture says earlier crawls planned, when it says anything.
   *
   * Absent means the app had no record, could not be asked, or holds a record
   * written before crawl scopes existed. All three are honestly "not recorded",
   * and none of them changes what this run fetches — see
   * {@link SwimCloudStoredCapture.crawlScope}.
   */
  readonly storedScope?: SwimCloudCaptureCrawlScope;
}

const NOTHING_CAPTURED: ReadonlySet<string> = new Set<string>();

function degraded(degradation: SwimCloudResumeDegradation): SwimCloudResumeDecision {
  return { available: false, found: false, alreadyCaptured: NOTHING_CAPTURED, storedEventRefs: [], degradation };
}

/**
 * Turn one round-trip outcome into the resume state the crawl plans against.
 *
 * Every outcome except a fully readable capture record yields an **empty** skip
 * set, so the crawl plans every page. That is slower and correct; the opposite
 * default would drop pages from a capture on the strength of a reply this
 * script could not read. `CLAUDE.md`'s "absent ≠ empty" applies directly:
 * `degradation` records *why* the set is empty, so the panel can say "we could
 * not ask" rather than implying "nothing is stored".
 *
 * The `worker-error-reply` case is the one this function exists for. Since
 * `background.ts` now answers a thrown handler with `{ error }` instead of
 * never answering at all, a reply that carries an `error` string must read as
 * "could not ask" — not as a capture record with no pages in it.
 */
/**
 * `knownEventRefs` from the app, or an empty list.
 *
 * Validated rather than cast, same rule as {@link readStoredCapture}: this
 * arrives over HTTP from a process the script does not version-lock against,
 * and a malformed entry must contribute nothing rather than become a planned
 * URL. An app that predates this field simply omits it.
 */
function readStoredEventRefs(capture: unknown): readonly string[] {
  if (!isRecordLike(capture)) return [];
  const refs = (capture as { knownEventRefs?: unknown }).knownEventRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

export function decideResumeFromRoundTrip(trip: SwimCloudReadCaptureRoundTrip): SwimCloudResumeDecision {
  if (trip.kind === 'timeout') return degraded('timed-out');
  if (trip.kind === 'error') return degraded('errored');

  const response = trip.response;
  if (!isRecordLike(response)) return degraded('unreadable-reply');
  if (typeof response.error === 'string' && response.error.length > 0) return degraded('worker-error-reply');
  if (response.available !== true) return degraded('app-unreachable');
  if (response.found !== true) {
    return { available: true, found: false, alreadyCaptured: NOTHING_CAPTURED, storedEventRefs: [], degradation: 'none' };
  }

  const stored = readStoredCapture(response.capture);
  if (stored === undefined) {
    return { available: true, found: true, alreadyCaptured: NOTHING_CAPTURED, storedEventRefs: [], degradation: 'unreadable-reply' };
  }
  return {
    available: true,
    found: true,
    alreadyCaptured: alreadyCapturedUrls(stored),
    storedEventRefs: readStoredEventRefs(response.capture),
    degradation: 'none',
    ...(stored.crawlScope === undefined ? {} : { storedScope: stored.crawlScope }),
  };
}
