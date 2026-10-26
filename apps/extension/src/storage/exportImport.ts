/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Export and import (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.6).
 *
 * "SwimCloud data" is swim times and histories, rosters, SwimCloud's scores, snapshot `results`,
 * and swimmer and team display names. The default export carries ids only: it has no
 * `swimmerHistory`, no `rosters`, no `results` and no lineup `display`.
 *
 * Import rules, in order:
 * 1. A newer `formatVersion` (or `dbSchemaVersion`) is refused with `NewerExportError`.
 * 2. `includesSwimCloudData:false` with any `swimmerHistory`, `rosters`, `results` or `display`
 *    present refuses the file.
 * 3. Every record is validated first (validate.ts). Nothing is filled with a default. One bad
 *    record refuses the whole file and the error lists every bad JSON path. Nothing is written.
 * 4. Provenance is never upgraded: a `published` source must be in a bundled manifest
 *    (checked by the validator). Imported records get `origin:{kind:'imported',...}`,
 *    `rev:1` (a replace uses the stored `rev + 1`, see below) and `updatedAt: now`.
 * 5. `keep-both` gives a conflicting id a new id and remaps every reference in the same file.
 * 6. One readwrite transaction covers all stores: all or nothing.
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { stripSwimCloudData } from '@omniswim/engine';
import type { Lineup } from '@omniswim/engine';
import type { ChangeBus } from './changeBus';
import { ImportValidationError, NewerExportError } from './errors';
import type { ValidationIssue } from './errors';
import type { StorageRepo } from './repo';
import { DB_VERSION, STORE_DEFS } from './schema';
import type {
  ExportableStore,
  IsoTime,
  LineupRecord,
  MeetRecord,
  MetaChangeRevRow,
  OmniDbSchema,
  RosterRecord,
  RulePresetRecord,
  SessionPresetRecord,
  SettingRecord,
  SwimmerHistoryRecord,
  TagRecord,
} from './schema';
import { assertValidRecord, isStrictIsoInstant, validateRecord } from './validate';

export const EXPORT_FORMAT = 'omniswim-export';
export const EXPORT_FORMAT_VERSION = 1;

export interface OmniSwimExportV1 {
  readonly format: 'omniswim-export';
  readonly formatVersion: 1;
  readonly exportedAt: IsoTime;
  readonly extensionVersion: string;
  readonly dbSchemaVersion: number;
  readonly includesSwimCloudData: boolean;
  readonly stores: {
    readonly rulePresets?: readonly RulePresetRecord[];
    readonly sessionPresets?: readonly SessionPresetRecord[];
    readonly meets?: readonly MeetRecord[];
    readonly tags?: readonly TagRecord[];
    readonly lineups?: readonly LineupRecord[];
    /** Only with "include my settings". */
    readonly settings?: readonly SettingRecord[];
    /** Only if `includesSwimCloudData`. */
    readonly swimmerHistory?: readonly SwimmerHistoryRecord[];
    /** Only if `includesSwimCloudData`. */
    readonly rosters?: readonly RosterRecord[];
  };
}

/** The order stores appear in a file, and the order an import validates and writes them. */
export const EXPORT_STORE_ORDER: readonly ExportableStore[] = ['rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'settings', 'swimmerHistory', 'rosters'];
const SWIMCLOUD_STORES: readonly ExportableStore[] = ['swimmerHistory', 'rosters'];

type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExportOptions {
  /** Stores to include. `swimmerHistory` and `rosters` need `includeSwimCloudData`; `settings` needs `includeSettings`. */
  readonly stores: readonly ExportableStore[];
  readonly includeSwimCloudData: boolean;
  readonly includeSettings: boolean;
  /** Defaults to `chrome.runtime.getManifest().version`; throws when neither is available. */
  readonly extensionVersion?: string;
  /** Defaults to `new Date().toISOString()`. */
  readonly now?: () => IsoTime;
}

function manifestVersion(): string {
  const chromeApi = (globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: string } } } }).chrome;
  const version = chromeApi?.runtime?.getManifest?.().version;
  if (typeof version !== 'string' || version === '') {
    throw new RangeError('exportData: pass extensionVersion; chrome.runtime.getManifest() is not available here');
  }
  return version;
}

