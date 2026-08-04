/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Gender, Workspace } from '../types';
import { buildPrelimsDeltaTimeline, buildPrelimsOverUnderByEntryKey, hasPrelimsData } from './prelimsProjection';
import { buildPsychDeltaTimeline, buildPsychOverUnderByEntryKey, hasPsychData, psychResultsForGender } from './psychProjection';
import { mergeScoringSettings } from './scoringDefaults';
import { buildScoringSnapshot, type ScoringBundle } from './scoringEngine';
import type { CatalogTeamRoster } from './rosterCatalog';

type Snapshot = {
  projected: ScoringBundle;
  baseline: ScoringBundle;
  prelimsProjected: ScoringBundle;
  psychProjected: ScoringBundle;
};

type WorkerResponse = {
  id: number;
  ok: boolean;
  projected?: ScoringBundle;
  baseline?: ScoringBundle;
  prelimsProjected?: ScoringBundle;
  psychProjected?: ScoringBundle;
  error?: string;
};

function supportsModuleWorker(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

/**
 * Trailing debounce, in ms, between a workspace change and the recompute it
 * triggers. 200ms sits comfortably above normal keystroke/drag cadence
 * (~50-100ms between events) so a burst of edits collapses into a single
 * recompute, while staying under the ~300ms threshold where UI feedback
 * starts reading as sluggish. `scoringSettled` itself is NOT debounced — see
 * the effect below.
 */
export const SCORING_DEBOUNCE_MS = 200;

/**
 * Whether the scoring worker has settled for the current workspace state
 * (no recompute in flight). Provided by the app that owns useWorkspaceScoring
 * (e.g. ManagerApp) so deeply nested panels can gate actions — like capturing
 * a "· N pts" scenario label — on a non-transient total. Defaults to true so
 * consumers outside a provider behave exactly as before.
 */
export const ScoringSettledContext = createContext<boolean>(true);

/** Read the nearest ScoringSettledContext (true when none is provided). */
export function useScoringSettled(): boolean {
  return useContext(ScoringSettledContext);
}

type UseWorkspaceScoringArgs = {
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
  scoringRefreshKey: number;
  /** Optional roster catalog: long-lived team → athletes → events. When
   *  provided, the eligible catalog swims are layered into the scoring pool
   *  on top of the PDF-meet rows. */
  rosterCatalog?: CatalogTeamRoster;
};

/**
 * Computes projected + baseline + prelims-projected + psych-projected scoring bundles.
 *
 * The first computation runs synchronously (correct first paint). Subsequent
 * recomputes are offloaded to a Web Worker so the UI stays responsive during
 * what-if recalculation on large meets. While the worker runs, the last-good
 * snapshot is retained. Falls back to synchronous compute if workers are
 * unavailable or fail to initialize.
 */
export function useWorkspaceScoring({
  workspace,
  gender,
  removeSeniors,
  scoringRefreshKey,
  rosterCatalog,
}: UseWorkspaceScoringArgs) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() =>
    buildScoringSnapshot(workspace, gender, removeSeniors, rosterCatalog)
  );
  /** False while a worker recompute for the latest workspace state is in flight. */
  const [settled, setSettled] = useState(true);

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const latestHandledRef = useRef(0);
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (!supportsModuleWorker()) return;
    try {
      const worker = new Worker(new URL('../workers/scoringWorker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (!data || data.id < latestHandledRef.current) return;
        latestHandledRef.current = data.id;
        // Settled once the response for the newest posted request arrives.
        if (data.id >= requestIdRef.current) setSettled(true);
        if (
          data.ok &&
          data.projected &&
          data.baseline &&
          data.prelimsProjected &&
          data.psychProjected
        ) {
          setSnapshot({
            projected: data.projected,
            baseline: data.baseline,
            prelimsProjected: data.prelimsProjected,
            psychProjected: data.psychProjected,
          });
        }
      };
      worker.onerror = () => {
        workerRef.current?.terminate();
        workerRef.current = null;
        // Future recomputes run synchronously — nothing left in flight.
        setSettled(true);
      };
      workerRef.current = worker;
    } catch {
      workerRef.current = null;
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    // Correctness: `settled` flips false the instant a watched field changes —
    // synchronously, outside the debounce below. ScenarioSnapshotsPanel gates
    // its Save button on this flag so a scenario can't be captured with a
    // "· N pts" label computed from a workspace state that has already moved
    // on. Only the recompute itself (worker postMessage or the synchronous
    // fallback) may wait out the debounce.
    const id = ++requestIdRef.current;
    setSettled(false);

    const timer = setTimeout(() => {
      const worker = workerRef.current;
      if (worker) {
        const req: { id: number; workspace: Workspace; gender: Gender; removeSeniors: boolean; rosterCatalog?: CatalogTeamRoster } = {
          id,
          workspace,
          gender,
          removeSeniors,
        };
        if (rosterCatalog) req.rosterCatalog = rosterCatalog;
        worker.postMessage(req);
      } else {
        setSnapshot(buildScoringSnapshot(workspace, gender, removeSeniors, rosterCatalog));
        // Settled once the response for the newest posted request "arrives"
        // (here, completes synchronously) — same rule as the worker path.
        if (id >= requestIdRef.current) setSettled(true);
      }
    }, SCORING_DEBOUNCE_MS);

    // Clears the pending timer on unmount and whenever a newer change
    // supersedes it (effect cleanup runs before the next effect invocation),
    // so a burst of changes results in exactly one postMessage/recompute —
    // only the last-scheduled timer ever fires.
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspace.menResults,
    workspace.womenResults,
    workspace.psychMenResults,
    workspace.psychWomenResults,
    workspace.recruits,
    // Alias links change athlete identity, so the bundle must rebuild when one
    // is added or removed — otherwise a just-linked duplicate stays on screen.
    workspace.athleteAliases,
    workspace.deletedSwimmers,
    workspace.relayLegOverrides,
    workspace.meetEntryPlans,
    workspace.entryPlanMode,
    workspace.activeEntryIds,
    workspace.scoringSettings,
    workspace.scorerRosterOverrides,
    workspace.conference,
    workspace.scoringView,
    gender,
    removeSeniors,
    scoringRefreshKey,
    rosterCatalog,
  ]);

  const scoringSettings = useMemo(
    () =>
      mergeScoringSettings(workspace.scoringSettings, {
        conference: workspace.conference,
        resultsForPdfHint: [
          ...(workspace.menResults ?? []),
          ...(workspace.womenResults ?? []),
          ...(workspace.psychMenResults ?? []),
          ...(workspace.psychWomenResults ?? []),
        ],
      }),
    [
      workspace.scoringSettings,
      workspace.conference,
      workspace.menResults,
      workspace.womenResults,
      workspace.psychMenResults,
      workspace.psychWomenResults,
      scoringRefreshKey,
    ]
  );

  const baselineByTeam = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of snapshot.baseline.sortedTeams) {
      map.set(t.teamName, t.totalPoints);
    }
    return map;
  }, [snapshot.baseline.teamStyleSignature]);

  const prelimsByTeam = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of snapshot.prelimsProjected.sortedTeams) {
      map.set(t.teamName, t.totalPoints);
    }
    return map;
  }, [snapshot.prelimsProjected.teamStyleSignature]);

  const psychByTeam = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of snapshot.psychProjected.sortedTeams) {
      map.set(t.teamName, t.totalPoints);
    }
    return map;
  }, [snapshot.psychProjected.teamStyleSignature]);

  const prelimsDeltaTimeline = useMemo(
    () =>
      buildPrelimsDeltaTimeline(
        snapshot.baseline.timelineData,
        snapshot.projected.timelineData,
        snapshot.prelimsProjected.timelineData
      ),
    [
      snapshot.baseline.timelineData,
      snapshot.projected.timelineData,
      snapshot.prelimsProjected.timelineData,
    ]
  );

  const psychDeltaTimeline = useMemo(
    () =>
      buildPsychDeltaTimeline(
        snapshot.baseline.timelineData,
        snapshot.projected.timelineData,
        snapshot.psychProjected.timelineData
      ),
    [
      snapshot.baseline.timelineData,
      snapshot.projected.timelineData,
      snapshot.psychProjected.timelineData,
    ]
  );

  const currentResults =
    gender === Gender.MEN ? (workspace.menResults ?? []) : (workspace.womenResults ?? []);
  const showPrelimsPerformance = hasPrelimsData(currentResults);
  const showPsychPerformance = hasPsychData(psychResultsForGender(workspace, gender));

  const prelimsOuByEntry = useMemo(
    () =>
      showPrelimsPerformance
        ? buildPrelimsOverUnderByEntryKey(
            snapshot.baseline.allScored,
            snapshot.prelimsProjected.allScored
          )
        : new Map(),
    [
      showPrelimsPerformance,
      snapshot.baseline.allScored,
      snapshot.prelimsProjected.allScored,
    ]
  );

  const psychOuByEntry = useMemo(
    () =>
      showPsychPerformance
        ? buildPsychOverUnderByEntryKey(
            snapshot.baseline.allScored,
            snapshot.psychProjected.allScored
          )
        : new Map(),
    [showPsychPerformance, snapshot.baseline.allScored, snapshot.psychProjected.allScored]
  );

  return {
    /** True when no worker recompute is pending for the current workspace state. */
    scoringSettled: settled,
    projected: snapshot.projected,
    baseline: snapshot.baseline,
    prelimsProjected: snapshot.prelimsProjected,
    psychProjected: snapshot.psychProjected,
    scoringSettings,
    baselineByTeam,
    prelimsByTeam,
    psychByTeam,
    prelimsDeltaTimeline,
    psychDeltaTimeline,
    showPrelimsPerformance,
    showPsychPerformance,
    prelimsOuByEntry,
    psychOuByEntry,
  };
}

export type { ScoringBundle } from './scoringEngine';
