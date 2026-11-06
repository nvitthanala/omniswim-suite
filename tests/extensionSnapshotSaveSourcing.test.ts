/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.3a MEDIUM-1 and the live-model wiring (T8): a snapshot is saved with the report facts valued under the sourcing settings the live model
 * carries, so a seed fact and its result row come from one valuation. The test injects a FRESH object equal to `SIMULATOR_SOURCING` through the
 * loader and watches what `captureReportFacts` and `scoreMeet` get: the save must use the injected object, not the constant, and must load the
 * live model once. The simulator adapter makes no flyover leg yet, so the engine's argument is the only place the settings show.
 */
import { describe, expect, it, vi } from 'vitest';
import { SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import { buildSnapshotRecord } from '../apps/extension/src/dashboard/snapshotSave';
import { loadLiveModel } from '../apps/extension/src/dashboard/liveModel';
import type { LiveLoader, LiveModel } from '../apps/extension/src/dashboard/liveModel';
import { saveRosterSeason } from '../apps/extension/src/dashboard/settingsStore';
import { configCWorld, realSolveLp } from './helpers/autoBuilderFixtures';
import { PAST, readyLive } from './helpers/liveFixtures';

const seen = vi.hoisted(() => ({ facts: [] as unknown[][], scores: [] as unknown[][] }));
vi.mock('@omniswim/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@omniswim/engine')>();
  return {
    ...real,
    captureReportFacts: (...args: Parameters<typeof real.captureReportFacts>) => {
      seen.facts.push(args);
      return real.captureReportFacts(...args);
    },
    scoreMeet: (...args: Parameters<typeof real.scoreMeet>) => {
      seen.scores.push(args);
      return real.scoreMeet(...args);
    },
  };
});

describe('buildSnapshotRecord sourcing and the live model', () => {
  it('loads the live model once and captures the facts and results from it, under the sourcing the loader injected', async () => {
    const world = await configCWorld();
    const injected = { ...SIMULATOR_SOURCING };
    expect(injected).toStrictEqual(SIMULATOR_SOURCING);
    expect(injected).not.toBe(SIMULATOR_SOURCING);
    let loads = 0;
    let loaded: LiveModel | undefined;
    const loadLive: LiveLoader = async (snapshot) => {
      loads += 1;
      const out = await loadLiveModel({ snapshot, repo: world.repo, currentLabel: null, sourcing: injected });
      if (out.kind === 'ready') loaded = out.live;
      return out;
    };
    seen.facts.length = 0;
    seen.scores.length = 0;
    const deps = { repo: world.repo, loadLive, solveLp: realSolveLp, now: () => '2026-10-31T14:05:09.000Z', newId: () => 'sourcing-1' };
    const built = await buildSnapshotRecord(world.snapshot, 'Config C', deps);
    expect(built.kind).toBe('built');
    expect(loads).toBe(1);
    if (loaded === undefined) throw new Error('the loader built no live model');
    // The facts: the very model, lineup and sourcing object of the one live model.
    expect(seen.facts).toHaveLength(1);
    expect(seen.facts[0]![0]).toBe(loaded.model);
    expect(seen.facts[0]![1]).toBe(loaded.lineup);
    expect(seen.facts[0]![2]).toBe(injected);
    expect(seen.facts[0]![2]).not.toBe(SIMULATOR_SOURCING);
    // The results of the record: scored once from the same live model, no tags, under the same object.
    const recordScores = seen.scores.filter((call) => call[0] === loaded!.model && call[1] === loaded!.lineup);
    expect(recordScores.length).toBeGreaterThanOrEqual(1);
    for (const call of recordScores) expect(call[4]).toBe(injected);
    if (built.kind === 'built') expect(built.record.payload).toBe(loaded.lineup);
    world.close();
  }, 120_000);

  it('refuses a roster season and says why, after one load; nothing is scored or captured', async () => {
    const world = await configCWorld();
    await saveRosterSeason(world.repo, world.meetKey, { kind: 'season', label: PAST });
    let loads = 0;
    const loadLive: LiveLoader = (snapshot) => { loads += 1; return world.loadLive(snapshot); };
    expect((await readyLive(world.loadLive, world.snapshot)).choice).toEqual({ kind: 'season', label: PAST });
    seen.facts.length = 0;
    const built = await buildSnapshotRecord(world.snapshot, 'Season', { repo: world.repo, loadLive, solveLp: realSolveLp, now: () => '2026-10-31T14:05:09.000Z', newId: () => 'season-1' });
    expect(built).toEqual({ kind: 'refused', reasons: ['Saved snapshots cannot record a roster season yet.'] });
    expect(loads).toBe(1);
    expect(seen.facts).toEqual([]);
    expect(await world.repo.list('lineups')).toEqual([]);
    world.close();
  }, 120_000);
});
