/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * IndexedDB schema v1 for the OmniSwim extension
 * (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.2).
 *
 * Only extension pages and the service worker may open this database. A content script runs as
 * swimcloud.com and would open SwimCloud's own IndexedDB (D3 decision 0.2), so no content-script
 * entry may import this folder. `tests/extensionBundleBoundaries.test.ts` (T-B6) enforces that.
 *
 * Absent is never empty (CLAUDE.md, data provenance): a record that was never fetched or never set
 * has no row. No type here has a default that stands in for a missing competition value.
 */
import type { DBSchema, IndexNames, StoreKey, StoreNames, StoreValue } from 'idb';
import type { Gender, IsoTime as EngineIsoTime, Lineup, RulePreset, SessionPreset } from '@omniswim/engine';

export const DB_NAME = 'omniswim';
export const DB_VERSION = 1;
/** The version of the D2 type shapes (`RulePreset`, `SessionPreset`, `Lineup`) a record holds. */
export const PAYLOAD_VERSION = 1;

/** SwimCloud numeric id kept as a string. 123 and '123' are DIFFERENT IndexedDB keys. */
export type SwimCloudId = string & { readonly __brand: 'SwimCloudId' };

const SWIMCLOUD_ID = /^[1-9][0-9]*$/;

/** Throws unless `raw` is a string of digits with no leading zero (`/^[1-9][0-9]*$/`). */
export function toSwimCloudId(raw: string): SwimCloudId {
  // RegExp#test coerces its argument, so 123 would pass the pattern. Check the type first.
  if (typeof raw !== 'string' || !SWIMCLOUD_ID.test(raw)) {
    throw new RangeError(`toSwimCloudId: ${JSON.stringify(raw)} is not a SwimCloud id (a string matching ${SWIMCLOUD_ID.source})`);
  }
  return raw as SwimCloudId;
}

/** `Date#toISOString()` form. Never a `Date`. */
export type IsoTime = EngineIsoTime;
/** 1 on create, +1 per write. */
export type Rev = number;

export type RecordOrigin =
  | { readonly kind: 'local' }
  | { readonly kind: 'imported'; readonly fileName: string; readonly importedAt: IsoTime; readonly exportedAt: IsoTime };

export type PresetRef =
  | { readonly kind: 'builtin'; readonly id: string; readonly version: number }
  | { readonly kind: 'user'; readonly id: string };

interface Versioned<P> {
  readonly payloadVersion: number;
  readonly payload: P;
}
interface Edited {
  readonly rev: Rev;
  readonly createdAt: IsoTime;
  readonly updatedAt: IsoTime;
}

export interface RulePresetRecord extends Versioned<RulePreset>, Edited {
  readonly id: string;
  readonly name: string;
  readonly origin: RecordOrigin;
  readonly derivedFrom?: { readonly builtinId: string; readonly builtinVersion: number };
}
export interface SessionPresetRecord extends Versioned<SessionPreset>, Edited {
  readonly id: string;
  readonly name: string;
  readonly origin: RecordOrigin;
  readonly derivedFrom?: { readonly builtinId: string; readonly builtinVersion: number };
}
export interface MeetRecord extends Edited {
  readonly meetKey: string;
  readonly name: string;
  readonly gender: Gender;
  readonly teamIds: readonly SwimCloudId[];
  /** Observed query string. Absent if unknown. */
  readonly simulatorQuery?: string;
  readonly rulePreset: PresetRef;
  readonly sessionPreset?: PresetRef;
  readonly origin: RecordOrigin;
}
export interface TagRecord {
  readonly meetKey: string;
  readonly teamId: SwimCloudId;
  readonly swimmerId: SwimCloudId;
  /** No `'auto'`: auto means no record. */
  readonly role: 'scorer' | 'non-scorer' | 'exhibition';
  readonly rev: Rev;
  readonly updatedAt: IsoTime;
}
export interface LineupRecord extends Versioned<Lineup>, Edited {
  readonly lineupId: string;
  readonly meetKey: string;
  readonly name: string;
  /** A snapshot is immutable after create. */
  readonly kind: 'lineup' | 'snapshot';
  readonly parentLineupId?: string;
  readonly origin: RecordOrigin;
  readonly builtUnder: {
    readonly rulePreset: PresetRef;
    readonly rulePresetRev?: Rev;
    readonly rulePresetValues: RulePreset;
    readonly sessionPreset?: PresetRef;
    readonly sessionPresetRev?: Rev;
    readonly sessionPresetValues?: SessionPreset;
  };
  /** Snapshot only. SwimCloud-derived (D2 Results). */
  readonly results?: unknown;
}
/** The payload type is fixed in P4. */
export interface SwimmerHistoryRecord extends Versioned<unknown> {
  readonly swimmerId: SwimCloudId;
  readonly fetchedAt: IsoTime;
  readonly sourceUrl: string;
  readonly parser: { readonly name: string; readonly confidence: string; readonly warnings: readonly string[] };
}
export interface RosterRecord {
  readonly teamId: SwimCloudId;
  readonly seasonId: string;
  readonly gender: Gender;
  readonly memberIds: readonly SwimCloudId[];
  readonly sourceUrl: string;
  readonly fetchedAt: IsoTime;
  readonly parser: { readonly name: string; readonly confidence: string };
}
export interface SettingsMap {
  /** Default `'light'`. */
  theme: 'light' | 'dark' | 'system';
  /** No default. Absent means the SwimCloud-sampled accent. */
  accent: string;
  /** Default 1.0 (R11, user-stated). */
  cutCloseThresholdPct: number;
  /** NO default (R14). Absent until the user sets it. */
  flyoverAllowanceSec: number;
  /** Default `'off'` (R7: extra fetches are not approved). */
  fetchPosture: 'off' | 'on-click';
}
export interface SettingRecord<K extends keyof SettingsMap = keyof SettingsMap> {
  readonly key: K;
  readonly value: SettingsMap[K];
  readonly rev: Rev;
  readonly updatedAt: IsoTime;
}

