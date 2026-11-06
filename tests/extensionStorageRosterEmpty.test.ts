/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * R53 (plans/2026-10-25/README.md): a roster fetched from SwimCloud with no members is stored as
 * verified-empty, with its fetch time and source, and is told apart from "not loaded" (no record).
 * D3 section 14 explains the shape: `RosterRecord.verifiedEmpty?: true`.
 */
import { describe, expect, it } from 'vitest';
import { validateRecord } from '../apps/extension/src/storage/validate';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { exportData, importData } from '../apps/extension/src/storage/exportImport';
import { readRosterState, verifiedEmptyRoster } from '../apps/extension/src/storage/rosterState';
import { toSwimCloudId } from '../apps/extension/src/storage/schema';
import type { RosterRecord } from '../apps/extension/src/storage/schema';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, removeAt, setAt } from './helpers/extensionRecords';

const paths = (record: unknown): string[] => validateRecord('rosters', record).map(i => i.path);
const emptyRoster = (): Record<string, unknown> => ({ ...fixtureRecord('rosters'), memberIds: [], verifiedEmpty: true });

async function newRepo() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('install') });
  return { db, repo: createStorageRepo(db, { now: steppingClock() }) };
}

describe('R53 verified-empty rosters: validation', () => {
  it('accepts an empty roster that is marked verified-empty, with its source and fetch time', () => {
    expect(validateRecord('rosters', emptyRoster())).toEqual([]);
  });

  it('rejects an empty roster with no mark, so a parser that found nothing cannot pass', () => {
    expect(paths({ ...fixtureRecord('rosters'), memberIds: [] })).toEqual(['$.memberIds']);
  });

  it('rejects the mark on a roster that has members', () => {
    expect(paths({ ...fixtureRecord('rosters'), verifiedEmpty: true })).toEqual(['$.verifiedEmpty']);
  });

  it('rejects verifiedEmpty:false and any value but true: leave the key out instead', () => {
    for (const value of [false, null, 1, 'true']) expect(paths({ ...emptyRoster(), verifiedEmpty: value }), String(value)).toEqual(['$.verifiedEmpty']);
  });

  it('a verified-empty roster still needs sourceUrl, fetchedAt and parser', () => {
    for (const key of ['sourceUrl', 'fetchedAt', 'parser']) expect(paths(removeAt(emptyRoster(), [key])), key).toEqual([`$.${key}`]);
    expect(paths(setAt(emptyRoster(), ['fetchedAt'], 'yesterday'))).toEqual(['$.fetchedAt']);
  });
});

describe('R53 verified-empty rosters: stored state', () => {
  const key = { teamId: toSwimCloudId('48'), seasonId: '26', gender: 'Women' as const };

  it('tells not-loaded, verified-empty and has-members apart', async () => {
    const { db, repo } = await newRepo();
    expect(await readRosterState(repo, key)).toEqual({ state: 'not-loaded' });
    // Not loaded is "no record", never an empty one.
    expect(await repo.get('rosters', ['48', '26', 'Women'])).toEqual({ found: false });

    await repo.putCache('rosters', emptyRoster() as unknown as RosterRecord);
    const empty = await readRosterState(repo, key);
    expect(empty.state).toBe('verified-empty');
    if (empty.state === 'verified-empty') {
      expect(empty.record.memberIds).toEqual([]);
      expect(empty.record.fetchedAt).toBe('2026-10-26T12:00:00.000Z');
      expect(empty.record.sourceUrl).toBe('https://www.swimcloud.com/team/48/roster/?season_id=26');
    }
    // Another team and another season are still not loaded.
    expect(await readRosterState(repo, { ...key, teamId: toSwimCloudId('58') })).toEqual({ state: 'not-loaded' });
    expect(await readRosterState(repo, { ...key, seasonId: '27' })).toEqual({ state: 'not-loaded' });

    await repo.putCache('rosters', fixtureRecord('rosters') as unknown as RosterRecord);
    expect((await readRosterState(repo, key)).state).toBe('members');
    db.close();
  });

  it('putCache refuses an empty roster without the mark and writes nothing', async () => {
    const { db, repo } = await newRepo();
    await expect(repo.putCache('rosters', { ...fixtureRecord<Record<string, unknown>>('rosters'), memberIds: [] } as never)).rejects.toThrow(/memberIds/);
    expect(await repo.list('rosters')).toEqual([]);
    expect(await readRosterState(repo, key)).toEqual({ state: 'not-loaded' });
    db.close();
  });

  it('verifiedEmptyRoster builds a record the validator accepts, and it has no members', () => {
    const { memberIds: _m, ...rest } = fixtureRecord<Record<string, unknown>>('rosters');
    const built = verifiedEmptyRoster(rest as never);
    expect(built.memberIds).toEqual([]);
    expect(built.verifiedEmpty).toBe(true);
    expect(validateRecord('rosters', built)).toEqual([]);
  });
});

describe('R53 verified-empty rosters: export and import', () => {
  const FULL = { stores: ['rosters'], includeSwimCloudData: true, includeSettings: false, extensionVersion: '0.1.0', now: () => '2026-10-28T00:00:00.000Z' } as const;

  it('round-trips with the mark, the source and the fetch time intact', async () => {
    const a = await newRepo();
    await a.repo.putCache('rosters', emptyRoster() as unknown as RosterRecord);
    const file = JSON.parse(JSON.stringify(await exportData(a.repo, FULL))) as { stores: { rosters: RosterRecord[] } };
    expect(file.stores.rosters).toEqual([emptyRoster()]);
    a.db.close();

    const b = await newRepo();
    await importData(b.db, file, { fileName: 'backup.json', onConflict: 'keep-both', now: () => '2026-10-28T01:00:00.000Z' });
    expect(await b.repo.list('rosters')).toEqual([emptyRoster()]);
    b.db.close();
  });

  it('refuses a file whose empty roster has no mark, and imports nothing', async () => {
    const a = await newRepo();
    await a.repo.putCache('rosters', emptyRoster() as unknown as RosterRecord);
    const file = JSON.parse(JSON.stringify(await exportData(a.repo, FULL))) as { stores: { rosters: Record<string, unknown>[] } };
    delete file.stores.rosters[0]?.verifiedEmpty;
    const b = await newRepo();
    await expect(importData(b.db, file, { fileName: 'bad.json', onConflict: 'keep-both' })).rejects.toThrow(/stores\.rosters\[0\]\.memberIds/);
    expect(await b.repo.list('rosters')).toEqual([]);
    a.db.close();
    b.db.close();
  });
});
