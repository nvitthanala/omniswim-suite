/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Status-keyed cache for captured SwimCloud pages
 * (`plans/2026-09-06/03-architecture.md` §1.4 / §3).
 *
 * A `'final'` entry is a snapshot: the page's results are posted complete and
 * the entry is treated as immutable — it is never re-fetched, and this module
 * refuses even an explicit request to refresh one (see
 * {@link SwimCloudFinalEntryImmutableError} in `./fetcher.ts`, which is the
 * only thing that decides whether to call {@link SwimCloudCacheStore.set}). A
 * `'provisional'` entry (a meet still in progress, a roster mid-season) is the
 * only kind eligible for a manual re-fetch.
 *
 * This is a synthesis, not a citation: no prior-art source solved "snapshot
 * final results once, keep polling in-progress meets" for a live sports-results
 * page (`03-architecture.md` §1.4's research note says so explicitly). It is
 * the general idempotent-URL-cache pattern applied to this domain.
 *
 * Local-only. Per `plans/2026-09-06/01-legal-and-access-strategy.md` §4,
 * nothing captured through Track B is ever synced, shared, or exported off the
 * machine it runs on — there is no network code anywhere in this file.
 */

import type { SwimCloudCaptureTrack } from './entities';

export type SwimCloudCacheStatus = 'provisional' | 'final';

/** One captured page, as stored. */
export interface SwimCloudCacheEntry {
  /** The classifier's `canonicalUrl` — see `urlClassifier.ts`'s `SwimCloudUrlFetchable.canonicalUrl`. */
  readonly canonicalUrl: string;
  readonly html: string;
  readonly status: SwimCloudCacheStatus;
  /** ISO-8601 instant the page was captured (not when it was cached, if those ever differ). */
  readonly retrievedAt: string;
  readonly track: SwimCloudCaptureTrack;
  readonly sha256?: string;
}

/** Storage abstraction so the fetcher wrapper never depends on a concrete backend. */
export interface SwimCloudCacheStore {
  get(canonicalUrl: string): Promise<SwimCloudCacheEntry | undefined>;
  /** Callers should prefer `fetcher.ts`'s wrapper over calling this directly — see the file header. */
  set(entry: SwimCloudCacheEntry): Promise<void>;
  /** The one way to make a `'final'` entry eligible for re-fetch again: delete it first, explicitly. */
  delete(canonicalUrl: string): Promise<void>;
  list(): Promise<readonly SwimCloudCacheEntry[]>;
}

/**
 * In-memory cache. Gone when the process exits — useful for tests, and as the
 * default for a caller that hasn't wired up persistence yet. Not what "local
 * -only storage" in the legal doc means for a real coach's workflow; that's
 * {@link FileSystemSwimCloudCache}.
 */
export class InMemorySwimCloudCache implements SwimCloudCacheStore {
  private readonly entries = new Map<string, SwimCloudCacheEntry>();

  async get(canonicalUrl: string): Promise<SwimCloudCacheEntry | undefined> {
    return this.entries.get(canonicalUrl);
  }

  async set(entry: SwimCloudCacheEntry): Promise<void> {
    this.entries.set(entry.canonicalUrl, entry);
  }

  async delete(canonicalUrl: string): Promise<void> {
    this.entries.delete(canonicalUrl);
  }

  async list(): Promise<readonly SwimCloudCacheEntry[]> {
    return Array.from(this.entries.values());
  }
}

/**
 * One JSON file per cached page, under `dir`. The filename is derived from the
 * canonical URL rather than the URL itself, so a URL with `/`s or a query
 * string never has to survive a filesystem round-trip verbatim.
 *
 * No database dependency on purpose — `packages/db`'s SQLite/Postgres wiring
 * was deliberately descoped from Phase 1
 * (`plans/2026-09-06/WORKLOG-01-phase1-data-model-and-scoring.md`, "Descoped
 * from phase 1") and this doesn't reach for it either. A coach's captured
 * pages living as plain files in a directory they can see is also, on its own
 * merits, the most honest form "local-only" can take.
 */
export class FileSystemSwimCloudCache implements SwimCloudCacheStore {
  constructor(private readonly dir: string) {}

  async get(canonicalUrl: string): Promise<SwimCloudCacheEntry | undefined> {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(this.pathFor(canonicalUrl), 'utf8');
      return JSON.parse(raw) as SwimCloudCacheEntry;
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async set(entry: SwimCloudCacheEntry): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.pathFor(entry.canonicalUrl), JSON.stringify(entry, null, 2), 'utf8');
  }

  async delete(canonicalUrl: string): Promise<void> {
    const fs = await import('node:fs/promises');
    try {
      await fs.unlink(this.pathFor(canonicalUrl));
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
  }

  async list(): Promise<readonly SwimCloudCacheEntry[]> {
    const fs = await import('node:fs/promises');
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
    const entries: SwimCloudCacheEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const raw = await fs.readFile(`${this.dir}/${name}`, 'utf8');
      entries.push(JSON.parse(raw) as SwimCloudCacheEntry);
    }
    return entries;
  }

  private pathFor(canonicalUrl: string): string {
    return `${this.dir}/${fileNameFor(canonicalUrl)}.json`;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * A filesystem-safe, collision-resistant, deterministic name for a canonical
 * URL: percent-encoded characters outside `[A-Za-z0-9._-]`, capped with a hash
 * suffix so two URLs that differ only past a filesystem's path-length limit
 * can never collide.
 */
function fileNameFor(canonicalUrl: string): string {
  const safe = canonicalUrl.replace(/[^A-Za-z0-9._-]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`);
  const truncated = safe.length > 120 ? safe.slice(0, 120) : safe;
  return `${truncated}-${simpleHash(canonicalUrl)}`;
}

/**
 * A small, dependency-free, non-cryptographic hash — only used to disambiguate
 * filenames, never for integrity (that's {@link SwimCloudCacheEntry.sha256},
 * computed by the caller over the raw HTML, not by this module).
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
