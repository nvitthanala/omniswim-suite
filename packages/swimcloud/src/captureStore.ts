/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The local capture store — a manifest layer over `./cache.ts`'s
 * `FileSystemSwimCloudCache`, per `plans/2026-09-08/02-capture-store.md`.
 *
 * A "capture" is one crawl's worth of pages for one subject (a meet, or a
 * team) — the thing the Matrix picker lists and imports from. Pages
 * themselves are the existing, unchanged `FileSystemSwimCloudCache` format;
 * this module only adds the manifest (`captures/*.json`, `index.json`) that
 * groups pages into a capture and tracks what's known about its
 * completeness.
 *
 * Deliberately never claims a completeness value it cannot prove — see
 * {@link SwimCloudCaptureCompleteness}. This is `CLAUDE.md`'s "absent ≠
 * empty" rule applied to a crawl: a truncated capture must not look
 * indistinguishable from a genuinely complete one.
 *
 * Local-only, same posture as `./cache.ts`: no network code in this file.
 */

import type { SwimCloudCaptureSubject, SwimCloudCaptureTrack, SwimCloudMeetId, SwimCloudTeamId } from './entities';
import type { SwimCloudResourceKind } from './urlClassifier';
import type { SwimCloudCacheEntry } from './cache';
import { FileSystemSwimCloudCache } from './cache';

/** Re-exported from `./entities` — see that type's doc comment for why it
 * lives there and not here (this file pulls in `./cache`'s Node-only code;
 * the subject type must not). */
export type { SwimCloudCaptureSubject } from './entities';

/**
 * What happened when one planned page was fetched.
 *
 * `'ok'` is the only outcome whose page carries real HTML. The other four
 * are recorded, never silently dropped — a 404 for a team's women's swims
 * list is a real fact (no women's program) as legitimate as a successful
 * fetch, and `CLAUDE.md`'s "fail loudly, never gap-fill" rule applies to a
 * crawl record exactly as it does to a parser.
 */
export type SwimCloudCapturePageOutcome = 'ok' | 'http-error' | 'forbidden' | 'skipped' | 'canceled';

/** One page the crawl planned and attempted, successful or not. */
export interface SwimCloudCapturePageRef {
  /** The cache key — `urlClassifier.ts`'s `SwimCloudUrlFetchable.canonicalUrl`. */
  readonly canonicalUrl: string;
  readonly resourceKind: SwimCloudResourceKind;
  readonly meetId?: SwimCloudMeetId;
  readonly teamId?: SwimCloudTeamId;
  readonly gender?: string;
  readonly page?: number;
  /** ISO-8601 instant this attempt was made. */
  readonly retrievedAt: string;
  readonly httpStatus?: number;
  /** SHA-256 of the raw HTML, computed by the writer. Absent for a non-'ok' outcome. */
  readonly sha256?: string;
  readonly bytes?: number;
  readonly cacheStatus: 'provisional' | 'final';
  readonly outcome: SwimCloudCapturePageOutcome;
  /** Present iff `outcome !== 'ok'` — what went wrong, in one sentence. */
  readonly detail?: string;
}

/**
 * What a caller can trust about a capture's completeness.
 *
 * There is deliberately no `'complete'` value. `'every-planned-page-fetched'`
 * is a claim about the plan the crawler committed to, not a claim about
 * SwimCloud — a plan built from a truncated team list (see
 * `parseMeetTeamsHtml`'s `discoveryCompleteness: 'unproven'`) can fetch
 * every page it planned and still not be the whole meet. A UI showing this
 * value must render it as exactly that qualified claim, never as "Complete."
 */
export type SwimCloudCaptureCompleteness =
  | 'in-progress'
  | 'every-planned-page-fetched'
  | 'partial'
  | 'failed';

export interface SwimCloudCaptureTeamDiscovery {
  readonly source: 'topteams' | 'meet-root-links-fallback';
  readonly genders: readonly string[];
  readonly teamIds: readonly string[];
  readonly completeness: 'unproven' | 'verified-complete-for-this-capture' | 'user-confirmed';
}

