/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * R51 (plans/2026-10-25/README.md): the class year comes from SwimCloud, and the user may override
 * it. The override is user data in its own store (`classYearOverrides`, key [swimmerId, seasonId]).
 * The sourced value is `RosterRecord.classYears`. A read gives the override, else the sourced
 * value with its source, else absent. Absent is never a default class year (D3 section 14).
 *
 * The user example: swimmer 1130590 transferred into Henderson State and is a senior, and SwimCloud
 * lists a different class year.
 */
import { describe, expect, it } from 'vitest';
import { validateRecord } from '../apps/extension/src/storage/validate';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { exportData, importData } from '../apps/extension/src/storage/exportImport';
import { readClassYear, resolveClassYear } from '../apps/extension/src/storage/classYear';
import { CLASS_YEARS, EDITED_STORES, STORE_DEFS, toSwimCloudId } from '../apps/extension/src/storage/schema';
import type { ClassYearCode, ClassYearOverrideRecord, RosterRecord } from '../apps/extension/src/storage/schema';
import { StaleWriteError } from '../apps/extension/src/storage/errors';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, removeAt, setAt, withoutRev } from './helpers/extensionRecords';

// A class year the engine reads but CLASS_YEARS lacks makes this line a type error (tsc over tests).
type MissingFromList = Exclude<ClassYearCode, (typeof CLASS_YEARS)[number]>;
const noneMissing: MissingFromList extends never ? true : false = true;

const SWIMMER = toSwimCloudId('1130590');
const TEAM = toSwimCloudId('48');
const SEASON = '26';
const SOURCE_URL = 'https://www.swimcloud.com/team/48/roster/?season_id=26';

const override = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  swimmerId: '1130590',
  seasonId: SEASON,
  classYear: 'SR',
  origin: { kind: 'local' },
  rev: 1,
  createdAt: '2026-10-26T13:00:00.000Z',
  updatedAt: '2026-10-26T13:00:00.000Z',
  ...over,
});
/** The fixture roster for team 48, with SwimCloud class years: 1130590 is listed as a junior. */
const roster = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...fixtureRecord('rosters'),
  memberIds: ['1001', '1002', '1130590'],
  classYears: { '1001': 'FR', '1130590': 'JR' },
  ...over,
});

async function newRepo() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('install') });
  return { db, repo: createStorageRepo(db, { now: steppingClock() }) };
}

const paths = (store: 'classYearOverrides' | 'rosters', record: unknown): string[] => validateRecord(store as never, record).map(i => i.path);

describe('R51 class year: the code list', () => {
  it('is the D2 list FR, SO, JR, SR, GR; HS (recruits) is not in it', () => {
    expect(noneMissing).toBe(true);
    expect([...CLASS_YEARS]).toEqual(['FR', 'SO', 'JR', 'SR', 'GR']);
  });
});

describe('R51 class year: validating the override record', () => {
  it('accepts an override for one swimmer in one season', () => {
    expect(validateRecord('classYearOverrides' as never, override())).toEqual([]);
  });

  it('is an edited store keyed by swimmer and season, with a season index', () => {
    expect(EDITED_STORES).toContain('classYearOverrides');
    expect(STORE_DEFS.classYearOverrides).toEqual({ keyPath: ['swimmerId', 'seasonId'], indexes: { bySeason: 'seasonId' } });
  });

  it('rejects a bad class year, including null (clear an override by deleting it) and HS', () => {
    for (const value of [null, 'HS', 'sr', 'Senior', 4, '']) expect(paths('classYearOverrides', override({ classYear: value })), String(value)).toEqual(['$.classYear']);
  });

  it('rejects a bad swimmer id and a missing season, key or origin', () => {
    for (const id of ['0123', 1130590, '', 'abc']) expect(paths('classYearOverrides', override({ swimmerId: id })), String(id)).toEqual(['$.swimmerId']);
    for (const key of ['seasonId', 'classYear', 'swimmerId', 'origin', 'rev', 'createdAt', 'updatedAt']) {
      expect(paths('classYearOverrides', removeAt(override(), [key])), key).toEqual([`$.${key}`]);
    }
    expect(paths('classYearOverrides', override({ extra: 1 }))).toEqual(['$.extra']);
  });
});

