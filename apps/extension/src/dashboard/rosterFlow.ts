/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a: the docked panel's roster flow. One instance per page. It owns the run client, the page's season list, and the report of the last
 * finished run, and it saves a finished run (`rosterRun.ts`). The Rosters tab only reads it and calls `fetchRosters`.
 *
 * Nothing here starts on load, on a snapshot or on a port message: `fetchRosters` is called from a click handler, and the run client refuses it
 * unless the posture is `'on-click'`.
 */
import type { ParsedSeasonChoices } from '../shared/bridgeSchema';
import type { FetchOverlayMessage } from '../shared/panelProtocol';
import type { StorageRepo } from '../storage';
import { createFetchRunClient } from './fetchClient';
import type { FetchRunClient, FetchRunClientDeps, RunState } from './fetchClient';
import { planRosterRequests } from './rosterPlan';
import type { PlannedRosterRequest, RosterPlan, RosterSeasonChoice } from './rosterPlan';
import { saveRosterRun } from './rosterRun';
import type { RosterSaveReport } from './rosterRun';
import type { SimGender } from '../shared/fetchProtocol';

export type SeasonList = Extract<ParsedSeasonChoices, { ok: true }>;

export type RosterSaveState =
  | { readonly kind: 'none' }
  | { readonly kind: 'saving'; readonly runId: string }
  | { readonly kind: 'saved'; readonly runId: string; readonly reports: readonly RosterSaveReport[] }
  | { readonly kind: 'save-failed'; readonly runId: string; readonly detail: string };

export interface RosterFlow {
  readonly client: FetchRunClient<PlannedRosterRequest>;
  seasons(): SeasonList | null;
  setSeasons(list: SeasonList): void;
  save(): RosterSaveState;
  /** Plan, then start a run. Returns the plan so the caller can show why nothing started. Call it from a click only. */
  fetchRosters(input: { readonly teamIds: readonly string[]; readonly gender: SimGender; readonly choice: RosterSeasonChoice; readonly posture: 'off' | 'on-click' | undefined }): RosterPlan;
  handle(message: FetchOverlayMessage): void;
  portChanged(): void;
  /** Fires on a season list, a run state or a save state change. */
  subscribe(listener: () => void): () => void;
}

export function createRosterFlow(deps: FetchRunClientDeps & { readonly repo: () => Promise<StorageRepo> }): RosterFlow {
  const client = createFetchRunClient<PlannedRosterRequest>(deps);
  const listeners = new Set<() => void>();
  let seasons: SeasonList | null = null;
  let save: RosterSaveState = { kind: 'none' };
  const notify = (): void => { for (const l of [...listeners]) l(); };
  let lastHandled: string | null = null;

  const onRun = (state: RunState<PlannedRosterRequest>): void => {
    if (state.phase === 'finished' && lastHandled !== state.runId) {
      lastHandled = state.runId;
      const runId = state.runId;
      save = { kind: 'saving', runId };
      notify();
      void deps.repo()
        .then((repo) => saveRosterRun(state.items, repo))
        .then((reports) => { save = { kind: 'saved', runId, reports }; })
        .catch((error: unknown) => { save = { kind: 'save-failed', runId, detail: error instanceof Error ? error.message : String(error) }; })
        .finally(notify);
      return;
    }
    notify();
  };
  client.subscribe(onRun);

  return {
    client,
    seasons: () => seasons,
    setSeasons(list) { seasons = list; notify(); },
    save: () => save,
    fetchRosters({ teamIds, gender, choice, posture }) {
      const plan = planRosterRequests({ teamIds, gender, choice, seasons });
      if (!plan.ok) return plan;
      save = { kind: 'none' };
      client.start('roster', plan.requests, posture);
      return plan;
    },
    handle: (message) => client.handle(message),
    portChanged: () => client.portChanged(),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
