import { describe, expect, it } from 'vitest';
import { validateRecord } from '../apps/extension/src/storage/validate';
import { createUndoStack } from '../apps/extension/src/storage/undo';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, withoutRev } from './helpers/extensionRecords';
import { scoreMeet } from '@omniswim/engine';
import type { ConversionSettings, Lineup, MeetModel } from '@omniswim/engine';
import { completeNsisc } from './engineTestPresets';
import { exportData, importData } from '../apps/extension/src/storage/exportImport';

describe('P7 C2 storage additions', () => {
  it('rivalsByMeet accepts engine RivalRef and accent requires #rrggbb', () => {
    const rivals = { key: 'theme', value: { theme: 'light' }, rev: 1, updatedAt: '2026-10-28T00:00:00.000Z' };
    expect(validateRecord('settings', { ...rivals, key: 'rivalsByMeet', value: { meet: { kind: 'team', teamId: '123' } } })).toEqual([]);
    expect(validateRecord('settings', { ...rivals, key: 'accent', value: 'blue' })).toHaveLength(1);
    expect(validateRecord('settings', { ...rivals, key: 'accent', value: '#12abEF' })).toEqual([]);
  });

  it('rejects invalid facts with their storage path', () => {
    const base = withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 0));
    const badFacts = validateRecord('lineups', { ...base, facts: { bad: true }, rev: 1, updatedAt: '2026-10-28T00:00:00.000Z' });
    expect(badFacts[0]?.path).toBe('$.facts');
  });

  it('preserves an opaque legacy results shape through validation, export, and import', async () => {
    const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('opaque') });
    const repo = createStorageRepo(db, { now: steppingClock() });
    const arbitraryOldResults = { legacyVersion: 'old', scores: [{ team: 12 }], extensionData: { untouched: true } };
    const snapshot = { ...withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 1)), results: arbitraryOldResults };
    await repo.put('lineups', snapshot as never, 'new');
    const stored = (await repo.list('lineups'))[0] as { results: unknown };
    expect(stored.results).toEqual(arbitraryOldResults);
    const file = await exportData(repo, { stores: ['lineups'], includeSwimCloudData: true, includeSettings: false, extensionVersion: '0.1.0' });
    const importedDb = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('opaque-import') });
    await importData(importedDb, file, { fileName: 'opaque.json', onConflict: 'keep-both' });
    expect((await createStorageRepo(importedDb).list('lineups'))[0]?.results).toEqual(arbitraryOldResults);
    db.close(); importedDb.close();
  });

  it('accepts and round-trips snapshot Results from scoreMeet', async () => {
    const model: MeetModel = {
      payloadVersion: 1, meetKey: 'synthetic',
      teams: [{ teamId: '48', division: { state: 'unknown', reason: 'unmapped_team' } }],
      swimmers: [{ swimmerId: '1001', teamId: '48', gender: 'Women', classYear: null, roster: 'member' }],
      events: [{ eventKey: '100 Freestyle', gender: 'Women', kind: 'individual', distanceYards: 100, relayKind: null }],
      swims: [{ swimId: 's1', swimmerId: '1001', eventKey: '100 Freestyle', recordedCourse: 'SCY', recordedTime: { text: '55.00', hundredths: 5500 }, date: null, seasonId: null, flags: {}, scy: { kind: 'recorded-scy' }, origin: { kind: 'simulator', snapshotId: 'test' } }],
      relaySplits: [], recordRange: { kind: 'seasons', seasonIds: ['2025-26'] }, extendedWindow: false, observedScores: null,
    };
    const lineup: Lineup = { payloadVersion: 1, meetKey: 'synthetic', entries: [{ kind: 'individual', teamId: '48', swimmerId: '1001', eventKey: '100 Freestyle', gender: 'Women', seedSwimId: null }] };
    const results = scoreMeet(model, lineup, [{ teamId: '48', swimmerId: '1001', role: 'scorer' }], completeNsisc(), { includeConvertedSwims: false, lcmToScy: null } satisfies ConversionSettings);
    const first = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('score') });
    const firstRepo = createStorageRepo(first, { now: steppingClock() });
    const snapshot = { ...withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 1)), results };
    await firstRepo.put('lineups', snapshot as never, 'new');
    expect(validateRecord('lineups', { ...snapshot, rev: 1, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' })).toEqual([]);
    const file = await exportData(firstRepo, { stores: ['lineups'], includeSwimCloudData: true, includeSettings: false, extensionVersion: '0.1.0' });
    const second = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('score-import') });
    await importData(second, file, { fileName: 'score.json', onConflict: 'keep-both' });
    expect((await createStorageRepo(second).list('lineups'))[0]?.results).toEqual(results);
    first.close(); second.close();
  });

  it('undo restores before state, refuses stale writes atomically, and caps history at 50', async () => {
    const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('undo') });
    const repo = createStorageRepo(db, { now: steppingClock() });
    const initial = await repo.put('lineups', withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 0)) as never, 'new');
    const changed = await repo.put('lineups', { ...withoutRev(initial as never as Record<string, unknown>), name: 'Changed' } as never, initial.rev);
    const stack = createUndoStack(repo);
    stack.recordUndo({ changes: [{ before: { op: 'put', store: 'lineups', record: initial }, writtenRev: changed.rev }] });
    expect(await stack.undo()).toEqual({ status: 'undone' });
    expect((await repo.get('lineups', initial.lineupId)).found && (await repo.get('lineups', initial.lineupId) as {found:true;value:{name:string}}).value.name).toBe(initial.name);

    const after = (await repo.get('lineups', initial.lineupId) as {found:true;value:typeof initial}).value;
    const next = await repo.put('lineups', { ...withoutRev(after as never as Record<string, unknown>), name: 'Next' } as never, after.rev);
    stack.recordUndo({ changes: [{ before: { op: 'put', store: 'lineups', record: after }, writtenRev: next.rev }] });
    await repo.put('lineups', { ...withoutRev(next as never as Record<string, unknown>), name: 'External' } as never, next.rev);
    expect(await stack.undo()).toEqual({ status: 'changed elsewhere' });
    expect((await repo.get('lineups', initial.lineupId) as {found:true;value:{name:string}}).value.name).toBe('External');
    for (let i = 0; i < 55; i++) stack.recordUndo({ changes: [{ before: { op: 'delete', store: 'lineups', key: initial.lineupId }, writtenRev: 1 }] });
    expect(stack.size).toBe(50);
    db.close();
  });
});