describe('R51 class year: validating the sourced map on a roster', () => {
  it('accepts a roster with class years for some of its members', () => {
    expect(validateRecord('rosters', roster())).toEqual([]);
    expect(validateRecord('rosters', fixtureRecord('rosters'))).toEqual([]);
  });

  it('rejects a class year for a swimmer who is not a member, a bad code, and a bad key', () => {
    expect(paths('rosters', roster({ classYears: { '9999': 'SR' } }))).toEqual(['$.classYears.9999']);
    expect(paths('rosters', roster({ classYears: { '1001': 'HS' } }))).toEqual(['$.classYears.1001']);
    expect(paths('rosters', roster({ classYears: { '01001': 'FR' } }))).toEqual(['$.classYears.01001']);
    expect(paths('rosters', roster({ classYears: null }))).toEqual(['$.classYears']);
    // An empty map is not "no class years": leave the key out.
    expect(paths('rosters', roster({ classYears: {} }))).toEqual(['$.classYears']);
  });

  it('rejects class years on a verified-empty roster', () => {
    expect(paths('rosters', { ...roster(), memberIds: [], verifiedEmpty: true })).toEqual(['$.classYears.1001']);
  });
});

describe('R51 class year: what a read gives', () => {
  const ov = override() as unknown as ClassYearOverrideRecord;
  const ro = roster() as unknown as RosterRecord;

  it('the override wins over the sourced value, and says it is the user value with its rev and time', () => {
    expect(resolveClassYear({ swimmerId: SWIMMER, seasonId: SEASON, override: ov, roster: ro })).toEqual({
      state: 'user',
      classYear: 'SR',
      rev: 1,
      updatedAt: '2026-10-26T13:00:00.000Z',
    });
  });

  it('with no override, the sourced value comes back with its source and fetch time', () => {
    expect(resolveClassYear({ swimmerId: SWIMMER, seasonId: SEASON, roster: ro })).toEqual({
      state: 'sourced',
      classYear: 'JR',
      sourceUrl: SOURCE_URL,
      fetchedAt: '2026-10-26T12:00:00.000Z',
    });
  });

  it('with neither, it is absent: no default class year', () => {
    expect(resolveClassYear({ swimmerId: SWIMMER, seasonId: SEASON })).toEqual({ state: 'absent' });
    // A roster that lists the swimmer but carries no class year for them.
    expect(resolveClassYear({ swimmerId: toSwimCloudId('1002'), seasonId: SEASON, roster: ro })).toEqual({ state: 'absent' });
    // A roster written before R51 has no map at all.
    expect(resolveClassYear({ swimmerId: toSwimCloudId('1001'), seasonId: SEASON, roster: fixtureRecord('rosters') as unknown as RosterRecord })).toEqual({
      state: 'absent',
    });
  });

  it('refuses inputs for another swimmer or another season instead of returning their value', () => {
    expect(() => resolveClassYear({ swimmerId: SWIMMER, seasonId: '27', roster: ro })).toThrow(RangeError);
    expect(() => resolveClassYear({ swimmerId: SWIMMER, seasonId: SEASON, override: { ...ov, swimmerId: toSwimCloudId('1001') } })).toThrow(RangeError);
    expect(() => resolveClassYear({ swimmerId: SWIMMER, seasonId: '27', override: ov })).toThrow(RangeError);
  });

  it('through the repo: user override, then sourced after the override is deleted, then absent with no roster', async () => {
    const { db, repo } = await newRepo();
    const q = { swimmerId: SWIMMER, seasonId: SEASON, teamId: TEAM, gender: 'Women' as const };
    expect(await readClassYear(repo, q)).toEqual({ state: 'absent' });

    await repo.putCache('rosters', ro);
    expect(await readClassYear(repo, q)).toMatchObject({ state: 'sourced', classYear: 'JR' });

    const saved = await repo.put('classYearOverrides', withoutRev(ov) as never, 'new');
    expect(saved.rev).toBe(1);
    expect(await readClassYear(repo, q)).toMatchObject({ state: 'user', classYear: 'SR', rev: 1 });

    // A refetch replaces the roster row. The override is in another store, so it survives.
    await repo.putCache('rosters', roster({ classYears: { '1130590': 'SO' }, fetchedAt: '2026-10-27T09:00:00.000Z' }) as unknown as RosterRecord);
    expect(await readClassYear(repo, q)).toMatchObject({ state: 'user', classYear: 'SR' });

    await repo.delete('classYearOverrides', ['1130590', SEASON], saved.rev);
    expect(await readClassYear(repo, q)).toEqual({
      state: 'sourced',
      classYear: 'SO',
      sourceUrl: SOURCE_URL,
      fetchedAt: '2026-10-27T09:00:00.000Z',
    });
    db.close();
  });

  it('an override is for one season: the next season does not inherit it', async () => {
    const { db, repo } = await newRepo();
    await repo.put('classYearOverrides', withoutRev(ov) as never, 'new');
    const next = await readClassYear(repo, { swimmerId: SWIMMER, seasonId: '27', teamId: TEAM, gender: 'Women' });
    expect(next).toEqual({ state: 'absent' });
    db.close();
  });
});