export interface SwimCloudCaptureRecord {
  /** Derived from the subject — `'meet-356467'` or `'team-58-2026-2027'`. */
  readonly captureId: string;
  readonly subject: SwimCloudCaptureSubject;
  /** The meet or team name, as printed on a captured page, once known. */
  readonly label?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly track: SwimCloudCaptureTrack;
  readonly completeness: SwimCloudCaptureCompleteness;
  readonly teamDiscovery?: SwimCloudCaptureTeamDiscovery;
  readonly plannedPageCount: number;
  readonly pages: readonly SwimCloudCapturePageRef[];
  readonly notes: readonly string[];
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** A `.then` handler that discards whatever it is handed, success or failure. */
function ignoreSettlement(): void {
  /* intentionally empty */
}

/**
 * Serializes async operations that share a key — and only those.
 *
 * Each key owns a promise chain. A new operation is appended to its key's
 * chain and does not start until every operation already queued on that same
 * key has settled. Operations on different keys share no state and run fully
 * in parallel, so one busy key never becomes a bottleneck for the rest.
 *
 * A failed operation does not poison its chain. The chain stores a promise
 * that cannot reject, so the next waiter runs whatever its predecessor did,
 * and each caller still sees only its own operation's outcome.
 *
 * The map does not grow without bound: a key's entry is deleted as soon as
 * its chain goes idle, so the map holds one entry per key with an operation
 * actually in flight, not one per key ever seen.
 *
 * **In-process only.** This is a lock between async callers inside one Node
 * process. It does NOT lock the filesystem. See
 * {@link FileSystemSwimCloudCaptureStore} for what that does and does not
 * protect.
 */
class KeyedAsyncMutex {
  private readonly chains = new Map<string, Promise<void>>();

  /** Run `operation` once every earlier operation on `key` has settled. */
  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.chains.get(key) ?? Promise.resolve();
    // `operation` is passed as both handlers so that a predecessor which
    // somehow rejects still releases the lock rather than cancelling
    // everything queued behind it.
    const result = predecessor.then(operation, operation);
    // What the next waiter chains onto: settled, never rejected.
    const settled = result.then(ignoreSettlement, ignoreSettlement);
    this.chains.set(key, settled);
    void settled.then(() => {
      // Only the tail of the chain clears the entry. If another caller
      // queued behind this one it has already replaced the value, and the
      // identity check leaves that newer chain alone.
      if (this.chains.get(key) === settled) {
        this.chains.delete(key);
      }
    });
    return result;
  }
}

/**
 * `FileSystemSwimCloudCache` for page bytes, plus the manifest this module
 * adds. Directory layout, exactly as specified in
 * `plans/2026-09-08/02-capture-store.md`:
 *
 * ```
 * <root>/
 *   index.json        # derived, rebuildable from captures/*.json — never a source of truth
 *   captures/
 *     <captureId>.json
 *   pages/             # unchanged FileSystemSwimCloudCache format
 * ```
 *
 * Merge semantics mirror `packages/matrix/src/lib/swimCloudMeetImportBridge.ts`'s
 * `mergeSwimCloudResults` deliberately, one level up: pages merge by
 * `canonicalUrl` (existing keep position, new append, re-capture replaces),
 * captures merge by `captureId` (`createdAt` preserved, `updatedAt` moves).
 *
 * ## Concurrency
 *
 * {@link upsertCapture}, {@link putPage} and {@link deleteCapture} each do a
 * read-modify-write on one capture's JSON file: read the record, merge, write
 * the whole thing back. Run two of those at once against the same
 * `captureId` and both read the same `pages` array, both append their own new
 * ref to it, and the second write silently discards the first ref. The HTML
 * bytes survive (they are keyed by URL under `pages/`), but the manifest
 * forgets the page ever existed — and `pages` is what parsing iterates, so
 * the page becomes invisible with no error anywhere. That is `CLAUDE.md`'s
 * top failure mode: a silent empty, not a crash.
 *
 * A {@link KeyedAsyncMutex} keyed by `captureId` closes that window. Writes
 * to one capture queue behind each other; writes to different captures do not
 * block each other at all.
 *
 * **What this protects:** concurrent async callers inside a single Node
 * process — which is the real deployment shape here, one local Express server
 * (`apps/shell/server.ts`) whose route handlers can overlap. Two browser tabs
 * crawling the same meet hit that server's handlers, and they are now safe.
 *
 * **What this does NOT protect:** two separate OS processes writing to the
 * same `root` directory. There is no file lock and no atomic
 * compare-and-swap on disk, so a second server instance, a manual script, or
 * a synced folder writing to the same capture concurrently can still lose a
 * page ref. Nothing ships that shape today; if something ever does, this
 * needs an on-disk lock or a write-temp-then-rename with a version check, not
 * a bigger in-process mutex.
 *
 * **Also not protected:** `index.json`. Two writes to *different* captures
 * can interleave their {@link rebuildIndex} calls and leave the index missing
 * a capture that is present on disk. That is deliberate and bounded — the
 * index is a derived read cache, never a source of truth (see
 * {@link rebuildIndex}), the captures themselves stay correct, and the next
 * write repairs it. Serializing it would make every capture wait on every
 * other, which is the bottleneck the per-id key exists to avoid.
 */