/**
 * Defaults live in code and are never written at install. Every key except `flyoverAllowanceSec`
 * and `accent`: no source states a value for those two.
 */
export const SETTINGS_DEFAULTS: Readonly<Partial<SettingsMap>> = Object.freeze({
  theme: 'light',
  cutCloseThresholdPct: 1.0,
  fetchPosture: 'off',
});

/** The `meta` row `{key:'db'}`. */
export interface MetaDbRow {
  readonly key: 'db';
  readonly schemaVersion: number;
  readonly createdAt: IsoTime;
  /** A random UUID that never leaves the browser. */
  readonly installId: string;
  readonly migrationLog: readonly { readonly from: number; readonly to: number; readonly at: IsoTime }[];
}
/** The `meta` row `{key:'changeRev'}`. */
export interface MetaChangeRevRow {
  readonly key: 'changeRev';
  readonly value: number;
}

export interface OmniDbSchema extends DBSchema {
  meta: { key: string; value: { key: string; [k: string]: unknown } };
  settings: { key: keyof SettingsMap; value: SettingRecord };
  rulePresets: { key: string; value: RulePresetRecord; indexes: { byName: string } };
  sessionPresets: { key: string; value: SessionPresetRecord; indexes: { byName: string } };
  meets: { key: string; value: MeetRecord; indexes: { byUpdatedAt: string } };
  tags: { key: [string, string, string]; value: TagRecord; indexes: { byMeet: string } };
  lineups: { key: string; value: LineupRecord; indexes: { byMeet: string; byUpdatedAt: string } };
  swimmerHistory: { key: string; value: SwimmerHistoryRecord; indexes: { byFetchedAt: string } };
  rosters: { key: [string, string, string]; value: RosterRecord; indexes: { byFetchedAt: string } };
}

/** Every store, in the order a v1 database creates them. */
export const STORE_NAMES = ['meta', 'settings', 'rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'swimmerHistory', 'rosters'] as const;
export type StoreName = (typeof STORE_NAMES)[number];
/** Every store except `meta`. */
export type UserStore = Exclude<StoreName, 'meta'>;
/** Stores whose records carry `rev` and go through optimistic writes. */
export type EditedStore = Exclude<UserStore, 'swimmerHistory' | 'rosters'>;
/** Fetched-data caches. No `rev`: a later fetch replaces the row. */
export type CacheStore = 'swimmerHistory' | 'rosters';
export type ExportableStore = UserStore;

export const USER_STORES: readonly UserStore[] = ['settings', 'rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'swimmerHistory', 'rosters'];
export const EDITED_STORES: readonly EditedStore[] = ['settings', 'rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups'];
export const CACHE_STORES: readonly CacheStore[] = ['swimmerHistory', 'rosters'];

export type KeyOf<S extends StoreName> = StoreKey<OmniDbSchema, S & StoreNames<OmniDbSchema>>;
export type ValueOf<S extends StoreName> = StoreValue<OmniDbSchema, S & StoreNames<OmniDbSchema>>;
export type IndexOf<S extends StoreName> = IndexNames<OmniDbSchema, S & StoreNames<OmniDbSchema>>;

/** What a v1 database holds. `createV1Stores` and the dump helper read this one table. */
export const STORE_DEFS: Readonly<
  Record<StoreName, { readonly keyPath: string | readonly string[]; readonly indexes: Readonly<Record<string, string>> }>
> = {
  meta: { keyPath: 'key', indexes: {} },
  settings: { keyPath: 'key', indexes: {} },
  rulePresets: { keyPath: 'id', indexes: { byName: 'name' } },
  sessionPresets: { keyPath: 'id', indexes: { byName: 'name' } },
  meets: { keyPath: 'meetKey', indexes: { byUpdatedAt: 'updatedAt' } },
  tags: { keyPath: ['meetKey', 'teamId', 'swimmerId'], indexes: { byMeet: 'meetKey' } },
  lineups: { keyPath: 'lineupId', indexes: { byMeet: 'meetKey', byUpdatedAt: 'updatedAt' } },
  swimmerHistory: { keyPath: 'swimmerId', indexes: { byFetchedAt: 'fetchedAt' } },
  rosters: { keyPath: ['teamId', 'seasonId', 'gender'], indexes: { byFetchedAt: 'fetchedAt' } },
};
