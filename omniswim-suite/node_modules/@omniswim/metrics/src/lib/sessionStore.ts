/**
 * IndexedDB persistence for Metrics analysis sessions.
 *
 * Stores the race configuration, manual tracking events, and computed metrics
 * so a coach can revisit an analysis without re-uploading. Video blobs are NOT
 * stored (they are large and local-only); only the lightweight analysis state.
 */
import type { TrackingEvent } from '../components/VideoPlayer';
import type { BiomechanicsData, RaceConfig } from '../types';

export type MetricsSession = {
  id: string;
  name: string;
  savedAt: number;
  videoName?: string;
  videoMeta?: { duration: number; width: number; height: number; fps?: number };
  config: RaceConfig;
  events: TrackingEvent[];
  data: BiomechanicsData | null;
};

const DB_NAME = 'omni-metrics';
const STORE = 'sessions';
const DB_VERSION = 1;

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

export async function saveSession(session: MetricsSession): Promise<void> {
  await tx('readwrite', store => store.put(session));
}

export async function listSessions(): Promise<MetricsSession[]> {
  const all = await tx<MetricsSession[]>('readonly', store => store.getAll() as IDBRequest<MetricsSession[]>);
  return (all ?? []).sort((a, b) => b.savedAt - a.savedAt);
}

export async function loadSession(id: string): Promise<MetricsSession | undefined> {
  return tx<MetricsSession | undefined>(
    'readonly',
    store => store.get(id) as IDBRequest<MetricsSession | undefined>
  );
}

export async function deleteSession(id: string): Promise<void> {
  await tx('readwrite', store => store.delete(id));
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
