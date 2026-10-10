/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * State for the "Build theoretical meet" dialog. Wraps `theoreticalMeetFlow.ts` (the data-layer calls)
 * in React state: the capture list, the picked teams, the per-team read, the preview, and Create.
 *
 * Nothing here computes a competition value. The preview is `buildMeet`'s output and a thrown
 * data-layer error becomes a `TheoreticalProblem` that blocks Create.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '@omniswim/core/types';
import type { TheoreticalMeetFromCapturesResult } from '../../lib/theoreticalMeetFromCaptures';
import type { RelayFlyingStartAdjustment, RelayLegDistance, TheoreticalEventExclusion } from '../../lib/theoreticalMeetSeeds';
import { newTheoreticalWorkspaceId } from '../../lib/theoreticalMeetWorkspace';
import type { CaptureApi } from './captureApi';
import { buildMeet, createMeet, readTeamCapture, type BuildMeetArgs, type BuiltMeet } from './theoreticalMeetFlow';
import {
  buildScoringChoices,
  describeTheoreticalError,
  dropRemovalsForTeams,
  eventOrderChoices,
  eventOrderOf,
  groupCaptures,
  parseFlyingStartText,
  parseMaxRelaysText,
  pruneSelection,
  toggleRemoval,
  type CaptureListRecord,
  type CaptureTeamGroup,
  type TheoreticalProblem,
} from './theoreticalMeetView';

export type FlowStep = 'teams' | 'scoring' | 'preview';

export type CaptureListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly records: readonly CaptureListRecord[] }
  | { readonly status: 'error'; readonly problem: TheoreticalProblem };

export type TeamLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly result: TheoreticalMeetFromCapturesResult }
  | { readonly status: 'failed'; readonly problem: TheoreticalProblem };

export type PreviewState =
  | { readonly status: 'waiting' }
  | { readonly status: 'ready'; readonly built: BuiltMeet }
  | { readonly status: 'error'; readonly problem: TheoreticalProblem };