describe('R51 class year: writes', () => {
  it('put sets rev and updatedAt, an update needs the rev it read, and a stale write is refused', async () => {
    const { db, repo } = await newRepo();
    const first = await repo.put('classYearOverrides', withoutRev(override()) as never, 'new');
    expect(first.rev).toBe(1);
    await expect(repo.put('classYearOverrides', withoutRev(override()) as never, 'new')).rejects.toBeInstanceOf(StaleWriteError);
    const second = await repo.put('classYearOverrides', withoutRev(override({ classYear: 'GR' })) as never, first.rev);
    expect(second).toMatchObject({ rev: 2, classYear: 'GR', createdAt: first.createdAt });
    expect(second.updatedAt).not.toBe(first.updatedAt);
    await expect(repo.put('classYearOverrides', withoutRev(override({ classYear: 'FR' })) as never, first.rev)).rejects.toBeInstanceOf(StaleWriteError);
    expect((await repo.list('classYearOverrides', { index: 'bySeason', value: SEASON })).map(r => r.classYear)).toEqual(['GR']);
    expect(await repo.list('classYearOverrides', { index: 'bySeason', value: '27' })).toEqual([]);
    db.close();
  });

  it('put refuses an invalid override and writes nothing', async () => {
    const { db, repo } = await newRepo();
    await expect(repo.put('classYearOverrides', withoutRev(setAt(override(), ['classYear'], 'HS')) as never, 'new')).rejects.toThrow(/classYear/);
    expect(await repo.list('classYearOverrides')).toEqual([]);
    db.close();
  });
});