/** The lineup without its SwimCloud-derived parts: payload `display` and snapshot `results`. */
function withoutSwimCloudData(record: LineupRecord): LineupRecord {
  const { results: _results, ...rest } = record;
  return { ...rest, payload: stripSwimCloudData(record.payload as Lineup) };
}

export async function exportData(repo: StorageRepo, opts: ExportOptions): Promise<OmniSwimExportV1> {
  for (const store of opts.stores) {
    if (!EXPORT_STORE_ORDER.includes(store)) throw new RangeError(`exportData: ${String(store)} is not an exportable store`);
    if (SWIMCLOUD_STORES.includes(store) && !opts.includeSwimCloudData) {
      throw new RangeError(`exportData: ${store} is SwimCloud data; set includeSwimCloudData to export it`);
    }
    if (store === 'settings' && !opts.includeSettings) throw new RangeError('exportData: settings need includeSettings');
  }
  const stores: Record<string, readonly unknown[]> = {};
  // A requested store with no rows exports as [] (present and empty); a store not requested is absent.
  // One readonly transaction for every store, so no write lands between two reads and leaves a dangling reference.
  const wanted = EXPORT_STORE_ORDER.filter(store => opts.stores.includes(store));
  const read = await repo.listMany(wanted);
  for (const store of wanted) {
    const rows = read[store] ?? [];
    stores[store] = store === 'lineups' && !opts.includeSwimCloudData ? (rows as LineupRecord[]).map(withoutSwimCloudData) : rows;
  }
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: (opts.now ?? (() => new Date().toISOString()))(),
    extensionVersion: opts.extensionVersion ?? manifestVersion(),
    dbSchemaVersion: DB_VERSION,
    includesSwimCloudData: opts.includeSwimCloudData,
    stores,
  };
}

/* -------------------------------------------------------------------------- */
/* Import                                                                     */
/* -------------------------------------------------------------------------- */

export type OnConflict = 'keep-both' | 'replace' | 'skip';

export interface ImportOptions {
  readonly fileName: string;
  readonly onConflict: OnConflict;
  /** Defaults to `new Date().toISOString()`. */
  readonly now?: () => IsoTime;
  /** The id source for `keep-both`. Defaults to `crypto.randomUUID()`. */
  readonly newId?: () => string;
  /** Receives one notice after the import commits. */
  readonly bus?: ChangeBus;
}

export type SkipReason = 'exists' | 'snapshot-immutable' | 'kind-differs';

export interface ImportReport {
  readonly fileName: string;
  readonly formatVersion: number;
  readonly exportedAt: IsoTime;
  /** Records written, new or replaced, per store. */
  readonly written: Readonly<Partial<Record<ExportableStore, number>>>;
  /** Records that overwrote a stored record (`onConflict:'replace'`). */
  readonly replaced: readonly { readonly store: ExportableStore; readonly key: string }[];
  /** Records left out; the stored record stays. */
  readonly skipped: readonly { readonly store: ExportableStore; readonly key: string; readonly reason: SkipReason }[];
  /** Ids that `keep-both` changed. */
  readonly remapped: readonly { readonly store: IdStore; readonly from: string; readonly to: string }[];
}

/** Stores whose key is a generated id, so `keep-both` can mint a new one. */
type IdStore = 'rulePresets' | 'sessionPresets' | 'meets' | 'lineups';
const ID_FIELD: Readonly<Record<IdStore, string>> = { rulePresets: 'id', sessionPresets: 'id', meets: 'meetKey', lineups: 'lineupId' };
const ID_STORES = Object.keys(ID_FIELD) as IdStore[];

const ENVELOPE_KEYS = ['format', 'formatVersion', 'exportedAt', 'extensionVersion', 'dbSchemaVersion', 'includesSwimCloudData', 'stores'];

