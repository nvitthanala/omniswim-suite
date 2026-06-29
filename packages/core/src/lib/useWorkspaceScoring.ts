/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Gender, Workspace } from '../types';
import { buildPrelimsDeltaTimeline, buildPrelimsOverUnderByEntryKey, hasPrelimsData } from './prelimsProjection';
import { buildPsychDeltaTimeline, buildPsychOverUnderByEntryKey, hasPsychData, psychResultsForGender } from './psychProjection';
import { mergeScoringSettings } from './scoringDefaults';
import { buildScoringSnapshot, type ScoringBundle } from './scoringEngine';

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

type UseWorkspaceScoringArgs = {
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
  scoringRefreshKey: number;
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
}: UseWorkspaceScoringArgs) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() =>
    buildScoringSnapshot(workspace, gender, removeSeniors)
  );

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
    workspace.psychMenResults,
    workspace.psychWomenResults,
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
