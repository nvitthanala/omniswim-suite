/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * R54 (plans/2026-10-25/README.md): a meet with no teams saves as a draft. Scoring and the
 * optimizer refuse a draft. They are not built in the extension yet (P3), so storage holds the
 * state (`MeetRecord.status?: 'draft'`) and one guard, `requireScorableMeet`, that P3 must call.
 */
import { describe, expect, it } from 'vitest';
import { validateRecord } from '../apps/extension/src/storage/validate';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { exportData, importData } from '../apps/extension/src/storage/exportImport';
import { requireScorableMeet } from '../apps/extension/src/storage/meetGuard';
import type { ScorableMeet } from '../apps/extension/src/storage/meetGuard';
import type { MeetRecord } from '../apps/extension/src/storage/schema';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, fixtureRecords, removeAt, withoutRev } from './helpers/extensionRecords';

const paths = (record: unknown): string[] => validateRecord('meets', record).map(i => i.path);
const draft = (): Record<string, unknown> => ({ ...fixtureRecord('meets'), meetKey: 'm-draft', teamIds: [], status: 'draft' });

async function newRepo() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('install') });
  return { db, repo: createStorageRepo(db, { now: steppingClock() }) };
}

describe('R54 draft meets: validation', () => {
  it('accepts a meet with no teams when it is marked as a draft', () => {
    expect(validateRecord('meets', draft())).toEqual([]);
  });

  it('rejects a meet with no teams and no draft mark', () => {
    expect(paths({ ...fixtureRecord('meets'), teamIds: [] })).toEqual(['$.teamIds']);
    expect(paths(removeAt(draft(), ['status']))).toEqual(['$.teamIds']);
  });

  it('rejects a draft that has teams, so a stale mark cannot block a complete meet', () => {
    expect(paths({ ...fixtureRecord('meets'), status: 'draft' })).toEqual(['$.status']);
  });

  it('rejects any status but "draft"', () => {
    for (const value of ['final', 'ready', '', null, true, 'Draft']) expect(paths({ ...draft(), status: value }), String(value)).toEqual(['$.status']);
  });

  it('every v1 meet, written before drafts existed, is still valid and is not a draft', () => {
    for (const meet of fixtureRecords<Record<string, unknown>>('meets')) {
      expect(validateRecord('meets', meet)).toEqual([]);
      expect('status' in meet).toBe(false);
      expect(requireScorableMeet(meet as unknown as MeetRecord).ok).toBe(true);
    }
  });
});

describe('R54 draft meets: the guard', () => {
  it('refuses a draft with a typed refusal, and does not throw', () => {
    const result = requireScorableMeet(draft() as unknown as MeetRecord);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('draft');
      expect(result.meetKey).toBe('m-draft');
      expect(result.message).toMatch(/draft/i);
    }
  });

  it('is the only way to get a ScorableMeet: a raw MeetRecord does not type-check as one (tsc over tests)', () => {
    const takesScorable = (_meet: ScorableMeet): void => undefined;
    const raw = fixtureRecord<Record<string, unknown>>('meets') as unknown as MeetRecord;
    // @ts-expect-error a raw MeetRecord skipped the guard
    takesScorable(raw);
    const result = requireScorableMeet(raw);
    if (result.ok) takesScorable(result.meet);
    expect(result.ok).toBe(true);
  });

  it('passes a meet with teams and gives the same meet back', () => {
    const meet = fixtureRecord<Record<string, unknown>>('meets') as unknown as MeetRecord;
    const result = requireScorableMeet(meet);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.meet).toBe(meet);
  });

  it('refuses a record with no teams and no draft mark: a corrupt record is not a scorable meet', () => {
    const result = requireScorableMeet({ ...fixtureRecord('meets'), teamIds: [] } as unknown as MeetRecord);
    expect(result).toMatchObject({ ok: false, reason: 'no-teams', meetKey: 'm-1' });
  });

  it('refuses a draft mark even when teams are present', () => {
    expect(requireScorableMeet({ ...fixtureRecord('meets'), status: 'draft' } as unknown as MeetRecord)).toMatchObject({ ok: false, reason: 'draft' });
  });
});

describe('R54 draft meets: stored', () => {
  it('saves a draft, reads it back, and completes it when teams are added', async () => {
    const { db, repo } = await newRepo();
    const saved = await repo.put('meets', withoutRev(draft()) as never, 'new');
    expect(saved.status).toBe('draft');
    expect(saved.teamIds).toEqual([]);
    const read = await repo.get('meets', 'm-draft');
    expect(read.found && requireScorableMeet(read.value as MeetRecord).ok).toBe(false);

    // Adding teams ends the draft: the writer leaves status out.
    const completed = { ...withoutRev(saved as never as Record<string, unknown>), teamIds: ['48'] } as Record<string, unknown>;
    delete completed.status;
    await expect(repo.put('meets', { ...completed, status: 'draft' } as never, saved.rev)).rejects.toThrow(/status/);
    const done = await repo.put('meets', completed as never, saved.rev);
    expect(done.rev).toBe(2);
    expect('status' in done).toBe(false);
    expect(requireScorableMeet(done).ok).toBe(true);
    db.close();
  });

  it('put refuses an empty meet that is not a draft and writes nothing', async () => {
    const { db, repo } = await newRepo();
    await expect(repo.put('meets', withoutRev({ ...draft(), status: undefined }) as never, 'new')).rejects.toThrow();
    await expect(repo.put('meets', withoutRev(removeAt(draft(), ['status'])) as never, 'new')).rejects.toThrow(/teamIds/);
    expect(await repo.list('meets')).toEqual([]);
    db.close();
  });

  it('a draft round-trips through export and import, still a draft', async () => {
    const a = await newRepo();
    await a.repo.put('meets', withoutRev(draft()) as never, 'new');
    const file = JSON.parse(
      JSON.stringify(await exportData(a.repo, { stores: ['meets'], includeSwimCloudData: false, includeSettings: false, extensionVersion: '0.1.0' }))
    );
    a.db.close();
    const b = await newRepo();
    await importData(b.db, file, { fileName: 'backup.json', onConflict: 'keep-both' });
    const [meet] = await b.repo.list('meets');
    expect(meet?.status).toBe('draft');
    expect(meet?.teamIds).toEqual([]);
    expect(requireScorableMeet(meet as MeetRecord).ok).toBe(false);
    b.db.close();
  });
});