function isRow(v: unknown): v is Row {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/** Old export versions would be migrated here, oldest first. There is one format so far. */
function migrateExportFile(file: Row): Row {
  const version = file.formatVersion;
  if (version === EXPORT_FORMAT_VERSION) return file;
  throw new ImportValidationError([{ path: 'formatVersion', message: `no migration from export format ${String(version)}` }]);
}

function checkEnvelope(file: unknown): Row {
  if (!isRow(file)) throw new ImportValidationError([{ path: '$', message: 'expected a JSON object' }]);
  if (file.format !== EXPORT_FORMAT) throw new ImportValidationError([{ path: 'format', message: `expected "${EXPORT_FORMAT}"` }]);
  const version = file.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ImportValidationError([{ path: 'formatVersion', message: 'expected a whole number of 1 or more' }]);
  }
  if (version > EXPORT_FORMAT_VERSION) {
    throw new NewerExportError(`This file is export format ${version}. This version of OmniSwim reads up to ${EXPORT_FORMAT_VERSION}. Update the extension.`);
  }
  const migrated = migrateExportFile(file);
  const issues: ValidationIssue[] = [];
  for (const k of ENVELOPE_KEYS) if (!Object.hasOwn(migrated, k)) issues.push({ path: k, message: 'missing' });
  for (const k of Object.keys(migrated)) if (!ENVELOPE_KEYS.includes(k)) issues.push({ path: k, message: 'unknown key' });
  if (issues.length === 0) {
    if (!isStrictIsoInstant(migrated.exportedAt)) {
      issues.push({ path: 'exportedAt', message: 'not an ISO instant' });
    }
    if (typeof migrated.extensionVersion !== 'string' || migrated.extensionVersion === '') issues.push({ path: 'extensionVersion', message: 'expected a non-empty string' });
    if (typeof migrated.dbSchemaVersion !== 'number' || !Number.isInteger(migrated.dbSchemaVersion) || migrated.dbSchemaVersion < 1) {
      issues.push({ path: 'dbSchemaVersion', message: 'expected a whole number of 1 or more' });
    }
    if (typeof migrated.includesSwimCloudData !== 'boolean') issues.push({ path: 'includesSwimCloudData', message: 'expected true or false' });
    if (!isRow(migrated.stores)) issues.push({ path: 'stores', message: 'expected an object' });
  }
  if (issues.length > 0) throw new ImportValidationError(issues);
  if ((migrated.dbSchemaVersion as number) > DB_VERSION) {
    throw new NewerExportError(`This file was written for database version ${String(migrated.dbSchemaVersion)}. This version of OmniSwim uses ${DB_VERSION}. Update the extension.`);
  }
  return migrated;
}

/** Validate every record and the SwimCloud-data rule. Returns the records per store, or throws with every issue. */
function validateFile(file: Row): Map<ExportableStore, Row[]> {
  const issues: ValidationIssue[] = [];
  const stores = file.stores as Row;
  const includesSwimCloudData = file.includesSwimCloudData === true;
  const out = new Map<ExportableStore, Row[]>();

  for (const name of Object.keys(stores)) {
    if (!EXPORT_STORE_ORDER.includes(name as ExportableStore)) issues.push({ path: `stores.${name}`, message: 'unknown store' });
  }
  for (const store of EXPORT_STORE_ORDER) {
    const rows = stores[store];
    if (rows === undefined) continue;
    const base = `stores.${store}`;
    if (!Array.isArray(rows)) {
      issues.push({ path: base, message: 'expected a list' });
      continue;
    }
    if (!includesSwimCloudData && SWIMCLOUD_STORES.includes(store)) {
      issues.push({ path: base, message: 'SwimCloud data in a file that says includesSwimCloudData:false' });
      continue;
    }
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const path = `${base}[${i}]`;
      const found = validateRecord(store, row, path);
      if (found.length > 0) {
        issues.push(...found);
        return;
      }
      const record = row as Row;
      if (store === 'lineups' && !includesSwimCloudData) {
        if (Object.hasOwn(record, 'results')) issues.push({ path: `${path}.results`, message: 'SwimCloud data in a file that says includesSwimCloudData:false' });
        if (Object.hasOwn(record.payload as Row, 'display')) {
          issues.push({ path: `${path}.payload.display`, message: 'SwimCloud data in a file that says includesSwimCloudData:false' });
        }
      }
      const key = JSON.stringify(keyOf(store, record));
      if (seen.has(key)) issues.push({ path, message: `duplicate key ${key}` });
      seen.add(key);
    });
    out.set(store, rows as Row[]);
  }
  if (issues.length > 0) throw new ImportValidationError(issues);
  return out;
}

