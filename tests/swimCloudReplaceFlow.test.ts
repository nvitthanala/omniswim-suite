/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/manager/src/lib/swimCloudReplaceFlow.ts` — the UI-side glue
 * around `importHistoryToRoster(..., { mode: 'replace' })`
 * (plans/2026-09-24, item A1). Core replace correctness (what a replace
 * removes and keeps) is proven in `tests/swimCloudReplaceImport.test.ts`
 * against `tests/fixtures/hsu-2026-27-replace-snapshot.json`; this file only
 * proves the two rules a pure core function cannot enforce on its own:
 * a replace backs the workspace up before it ever imports, and it never
 * imports at all if that backup fails. Also covers `withManualSource`
 * (ManagerApp's "a coach typed this in by hand" tag) and
 * `describeReplaceCounts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { Gender, type Recruit, type Workspace } from '@omniswim/core/types';
import { SwimCloudReplaceRefusedError } from '@omniswim/core/lib/historyImportRoster';
import {
  describeReplaceCounts,
  performSwimCloudImport,
  withManualSource,
} from '@omniswim/manager/lib/swimCloudReplaceFlow';

const HSU = 'Henderson State University';

function emptyWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Test workspace',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
    athleteHistory: [
      { name: 'A Swimmer', team: HSU, gender: Gender.MEN, event: '100 Freestyle', time: '48.00', source: 'paste' },
    ],
  } as Workspace;
}

const INCOMING = [
  { name: 'A Swimmer', team: HSU, gender: Gender.MEN, event: '100 Freestyle', time: '47.90', source: 'paste' as const },
];

describe('performSwimCloudImport', () => {
  it('never calls backup for a merge', async () => {
    const backup = vi.fn(async () => undefined);
    const result = await performSwimCloudImport(
      emptyWorkspace(),
      INCOMING,
      { team: HSU, gender: Gender.MEN, mode: 'merge' },
      { backup }
    );
    expect(backup).not.toHaveBeenCalled();
    expect(result.noop).toBe(false);
  });

  it('backs up before importing, for a replace', async () => {
    const order: string[] = [];
    const backup = vi.fn(async () => {
      order.push('backup');
    });
    const result = await performSwimCloudImport(
      emptyWorkspace(),
      INCOMING,
      { team: HSU, gender: Gender.MEN, mode: 'replace' },
      { backup }
    );
    order.push('imported');
    expect(order).toStrictEqual(['backup', 'imported']);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(result.replaced).toBeDefined();
    expect(result.replaced?.historyToRemove).toHaveLength(1);
  });

  it('never imports — and rejects — if the backup fails', async () => {
    const backup = vi.fn(async () => {
      throw new Error('disk full');
    });
    await expect(
      performSwimCloudImport(
        emptyWorkspace(),
        INCOMING,
        { team: HSU, gender: Gender.MEN, mode: 'replace' },
        { backup }
      )
    ).rejects.toThrow('disk full');
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it('refuses a replace whose incoming import holds nothing for the team/gender', async () => {
    const backup = vi.fn(async () => undefined);
    await expect(
      performSwimCloudImport(
        emptyWorkspace(),
        [{ name: 'Someone Else', team: 'Other School', gender: Gender.WOMEN, event: '50 Freestyle', time: '25.00', source: 'paste' }],
        { team: HSU, gender: Gender.MEN, mode: 'replace' },
        { backup }
      )
    ).rejects.toBeInstanceOf(SwimCloudReplaceRefusedError);
  });
});

describe('withManualSource', () => {
  const base: Recruit = {
    id: 'r1',
    name: 'Hand-Typed Swimmer',
    team: HSU,
    event: '200 IM',
    time: '1:55.00',
    gender: Gender.MEN,
    classYear: 'FR' as Recruit['classYear'],
    timeType: 'SCY',
  };

  it('tags a sourceless row manual', () => {
    expect(withManualSource(base).source).toBe('manual');
  });

  it('leaves an already-sourced row alone', () => {
    const swimCloudRow: Recruit = { ...base, source: 'swimcloud' };
    expect(withManualSource(swimCloudRow)).toBe(swimCloudRow);
  });
});

describe('describeReplaceCounts', () => {
  it('lists only the non-zero planes, pluralized', () => {
    expect(describeReplaceCounts({ history: 1, recruits: 0, plans: 3 })).toBe(
      '1 history row, 3 lineup entries'
    );
    expect(describeReplaceCounts({ history: 0, recruits: 0, plans: 0 })).toBe('nothing');
  });
});
