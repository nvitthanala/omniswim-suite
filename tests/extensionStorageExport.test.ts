/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 5.6, T-E1 to T-E8: export and import of the extension's data.
 * Each test gets a fresh fake-indexeddb factory (tests/helpers/extensionDb.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { exportData, importData, EXPORT_STORE_ORDER } from '../apps/extension/src/storage/exportImport';
import type { OmniSwimExportV1 } from '../apps/extension/src/storage/exportImport';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { readChangeRev, createMemoryChangeBus } from '../apps/extension/src/storage/changeBus';
import { ImportValidationError, InvalidRecordError, NewerExportError, SnapshotImmutableError, StaleWriteError } from '../apps/extension/src/storage/errors';
import { DB_VERSION, toSwimCloudId, USER_STORES } from '../apps/extension/src/storage/schema';
import type { ExportableStore, LineupRecord, MeetRecord, RulePresetRecord } from '../apps/extension/src/storage/schema';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, fixtureRecords, hasFixtureStore, removeAt, seedFromFixture, setAt, withoutRev } from './helpers/extensionRecords';

async function newDb() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('install') });
  const repo = createStorageRepo(db, { now: steppingClock() });
  return { db, repo };
}

const ALL_STORES: readonly ExportableStore[] = [...EXPORT_STORE_ORDER];
const FULL = { stores: ALL_STORES, includeSwimCloudData: true, includeSettings: true, extensionVersion: '0.1.0', now: () => '2026-10-28T00:00:00.000Z' } as const;
const DEFAULT = {
  // D3 14: classYearOverrides is user data, so the default export carries it.
  stores: ['rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides'] as ExportableStore[],
  includeSwimCloudData: false,
  includeSettings: false,
  extensionVersion: '0.1.0',
  now: () => '2026-10-28T00:00:00.000Z',
} as const;

/** What a file looks like after it left the browser. */
const asFile = (x: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(x));

async function exported(options: typeof FULL | typeof DEFAULT = FULL) {
  const { db, repo } = await newDb();
  await seedFromFixture(repo);
  const file = await exportData(repo, options);
  db.close();
  return asFile(file);
}

async function dumpStores(repo: ReturnType<typeof createStorageRepo>) {
  const out: Record<string, unknown[]> = {};
  for (const store of USER_STORES) out[store] = await repo.list(store);
  return out;
}

/** Drop what an import rewrites: the file's exportedAt, and each record's origin, rev and updatedAt. */
function normalized(file: OmniSwimExportV1): unknown {
  const stores: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(file.stores)) {
    stores[name] = (rows as unknown as Record<string, unknown>[]).map(r => {
      const { origin: _o, rev: _r, updatedAt: _u, ...rest } = r;
      return rest;
    });
  }
  const { exportedAt: _e, ...head } = file;
  return { ...head, stores };
}

function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, into));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}