function keyOf(store: ExportableStore, record: Row): IDBValidKey {
  const keyPath = STORE_DEFS[store].keyPath;
  return (Array.isArray(keyPath) ? keyPath.map(k => record[k as string]) : record[keyPath as string]) as IDBValidKey;
}

type RawTx = IDBPTransaction<unknown, string[], 'readwrite'>;
type IdMap = Map<string, string>;
type IdMaps = Record<IdStore, IdMap>;

const emptyMaps = (): IdMaps => ({ rulePresets: new Map(), sessionPresets: new Map(), meets: new Map(), lineups: new Map() });

function remapRef(ref: unknown, map: IdMap): unknown {
  if (isRow(ref) && ref.kind === 'user' && typeof ref.id === 'string') {
    const to = map.get(ref.id);
    if (to !== undefined) return { ...ref, id: to };
  }
  return ref;
}

/** Step 1 (keep-both): a new id for each id-bearing record whose id is already stored. */
async function mintIds(tx: RawTx, byStore: Map<ExportableStore, Row[]>, newId: () => string): Promise<{ maps: IdMaps; remapped: ImportReport['remapped'] }> {
  const maps = emptyMaps();
  const remapped: { store: IdStore; from: string; to: string }[] = [];
  const taken = new Set<string>();
  for (const store of ID_STORES) for (const row of byStore.get(store) ?? []) taken.add(`${store}:${String(row[ID_FIELD[store]])}`);
  for (const store of ID_STORES) {
    if (!byStore.has(store)) continue;
    const os = tx.objectStore(store);
    for (const row of byStore.get(store) ?? []) {
      const id = row[ID_FIELD[store]] as string;
      if ((await os.get(id)) === undefined) continue;
      let candidate = newId();
      while (taken.has(`${store}:${candidate}`) || (await os.get(candidate)) !== undefined) candidate = newId();
      taken.add(`${store}:${candidate}`);
      maps[store].set(id, candidate);
      remapped.push({ store, from: id, to: candidate });
    }
  }
  return { maps, remapped };
}

/** Step 2a: the record with its own id and every reference replaced by the new ids. */
function rewriteIds(store: ExportableStore, row: Row, maps: IdMaps): Row {
  const r: Row = { ...row };
  if (store === 'rulePresets' || store === 'sessionPresets') {
    r.id = maps[store].get(r.id as string) ?? r.id;
  } else if (store === 'meets') {
    r.meetKey = maps.meets.get(r.meetKey as string) ?? r.meetKey;
    r.rulePreset = remapRef(r.rulePreset, maps.rulePresets);
    if (r.sessionPreset !== undefined) r.sessionPreset = remapRef(r.sessionPreset, maps.sessionPresets);
  } else if (store === 'tags') {
    r.meetKey = maps.meets.get(r.meetKey as string) ?? r.meetKey;
  } else if (store === 'lineups') {
    r.lineupId = maps.lineups.get(r.lineupId as string) ?? r.lineupId;
    r.meetKey = maps.meets.get(r.meetKey as string) ?? r.meetKey;
    r.payload = { ...(r.payload as Row), meetKey: r.meetKey };
    if (typeof r.parentLineupId === 'string') r.parentLineupId = maps.lineups.get(r.parentLineupId) ?? r.parentLineupId;
    const b: Row = { ...(r.builtUnder as Row) };
    b.rulePreset = remapRef(b.rulePreset, maps.rulePresets);
    if (b.sessionPreset !== undefined) b.sessionPreset = remapRef(b.sessionPreset, maps.sessionPresets);
    r.builtUnder = b;
  }
  return r;
}

/** Why a stored record stops an incoming one, or `null` when the incoming record may be written. */
function conflictSkip(store: ExportableStore, stored: Row, incoming: Row, onConflict: OnConflict): SkipReason | null {
  if (onConflict !== 'replace') return 'exists';
  if (store === 'lineups') {
    if (stored.kind === 'snapshot') return 'snapshot-immutable';
    if (stored.kind !== incoming.kind) return 'kind-differs';
  }
  return null;
}

