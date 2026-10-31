/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `globalThis.osxHarness`: the probe that tests/extension-harness drives with `frame.evaluate`.
 * It does the things the harness must check from inside an extension page: solve a model on the
 * page's own worker, put and get one setting through the storage repo, report the panel port's
 * counters, list the worker scripts the page started, and seed the own team, rule preset and scorer tags an AutoBuilder run needs
 * (`seedAutoBuild`). It reads and writes no more than that.
 *
 * It is reachable only from this page's own JavaScript world. The simulator page cannot see it:
 * the docked iframe is a cross-origin frame there.
 */
import { createChromeChangeBus, createStorageRepo, openOmniDb, saveScorerOwnTeam, saveScorerRulePreset, toSwimCloudId } from '../storage';
import type { GetResult, SettingsMap, StorageRepo } from '../storage';
import type { SolveLpRequest, SolveMipRequest, SolvedMipResponse, SolvedResponse } from '../shared/optimizerProtocol';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { meetKeyForSnapshot } from './autoBuilderRequest';
import { createOptimizerClient } from './optimizerClient';
import type { PanelStats } from './panelPort';

export type HarnessSetting = 'cutCloseThresholdPct' | 'theme' | 'accent';

export interface OsxHarness {
  readonly host: string;
  solveLp(lp: string, options?: SolveLpRequest['options']): Promise<SolvedResponse>;
  /** The `solve-mip` request (D5 section 11): the Model API, with the dual bound and, at a time limit, the incumbent. */
  solveMip(lp: string, options?: SolveMipRequest['options']): Promise<SolvedMipResponse>;
  /** The worker's reply to a request type it does not implement. */
  probeUnsupported(): Promise<string>;
  /** Create the setting, or update it at the stored `rev`. Returns the stored record. */
  putSetting<K extends HarnessSetting>(key: K, value: SettingsMap[K]): Promise<unknown>;
  getSetting(key: HarnessSetting): Promise<GetResult<'settings'>>;
  /**
   * Store what an AutoBuilder run needs for a meet, as a coach would choose it: the own team, the built-in NSISC v5 rules and a scorer tag per swimmer.
   * Returns the meet key it wrote under.
   */
  seedAutoBuild(snapshot: SimSnapshot, ownTeamId: string, scorerIds: readonly string[]): Promise<string>;
  /** The number of lineup records in the store. */
  lineupCount(): Promise<number>;
  lineupIds(): Promise<readonly string[]>;
  /** Counts every user store, including the two fetched-data caches. */
  storeCounts(): Promise<Readonly<Record<string, number>>>;
  deleteLineupExternally(lineupId: string): Promise<void>;
  /** The script URL of every Worker this page has started, in order. Lets the harness show which worker ran a job. */
  workerStarts(): readonly string[];
  /** `null` when this page is not a docked iframe with a valid nonce. */
  panel(): PanelStats | null;
}

/** Record each `new Worker(url)` this page makes. Harness build only. Workers start lazily, so every one made after install is seen. */
function recordWorkerStarts(): string[] {
  const started: string[] = [];
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      started.push(String(url));
    }
  };
  return started;
}

export function installHarness(host: string, panel: PanelStats | null): OsxHarness {
  const workerStarts = recordWorkerStarts();
  const optimizer = createOptimizerClient();
  let repoPromise: Promise<StorageRepo> | undefined;
  const repo = (): Promise<StorageRepo> => (repoPromise ??= openOmniDb().then((db) => createStorageRepo(db, { bus: createChromeChangeBus(chrome.storage as never) })));

  const harness: OsxHarness = {
    host,
    solveLp: (lp, options) => optimizer.solveLp(lp, options),
    solveMip: (lp, options) => optimizer.solveMip(lp, options),
    probeUnsupported: () => optimizer.probeUnsupported(),
    async putSetting(key, value) {
      const r = await repo();
      const current = await r.get('settings', key);
      return r.put('settings', { key, value } as Parameters<typeof r.put<'settings'>>[1], current.found ? current.value.rev : 'new');
    },
    async getSetting(key) {
      return (await repo()).get('settings', key);
    },
    async seedAutoBuild(snapshot, ownTeamId, scorerIds) {
      const r = await repo();
      const meetKey = meetKeyForSnapshot(snapshot);
      const teamId = toSwimCloudId(ownTeamId);
      await saveScorerOwnTeam(r, meetKey, teamId);
      await saveScorerRulePreset(r, meetKey, { kind: 'builtin', id: 'nsisc', version: 5 });
      for (const swimmerId of scorerIds) await r.put('tags', { meetKey, teamId, swimmerId: toSwimCloudId(swimmerId), role: 'scorer' }, 'new');
      return meetKey;
    },
    async lineupCount() {
      return (await (await repo()).list('lineups')).length;
    },
    async lineupIds() {
      return (await (await repo()).list('lineups')).map((record) => record.lineupId);
    },
    async storeCounts() {
      const r = await repo();
      const stores = ['settings', 'rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'classYearOverrides', 'swimmerHistory', 'rosters'] as const;
      const values = await r.listMany(stores);
      return Object.fromEntries(stores.map(name => [name, values[name].length]));
    },
    async deleteLineupExternally(lineupId) {
      const r = await repo();
      const current = await r.get('lineups', lineupId);
      if (current.found) await r.delete('lineups', lineupId, current.value.rev);
    },
    workerStarts: () => [...workerStarts],
    panel: () => panel,
  };
  (globalThis as { osxHarness?: OsxHarness }).osxHarness = harness;
  return harness;
}
