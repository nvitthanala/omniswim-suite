/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fixtures for the AutoBuilder panel tests: the recorded simulator config C (men, Henderson State and two opponents) in a fresh
 * IndexedDB, with the coach choices a run needs, and a real HiGHS for the opponent re-suggests. Every swimmer, team and time comes from
 * the committed fixture. No competition value is typed here.
 */
import loadHighs from 'highs';
import { autoBuild } from '@omniswim/engine';
import type { AutoBuildResult, LpSolve } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../../apps/extension/src/shared/bridgeSchema';
import { createStorageRepo, openOmniDb, saveScorerOwnTeam, saveScorerRulePreset, toSwimCloudId } from '../../apps/extension/src/storage';
import type { PresetRef, StorageRepo } from '../../apps/extension/src/storage';
import { defaultControls, meetKeyForSnapshot, prepareRequest, snapshotKey } from '../../apps/extension/src/dashboard/autoBuilderRequest';
import type { AutoBuildControls } from '../../apps/extension/src/dashboard/autoBuilderRequest';
import type { TaggedResult } from '../../apps/extension/src/dashboard/autoBuilderResult';
import { freshFactory, steppingClock } from './extensionDb';
import { buildSnapshot } from './simulatorFixtures';
import { withNumericSwimmerIds } from './numericSnapshot';
import { nodeMipSolve } from './nodeMipSolve';

export const RULE_REF: PresetRef = { kind: 'builtin', id: 'nsisc', version: 5 };

let highsPromise: ReturnType<typeof loadHighs> | undefined;
/** The optimizer worker's `solve-lp`, in Node: the same `highs.solve` call, the same reply shape. */
export const realSolveLp: LpSolve = async (lp, options) => {
  highsPromise ??= loadHighs({});
  const highs = await highsPromise;
  const result = highs.solve(lp, options as Parameters<typeof highs.solve>[1]);
  const columns: Record<string, number> = {};
  if (result.Status === 'Optimal') for (const [name, col] of Object.entries(result.Columns)) columns[name] = col.Primal;
  return { status: result.Status, objective: result.ObjectiveValue, columns };
};

export interface ConfigCWorld {
  readonly snapshot: SimSnapshot;
  readonly repo: StorageRepo;
  readonly meetKey: string;
  readonly ownTeamId: string;
  /** The three own swimmers tagged scorer. */
  readonly pinned: readonly string[];
  readonly close: () => void;
}

/** Config C in a fresh store: own team 58, the NSISC v5 rules, three own scorer tags. */
export async function configCWorld(): Promise<ConfigCWorld> {
  // The fixture names swimmers "T48-S01"; the store takes SwimCloud ids only, so the ids become numbers (numericSnapshot.ts).
  const snapshot = withNumericSwimmerIds(buildSnapshot('C').snapshot);
  const meetKey = meetKeyForSnapshot(snapshot);
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: () => 'autobuilder-test' });
  const repo = createStorageRepo(db, { now: steppingClock() });
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey, snapshotId: 'live-snapshot' });
  if (adapted.kind !== 'ready') throw new Error(`config C did not adapt: ${adapted.kind}`);
  const ownTeamId = '58';
  const pinned = adapted.adapted.model.swimmers
    .filter((s) => String(s.teamId) === ownTeamId && s.gender === 'Men')
    .map((s) => String(s.swimmerId))
    .sort()
    .slice(0, 3);
  await saveScorerOwnTeam(repo, meetKey, toSwimCloudId(ownTeamId));
  await saveScorerRulePreset(repo, meetKey, RULE_REF);
  for (const swimmerId of pinned) await repo.put('tags', { meetKey, teamId: toSwimCloudId(ownTeamId), swimmerId: toSwimCloudId(swimmerId), role: 'scorer' }, 'new');
  return { snapshot, repo, meetKey, ownTeamId, pinned, close: () => db.close() };
}

/** Run the AutoBuilder in Node on a world, with the request the panel would send. */
export async function runWorld(world: ConfigCWorld, controls: AutoBuildControls = defaultControls()): Promise<TaggedResult> {
  const prepared = await prepareRequest({ snapshot: world.snapshot, repo: world.repo, solveLp: realSolveLp, controls });
  if (prepared.kind !== 'ready') throw new Error(`the request is not ready: ${prepared.missing.join(' ')}`);
  const result: AutoBuildResult = await autoBuild({ ...prepared.request }, nodeMipSolve());
  return { result, request: prepared.request, inputs: prepared.inputs, controls, snapshotKey: snapshotKey(world.snapshot), loadMs: 0, wallMs: 0 };
}
