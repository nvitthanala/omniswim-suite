/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builders for the live-model tests. SYNTHETIC rosters over the committed simulator fixture (config C, men, teams 58, 48 and 412). The swimmer
 * ids are numeric (D7 decision I: `withNumericSwimmerIds`), so a roster record can list them. No competition value is typed here.
 */
import { adaptSimulatorSnapshot, SIMULATOR_SOURCING } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../../apps/extension/src/shared/bridgeSchema';
import { toSwimCloudId } from '../../apps/extension/src/storage';
import type { ClassYearCode, RosterRecord, StorageRepo } from '../../apps/extension/src/storage';
import { buildLiveModel, loadLiveModel } from '../../apps/extension/src/dashboard/liveModel';
import type { LiveLoader, LiveModel, LiveStored } from '../../apps/extension/src/dashboard/liveModel';
import type { RosterSeasonChoice } from '../../apps/extension/src/dashboard/rosterPlan';
import { meetKeyForSnapshot } from '../../apps/extension/src/dashboard/meetKey';
import { buildSnapshot } from './simulatorFixtures';
import type { ConfigName } from './simulatorFixtures';
import { withNumericSwimmerIds } from './numericSnapshot';

export const AT = '2026-11-06T00:00:00.000Z';
export const CURRENT = '2026-2027';
export const PAST = '2025-2026';

export const emptyStored = (): LiveStored => ({ membership: new Map(), current: new Map(), overrides: [] });

export const numericSnapshot = (config: ConfigName = 'C'): SimSnapshot => withNumericSwimmerIds(buildSnapshot(config).snapshot);

/** The adapter's own output for a snapshot: the reference every simulator-current comparison reads. */
export function adaptedOf(snapshot: SimSnapshot) {
  const out = adaptSimulatorSnapshot(snapshot, { meetKey: meetKeyForSnapshot(snapshot), snapshotId: 'live-snapshot' });
  if (out.kind !== 'ready') throw new Error(`the fixture did not adapt: ${out.kind}`);
  return out.adapted;
}

/** The ids of a team's swimmers, sorted. Read from the adapter, so the fixture is the source. */
export const swimmersOf = (snapshot: SimSnapshot, teamId: string): string[] =>
  adaptedOf(snapshot).model.swimmers.filter((s) => String(s.teamId) === teamId).map((s) => String(s.swimmerId)).sort();

export function rosterRecord(teamId: string, seasonId: string, memberIds: readonly string[], extra: Partial<RosterRecord> = {}): RosterRecord {
  return {
    teamId: toSwimCloudId(teamId), seasonId, gender: 'Men', memberIds: memberIds.map(toSwimCloudId),
    sourceUrl: `https://www.swimcloud.com/team/${teamId}/roster/?gender=M`, fetchedAt: AT, parser: { name: 'readRosterFetch', confidence: 'synthetic-test' },
    ...extra,
  };
}

export function classYearsFor(ids: readonly string[], codes: readonly ClassYearCode[] = ['FR', 'SO', 'JR', 'SR', 'GR']): Record<string, ClassYearCode> {
  return Object.fromEntries(ids.map((id, i) => [id, codes[i % codes.length] as ClassYearCode]));
}

export function storedOf(parts: { membership?: readonly RosterRecord[]; current?: readonly RosterRecord[]; overrides?: LiveStored['overrides'] }): LiveStored {
  const byTeam = (rows: readonly RosterRecord[] = []): Map<string, RosterRecord> => new Map(rows.map((r) => [String(r.teamId), r]));
  return { membership: byTeam(parts.membership), current: byTeam(parts.current), overrides: parts.overrides ?? [] };
}

export function liveOf(snapshot: SimSnapshot, opts: { choice?: RosterSeasonChoice; currentLabel?: string | null; stored?: LiveStored; sourcing?: typeof SIMULATOR_SOURCING } = {}): LiveModel {
  const out = buildLiveModel({
    snapshot,
    choice: opts.choice ?? { kind: 'simulator-current' },
    currentLabel: opts.currentLabel === undefined ? null : opts.currentLabel,
    stored: opts.stored ?? emptyStored(),
    sourcing: opts.sourcing ?? SIMULATOR_SOURCING,
  });
  if (out.kind !== 'ready') throw new Error(`the live model is not ready: ${out.kind === 'error' ? out.reason : out.missing.join(', ')}`);
  return out.live;
}

/** The real loader over a repo: what the dashboard's `liveLoader` does, with `SIMULATOR_SOURCING` and a fixed current-season label. */
export const repoLoader = (repo: StorageRepo, currentLabel: string | null = null): LiveLoader => (snapshot) =>
  loadLiveModel({ snapshot, repo, currentLabel, sourcing: SIMULATOR_SOURCING });

/** The ready live model, or a thrown error that names why it is not ready. */
export async function readyLive(loader: LiveLoader, snapshot: SimSnapshot): Promise<LiveModel> {
  const out = await loader(snapshot);
  if (out.kind !== 'ready') throw new Error(`the live model is not ready: ${out.kind === 'error' ? out.reason : out.missing.join(', ')}`);
  return out.live;
}