describe('R51 class year: export and import', () => {
  const opts = { includeSettings: false, extensionVersion: '0.1.0', now: () => '2026-10-28T00:00:00.000Z' } as const;
  const envelope = {
    format: 'omniswim-export',
    formatVersion: 1,
    exportedAt: '2026-10-28T00:00:00.000Z',
    extensionVersion: '0.1.0',
    dbSchemaVersion: 2,
    includesSwimCloudData: false,
  };

  it('the default export carries the override (user data) and no sourced class years', async () => {
    const a = await newRepo();
    await a.repo.putCache('rosters', roster() as unknown as RosterRecord);
    await a.repo.put('classYearOverrides', withoutRev(override()) as never, 'new');
    const file = JSON.parse(JSON.stringify(await exportData(a.repo, { ...opts, stores: ['rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides'], includeSwimCloudData: false }))) as {
      stores: Record<string, Record<string, unknown>[]>;
    };
    expect(Object.keys(file.stores)).toEqual(['rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides']);
    expect(file.stores.classYearOverrides).toHaveLength(1);
    expect(file.stores.classYearOverrides?.[0]).toMatchObject({ swimmerId: '1130590', seasonId: SEASON, classYear: 'SR' });
    expect(JSON.stringify(file)).not.toContain('classYears');
    a.db.close();
  });

  it('round-trips the override and the sourced map, and marks the imported override as imported', async () => {
    const a = await newRepo();
    await a.repo.putCache('rosters', roster() as unknown as RosterRecord);
    await a.repo.put('classYearOverrides', withoutRev(override()) as never, 'new');
    const file = JSON.parse(JSON.stringify(await exportData(a.repo, { ...opts, stores: ['rosters', 'classYearOverrides'], includeSwimCloudData: true })));
    a.db.close();

    const b = await newRepo();
    await importData(b.db, file, { fileName: 'backup.json', onConflict: 'keep-both', now: () => '2026-10-28T01:00:00.000Z' });
    expect(await b.repo.list('rosters')).toEqual([roster()]);
    const [imported] = await b.repo.list('classYearOverrides');
    expect(imported).toMatchObject({ swimmerId: '1130590', seasonId: SEASON, classYear: 'SR', rev: 1, updatedAt: '2026-10-28T01:00:00.000Z' });
    expect(imported?.origin).toEqual({ kind: 'imported', fileName: 'backup.json', importedAt: '2026-10-28T01:00:00.000Z', exportedAt: '2026-10-28T00:00:00.000Z' });
    b.db.close();
  });

  it('a conflicting override is kept by default and replaced only on request, continuing the stored rev', async () => {
    const a = await newRepo();
    await a.repo.put('classYearOverrides', withoutRev(override({ classYear: 'GR' })) as never, 'new');
    const file = JSON.parse(JSON.stringify(await exportData(a.repo, { ...opts, stores: ['rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides'], includeSwimCloudData: false })));
    a.db.close();

    const b = await newRepo();
    const mine = await b.repo.put('classYearOverrides', withoutRev(override({ classYear: 'SR' })) as never, 'new');
    const kept = await importData(b.db, file, { fileName: 'f.json', onConflict: 'keep-both' });
    expect(kept.skipped).toEqual([{ store: 'classYearOverrides', key: '["1130590","26"]', reason: 'exists' }]);
    expect((await b.repo.list('classYearOverrides'))[0]?.classYear).toBe('SR');

    const replaced = await importData(b.db, file, { fileName: 'f.json', onConflict: 'replace' });
    expect(replaced.replaced).toHaveLength(1);
    expect((await b.repo.list('classYearOverrides'))[0]).toMatchObject({ classYear: 'GR', rev: mine.rev + 1 });
    b.db.close();
  });

  it('refuses a file with a bad override and imports nothing', async () => {
    const b = await newRepo();
    const file = { ...envelope, stores: { classYearOverrides: [override({ classYear: 'HS' })] } };
    await expect(importData(b.db, file, { fileName: 'bad.json', onConflict: 'keep-both' })).rejects.toThrow(/stores\.classYearOverrides\[0\]\.classYear/);
    expect(await b.repo.list('classYearOverrides')).toEqual([]);
    b.db.close();
  });

  it('refuses a file that says includesSwimCloudData:false but carries rosters with sourced class years', async () => {
    const b = await newRepo();
    const file = { ...envelope, stores: { rosters: [roster()] } };
    await expect(importData(b.db, file, { fileName: 'bad.json', onConflict: 'keep-both' })).rejects.toThrow(/stores\.rosters/);
    b.db.close();
  });
});