export class FileSystemSwimCloudCaptureStore {
  private readonly pageCache: FileSystemSwimCloudCache;
  private readonly capturesDir: string;
  private readonly indexPath: string;
  /** Keyed by `captureId` — see this class's "Concurrency" note. */
  private readonly writeLock = new KeyedAsyncMutex();

  constructor(private readonly root: string) {
    this.pageCache = new FileSystemSwimCloudCache(`${root}/pages`);
    this.capturesDir = `${root}/captures`;
    this.indexPath = `${root}/index.json`;
  }

  async getCapture(captureId: string): Promise<SwimCloudCaptureRecord | undefined> {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(this.captureFilePath(captureId), 'utf8');
      return JSON.parse(raw) as SwimCloudCaptureRecord;
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async listCaptures(): Promise<readonly SwimCloudCaptureRecord[]> {
    const fs = await import('node:fs/promises');
    let names: string[];
    try {
      names = await fs.readdir(this.capturesDir);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
    const records: SwimCloudCaptureRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const raw = await fs.readFile(`${this.capturesDir}/${name}`, 'utf8');
      records.push(JSON.parse(raw) as SwimCloudCaptureRecord);
    }
    return records;
  }

  /**
   * Merge `record` into whatever is already stored under its `captureId`.
   * Pages merge by `canonicalUrl`; `createdAt` is preserved from the
   * existing record if there is one, `updatedAt` always moves to now.
   *
   * Serialized against other writes to the same `captureId`.
   */
  async upsertCapture(record: SwimCloudCaptureRecord): Promise<SwimCloudCaptureRecord> {
    return this.writeLock.runExclusive(record.captureId, async () => {
      const existing = await this.getCapture(record.captureId);
      const mergedPages = mergePageRefs(existing?.pages ?? [], record.pages);
      const merged: SwimCloudCaptureRecord = {
        ...record,
        createdAt: existing?.createdAt ?? record.createdAt,
        updatedAt: new Date().toISOString(),
        pages: mergedPages,
      };
      await this.writeCapture(merged);
      await this.rebuildIndex();
      return merged;
    });
  }

  /**
   * Write one fetched page: the bytes go through the unchanged
   * `FileSystemSwimCloudCache`, and the capture's own page-ref list is
   * patched (merge-by-`canonicalUrl`, same rule as {@link upsertCapture}).
   *
   * Does not create the capture if it doesn't exist — call
   * {@link upsertCapture} first with `pages: []` when starting a new crawl,
   * matching how a crawl actually proceeds (open the capture, then post
   * pages as they're fetched).
   *
   * Serialized against other writes to the same `captureId`. The byte write
   * is inside the same critical section as the manifest patch, so the page's
   * HTML is always on disk before any reader can see the ref pointing at it.
   */
  async putPage(
    captureId: string,
    entry: SwimCloudCacheEntry | undefined,
    pageRef: SwimCloudCapturePageRef,
  ): Promise<void> {
    return this.writeLock.runExclusive(captureId, async () => {
      if (entry !== undefined) {
        await this.pageCache.set({ ...entry, captureId });
      }
      const existing = await this.getCapture(captureId);
      if (existing === undefined) {
        throw new Error(
          `putPage: no capture ${JSON.stringify(captureId)} exists — call upsertCapture first to open it.`,
        );
      }
      const pages = mergePageRefs(existing.pages, [pageRef]);
      await this.writeCapture({ ...existing, pages, updatedAt: new Date().toISOString() });
      await this.rebuildIndex();
    });
  }

  async readPage(canonicalUrl: string): Promise<SwimCloudCacheEntry | undefined> {
    return this.pageCache.get(canonicalUrl);
  }

  /**
   * Serialized against writes to the same `captureId`, so a delete never runs
   * halfway through a concurrent {@link putPage} — the two orderings both
   * leave a coherent store, an interleaving does not.
   */
  async deleteCapture(captureId: string, options: { readonly withPages: boolean }): Promise<void> {
    return this.writeLock.runExclusive(captureId, async () => {
      const fs = await import('node:fs/promises');
      const existing = await this.getCapture(captureId);
      if (options.withPages && existing !== undefined) {
        for (const page of existing.pages) {
          await this.pageCache.delete(page.canonicalUrl);
        }
      }
      try {
        await fs.unlink(this.captureFilePath(captureId));
      } catch (error) {
        if (!isEnoent(error)) {
          throw error;
        }
      }
      await this.rebuildIndex();
    });
  }

  /**
   * Recompute `index.json` from `captures/*.json`. `index.json` is a read
   * cache, never a source of truth — a caller that finds it missing or
   * disagreeing with the captures on disk should call this rather than
   * trust either blindly.
   */
  async rebuildIndex(): Promise<void> {
    const fs = await import('node:fs/promises');
    const records = await this.listCaptures();
    const summary = records.map((r) => ({
      captureId: r.captureId,
      subject: r.subject,
      label: r.label,
      updatedAt: r.updatedAt,
      completeness: r.completeness,
      pageCount: r.pages.length,
      plannedPageCount: r.plannedPageCount,
    }));
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(summary, null, 2), 'utf8');
  }

