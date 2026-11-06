import { describe, expect, it } from 'vitest';
import { panelCutTagsForModel } from '../apps/extension/src/dashboard/scorerTagScoring';
import { backupExportOptions, presetDerivedFromText } from '../apps/extension/src/dashboard/tabHost';
import { clearFetchedSwimCloudData, formatStorageBytes, readStorageEstimate, saveCutCloseThreshold } from '../apps/extension/src/dashboard/settingsStore';
import { createStorageRepo, exportData, importData, openOmniDb, USER_STORES } from '../apps/extension/src/storage';
import { listRulePresetChoices } from '../apps/extension/src/storage';
import type { OmniDbSchema } from '../apps/extension/src/storage';
import { freshFactory, steppingClock } from './helpers/extensionDb';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { seedFromFixture } from './helpers/extensionRecords';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { MeetModel } from '@omniswim/engine';
import type { IDBPDatabase } from 'idb';

async function fresh() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: () => 'ue-install' });
  return { db, repo: createStorageRepo(db, { now: steppingClock() }) };
}
const exportOptions = { stores: ['rulePresets','sessionPresets','meets','tags','lineups','classYearOverrides'] as const, includeSwimCloudData: false, includeSettings: false, extensionVersion: 'test' };
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['origin','rev','updatedAt'].includes(k)).map(([k,v]) => [k, stable(v)]));
  return value;
};

