/**
 * IndexedDB persistence for Metrics analysis sessions.
 *
 * Stores only operator input — the race configuration and the tags placed
 * during tagging. Metrics are never persisted: they are recomputed by calling
 * `analyzeRace` on load, so a later formula fix in the engine retroactively
 * corrects every saved analysis instead of freezing a stale number in the DB.
 * Video files are never stored, only the file name.
 */
import { analyzeRace, type RaceAnalysisResult, type RaceConfig, type RaceTag } from '@omniswim/core/lib/raceAnalysis';

export interface SessionVideoMeta {
  fileName: string;
  duration: number;
  width: number;
  height: number;
  fps?: number;
}

export interface SessionRecord {
  id: string;
  swimmerName: string;
  video: SessionVideoMeta;
  config: RaceConfig;
  tags: RaceTag[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  label: string;
  updatedAt: number;
  legacy: boolean;
}

export type LoadedSession =
  | { legacy: false; record: SessionRecord; analysis: RaceAnalysisResult }
  | { legacy: true; id: string; label: string; updatedAt: number; reason: string };

const DB_NAME = 'omni-metrics';
const STORE = 'sessions';
const DB_VERSION = 2;
const CURRENT_SCHEMA_VERSION = 2 as const;

// Sessions saved by DB_VERSION 1 store a computed-metrics blob under a
// different shape ({ name, savedAt, events, data, ... }) with no `tags` array
// and an incompatible `config`. They cannot be converted into RaceTag[], so
// they are left in the store as-is and detected at read time instead of
// migrated; the caller is told they are legacy/untrusted rather than having
// them silently dropped.
type StoredRecord = SessionRecord & { schemaVersion: typeof CURRENT_SCHEMA_VERSION };

function isCurrentRecord(raw: unknown): raw is StoredRecord {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return r.schemaVersion === CURRENT_SCHEMA_VERSION && Array.isArray(r.tags) && typeof r.config === 'object';
}

function legacyLabel(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const name = (raw as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'Legacy session';
}

function legacyUpdatedAt(raw: unknown): number {
  if (typeof raw === 'object' && raw !== null) {
    const savedAt = (raw as Record<string, unknown>).savedAt;
    if (typeof savedAt === 'number') return savedAt;
  }
  return 0;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        transaction.oncomplete = () => db.close();
      })
  );
}

export async function saveSession(record: SessionRecord): Promise<void> {
  const stored: StoredRecord = { ...record, schemaVersion: CURRENT_SCHEMA_VERSION };
  await tx('readwrite', store => store.put(stored));
}

export async function listSessions(): Promise<SessionSummary[]> {
  const all = await tx<unknown[]>('readonly', store => store.getAll() as IDBRequest<unknown[]>);
  return (all ?? [])
    .map((raw): SessionSummary =>
      isCurrentRecord(raw)
        ? { id: raw.id, label: raw.swimmerName || 'Unnamed swimmer', updatedAt: raw.updatedAt, legacy: false }
        : {
            id: (raw as { id: string }).id,
            label: legacyLabel(raw),
            updatedAt: legacyUpdatedAt(raw),
            legacy: true,
          }
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(id: string): Promise<LoadedSession | undefined> {
  const raw = await tx<unknown>('readonly', store => store.get(id) as IDBRequest<unknown>);
  if (raw === undefined) return undefined;
  if (isCurrentRecord(raw)) {
    return { legacy: false, record: raw, analysis: analyzeRace(raw.config, raw.tags) };
  }
  return {
    legacy: true,
    id: (raw as { id: string }).id,
    label: legacyLabel(raw),
    updatedAt: legacyUpdatedAt(raw),
    reason:
      'Saved under an earlier schema as a computed-metrics blob. Its stored numbers are untrusted and cannot be recomputed with the current engine.',
  };
}

export async function deleteSession(id: string): Promise<void> {
  await tx('readwrite', store => store.delete(id));
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
