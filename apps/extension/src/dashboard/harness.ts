/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `globalThis.osxHarness`: the probe that tests/extension-harness drives with `frame.evaluate`.
 * It does three things the harness must check from inside an extension page: solve a model on the
 * page's own worker, put and get one setting through the storage repo, and report the panel port's
 * counters. It reads and writes no more than that.
 *
 * It is reachable only from this page's own JavaScript world. The simulator page cannot see it:
 * the docked iframe is a cross-origin frame there.
 */
import { createStorageRepo, openOmniDb } from '../storage';
import type { GetResult, SettingsMap, StorageRepo } from '../storage';
import type { SolveLpRequest, SolveMipRequest, SolvedMipResponse, SolvedResponse } from '../shared/optimizerProtocol';
import { createOptimizerClient } from './optimizerClient';
import type { PanelStats } from './panelPort';

export type HarnessSetting = 'cutCloseThresholdPct';

export interface OsxHarness {
  readonly host: string;
  solveLp(lp: string, options?: SolveLpRequest['options']): Promise<SolvedResponse>;
  /** The `solve-mip` request (D5 section 11): the Model API, with the dual bound and, at a time limit, the incumbent. */
  solveMip(lp: string, options?: SolveMipRequest['options']): Promise<SolvedMipResponse>;
  /** The worker's reply to a request type it does not implement. */
  probeUnsupported(): Promise<string>;
  /** Create the setting, or update it at the stored `rev`. Returns the stored record. */
  putSetting(key: HarnessSetting, value: SettingsMap[HarnessSetting]): Promise<unknown>;
  getSetting(key: HarnessSetting): Promise<GetResult<'settings'>>;
  /** `null` when this page is not a docked iframe with a valid nonce. */
  panel(): PanelStats | null;
}

export function installHarness(host: string, panel: PanelStats | null): OsxHarness {
  const optimizer = createOptimizerClient();
  let repoPromise: Promise<StorageRepo> | undefined;
  const repo = (): Promise<StorageRepo> => (repoPromise ??= openOmniDb().then((db) => createStorageRepo(db)));

  const harness: OsxHarness = {
    host,
    solveLp: (lp, options) => optimizer.solveLp(lp, options),
    solveMip: (lp, options) => optimizer.solveMip(lp, options),
    probeUnsupported: () => optimizer.probeUnsupported(),
    async putSetting(key, value) {
      const r = await repo();
      const current = await r.get('settings', key);
      return r.put('settings', { key, value }, current.found ? current.value.rev : 'new');
    },
    async getSetting(key) {
      return (await repo()).get('settings', key);
    },
    panel: () => panel,
  };
  (globalThis as { osxHarness?: OsxHarness }).osxHarness = harness;
  return harness;
}
