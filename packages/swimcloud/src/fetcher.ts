/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Track B: the local, on-demand, single-operator, accepted-risk automated
 * fetch path (`plans/2026-09-06/01-legal-and-access-strategy.md` §4).
 *
 * {@link SwimCloudPoliteFetcher} wraps any raw page fetcher with everything
 * that path's own constraints require, **enforced here in code, not left to
 * caller discipline**:
 *
 *  - the robots.txt denylist, checked via `classifySwimCloudUrl` **before**
 *    any request is issued (`urlClassifier.ts`'s `forbidden` outcome) — Track
 *    B has already accepted the larger Terms-of-Use risk and gets no
 *    exemption from this list regardless;
 *  - a minimum delay between requests — never concurrent, never a burst;
 *  - a status-keyed cache read-through (`cache.ts`) — a URL already marked
 *    `'final'` is never re-requested, and this wrapper refuses even an
 *    explicit `forceRefresh` on one (loud, not silent — see
 *    {@link SwimCloudFinalEntryImmutableError}).
 *
 * **This module contains no scheduler, no timer, no background loop.** Every
 * fetch happens because something called `.fetch()`. Phase 3's paste-a-link UI
 * is expected to be the only caller, on an explicit user action, per the
 * recorded on-demand-only decision
 * (`plans/2026-09-06/00-executive-summary.md`, "Decisions on record").
 */

import type { SwimCloudCaptureTrack } from './entities';
import type { SwimCloudParseContext } from './parser';
import type { SwimCloudCacheEntry, SwimCloudCacheStatus, SwimCloudCacheStore } from './cache';
import {
  classifySwimCloudUrl,
  isFetchableSwimCloudUrl,
  isForbiddenSwimCloudUrl,
  type SwimCloudRobotsRule,
  type SwimCloudUrlMalformed,
  type SwimCloudUrlUnrecognized,
} from './urlClassifier';

/** What a concrete fetcher (Playwright, or a test double) has to implement. */
export interface SwimCloudRawFetcher {
  fetchRaw(url: string): Promise<SwimCloudRawFetchResult>;
}

export interface SwimCloudRawFetchResult {
  readonly html: string;
  readonly httpStatus: number;
}

/** Base of every error this wrapper throws instead of silently doing the wrong thing. */
export class SwimCloudFetchPolicyError extends Error {}

/** The URL is a recognized SwimCloud path robots.txt disallows. Never fetched — see `urlClassifier.ts`. */
export class SwimCloudForbiddenUrlError extends SwimCloudFetchPolicyError {
  constructor(
    readonly url: string,
    readonly rule: SwimCloudRobotsRule,
    detail: string,
  ) {
    super(`Refusing to fetch ${JSON.stringify(url)}: disallowed by robots.txt (${rule}). ${detail}`);
    this.name = 'SwimCloudForbiddenUrlError';
  }
}

/** The URL is not a recognized, well-formed SwimCloud resource — malformed or wholly unrecognized. Never `forbidden` (that's {@link SwimCloudForbiddenUrlError}) or `fetchable` (that's not an error at all). */
export class SwimCloudUnfetchableUrlError extends SwimCloudFetchPolicyError {
  constructor(readonly classification: SwimCloudUrlMalformed | SwimCloudUrlUnrecognized) {
    super(
      `Refusing to fetch ${JSON.stringify(classification.input)}: not a fetchable SwimCloud URL (${classification.outcome}). ${classification.detail}`,
    );
    this.name = 'SwimCloudUnfetchableUrlError';
  }
}

/**
 * Thrown when a caller asks to refresh a URL whose cache entry is already
 * `'final'`. This is deliberate friction, not a bug: a `'final'` snapshot is
 * supposed to be immutable (`cache.ts`'s file header). Silently honoring
 * `forceRefresh` here would make that guarantee decorative. To actually
 * re-capture a `'final'` page, delete its cache entry first — a separate,
 * visible action, not a fetch-time flag.
 */
export class SwimCloudFinalEntryImmutableError extends SwimCloudFetchPolicyError {
  constructor(readonly canonicalUrl: string) {
    super(
      `${JSON.stringify(canonicalUrl)} is cached as 'final' and will not be re-fetched, even with forceRefresh. Delete the cache entry first if this snapshot is genuinely wrong.`,
    );
    this.name = 'SwimCloudFinalEntryImmutableError';
  }
}

export interface SwimCloudPoliteFetchOptions {
  /**
   * Which access track this fetch belongs to, stamped onto both the cache
   * entry and the returned {@link SwimCloudParseContext}. `'playwright'` for
   * the real Track B fetcher; a caller under test supplies whatever its double
   * represents.
   */
  readonly track: SwimCloudCaptureTrack;
  readonly cache?: SwimCloudCacheStore;
  /**
   * Re-fetch even if a cache entry exists — but only if that entry is
   * `'provisional'`. A `'final'` entry throws
   * {@link SwimCloudFinalEntryImmutableError} instead of silently ignoring
   * this. Default `false`: prefer the cache whenever one exists, which is
   * what "cache every page aggressively" means in practice
   * (`01-legal-and-access-strategy.md` §4).
   */
  readonly forceRefresh?: boolean;
  /** Status to store a freshly-fetched page under. Default `'provisional'` — a caller asserts `'final'`, it is never inferred. */
  readonly markAs?: SwimCloudCacheStatus;
}

export interface SwimCloudPoliteFetchResult {
  readonly canonicalUrl: string;
  readonly html: string;
  readonly httpStatus?: number;
  readonly source: 'cache' | 'network';
  readonly status: SwimCloudCacheStatus;
  /** Ready to hand straight to `parseTeamRosterHtml`/`parseMeetResultsHtml` from `parser.ts`. */
  readonly context: SwimCloudParseContext;
}

/** Injectable clock/sleep so rate-limit tests never depend on a real timer. */
export interface SwimCloudPoliteFetcherClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: SwimCloudPoliteFetcherClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SwimCloudPoliteFetcherOptions {
  /** Minimum milliseconds between two network requests issued by this instance. Default 3000. */
  readonly minDelayMs?: number;
  readonly clock?: SwimCloudPoliteFetcherClock;
}

/**
 * The single choke point every Track B request passes through
 * (`plans/2026-09-06/03-architecture.md` §1.2 — "the politeness-enforcing
 * fetcher wrapper"). One instance's rate limit is tracked across all the URLs
 * it fetches, not per-URL — the point is bounding total load on SwimCloud, not
 * bounding load per page.
 */
export class SwimCloudPoliteFetcher {
  private readonly minDelayMs: number;
  private readonly clock: SwimCloudPoliteFetcherClock;
  private lastFetchAtMs: number | undefined;

  constructor(
    private readonly raw: SwimCloudRawFetcher,
    options: SwimCloudPoliteFetcherOptions = {},
  ) {
    this.minDelayMs = options.minDelayMs ?? 3000;
    this.clock = options.clock ?? REAL_CLOCK;
  }

  async fetch(url: string, options: SwimCloudPoliteFetchOptions): Promise<SwimCloudPoliteFetchResult> {
    const classification = classifySwimCloudUrl(url);

    if (isForbiddenSwimCloudUrl(classification)) {
      throw new SwimCloudForbiddenUrlError(url, classification.rule, classification.detail);
    }
    if (!isFetchableSwimCloudUrl(classification)) {
      throw new SwimCloudUnfetchableUrlError(classification);
    }

    const { canonicalUrl } = classification;
    const cache = options.cache;

    if (cache !== undefined) {
      const cached = await cache.get(canonicalUrl);
      if (cached !== undefined) {
        if (cached.status === 'final') {
          if (options.forceRefresh === true) {
            throw new SwimCloudFinalEntryImmutableError(canonicalUrl);
          }
          return resultFromCacheEntry(cached);
        }
        // 'provisional': serve it unless the caller explicitly wants a refresh.
        if (options.forceRefresh !== true) {
          return resultFromCacheEntry(cached);
        }
      }
    }

    await this.enforceRateLimit();
    const raw = await this.raw.fetchRaw(canonicalUrl);
    const retrievedAt = new Date(this.clock.now()).toISOString();
    const status = options.markAs ?? 'provisional';

    const entry: SwimCloudCacheEntry = {
      canonicalUrl,
      html: raw.html,
      status,
      retrievedAt,
      track: options.track,
    };
    if (cache !== undefined) {
      await cache.set(entry);
    }

    return {
      canonicalUrl,
      html: raw.html,
      httpStatus: raw.httpStatus,
      source: 'network',
      status,
      context: { sourceUrl: canonicalUrl, retrievedAt, track: options.track },
    };
  }

  private async enforceRateLimit(): Promise<void> {
    const now = this.clock.now();
    if (this.lastFetchAtMs !== undefined) {
      const elapsed = now - this.lastFetchAtMs;
      if (elapsed < this.minDelayMs) {
        await this.clock.sleep(this.minDelayMs - elapsed);
      }
    }
    this.lastFetchAtMs = this.clock.now();
  }
}

function resultFromCacheEntry(entry: SwimCloudCacheEntry): SwimCloudPoliteFetchResult {
  return {
    canonicalUrl: entry.canonicalUrl,
    html: entry.html,
    source: 'cache',
    status: entry.status,
    context: { sourceUrl: entry.canonicalUrl, retrievedAt: entry.retrievedAt, track: entry.track },
  };
}