interface Plan {
  readonly toWrite: { store: ExportableStore; record: Row }[];
  readonly replaced: { store: ExportableStore; key: string }[];
  readonly skipped: { store: ExportableStore; key: string; reason: SkipReason }[];
}

/** Step 2b: decide each record against what is stored, and set origin, rev and updatedAt. Writes nothing. */
async function planWrites(
  tx: RawTx,
  byStore: Map<ExportableStore, Row[]>,
  maps: IdMaps,
  ctx: { readonly onConflict: OnConflict; readonly origin: Row; readonly now: IsoTime }
): Promise<Plan> {
  const plan: Plan = { toWrite: [], replaced: [], skipped: [] };
  for (const store of EXPORT_STORE_ORDER) {
    for (const row of byStore.get(store) ?? []) {
      const r = rewriteIds(store, row, maps);
      const key = keyOf(store, r);
      const keyText = JSON.stringify(key);
      const stored = (await tx.objectStore(store).get(key)) as Row | undefined;
      let rev = 1;
      if (stored !== undefined) {
        const reason = conflictSkip(store, stored, r, ctx.onConflict);
        if (reason !== null) {
          plan.skipped.push({ store, key: keyText, reason });
          continue;
        }
        // A replace continues the stored rev, so a tab that read the old record still loses its next write.
        rev = ((stored.rev as number | undefined) ?? 0) + 1;
        plan.replaced.push({ store, key: keyText });
      }
      if (store !== 'swimmerHistory' && store !== 'rosters') {
        r.rev = rev;
        r.updatedAt = ctx.now;
      }
      if ('origin' in r) r.origin = ctx.origin;
      assertValidRecord(store, r);
      plan.toWrite.push({ store, record: r });
    }
  }
  return plan;
}

/** Step 3: write every planned record and bump `changeRev` once. `changeRev` is `undefined` when nothing was written. */
async function writePlan(tx: RawTx, plan: Plan): Promise<{ written: ImportReport['written']; changeRev: number | undefined }> {
  const written: Partial<Record<ExportableStore, number>> = {};
  for (const { store, record } of plan.toWrite) {
    await tx.objectStore(store).put(record);
    written[store] = (written[store] ?? 0) + 1;
  }
  if (plan.toWrite.length === 0) return { written, changeRev: undefined };
  const meta = tx.objectStore('meta');
  const row = (await meta.get('changeRev')) as MetaChangeRevRow | undefined;
  const changeRev = (row?.value ?? 0) + 1;
  await meta.put({ key: 'changeRev', value: changeRev } satisfies MetaChangeRevRow);
  return { written, changeRev };
}

export async function importData(db: IDBPDatabase<OmniDbSchema>, file: unknown, opts: ImportOptions): Promise<ImportReport> {
  const envelope = checkEnvelope(file);
  const byStore = validateFile(envelope);
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const exportedAt = envelope.exportedAt as IsoTime;

  const raw = db as unknown as IDBPDatabase<unknown>;
  const tx = raw.transaction([...byStore.keys(), 'meta'], 'readwrite') as unknown as RawTx;
  try {
    const minted = opts.onConflict === 'keep-both' ? await mintIds(tx, byStore, newId) : undefined;
    const origin = { kind: 'imported', fileName: opts.fileName, importedAt: now, exportedAt };
    const plan = await planWrites(tx, byStore, minted?.maps ?? emptyMaps(), { onConflict: opts.onConflict, origin, now });
    const { written, changeRev } = await writePlan(tx, plan);
    await tx.done;

    if (opts.bus && changeRev !== undefined) {
      try {
        await opts.bus.publish({ rev: changeRev, stores: [...new Set(plan.toWrite.map(w => w.store))], at: now });
      } catch {
        // A lost notice is not data loss (D3 5.3).
      }
    }
    return {
      fileName: opts.fileName,
      formatVersion: envelope.formatVersion as number,
      exportedAt,
      written,
      replaced: plan.replaced,
      skipped: plan.skipped,
      remapped: minted?.remapped ?? [],
    };
  } catch (error) {
    // Every check runs before the first write. Abort so a failure in the write step leaves nothing behind.
    tx.done.catch(() => undefined);
    try {
      tx.abort();
    } catch {
      // Already finished or aborted.
    }
    throw error;
  }
}