describe('extension storage export and import (D3 5.6)', () => {
  it('T-E1: a round trip with includeSwimCloudData:true gives the same export, ignoring exportedAt, origin, rev and updatedAt', async () => {
    const first = await exported(FULL);
    const total = Object.values(first.stores as Record<string, unknown[]>).reduce((n, rows) => n + rows.length, 0);
    expect(total).toBe(13);

    const { db, repo } = await newDb();
    const report = await importData(db, first, { fileName: 'backup.json', onConflict: 'keep-both', now: () => '2026-10-28T01:00:00.000Z' });
    expect(Object.values(report.written).reduce((n, c) => n + c, 0)).toBe(13);
    expect(report.skipped).toEqual([]);
    const second = asFile(await exportData(repo, { ...FULL, now: () => '2026-10-28T02:00:00.000Z' })) as unknown as OmniSwimExportV1;

    expect(normalized(second)).toEqual(normalized(first as unknown as OmniSwimExportV1));
    // The two things the round trip must not touch.
    const settings = (second.stores.settings ?? []) as readonly { key: string }[];
    expect(settings.map(s => s.key)).toEqual(['fetchPosture', 'theme']);
    expect(settings.some(s => s.key === 'flyoverAllowanceSec')).toBe(false);
    const presets = second.stores.rulePresets as RulePresetRecord[];
    const edited = presets.find(p => p.id === 'rp-2');
    const total8 = edited?.payload.entries.maxTotalPerSwimmer;
    expect(total8 && total8.state === 'set' && total8.value).toBe('unlimited');
    // Imported records say where they came from.
    const meet = (second.stores.meets as MeetRecord[])[0];
    expect(meet?.origin).toEqual({ kind: 'imported', fileName: 'backup.json', importedAt: '2026-10-28T01:00:00.000Z', exportedAt: '2026-10-28T00:00:00.000Z' });
    expect(meet?.rev).toBe(1);
    db.close();
  });

  it('T-E2: the default export has no swimmerHistory, rosters, results or display, and carries no SwimCloud names', async () => {
    // Non-vacuous: the stored data does have all four.
    const { db, repo } = await newDb();
    await seedFromFixture(repo);
    const stored = await repo.list('lineups');
    expect(stored.some(l => 'results' in l)).toBe(true);
    expect(stored.some(l => 'display' in l.payload)).toBe(true);
    expect((await repo.list('swimmerHistory')).length).toBeGreaterThan(0);
    expect((await repo.list('rosters')).length).toBeGreaterThan(0);

    const file = asFile(await exportData(repo, DEFAULT));
    expect(file.includesSwimCloudData).toBe(false);
    expect(Object.keys(file.stores as object)).toEqual(['rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides']);
    const keys = keysDeep(file);
    for (const banned of ['swimmerHistory', 'rosters', 'results', 'display']) expect(keys.has(banned), banned).toBe(false);
    const text = JSON.stringify(file);
    for (const name of ['Fixture Swimmer One', 'Fixture Team', 'synthetic']) expect(text, name).not.toContain(name);
    // Ids, events and roles stay.
    const lineups = (file.stores as { lineups: LineupRecord[] }).lineups;
    expect(lineups.map(l => l.lineupId)).toEqual(['l-1', 'l-2']);
    expect(lineups[0]?.payload.entries).toHaveLength(2);
    expect((file.stores as { tags: { role: string }[] }).tags.map(t => t.role)).toEqual(['scorer', 'exhibition']);
    // The repo's own data is unchanged by the export.
    expect((await repo.list('lineups')).some(l => 'results' in l)).toBe(true);

    // Asking for SwimCloud data or settings without the matching switch is an error, not a quiet omission.
    await expect(exportData(repo, { ...DEFAULT, stores: ['rosters'] })).rejects.toThrow(RangeError);
    await expect(exportData(repo, { ...DEFAULT, stores: ['settings'] })).rejects.toThrow(RangeError);
    // A requested store with no rows is present and empty; a store not requested is absent.
    const empty = await newDb();
    const emptyFile = asFile(await exportData(empty.repo, { ...DEFAULT, stores: ['meets'] }));
    expect(emptyFile.stores).toEqual({ meets: [] });
    empty.db.close();
    db.close();

    // The default export imports cleanly into an empty database.
    const target = await newDb();
    await importData(target.db, file, { fileName: 'default.json', onConflict: 'keep-both' });
    expect((await target.repo.list('lineups')).every(l => !('results' in l) && !('display' in l.payload))).toBe(true);
    target.db.close();
  });

  it('T-E3: one invalid record in the last store imports nothing, and the error names its JSON path', async () => {
    const file = await exported(FULL);
    const stores = file.stores as Record<string, Record<string, unknown>[]>;
    const roster = fixtureRecord('rosters');
    stores.rosters?.push({ ...roster, teamId: '58', memberIds: [] });
    const { db, repo } = await newDb();
    const bus = createMemoryChangeBus();
    const notices: unknown[] = [];
    bus.subscribe(n => notices.push(n));

    const error = await importData(db, file, { fileName: 'bad.json', onConflict: 'keep-both', bus }).catch(e => e as unknown);
    expect(error).toBeInstanceOf(ImportValidationError);
    expect((error as ImportValidationError).issues.map(i => i.path)).toEqual(['stores.rosters[1].memberIds']);
    const after = await dumpStores(repo);
    for (const store of USER_STORES) expect(after[store], store).toEqual([]);
    expect(await readChangeRev(db)).toBe(0);
    expect(notices).toEqual([]);

    // Every bad record is listed, not only the first.
    stores.rulePresets = [removeAt(stores.rulePresets?.[0] as Record<string, unknown>, ['name']), ...(stores.rulePresets?.slice(1) ?? [])];
    const both = await importData(db, file, { fileName: 'bad.json', onConflict: 'keep-both' }).catch(e => e as ImportValidationError);
    expect((both as ImportValidationError).issues.map(i => i.path)).toEqual(['stores.rulePresets[0].name', 'stores.rosters[1].memberIds']);
    db.close();
  });

  it('T-E3: a write that fails part way leaves no store changed (one transaction)', async () => {
    const file = await exported(FULL);
    const { db, repo } = await newDb();
    const real = IDBObjectStore.prototype.put;
    let calls = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: unknown, ...args: Parameters<typeof real>) {
      calls += 1;
      if (calls === 7) throw new Error('disk full');
      return real.apply(this as never, args);
    });
    try {
      await expect(importData(db, file, { fileName: 'x.json', onConflict: 'keep-both' })).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThanOrEqual(7);
    const after = await dumpStores(repo);
    for (const store of USER_STORES) expect(after[store], store).toEqual([]);
    db.close();
  });

  it('T-E4: keep-both gives every conflicting id a new id and remaps every reference in the file', async () => {
    const file = await exported(FULL);
    const { db, repo } = await newDb();
    await seedFromFixture(repo);
    const report = await importData(db, file, { fileName: 'copy.json', onConflict: 'keep-both', newId: sequentialIds('new') });

    expect(report.remapped.map(r => `${r.store}:${r.from}->${r.to}`).sort()).toEqual(
      [
        'lineups:l-1->new-6',
        'lineups:l-2->new-7',
        'meets:m-1->new-4',
        'meets:m-2->new-5',
        'rulePresets:rp-1->new-1',
        'rulePresets:rp-2->new-2',
        'sessionPresets:sp-1->new-3',
      ].sort()
    );
    // Natural-key stores cannot mint an id: the stored settings and caches stay and the file's copies are skipped.
    expect(report.skipped.map(s => s.store).sort()).toEqual(['rosters', 'settings', 'settings', 'swimmerHistory']);
    expect(report.skipped.every(s => s.reason === 'exists')).toBe(true);

    const rulePresets = (await repo.list('rulePresets')) as RulePresetRecord[];
    const meets = (await repo.list('meets')) as MeetRecord[];
    const lineups = (await repo.list('lineups')) as LineupRecord[];
    const tags = await repo.list('tags');
    expect(rulePresets).toHaveLength(4);
    expect(meets).toHaveLength(4);
    expect(lineups).toHaveLength(4);
    expect(tags).toHaveLength(4);

    // No dangling reference anywhere.
    const userPresetIds = new Set(rulePresets.map(p => p.id));
    const sessionIds = new Set((await repo.list('sessionPresets')).map(p => p.id));
    const meetKeys = new Set(meets.map(m => m.meetKey));
    const lineupIds = new Set(lineups.map(l => l.lineupId));
    for (const m of meets) {
      if (m.rulePreset.kind === 'user') expect(userPresetIds.has(m.rulePreset.id), `${m.meetKey}.rulePreset`).toBe(true);
      if (m.sessionPreset?.kind === 'user') expect(sessionIds.has(m.sessionPreset.id), `${m.meetKey}.sessionPreset`).toBe(true);
    }
    for (const t of tags) expect(meetKeys.has(t.meetKey), `tag ${t.meetKey}`).toBe(true);
    for (const l of lineups) {
      expect(meetKeys.has(l.meetKey), `${l.lineupId}.meetKey`).toBe(true);
      expect(l.payload.meetKey).toBe(l.meetKey);
      if (l.parentLineupId !== undefined) expect(lineupIds.has(l.parentLineupId), `${l.lineupId}.parent`).toBe(true);
      if (l.builtUnder.rulePreset.kind === 'user') expect(userPresetIds.has(l.builtUnder.rulePreset.id)).toBe(true);
    }
    // The imported copies point at the imported copies, not at the originals.
    const copyMeet = meets.find(m => m.meetKey === 'new-4');
    expect(copyMeet?.rulePreset).toEqual({ kind: 'user', id: 'new-1' });
    const copyLineup = lineups.find(l => l.lineupId === 'new-7');
    expect(copyLineup?.parentLineupId).toBe('new-6');
    expect(copyLineup?.meetKey).toBe('new-4');
    expect(copyLineup?.builtUnder.rulePreset).toEqual({ kind: 'user', id: 'new-1' });
    expect(tags.filter(t => t.meetKey === 'new-4')).toHaveLength(2);
    // The originals are untouched.
    expect(meets.find(m => m.meetKey === 'm-1')?.rulePreset).toEqual({ kind: 'user', id: 'rp-1' });
    db.close();
  });

  it('T-E4: only the conflicting preset id changes; a record that did not conflict keeps its id', async () => {
    const { db, repo } = await newDb();
    const mine = withoutRev(fixtureRecord<Record<string, unknown>>('rulePresets', 0));
    await repo.put('rulePresets', { ...mine, name: 'Mine' } as never, 'new');
    const file = await exported(FULL);
    // Keep the file small: one preset that conflicts, the meet that uses it, and a lineup under it.
    const stores = file.stores as Record<string, Record<string, unknown>[]>;
    const narrowed = { ...file, stores: { rulePresets: stores.rulePresets?.slice(0, 1), meets: stores.meets?.slice(0, 1), lineups: stores.lineups?.slice(0, 1) } };
    const report = await importData(db, narrowed, { fileName: 'one.json', onConflict: 'keep-both', newId: sequentialIds('n') });
    expect(report.remapped).toEqual([{ store: 'rulePresets', from: 'rp-1', to: 'n-1' }]);
    const presets = (await repo.list('rulePresets')) as RulePresetRecord[];
    expect(presets.map(p => [p.id, p.name])).toEqual([
      ['n-1', 'NSISC copy'],
      ['rp-1', 'Mine'],
    ]);
    const meet = (await repo.get('meets', 'm-1')) as { found: true; value: MeetRecord };
    expect(meet.value.rulePreset).toEqual({ kind: 'user', id: 'n-1' });
    const lineup = (await repo.get('lineups', 'l-1')) as { found: true; value: LineupRecord };
    expect(lineup.value.builtUnder.rulePreset).toEqual({ kind: 'user', id: 'n-1' });
    db.close();
  });

  it('onConflict replace continues the stored rev and skips a snapshot; skip changes nothing', async () => {
    const file = await exported(FULL);
    const { db, repo } = await newDb();
    await seedFromFixture(repo);
    const before = await dumpStores(repo);

    const skipped = await importData(db, file, { fileName: 's.json', onConflict: 'skip' });
    expect(Object.keys(skipped.written)).toEqual([]);
    expect(skipped.skipped).toHaveLength(13);
    expect(await dumpStores(repo)).toEqual(before);

    const replaced = await importData(db, file, { fileName: 'r.json', onConflict: 'replace', now: () => '2026-10-28T03:00:00.000Z' });
    expect(replaced.skipped).toEqual([{ store: 'lineups', key: '"l-2"', reason: 'snapshot-immutable' }]);
    expect(replaced.replaced).toHaveLength(12);
    const meet = (await repo.get('meets', 'm-2')) as { found: true; value: MeetRecord };
    // Seeded by put, the stored rev was 1. The replace takes the changeRev its import commits: above the stored rev, and never a rev the key held.
    expect(meet.value.rev).toBeGreaterThan(1);
    expect(meet.value.rev).toBe(await readChangeRev(db));
    expect(meet.value.origin).toMatchObject({ kind: 'imported', fileName: 'r.json' });
    expect(meet.value.updatedAt).toBe('2026-10-28T03:00:00.000Z');
    const snap = (await repo.get('lineups', 'l-2')) as { found: true; value: LineupRecord };
    expect(snap.value.origin).toEqual({ kind: 'local' });
    db.close();
  });

  it('T-E5: a missing cap, provenance "legacy" and an unknown published source are each refused, with nothing written', async () => {
    const good = await exported(FULL);
    const cases: [string, (file: Record<string, unknown>) => void, string][] = [
      [
        'missing cap',
        f => {
          const rows = (f.stores as { rulePresets: RulePresetRecord[] }).rulePresets;
          delete (rows[0]?.payload.entries.maxTotalPerSwimmer as unknown as Record<string, unknown>).value;
        },
        'stores.rulePresets[0].payload.entries.maxTotalPerSwimmer.value',
      ],
      [
        'legacy provenance',
        f => {
          const rows = (f.stores as { rulePresets: Record<string, unknown>[] }).rulePresets;
          rows[1] = setAt(rows[1] as Record<string, unknown>, ['payload', 'scoring', 'aFinalBracketSize', 'provenance'], { kind: 'legacy' });
        },
        'stores.rulePresets[1].payload.scoring.aFinalBracketSize.provenance',
      ],
      [
        'legacy provenance in a lineup builtUnder',
        f => {
          const rows = (f.stores as { lineups: Record<string, unknown>[] }).lineups;
          rows[0] = setAt(rows[0] as Record<string, unknown>, ['builtUnder', 'rulePresetValues', 'scoring', 'aFinalBracketSize', 'provenance'], { kind: 'legacy' });
        },
        'stores.lineups[0].builtUnder.rulePresetValues.scoring.aFinalBracketSize.provenance',
      ],
      [
        'unknown published source',
        f => {
          const rows = (f.stores as { rulePresets: Record<string, unknown>[] }).rulePresets;
          rows[1] = setAt(rows[1] as Record<string, unknown>, ['payload', 'scoring', 'individualPoints', 'provenance', 'source', 'sourceId'], 'not-in-any-manifest');
        },
        'stores.rulePresets[1].payload.scoring.individualPoints.provenance.source',
      ],
      [
        'a cap of 999 that the legacy scorer reads as unlimited',
        f => {
          const rows = (f.stores as { rulePresets: Record<string, unknown>[] }).rulePresets;
          rows[0] = setAt(rows[0] as Record<string, unknown>, ['payload', 'entries', 'maxTotalPerSwimmer', 'value'], 999);
        },
        'stores.rulePresets[0].payload.entries.maxTotalPerSwimmer.value',
      ],
    ];
    for (const [label, mutate, path] of cases) {
      const file = asFile(good);
      mutate(file);
      const { db, repo } = await newDb();
      const error = await importData(db, file, { fileName: 'bad.json', onConflict: 'keep-both' }).catch(e => e as unknown);
      expect(error, label).toBeInstanceOf(ImportValidationError);
      expect((error as ImportValidationError).issues.map(i => i.path), label).toEqual([path]);
      for (const store of USER_STORES) expect(await repo.list(store), `${label}: ${store}`).toEqual([]);
      db.close();
    }
  });

  it('refuses a newer format, a newer database schema, and SwimCloud data in a file that says it has none', async () => {
    const good = await exported(DEFAULT);
    const { db } = await newDb();
    const run = (file: unknown) => importData(db, file, { fileName: 'f.json', onConflict: 'keep-both' }).catch(e => e as unknown);

    expect(await run({ ...good, formatVersion: 2 })).toBeInstanceOf(NewerExportError);
    expect(await run({ ...good, dbSchemaVersion: DB_VERSION + 1 })).toBeInstanceOf(NewerExportError);
    expect(await run({ ...good, formatVersion: 0 })).toBeInstanceOf(ImportValidationError);
    expect(await run({ ...good, format: 'other' })).toBeInstanceOf(ImportValidationError);
    expect(await run('not an object')).toBeInstanceOf(ImportValidationError);
    expect(await run(removeAt(good, ['extensionVersion']))).toBeInstanceOf(ImportValidationError);
    expect(await run({ ...good, surprise: 1 })).toBeInstanceOf(ImportValidationError);

    const leaks: [string, Record<string, unknown>][] = [
      ['swimmerHistory present', { ...good, stores: { ...(good.stores as object), swimmerHistory: [] } }],
      ['rosters present', { ...good, stores: { ...(good.stores as object), rosters: [] } }],
      ['results present', setAt(good, ['stores', 'lineups', 1, 'results'], { payloadVersion: 1, teams: [], events: [], violations: [], rosterUnknown: [] })],
      ['facts present', setAt(good, ['stores', 'lineups', 0, 'facts'], { payloadVersion: 1, seeds: {}, classYears: {} })],
      ['display present', setAt(good, ['stores', 'lineups', 0, 'payload', 'display'], { swimmers: {}, teams: {}, entryTimes: {} })],
    ];
    for (const [label, file] of leaks) {
      const error = await run(file);
      expect(error, label).toBeInstanceOf(ImportValidationError);
      expect((error as ImportValidationError).issues.map(i => i.message).join(), label).toContain('includesSwimCloudData:false');
    }
    // An unknown store and a duplicate key are refused too.
    expect(await run({ ...good, stores: { ...(good.stores as object), widgets: [] } })).toBeInstanceOf(ImportValidationError);
    const dup = asFile(good);
    (dup.stores as { meets: unknown[] }).meets.push(fixtureRecord('meets', 0));
    expect(await run(dup)).toBeInstanceOf(ImportValidationError);
    db.close();
  });

  it('T-E6: every record type survives JSON.parse(JSON.stringify(r)) unchanged, in the fixture, in the database and in a file', async () => {
    const { db, repo } = await newDb();
    await seedFromFixture(repo);
    let seen = 0;
    for (const store of USER_STORES) {
      // v2 holds what v1 does, plus the R51, R53 and R54 records (a draft meet, a verified-empty roster, class years, an override).
      for (const version of [1, 2]) {
        if (!hasFixtureStore(store, version)) continue;
        for (const r of fixtureRecords(store, version)) {
          expect(JSON.parse(JSON.stringify(r)), `fixture v${version} ${store}`).toStrictEqual(r);
          seen += 1;
        }
      }
      for (const r of await repo.list(store)) {
        expect(JSON.parse(JSON.stringify(r)), `stored ${store}`).toStrictEqual(r);
        seen += 1;
      }
    }
    expect(seen).toBe(43); // 13 in v1, 17 in v2, 13 stored from v1
    const file = await exportData(repo, FULL);
    expect(JSON.parse(JSON.stringify(file))).toStrictEqual(file);
    // An undefined-valued key is refused before it can become a stored key that JSON drops.
    await expect(repo.put('meets', { ...withoutRev(fixtureRecord<Record<string, unknown>>('meets', 1)), meetKey: 'm-x', simulatorQuery: undefined } as never, 'new')).rejects.toBeInstanceOf(InvalidRecordError);
    db.close();
  });

  it('P7 C2: round trip preserves lineup facts and recorded coach and suggested tags', async () => {
    const { db, repo } = await newDb();
    const original = withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 0));
    const enriched = { ...original, facts: { payloadVersion: 1, seeds: {}, classYears: {} }, tags: { coach: [], suggested: [] } };
    await repo.put('lineups', enriched as never, 'new');
    const file = await exportData(repo, { ...FULL, stores: ['lineups'], now: () => '2026-10-28T00:00:00.000Z' });
    const target = await newDb();
    await importData(target.db, file, { fileName: 'facts.json', onConflict: 'keep-both' });
    const stored = (await target.repo.list('lineups'))[0] as LineupRecord;
    expect(stored.facts).toEqual(enriched.facts);
    expect(stored.tags).toEqual(enriched.tags);
    const defaultFile = await exportData(repo, { ...DEFAULT, stores: ['lineups'] });
    expect((defaultFile.stores.lineups?.[0] as LineupRecord).facts).toBeUndefined();
    target.db.close();
    db.close();
  });

  it('T-E7: a snapshot rejects any put after create', async () => {
    const { db, repo } = await newDb();
    const snapshot = withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 1));
    const created = await repo.put('lineups', snapshot as never, 'new');
    expect((created as LineupRecord).kind).toBe('snapshot');

    const edit = { ...snapshot, name: 'Renamed snapshot' };
    await expect(repo.put('lineups', edit as never, created.rev)).rejects.toBeInstanceOf(SnapshotImmutableError);
    await expect(repo.put('lineups', edit as never, 99)).rejects.toBeInstanceOf(SnapshotImmutableError);
    await expect(repo.put('lineups', edit as never, 'new')).rejects.toBeInstanceOf(StaleWriteError);
    const stored = (await repo.get('lineups', 'l-2')) as { found: true; value: LineupRecord };
    expect(stored.value).toEqual(created);
    expect(await readChangeRev(db)).toBe(1);

    // A plain lineup stays editable, and cannot be turned into a snapshot by an edit.
    const lineup = await repo.put('lineups', withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 0)) as never, 'new');
    const edited = await repo.put('lineups', { ...withoutRev(lineup as never as Record<string, unknown>), name: 'Edited' } as never, lineup.rev);
    // The edit takes the changeRev it commits (3: snapshot create 1, lineup create 2, edit 3).
    expect(edited.rev).toBe(3);
    expect(edited.rev).toBe(await readChangeRev(db));
    await expect(
      repo.put('lineups', { ...withoutRev(lineup as never as Record<string, unknown>), kind: 'snapshot', results: { x: 1 } } as never, edited.rev)
    ).rejects.toBeInstanceOf(InvalidRecordError);
    db.close();
  });

  it('T-E8: toSwimCloudId refuses a number, a leading zero and anything that is not digits', () => {
    expect(() => toSwimCloudId(123 as unknown as string)).toThrow(RangeError);
    expect(() => toSwimCloudId('0123')).toThrow(RangeError);
    for (const bad of ['', '0', '-1', '1.5', ' 1', '1 ', '12a', null, undefined, {}, ['1']]) {
      expect(() => toSwimCloudId(bad as unknown as string), String(bad)).toThrow(RangeError);
    }
    expect(toSwimCloudId('123')).toBe('123');
    expect(toSwimCloudId('1')).toBe('1');
  });
});
