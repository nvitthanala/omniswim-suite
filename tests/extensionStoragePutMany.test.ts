/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D6 section 3: `StorageRepo.putMany`, one readwrite transaction across stores. Every rev is checked, and a failure writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { createMemoryChangeBus, readChangeRev } from '../apps/extension/src/storage/changeBus';
import type { ChangeNotice } from '../apps/extension/src/storage/changeBus';
import { ChangeRevMovedError, InvalidRecordError, StaleWriteError } from '../apps/extension/src/storage/errors';
import type { MeetRecord, TagRecord } from '../apps/extension/src/storage/schema';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, withoutRev } from './helpers/extensionRecords';

async function setup() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds() });
  const bus = createMemoryChangeBus();
  const notices: ChangeNotice[] = [];
  bus.subscribe((n) => notices.push(n));
  return { db, notices, repo: createStorageRepo(db, { bus, now: steppingClock() }) };
}

const meet = () => withoutRev(fixtureRecord<MeetRecord>('meets', 0));
const tag = (swimmerId: string, role: TagRecord['role'] = 'scorer') => ({ meetKey: 'm-1', teamId: '58', swimmerId, role }) as Omit<TagRecord, 'rev' | 'updatedAt'>;
const tagKey = (swimmerId: string): [string, string, string] => ['m-1', '58', swimmerId];

describe('StorageRepo.putMany (D6 section 3)', () => {
  it('writes every op across stores, puts and a delete, with one change notice', async () => {
    const { repo, db, notices } = await setup();
    await repo.put('tags', tag('101'), 'new');
    const before = await readChangeRev(db as never);
    const out = await repo.putMany([
      { op: 'put', store: 'meets', record: meet(), expectedRev: 'new' },
      { op: 'put', store: 'tags', record: tag('102'), expectedRev: 'new' },
      { op: 'put', store: 'tags', record: tag('101', 'non-scorer'), expectedRev: 1 },
    ]);
    expect(out).toHaveLength(3);
    expect((await repo.get('meets', 'm-1')).found).toBe(true);
    expect(await repo.get('tags', tagKey('102'))).toMatchObject({ found: true, value: { rev: 1, role: 'scorer' } });
    expect(await repo.get('tags', tagKey('101'))).toMatchObject({ found: true, value: { rev: 2, role: 'non-scorer' } });
    expect(await readChangeRev(db as never)).toBe(before + 1);
    expect(notices.at(-1)?.stores.slice().sort()).toStrictEqual(['meets', 'tags']);
    // A delete inside a batch.
    await repo.putMany([
      { op: 'delete', store: 'tags', key: tagKey('101'), expectedRev: 2 },
      { op: 'put', store: 'tags', record: tag('103'), expectedRev: 'new' },
    ]);
    expect((await repo.get('tags', tagKey('101'))).found).toBe(false);
    expect((await repo.get('tags', tagKey('103'))).found).toBe(true);
    db.close();
  });

  it('a stale rev on one op writes nothing', async () => {
    const { repo, db, notices } = await setup();
    await repo.put('tags', tag('101'), 'new');
    const before = await readChangeRev(db as never);
    const noticesBefore = notices.length;
    await expect(
      repo.putMany([
        { op: 'put', store: 'meets', record: meet(), expectedRev: 'new' },
        { op: 'put', store: 'tags', record: tag('102'), expectedRev: 'new' },
        { op: 'put', store: 'tags', record: tag('101', 'non-scorer'), expectedRev: 7 },
      ]),
    ).rejects.toBeInstanceOf(StaleWriteError);
    expect((await repo.get('meets', 'm-1')).found).toBe(false);
    expect((await repo.get('tags', tagKey('102'))).found).toBe(false);
    expect(await repo.get('tags', tagKey('101'))).toMatchObject({ found: true, value: { rev: 1, role: 'scorer' } });
    expect(await readChangeRev(db as never)).toBe(before);
    expect(notices.length).toBe(noticesBefore);
    // A delete of a row that is not there is stale too, and takes the earlier put with it.
    await expect(
      repo.putMany([
        { op: 'put', store: 'tags', record: tag('104'), expectedRev: 'new' },
        { op: 'delete', store: 'tags', key: tagKey('999'), expectedRev: 1 },
      ]),
    ).rejects.toBeInstanceOf(StaleWriteError);
    expect((await repo.get('tags', tagKey('104'))).found).toBe(false);
    db.close();
  });

  it('a stale expectedChangeRev writes nothing, even when an unrelated store changed', async () => {
    const { repo, db, notices } = await setup();
    const seen = await repo.changeRev();
    expect(seen).toBe(0);
    // The precondition holds: the batch writes and moves changeRev by one.
    await repo.putMany([{ op: 'put', store: 'tags', record: tag('101'), expectedRev: 'new' }], { expectedChangeRev: seen });
    expect(await repo.changeRev()).toBe(1);
    // Another context writes a different store. The caller's changeRev is now stale.
    await repo.put('meets', meet(), 'new');
    const noticesBefore = notices.length;
    await expect(
      repo.putMany(
        [
          { op: 'put', store: 'tags', record: tag('102'), expectedRev: 'new' },
          { op: 'put', store: 'tags', record: tag('101', 'non-scorer'), expectedRev: 1 },
        ],
        { expectedChangeRev: 1 },
      ),
    ).rejects.toBeInstanceOf(ChangeRevMovedError);
    expect((await repo.get('tags', tagKey('102'))).found).toBe(false);
    expect(await repo.get('tags', tagKey('101'))).toMatchObject({ found: true, value: { rev: 1, role: 'scorer' } });
    expect(await repo.changeRev()).toBe(2);
    expect(notices.length).toBe(noticesBefore);
    // Without the option the per-op rev checks alone decide, as before.
    await repo.putMany([{ op: 'put', store: 'tags', record: tag('102'), expectedRev: 'new' }]);
    expect((await repo.get('tags', tagKey('102'))).found).toBe(true);
    db.close();
  });

  it('an invalid record writes nothing, and two ops on one key are refused', async () => {
    const { repo, db } = await setup();
    const bad = { ...tag('105'), swimmerId: 'T58-S01' } as Omit<TagRecord, 'rev' | 'updatedAt'>;
    await expect(
      repo.putMany([
        { op: 'put', store: 'tags', record: tag('104'), expectedRev: 'new' },
        { op: 'put', store: 'tags', record: bad, expectedRev: 'new' },
      ]),
    ).rejects.toBeInstanceOf(InvalidRecordError);
    expect((await repo.get('tags', tagKey('104'))).found).toBe(false);
    await expect(
      repo.putMany([
        { op: 'put', store: 'tags', record: tag('104'), expectedRev: 'new' },
        { op: 'put', store: 'tags', record: tag('104', 'non-scorer'), expectedRev: 1 },
      ]),
    ).rejects.toBeInstanceOf(RangeError);
    expect((await repo.get('tags', tagKey('104'))).found).toBe(false);
    expect(await repo.putMany([])).toStrictEqual([]);
    db.close();
  });
});
