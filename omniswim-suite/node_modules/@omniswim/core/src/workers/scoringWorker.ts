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

export type ScoringRequest = {
  id: number;
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
};

const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<ScoringRequest>) => {
  const { id, workspace, gender, removeSeniors } = event.data;
  try {
    const snapshot = buildScoringSnapshot(workspace, gender, removeSeniors);
    ctx.postMessage({ id, ok: true, ...snapshot });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
