/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.3a MEDIUM-1: a snapshot is saved with the report facts valued under the same sourcing settings the dashboard scores with
 * (`SIMULATOR_SOURCING`, the settings `rescoreSimulator` scored the stored results under), so a seed fact and its result row come
 * from one valuation. The simulator adapter makes no flyover leg yet, so the test watches the settings `captureReportFacts` gets.
 */
import { describe, expect, it, vi } from 'vitest';
import { SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import { buildSnapshotRecord } from '../apps/extension/src/dashboard/snapshotSave';
import { configCWorld, realSolveLp } from './helpers/autoBuilderFixtures';

const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@omniswim/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@omniswim/engine')>();
  return {
    ...real,
    captureReportFacts: (...args: Parameters<typeof real.captureReportFacts>) => {
      seen.calls.push(args);
      return real.captureReportFacts(...args);
    },
  };
});

describe('buildSnapshotRecord sourcing', () => {
  it('captures the report facts under SIMULATOR_SOURCING, the settings the dashboard scores with', async () => {
    const world = await configCWorld();
    const deps = { repo: world.repo, solveLp: realSolveLp, now: () => '2026-10-31T14:05:09.000Z', newId: () => 'sourcing-1' };
    const built = await buildSnapshotRecord(world.snapshot, 'Config C', deps);
    expect(built.kind).toBe('built');
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]![2]).toStrictEqual(SIMULATOR_SOURCING);
    expect(seen.calls[0]![2]).toBe(SIMULATOR_SOURCING);
    world.close();
  }, 120_000);
});