describe('dashboard Settings and Presets, U-e', () => {
  it('passes the configured threshold through to page panel cut tags', () => {
    const { snapshot } = buildSnapshot('A');
    const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: 'ue', snapshotId: 'ue' });
    if (adapted.kind !== 'ready') throw new Error('Fixture is not ready');
    const original = adapted.adapted.model;
    const source = original.swims.find(swim => swim.eventKey === '100 Freestyle');
    if (!source) throw new Error('Fixture has no 100 Freestyle swim');
    const swimmer = original.swimmers.find(x => x.swimmerId === source.swimmerId)!;
    const division = { state: 'known' as const, division: 'D1' as const, season: '2026-2027' };
    const model = { ...original, teams: original.teams.map(team => team.teamId === swimmer.teamId ? { ...team, division } : team),
      swims: original.swims.map(swim => swim.swimId === source.swimId ? { ...swim, recordedTime: { text: '43.00', hundredths: 4300 } } : swim) } as MeetModel;
    const atDefault = panelCutTagsForModel(model, undefined, 10000);
    const disabled = panelCutTagsForModel(model, undefined, 0);
    expect(atDefault.some(row => row.real.startsWith('Close to ') || row.estimated.startsWith('Close to '))).toBe(true);
    expect(disabled.some(row => row.real.startsWith('Close to ') || row.estimated.startsWith('Close to '))).toBe(false);
    expect(atDefault.find(row => row.real.startsWith('Close to '))?.real).toMatch(/^Close to .+: \d+\.\d{2} s off /);
  });

  it('reports that storage estimates are unavailable when the API is absent', async () => {
    await expect(readStorageEstimate(undefined)).resolves.toEqual({ available: false, text: 'Storage estimate is not available in this browser.' });
  });

  it('formats estimates in KB, MB and GB with one decimal place', async () => {
    expect(formatStorageBytes(12_697)).toBe('12.4 KB');
    expect(formatStorageBytes(13_002_342)).toBe('12.4 MB');
    expect(formatStorageBytes(2_254_857_830)).toBe('2.1 GB');
    await expect(readStorageEstimate({ estimate: async () => ({ usage: 13_002_342, quota: 2_254_857_830 }) }))
      .resolves.toMatchObject({ available: true, text: 'Using 12.4 MB of 2.1 GB.' });
  });

  it('includes settings in backups and includes SwimCloud stores only when requested', () => {
    const idsOnly = backupExportOptions(false);
    expect(idsOnly.includeSettings).toBe(true);
    expect(idsOnly.includeSwimCloudData).toBe(false);
    expect(idsOnly.stores).toContain('settings');
    expect(idsOnly.stores).not.toContain('swimmerHistory');
    expect(idsOnly.stores).not.toContain('rosters');
    const full = backupExportOptions(true);
    expect(full.includeSettings).toBe(true);
    expect(full.includeSwimCloudData).toBe(true);
    expect(full.stores).toContain('swimmerHistory');
    expect(full.stores).toContain('rosters');
  });

  it('exports stored settings by default and adds cache stores only for an opted-in export', async () => {
    const { db, repo } = await fresh();
    await seedFromFixture(repo);
    const defaultBackup = await exportData(repo, { ...backupExportOptions(false), extensionVersion: 'test' });
    expect(defaultBackup.stores.settings).toEqual(await repo.list('settings'));
    expect(defaultBackup.stores.swimmerHistory).toBeUndefined();
    expect(defaultBackup.stores.rosters).toBeUndefined();
    const fullBackup = await exportData(repo, { ...backupExportOptions(true), extensionVersion: 'test' });
    expect(fullBackup.includesSwimCloudData).toBe(true);
    expect(fullBackup.stores.swimmerHistory).toEqual(await repo.list('swimmerHistory'));
    expect(fullBackup.stores.rosters).toEqual(await repo.list('rosters'));
    db.close();
  });

  it('lists built-in and user preset provenance, including a newer built-in version', async () => {
    const { db, repo } = await fresh();
    const rules = await listRulePresetChoices(repo);
    const nsisc = rules.find(row => row.source === 'builtin' && row.ref.kind === 'builtin' && row.ref.id === 'nsisc');
    expect(nsisc).toBeDefined();
    expect(presetDerivedFromText('rule', { builtinId: 'nsisc', builtinVersion: 1 }, 'NSISC')).toMatch(/^Based on NSISC v1; v\d+ available$/);
    expect(presetDerivedFromText('rule', { builtinId: 'nsisc', builtinVersion: nsisc!.ref.kind === 'builtin' ? nsisc!.ref.version : 1 }, 'NSISC')).toBe(`Based on NSISC v${nsisc!.ref.kind === 'builtin' ? nsisc!.ref.version : 1}`);
    db.close();
  });

  it('deletes every fetched cache record and preserves every user store', async () => {
    const { db, repo } = await fresh();
    await seedFromFixture(repo);
    const stores = USER_STORES.filter(name => name !== 'swimmerHistory' && name !== 'rosters');
    const before = await repo.listMany(stores);
    const deleted = await clearFetchedSwimCloudData(db as IDBPDatabase<OmniDbSchema>);
    expect(deleted).toBeGreaterThan(0);
    expect(await repo.list('swimmerHistory')).toEqual([]);
    expect(await repo.list('rosters')).toEqual([]);
    expect(await repo.listMany(stores)).toEqual(before);
    db.close();
  });

  it('refuses an invalid backup before writing and includes the validator path', async () => {
    const { db, repo } = await fresh();
    const data = await exportData(repo, { ...exportOptions, stores: ['settings'], includeSettings: true });
    const bad = { ...data, stores: { ...data.stores, settings: [{ key: 'theme', value: 'ultraviolet', rev: 1, updatedAt: '2026-10-27T00:00:00.000Z' }] } };
    await expect(importData(db, bad, { fileName: 'bad.json', onConflict: 'skip' })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining('settings') })]) });
    expect(await repo.list('settings')).toEqual([]);
    db.close();
  });

  it('exports default user data and imports equal records into an empty database', async () => {
    const source = await fresh(); await seedFromFixture(source.repo);
    const exported = await exportData(source.repo, exportOptions);
    const target = await fresh();
    const report = await importData(target.db, exported, { fileName: 'roundtrip.json', onConflict: 'skip' });
    expect(report.skipped).toEqual([]);
    for (const store of exportOptions.stores) {
      const exportedRows = exported.stores[store] ?? [];
      const targetRows = await target.repo.list(store as never);
      expect(stable(targetRows)).toEqual(stable(exportedRows));
    }
    source.db.close(); target.db.close();
  });

  it('rejects a cut threshold the storage validator refuses', async () => {
    const { db, repo } = await fresh();
    await expect(repo.put('settings', { key: 'cutCloseThresholdPct', value: -0.1 }, 'new')).rejects.toThrow('cannot be negative');
    await expect(saveCutCloseThreshold(repo, 1.005)).rejects.toThrow('at most 2 decimals');
    expect(await repo.list('settings')).toEqual([]);
    db.close();
  });
});