export interface FlowOptions {
  readonly api: CaptureApi;
  /** Every workspace the app holds. Used for the event-order choices and the fresh-id check. */
  readonly workspaces: readonly Workspace[];
  readonly restoreWorkspace: (workspace: Workspace) => Promise<Workspace>;
  readonly onCreated: (workspace: Workspace) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export function useTheoreticalMeetFlow(options: FlowOptions) {
  const { api, workspaces, restoreWorkspace, onCreated } = options;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;
  const newIdRef = useRef(options.newId ?? newTheoreticalWorkspaceId);
  newIdRef.current = options.newId ?? newTheoreticalWorkspaceId;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  const [list, setList] = useState<CaptureListState>({ status: 'loading' });
  const [listVersion, setListVersion] = useState(0);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [step, setStep] = useState<FlowStep>('teams');
  const [scoringChoiceId, setScoringChoiceIdState] = useState<string | null>(null);
  const [eventOrderWorkspaceId, setEventOrderWorkspaceId] = useState<string | null>(null);
  const [includeExhibition, setIncludeExhibitionState] = useState(true);
  // Relays (estimates) are on by default. The flying-start adjustment is OFF by default and has no default value:
  // the user types seconds per leg distance, and an empty box means no adjustment for that distance.
  const [includeRelays, setIncludeRelaysState] = useState(true);
  const [flyingStartOn, setFlyingStartOn] = useState(false);
  const [flyingStartText, setFlyingStartText] = useState<Readonly<Record<RelayLegDistance, string>>>({ 50: '', 100: '', 200: '' });
  // "Relays per swimmer: at most N". Empty (the default) means no limit beyond the entry caps.
  const [maxRelaysText, setMaxRelaysText] = useState('');
  // Events the user removed in the preview, keyed by team, gender, swimmer and event (no meet id).
  const [removals, setRemovals] = useState<Readonly<Record<string, TheoreticalEventExclusion>>>({});
  const [name, setName] = useState('');
  const [teamLoads, setTeamLoads] = useState<Readonly<Record<string, TeamLoadState>>>({});
  const [creating, setCreating] = useState(false);
  const [createProblem, setCreateProblem] = useState<TheoreticalProblem | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ---- capture list ---- */

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    api.listCaptures().then(
      records => {
        if (!cancelled) setList({ status: 'ready', records });
      },
      err => {
        if (!cancelled) setList({ status: 'error', problem: describeTheoreticalError(err) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, listVersion]);

  const reloadList = useCallback(() => {
    setTeamLoads({});
    setListVersion(v => v + 1);
  }, []);

  const groups: CaptureTeamGroup[] = useMemo(
    () => (list.status === 'ready' ? groupCaptures(list.records, nowRef.current()) : []),
    [list]
  );

  // The team names each capture gave when it was read. Kept across reloads, so the removals of a capture that a
  // reload drops can still be tied to its teams.
  const teamNamesByCaptureRef = useRef(new Map<string, readonly string[]>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // A reload can remove or block a capture the user already picked. The removals of a team that left with it go too.
  useEffect(() => {
    if (list.status !== 'ready') return;
    const current = selectedRef.current;
    const next = pruneSelection(current, groups);
    if (next.length === current.length) return;
    const kept = new Set(next);
    const namesOf = (ids: readonly string[]) => ids.flatMap(id => teamNamesByCaptureRef.current.get(id) ?? []);
    const droppedNames = namesOf(current.filter(id => !kept.has(id)));
    const keptNames = namesOf(next);
    setSelected(next);
    if (droppedNames.length > 0) setRemovals(removals => dropRemovalsForTeams(removals, droppedNames, keptNames));
  }, [list, groups]);

  // A removal belongs to the field it was made in. A new team, scoring rule or exhibition switch makes a new
  // field, so earlier removals are dropped rather than carried into it unseen.
  const clearRemovals = useCallback(() => setRemovals(current => (Object.keys(current).length === 0 ? current : {})), []);
  const toggleEventRemoval = useCallback((removal: TheoreticalEventExclusion) => setRemovals(current => toggleRemoval(current, removal)), []);

  const toggleCapture = useCallback(
    (captureId: string) => {
      setSelected(current => (current.includes(captureId) ? current.filter(id => id !== captureId) : [...current, captureId]));
      clearRemovals();
    },
    [clearRemovals]
  );
  const setScoringChoiceId = useCallback(
    (id: string | null) => {
      setScoringChoiceIdState(id);
      clearRemovals();
    },
    [clearRemovals]
  );
  const setIncludeExhibition = useCallback(
    (include: boolean) => {
      setIncludeExhibitionState(include);
      clearRemovals();
    },
    [clearRemovals]
  );

  const setIncludeRelays = useCallback(
    (include: boolean) => {
      setIncludeRelaysState(include);
      clearRemovals();
    },
    [clearRemovals]
  );
  const setFlyingStartSeconds = useCallback((distance: RelayLegDistance, text: string) => setFlyingStartText(current => ({ ...current, [distance]: text })), []);

  /* ---- per-team read, run when the preview step is open ---- */

  const loadingRef = useRef(new Set<string>());

  const readOne = useCallback(
    (captureId: string, records: readonly CaptureListRecord[]) => {
      if (loadingRef.current.has(captureId)) return;
      loadingRef.current.add(captureId);
      setTeamLoads(current => ({ ...current, [captureId]: { status: 'loading' } }));
      readTeamCapture(api, captureId, records).then(
        result => {
          loadingRef.current.delete(captureId);
          teamNamesByCaptureRef.current.set(captureId, result.teams.map(t => t.teamName));
          if (mountedRef.current) setTeamLoads(current => ({ ...current, [captureId]: { status: 'done', result } }));
        },
        err => {
          loadingRef.current.delete(captureId);
          if (mountedRef.current) setTeamLoads(current => ({ ...current, [captureId]: { status: 'failed', problem: describeTheoreticalError(err) } }));
        }
      );
    },
    [api]
  );

  useEffect(() => {
    if (step !== 'preview' || list.status !== 'ready') return;
    for (const id of selected) {
      if (teamLoads[id] === undefined) readOne(id, list.records);
    }
  }, [step, selected, list, teamLoads, readOne]);

  const retryTeam = useCallback(
    (captureId: string) => {
      if (list.status !== 'ready') return;
      setTeamLoads(current => {
        const { [captureId]: _dropped, ...rest } = current;
        return rest;
      });
      loadingRef.current.delete(captureId);
      readOne(captureId, list.records);
    },
    [list, readOne]
  );

  /* ---- choices ---- */

  const scoringChoices = useMemo(() => buildScoringChoices(), []);
  const eventOrders = useMemo(() => eventOrderChoices(workspaces), [workspaces]);

  /* ---- preview ---- */

  // One id per dialog session. The preview and the created workspace use it unless it is taken.
  const previewIdRef = useRef<string | null>(null);

  const adjustment: RelayFlyingStartAdjustment | undefined = useMemo(
    () => (flyingStartOn ? parseFlyingStartText(flyingStartText) : undefined),
    [flyingStartOn, flyingStartText]
  );

  const maxRelaysPerSwimmer: number | undefined = useMemo(() => parseMaxRelaysText(maxRelaysText), [maxRelaysText]);

  const buildArgs: BuildMeetArgs | null = useMemo(() => {
    if (scoringChoiceId === null || selected.length === 0) return null;
    const results: Record<string, TheoreticalMeetFromCapturesResult | undefined> = {};
    for (const id of selected) {
      const load = teamLoads[id];
      results[id] = load?.status === 'done' ? load.result : undefined;
    }
    const order = eventOrderWorkspaceId === null ? undefined : eventOrderOf(workspaces.find(w => w.id === eventOrderWorkspaceId));
    const excludedEvents = Object.values(removals);
    return {
      captureIds: selected,
      resultsByCaptureId: results,
      scoringChoiceId,
      includeExhibition,
      ...(order === undefined ? {} : { eventOrder: order }),
      ...(excludedEvents.length === 0 ? {} : { excludedEvents }),
      ...(includeRelays
        ? {
            includeRelays: true,
            ...(adjustment === undefined ? {} : { relayFlyingStartAdjustmentSec: adjustment }),
            ...(maxRelaysPerSwimmer === undefined ? {} : { maxRelaysPerSwimmer }),
          }
        : {}),
    };
  }, [selected, teamLoads, scoringChoiceId, includeExhibition, eventOrderWorkspaceId, workspaces, removals, includeRelays, adjustment, maxRelaysPerSwimmer]);

  const allRead = selected.length > 0 && selected.every(id => teamLoads[id]?.status === 'done');
  const anyFailed = selected.some(id => teamLoads[id]?.status === 'failed');

  const preview: PreviewState = useMemo(() => {
    if (step !== 'preview' || buildArgs === null || !allRead) return { status: 'waiting' };
    try {
      previewIdRef.current ??= newIdRef.current();
      return { status: 'ready', built: buildMeet(buildArgs, previewIdRef.current, nowRef.current()) };
    } catch (err) {
      return { status: 'error', problem: describeTheoreticalError(err) };
    }
  }, [step, buildArgs, allRead]);

  /* ---- create ---- */

  // A ref, not the `creating` state: two clicks in one tick both see the same stale state value.
  const creatingRef = useRef(false);
  const create = useCallback(async () => {
    if (preview.status !== 'ready' || buildArgs === null || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateProblem(null);
    try {
      const { workspace } = await createMeet(
        {
          restoreWorkspace,
          existingWorkspaceIds: () => workspacesRef.current.map(w => w.id),
          newId: newIdRef.current,
          now: nowRef.current,
        },
        buildArgs,
        preview.built,
        name
      );
      if (mountedRef.current) onCreated(workspace);
    } catch (err) {
      if (mountedRef.current) setCreateProblem(describeTheoreticalError(err));
    } finally {
      creatingRef.current = false;
      if (mountedRef.current) setCreating(false);
    }
  }, [preview, buildArgs, restoreWorkspace, name, onCreated]);

  return {
    list,
    groups,
    reloadList,
    selected,
    toggleCapture,
    step,
    setStep,
    scoringChoices,
    scoringChoiceId,
    setScoringChoiceId,
    eventOrders,
    eventOrderWorkspaceId,
    setEventOrderWorkspaceId,
    includeExhibition,
    setIncludeExhibition,
    includeRelays,
    setIncludeRelays,
    flyingStartOn,
    setFlyingStartOn,
    flyingStartText,
    setFlyingStartSeconds,
    maxRelaysText,
    setMaxRelaysText,
    removals,
    toggleEventRemoval,
    clearRemovals,
    name,
    setName,
    teamLoads,
    retryTeam,
    allRead,
    anyFailed,
    preview,
    creating,
    createProblem,
    create,
  };
}

export type TheoreticalMeetFlow = ReturnType<typeof useTheoreticalMeetFlow>;
