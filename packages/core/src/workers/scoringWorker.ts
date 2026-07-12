/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Web Worker that runs the scoring engine off the main thread. The shell
 * instantiates this with Vite's `new Worker(new URL(...), { type: 'module' })`.
 */
/// <reference lib="webworker" />
import { buildScoringSnapshot } from '../lib/scoringEngine';
import type { Gender, Workspace } from '../types';
import type { CatalogTeamRoster } from '../lib/rosterCatalog';

export type ScoringRequest = {
  id: number;
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
  rosterCatalog?: CatalogTeamRoster;
};

const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<ScoringRequest>) => {
  const { id, workspace, gender, removeSeniors, rosterCatalog } = event.data;
  try {
    const snapshot = buildScoringSnapshot(workspace, gender, removeSeniors, rosterCatalog);
    ctx.postMessage({ id, ok: true, ...snapshot });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
