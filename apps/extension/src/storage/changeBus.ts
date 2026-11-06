/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The change bus (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.3 rule 3).
 *
 * Every write transaction bumps `meta.changeRev`. After the transaction commits, the writer
 * publishes `{rev, stores, at}` under `osx:change` in `chrome.storage.local`. Other surfaces
 * listen on `chrome.storage.onChanged`. A lost notice is not data loss: `watchChanges` also
 * compares `changeRev` when the page becomes visible or gains focus.
 *
 * The bus is an injected interface, so tests run without `chrome`.
 */
import type { IDBPDatabase } from 'idb';
import type { IsoTime, MetaChangeRevRow, OmniDbSchema, StoreName } from './schema';

export const CHANGE_NOTICE_KEY = 'osx:change';

export interface ChangeNotice {
  readonly rev: number;
  readonly stores: readonly StoreName[];
  readonly at: IsoTime;
}

/** A change seen by comparing `changeRev`, with no notice: the stores are not known. */
export interface MissedChange {
  readonly rev: number;
  readonly stores: 'unknown';
  readonly at: null;
}

export interface ChangeBus {
  /** Called after the write committed. A failure here never undoes the write. */
  publish(notice: ChangeNotice): Promise<void>;
  subscribe(listener: (notice: ChangeNotice) => void): () => void;
}

/** Accepts a stored notice only if every field has the right type. */
export function isChangeNotice(value: unknown): value is ChangeNotice {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.rev === 'number' &&
    Number.isInteger(v.rev) &&
    v.rev >= 1 &&
    Array.isArray(v.stores) &&
    v.stores.every(s => typeof s === 'string') &&
    typeof v.at === 'string'
  );
}

/** An in-process bus. Share one object between repos to model several tabs. */
export function createMemoryChangeBus(): ChangeBus {
  const listeners = new Set<(notice: ChangeNotice) => void>();
  return {
    publish(notice) {
      for (const l of [...listeners]) l(notice);
      return Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The slice of `chrome.storage` the bus uses. */
export interface ChromeStorageLike {
  readonly local: { set(items: Record<string, unknown>): Promise<void> };
  readonly onChanged: {
    addListener(cb: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void): void;
    removeListener(cb: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void): void;
  };
}

/** The production bus over `chrome.storage.local` and `chrome.storage.onChanged`. */
export function createChromeChangeBus(storage: ChromeStorageLike): ChangeBus {
  return {
    publish: notice => storage.local.set({ [CHANGE_NOTICE_KEY]: notice }),
    subscribe(listener) {
      const cb = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
        if (areaName !== 'local') return;
        const next = changes[CHANGE_NOTICE_KEY]?.newValue;
        if (isChangeNotice(next)) listener(next);
      };
      storage.onChanged.addListener(cb);
      return () => storage.onChanged.removeListener(cb);
    },
  };
}

/** The current `changeRev`; 0 before the first write. */
export async function readChangeRev(db: IDBPDatabase<OmniDbSchema>): Promise<number> {
  const row = (await db.get('meta', 'changeRev')) as MetaChangeRevRow | undefined;
  if (row === undefined) return 0;
  if (typeof row.value !== 'number' || !Number.isInteger(row.value) || row.value < 0) {
    throw new Error(`meta.changeRev is not a count: ${JSON.stringify(row.value)}`);
  }
  return row.value;
}

/** What `watchChanges` needs from `document` and `window`: `visibilitychange` and `focus`. */
export interface EventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ChangeWatch {
  stop(): void;
  /** The highest `changeRev` this watch has reported or started from. */
  lastSeenRev(): number;
}

/**
 * Report each change once. A notice reports its stores. When `visibilitychange` or `focus` fires
 * on a target, the watch compares `changeRev` and reports a `MissedChange` if a notice was lost.
 */
export async function watchChanges(
  db: IDBPDatabase<OmniDbSchema>,
  bus: ChangeBus,
  onChange: (change: ChangeNotice | MissedChange) => void,
  opts: { readonly targets?: readonly EventSource[] } = {}
): Promise<ChangeWatch> {
  let seen = await readChangeRev(db);
  const stopBus = bus.subscribe(notice => {
    if (notice.rev <= seen) return;
    // Notices for the revs between `seen` and this one were lost or are late. Report them as unknown
    // stores now; the late notice is then ignored because its rev is not above `seen`.
    if (notice.rev > seen + 1) onChange({ rev: notice.rev - 1, stores: 'unknown', at: null });
    seen = notice.rev;
    onChange(notice);
  });
  const check = (): void => {
    void readChangeRev(db).then(
      rev => {
        if (rev <= seen) return;
        seen = rev;
        onChange({ rev, stores: 'unknown', at: null });
      },
      // A closed connection means `onVersionChange` already told the page to reload.
      () => undefined
    );
  };
  const targets = opts.targets ?? [];
  for (const t of targets) {
    t.addEventListener('visibilitychange', check);
    t.addEventListener('focus', check);
  }
  return {
    stop() {
      stopBus();
      for (const t of targets) {
        t.removeEventListener('visibilitychange', check);
        t.removeEventListener('focus', check);
      }
    },
    lastSeenRev: () => seen,
  };
}
