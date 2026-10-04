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
import { newTheoreticalWorkspaceId } from '../../lib/theoreticalMeetWorkspace';
import type { CaptureApi } from './captureApi';
import { buildMeet, createMeet, readTeamCapture, type BuildMeetArgs, type BuiltMeet } from './theoreticalMeetFlow';
import {
  buildScoringChoices,
  describeTheoreticalError,
  eventOrderChoices,
  eventOrderOf,
  groupCaptures,
  pruneSelection,
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
  const [scoringChoiceId, setScoringChoiceId] = useState<string | null>(null);
  const [eventOrderWorkspaceId, setEventOrderWorkspaceId] = useState<string | null>(null);
  const [includeExhibition, setIncludeExhibition] = useState(true);
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

  // A reload can remove or block a capture the user already picked.
  useEffect(() => {
    if (list.status !== 'ready') return;
    setSelected(current => {
      const next = pruneSelection(current, groups);
      return next.length === current.length ? current : next;
    });
  }, [list, groups]);

  const toggleCapture = useCallback((captureId: string) => {
    setSelected(current => (current.includes(captureId) ? current.filter(id => id !== captureId) : [...current, captureId]));
  }, []);

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

  const buildArgs: BuildMeetArgs | null = useMemo(() => {
    if (scoringChoiceId === null || selected.length === 0) return null;
    const results: Record<string, TheoreticalMeetFromCapturesResult | undefined> = {};
    for (const id of selected) {
      const load = teamLoads[id];
      results[id] = load?.status === 'done' ? load.result : undefined;
    }
    const order = eventOrderWorkspaceId === null ? undefined : eventOrderOf(workspaces.find(w => w.id === eventOrderWorkspaceId));
    return {
      captureIds: selected,
      resultsByCaptureId: results,
      scoringChoiceId,
      includeExhibition,
      ...(order === undefined ? {} : { eventOrder: order }),
    };
  }, [selected, teamLoads, scoringChoiceId, includeExhibition, eventOrderWorkspaceId, workspaces]);

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

  const create = useCallback(async () => {
    if (preview.status !== 'ready' || buildArgs === null || creating) return;
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
      if (mountedRef.current) setCreating(false);
    }
  }, [preview, buildArgs, creating, restoreWorkspace, name, onCreated]);

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