  private captureFilePath(captureId: string): string {
    return `${this.capturesDir}/${captureId}.json`;
  }

  private async writeCapture(record: SwimCloudCaptureRecord): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.mkdir(this.capturesDir, { recursive: true });
    await fs.writeFile(this.captureFilePath(record.captureId), JSON.stringify(record, null, 2), 'utf8');
  }
}

/** Existing entries keep position; a re-fetched URL replaces its predecessor; new URLs append. */
function mergePageRefs(
  existing: readonly SwimCloudCapturePageRef[],
  incoming: readonly SwimCloudCapturePageRef[],
): SwimCloudCapturePageRef[] {
  const byUrl = new Map(incoming.map((p) => [p.canonicalUrl, p]));
  const merged = existing.map((p) => byUrl.get(p.canonicalUrl) ?? p);
  const seen = new Set(existing.map((p) => p.canonicalUrl));
  for (const p of incoming) {
    if (!seen.has(p.canonicalUrl)) {
      merged.push(p);
    }
  }
  return merged;
}

/**
 * The id a subject's capture is stored under — deterministic, so re-opening
 * the same subject always finds the same record.
 *
 * Defined in `./entities.ts` and re-exported here, unchanged for every caller.
 * It moved 2026-09-08 because a second consumer appeared that cannot import
 * this file: the browser extension's background service worker builds
 * `/api/swimcloud/captures/{captureId}/pages` URLs, and this module composes
 * `./cache.ts`'s Node-only code, so the worker had been carrying a hand-written
 * copy of the rule. Two copies that agree only by construction is exactly the
 * silent-drift failure this repo refuses elsewhere — a changed rule here would
 * have made every page POST 404 against a capture id nobody opened, with
 * nothing to catch it. One definition, in the Node-free module both sides can
 * reach.
 */
export { captureIdForSubject } from './entities';
