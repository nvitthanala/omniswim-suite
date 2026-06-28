/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Gender, Workspace } from '../types';
import { buildPrelimsDeltaTimeline, hasPrelimsData } from './prelimsProjection';
import { mergeScoringSettings } from './scoringDefaults';
import { buildScoringSnapshot, type ScoringBundle } from './scoringEngine';

type Snapshot = { projected: ScoringBundle; baseline: ScoringBundle; prelimsProjected: ScoringBundle };

type WorkerResponse = {
  id: number;
  ok: boolean;
  projected?: ScoringBundle;
  baseline?: ScoringBundle;
  prelimsProjected?: ScoringBundle;
  error?: string;
};

function supportsModuleWorker(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

type UseWorkspaceScoringArgs = {
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
  scoringRefreshKey: number;
};

/**
 * Computes projected + baseline + prelims-projected scoring bundles.
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
}: UseWorkspaceScoringArgs) {
  // Synchronous first snapshot — guarantees correct initial render.
  const [snapshot, setSnapshot] = useState<Snapshot>(() =>
    buildScoringSnapshot(workspace, gender, removeSeniors)
  );

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const latestHandledRef = useRef(0);
  const isFirstRun = useRef(true);

  // Lazily create the worker once.
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
        if (data.ok && data.projected && data.baseline && data.prelimsProjected) {
          setSnapshot({
            projected: data.projected,
            baseline: data.baseline,
            prelimsProjected: data.prelimsProjected,
          });
        }
      };
      worker.onerror = () => {
        // Disable worker; fall back to sync compute on subsequent changes.
        workerRef.current?.terminate();
        workerRef.current = null;
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

  // Recompute whenever scoring-relevant inputs change.
  useEffect(() => {
    // Skip the very first effect run — initial state already computed it.
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const worker = workerRef.current;
    if (worker) {
      const id = ++requestIdRef.current;
      worker.postMessage({ id, workspace, gender, removeSeniors });
    } else {
      setSnapshot(buildScoringSnapshot(workspace, gender, removeSeniors));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspace.menResults,
    workspace.womenResults,
    workspace.recruits,
    workspace.deletedSwimmers,
    workspace.relayLegOverrides,
    workspace.meetEntryPlans,
    workspace.entryPlanMode,
    workspace.activeEntryIds,
    workspace.scoringSettings,
    workspace.scorerRosterOverrides,
    workspace.conference,
    gender,
    removeSeniors,
    scoringRefreshKey,
  ]);

  const scoringSettings = useMemo(
    () =>
      mergeScoringSettings(workspace.scoringSettings, {
        conference: workspace.conference,
        resultsForPdfHint: [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])],
      }),
    [
      workspace.scoringSettings,
      workspace.conference,
      workspace.menResults,
      workspace.womenResults,
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

  const currentResults =
    gender === Gender.MEN ? (workspace.menResults ?? []) : (workspace.womenResults ?? []);
  const showPrelimsPerformance = hasPrelimsData(currentResults);

  return {
    projected: snapshot.projected,
    baseline: snapshot.baseline,
    prelimsProjected: snapshot.prelimsProjected,
    scoringSettings,
    baselineByTeam,
    prelimsByTeam,
    prelimsDeltaTimeline,
    showPrelimsPerformance,
  };
}

export type { ScoringBundle } from './scoringEngine';
