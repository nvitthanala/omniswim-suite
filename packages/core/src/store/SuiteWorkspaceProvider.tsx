import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gender, type Workspace } from '../types';
import {
  createWorkspace,
  deleteWorkspaceApi,
  fetchWorkspaces,
  StaleSaveError,
  updateWorkspaceApi,
  VersionConflictError,
  workspaceVersion,
} from '../api/workspaces';

/** One random id per page load. The server compares save numbers only within one id. */
function newSaveClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  // Non-secure contexts (plain http on a LAN address) have no randomUUID.
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * What became of one edit queued with `saveWorkspace`.
 *
 * - `ok`: the server stored it; `workspace` is the stored copy.
 * - `conflict`: the workspace changed elsewhere. The edit is on screen, unsaved, and autosave is
 *   paused until `reloadWorkspace`. This is not a generic failure: the banner owns it.
 * - `stale`: the server already holds a newer save from this page and ignored this one.
 * - `error`: the request failed (network, 4xx/5xx). `message` is the reason; the user was notified.
 * - `discarded`: the edit was dropped before it was sent (Reload, delete, or the provider unmounted).
 * - `no-workspace`: no workspace was open, so nothing was queued.
 */
export type WorkspaceSaveResult =
  | { ok: true; workspace: Workspace }
  | {
      ok: false;
      reason: 'conflict' | 'stale' | 'error' | 'discarded' | 'no-workspace';
      message: string;
    };

type SaveWaiter = (result: WorkspaceSaveResult) => void;

const CONFLICT_RESULT: WorkspaceSaveResult = {
  ok: false,
  reason: 'conflict',
  message: 'This workspace changed in another tab. Reload to see the latest version.',
};
const DISCARDED_RESULT: WorkspaceSaveResult = {
  ok: false,
  reason: 'discarded',
  message: 'The change was dropped before it was saved.',
};

export type AppletId = 'home' | 'manager' | 'matrix' | 'metrics';

export type NotifyKind = 'error' | 'success' | 'info';

type SuiteWorkspaceContextValue = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeWorkspace: Workspace | undefined;
  activeGender: Gender;
  isLoading: boolean;
  error: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
  setActiveGender: (gender: Gender) => void;
  createWorkspace: (name?: string) => Promise<Workspace>;
  /**
   * Queue an edit. Resolves as soon as the edit is on screen and queued, NOT when it is saved, so
   * existing callers do not wait on the network. A failed save is shown to the user (notice, error
   * banner or conflict banner) but not reported here. Use `saveWorkspace` when the caller must
   * know whether the edit was stored.
   */
  updateWorkspace: (patch: Partial<Workspace>) => Promise<void>;
  /**
   * Same queueing as `updateWorkspace`, but resolves with the outcome once the save carrying this
   * edit settles. Never rejects. Edits merged into one request all resolve with that request's result.
   */
  saveWorkspace: (patch: Partial<Workspace>) => Promise<WorkspaceSaveResult>;
  deleteWorkspace: (id: string) => Promise<void>;
  restoreWorkspace: (workspace: Workspace) => Promise<Workspace>;
  refreshWorkspaces: () => Promise<void>;
  /**
   * Ids of workspaces whose last save was refused because another tab, user or script
   * changed them first. Autosave is paused for these and the local edits are still on
   * screen, unsaved. Only {@link reloadWorkspace} clears an id (and discards the edits).
   */
  versionConflictIds: string[];
  /** Refetch from the server and drop this tab's unsaved edits to `id`. Clears its conflict. */
  reloadWorkspace: (id: string) => Promise<void>;
  rosterNames: string[];
};

const SuiteWorkspaceContext = createContext<SuiteWorkspaceContextValue | null>(null);

const WORKSPACES_KEY = ['workspaces'] as const;
const WORKSPACE_KEY = 'omni-active-workspace-id';
const GENDER_KEY = 'omni-active-gender';

function collectRosterNames(workspace: Workspace | undefined): string[] {
  if (!workspace) return [];
  const names = new Set<string>();
  for (const r of [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])]) {
    if (r.name && !r.isRelay) names.add(r.name);
  }
  for (const r of workspace.recruits ?? []) {
    if (r.name) names.add(r.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function SuiteWorkspaceProvider({
  children,
  onNotify,
}: {
  children: ReactNode;
  /** Optional sink for user-facing notifications (wired to toasts in the shell). */
  onNotify?: (kind: NotifyKind, message: string) => void;
}) {
  const queryClient = useQueryClient();
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  const notify = useCallback((kind: NotifyKind, message: string) => {
    notifyRef.current?.(kind, message);
  }, []);

  /**
   * Save bookkeeping, per workspace id. One save is in flight per workspace at a time:
   * an edit made meanwhile joins `pendingRef` and goes out when that PUT finishes, so a
   * save never carries a version the previous save is about to move on.
   */
  const inFlightRef = useRef(new Set<string>());
  /** Edits not yet sent: waiting out the debounce, or waiting for the PUT in flight. */
  const pendingRef = useRef(new Map<string, Partial<Workspace>>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /**
   * The version this tab last saw from the server, sent as the expected version on a
   * save. Written ONLY from a list fetch (when that workspace has nothing pending or in
   * flight) and from a successful PUT / create response. Deliberately never read back
   * from the query cache: `onSuccess` skips the cache write when a save is overtaken, so
   * the cache can hold a version a later save has already moved past.
   */
  const knownVersionRef = useRef(new Map<string, number>());
  const conflictRef = useRef(new Set<string>());
  /** Callers of `saveWorkspace` waiting on the queued (not yet sent) patch, per workspace. */
  const waitersRef = useRef(new Map<string, SaveWaiter[]>());
  const [versionConflictIds, setVersionConflictIds] = useState<string[]>([]);

  const loadWorkspaces = useCallback(async () => {
    const list = await fetchWorkspaces();
    // A workspace with an unsent, in-flight or refused edit is "held": this tab has changes to it
    // that the server does not. A version conflict always leaves its edits queued, so a conflicted
    // workspace is held until Reload clears the queue. Reload is the only fetch that may replace it.
    const isHeld = (id: string) =>
      inFlightRef.current.has(id) || pendingRef.current.has(id) || timersRef.current.has(id);
    const shown = new Map(
      (queryClient.getQueryData<Workspace[]>(WORKSPACES_KEY) ?? []).map(w => [w.id, w] as const)
    );
    for (const w of list) {
      const v = workspaceVersion(w);
      if (v === undefined) continue;
      // A fetch answers "what does the server hold?"; it must not overwrite what a save in
      // progress already knows, and it never moves a known version backwards.
      if (isHeld(w.id)) continue;
      const known = knownVersionRef.current.get(w.id);
      if (known === undefined || v > known) knownVersionRef.current.set(w.id, v);
    }
    // The data is held back the same way as the version: a list refetch (a snapshot restore, a
    // failed save elsewhere) must not swap the user's edits for the server copy under the banner.
    return list.map(w => (isHeld(w.id) ? (shown.get(w.id) ?? w) : w));
  }, [queryClient]);

  const {
    data: workspaces = [],
    isLoading,
    isSuccess,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: loadWorkspaces,
  });

  /**
   * The user's *intent*. The selection actually handed to consumers is derived
   * from this plus the live list (see `activeWorkspaceId` below), so this value
   * is allowed to lag or to name a workspace that no longer exists.
   */
  const [storedWorkspaceId, setStoredWorkspaceId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(WORKSPACE_KEY);
  });
  const [activeGender, setActiveGenderState] = useState<Gender>(() => {
    if (typeof window === 'undefined') return Gender.MEN;
    const stored = window.localStorage.getItem(GENDER_KEY);
    return stored === Gender.WOMEN ? Gender.WOMEN : Gender.MEN;
  });
  const [mutationError, setMutationError] = useState<string | null>(null);
  /** Latest save number sent per workspace id. See `flushUpdate` and the `onSuccess` below. */
  const saveSeqRef = useRef(new Map<string, number>());
  /** Names this page load to the server, which orders saves per client id. */
  const saveClientIdRef = useRef<string | null>(null);
  if (saveClientIdRef.current === null) saveClientIdRef.current = newSaveClientId();

  const error = mutationError ?? (queryError ? 'Failed to load workspaces' : null);

  /**
   * Single authority for "which workspace is selected".
   *
   * This used to be two writers that could disagree: an effect that snapped the
   * selection to `workspaces[0]` whenever the list changed, and `deleteWorkspace`'s
   * own inline pick which re-read the query cache from inside a `useState`
   * updater (an impure reducer — React is free to replay update queues, so its
   * answer depended on when React happened to run it).
   *
   * Deriving the selection during render instead makes it a pure function of
   * (intent, list). It can never name a row that is not in the list, two
   * writers can never hand it back and forth, and deleting a workspace needs no
   * selection logic of its own — dropping the row from the list is enough.
   */
  const activeWorkspaceId = useMemo(() => {
    const firstWorkspace = workspaces[0];
    if (firstWorkspace === undefined) return null;
    if (storedWorkspaceId != null && workspaces.some(w => w.id === storedWorkspaceId)) {
      return storedWorkspaceId;
    }
    return firstWorkspace.id;
  }, [workspaces, storedWorkspaceId]);

  // Mirror the resolved id back into intent so the two cannot drift. Only ever
  // writes a real id: while the list is still loading the derived value is null,
  // and clobbering intent there would throw away the restored-from-storage
  // selection before the list arrives.
  useEffect(() => {
    if (activeWorkspaceId == null) return;
    setStoredWorkspaceId(current => (current === activeWorkspaceId ? current : activeWorkspaceId));
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeWorkspaceId != null) {
      window.localStorage.setItem(WORKSPACE_KEY, activeWorkspaceId);
    } else if (isSuccess && workspaces.length === 0) {
      // Every workspace really is gone — don't leave a dead id to restore on reload.
      window.localStorage.removeItem(WORKSPACE_KEY);
    }
  }, [activeWorkspaceId, isSuccess, workspaces.length]);

  // A queued autosave must not outlive the provider.
  useEffect(() => {
    const timers = timersRef.current;
    const waiters = waitersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const list of waiters.values()) for (const w of list) w(DISCARDED_RESULT);
      waiters.clear();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(GENDER_KEY, activeGender);
  }, [activeGender]);

  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId]
  );

  const rosterNames = useMemo(() => collectRosterNames(activeWorkspace), [activeWorkspace]);

  // Guard the cast: a caller handing us `undefined` (e.g. an id read off a
  // malformed create response) must land on "no selection", not on a value that
  // reads as absent to `!= null` but not to `=== null`.
  const setActiveWorkspaceId = useCallback((id: string | null) => {
    setStoredWorkspaceId(typeof id === 'string' ? id : null);
  }, []);

  const setActiveGender = useCallback((gender: Gender) => {
    setActiveGenderState(gender);
  }, []);

  const setCache = useCallback(
    (updater: (list: Workspace[]) => Workspace[]) => {
      queryClient.setQueryData<Workspace[]>(WORKSPACES_KEY, prev => updater(prev ?? []));
    },
    [queryClient]
  );

  const setConflict = useCallback((id: string, on: boolean) => {
    if (on) conflictRef.current.add(id);
    else conflictRef.current.delete(id);
    setVersionConflictIds([...conflictRef.current]);
  }, []);

  const clearQueuedSave = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) clearTimeout(t);
    timersRef.current.delete(id);
    pendingRef.current.delete(id);
    // Whoever waited on the dropped edit must hear that it is gone, not wait forever.
    const dropped = waitersRef.current.get(id);
    waitersRef.current.delete(id);
    if (dropped) for (const w of dropped) w(DISCARDED_RESULT);
  }, []);

  const sendSaveRef = useRef<(id: string, patch: Partial<Workspace>, waiters: SaveWaiter[]) => Promise<void>>(
    async () => undefined
  );

  /** Send the pending patch for `id` unless a save is in flight or the workspace is in conflict. */
  const trySave = useCallback(
    (id: string) => {
      timersRef.current.delete(id);
      if (conflictRef.current.has(id) || inFlightRef.current.has(id)) return;
      const patch = pendingRef.current.get(id);
      if (!patch) return;
      pendingRef.current.delete(id);
      // The callers waiting on this patch travel with it; later edits get their own request.
      const waiters = waitersRef.current.get(id) ?? [];
      waitersRef.current.delete(id);
      void sendSaveRef.current(id, patch, waiters);
    },
    []
  );

  const sendSave = useCallback(
    async (id: string, patch: Partial<Workspace>, waiters: SaveWaiter[]): Promise<void> => {
      inFlightRef.current.add(id);
      let outcome: WorkspaceSaveResult = DISCARDED_RESULT;
      // Number the save per workspace. The cache write below compares against the latest number.
      const seq = (saveSeqRef.current.get(id) ?? 0) + 1;
      saveSeqRef.current.set(id, seq);
      try {
        // `seq` orders saves from this page; the expected version detects somebody ELSE's save.
        const updated = await updateWorkspaceApi(
          id,
          patch,
          { clientId: saveClientIdRef.current!, seq },
          knownVersionRef.current.get(id)
        );
        const v = workspaceVersion(updated);
        if (v !== undefined) knownVersionRef.current.set(id, v);
        // A response may only replace the cache while it is the freshest word on that workspace.
        // `updateWorkspace` already wrote every local change into the cache, so a response that
        // has been overtaken (a newer change waits to be sent) would put older arrays back in view.
        const overtaken =
          saveSeqRef.current.get(updated.id) !== seq ||
          pendingRef.current.has(updated.id) ||
          timersRef.current.has(updated.id);
        if (!overtaken) {
          setCache(list => list.map(w => (w.id === updated.id ? updated : w)));
        }
        setMutationError(null);
        outcome = { ok: true, workspace: updated };
      } catch (err: unknown) {
        if (err instanceof VersionConflictError) {
          // Someone else changed this workspace first. Nothing was written. Do NOT refetch and do
          // NOT adopt the new version: either would silently replace the edits on screen. Pause
          // autosave for this workspace and keep what the user typed; only Reload discards it.
          console.warn('Workspace save refused, the workspace changed elsewhere:', err.message);
          pendingRef.current.set(id, { ...patch, ...pendingRef.current.get(id) });
          const t = timersRef.current.get(id);
          if (t) clearTimeout(t);
          timersRef.current.delete(id);
          setConflict(id, true);
          setMutationError(null);
          outcome = CONFLICT_RESULT;
          // Edits queued behind this one are held too and will not be sent. Say so now: their
          // callers would otherwise wait for a Reload that may never come.
          const held = waitersRef.current.get(id);
          waitersRef.current.delete(id);
          if (held) for (const w of held) w(CONFLICT_RESULT);
        } else if (err instanceof StaleSaveError) {
          // The server already holds a newer save from this page, so the stored data is right and the
          // cache already shows it. Do not roll back or refetch: a refetch could drop a change that is
          // still waiting to be sent. Tell the user, so the refusal is never silent.
          console.warn('Stale workspace save refused by the server:', err.message);
          notify('info', 'An older save arrived after a newer one and was ignored. Your latest changes are saved.');
          outcome = { ok: false, reason: 'stale', message: err.message };
        } else {
          const message = err instanceof Error ? err.message : 'Save failed';
          setMutationError(message);
          notify('error', message);
          outcome = { ok: false, reason: 'error', message };
          // Re-sync from server to roll back the optimistic edit.
          void queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
        }
      } finally {
        for (const w of waiters) w(outcome);
        inFlightRef.current.delete(id);
        // Edits made while this PUT was in flight go out now, unless the user is still typing
        // (the debounce timer will send them) or the workspace is paused on a conflict.
        if (
          pendingRef.current.has(id) &&
          !timersRef.current.has(id) &&
          !conflictRef.current.has(id)
        ) {
          trySave(id);
        }
      }
    },
    [notify, queryClient, setCache, setConflict, trySave]
  );

  // `trySave` is created before `sendSave` and must call the live one.
  sendSaveRef.current = sendSave;

  const saveWorkspace = useCallback(
    (patch: Partial<Workspace>): Promise<WorkspaceSaveResult> => {
      if (!activeWorkspaceId) {
        return Promise.resolve({ ok: false, reason: 'no-workspace', message: 'No workspace is open.' });
      }
      const id = activeWorkspaceId;
      setCache(list => list.map(w => (w.id === id ? { ...w, ...patch } : w)));
      pendingRef.current.set(id, { ...pendingRef.current.get(id), ...patch });
      // A workspace paused on a conflict keeps the edit on screen and in memory, and sends nothing.
      if (conflictRef.current.has(id)) return Promise.resolve(CONFLICT_RESULT);
      const outcome = new Promise<WorkspaceSaveResult>(resolve => {
        const list = waitersRef.current.get(id) ?? [];
        list.push(resolve);
        waitersRef.current.set(id, list);
      });
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      timersRef.current.set(
        id,
        setTimeout(() => trySave(id), 300)
      );
      return outcome;
    },
    [activeWorkspaceId, setCache, trySave]
  );

  const updateWorkspace = useCallback(
    async (patch: Partial<Workspace>) => {
      // Fire and forget by contract: resolve now, and let the save report through the notice,
      // the error banner or the conflict banner.
      void saveWorkspace(patch);
    },
    [saveWorkspace]
  );

  const reloadWorkspace = useCallback(
    async (id: string) => {
      // Drop what this tab holds for `id` first so the fetch is allowed to set its version, then
      // clear the conflict only once the fresh copy is actually here.
      clearQueuedSave(id);
      knownVersionRef.current.delete(id);
      const result = await refetch();
      if (result.isError || !result.data) {
        notify('error', 'Could not reload the workspace. Your changes in this tab are still on screen.');
        return;
      }
      setConflict(id, false);
      setMutationError(null);
    },
    [clearQueuedSave, notify, refetch, setConflict]
  );

  const handleCreateWorkspace = useCallback(
    async (name?: string) => {
      try {
        const newWs = await createWorkspace(name ?? `Blank Workspace ${workspaces.length + 1}`);
        const created = workspaceVersion(newWs);
        if (created !== undefined) knownVersionRef.current.set(newWs.id, created);
        setCache(list => [...list, newWs]);
        setStoredWorkspaceId(newWs.id);
        setMutationError(null);
        return newWs;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create workspace';
        setMutationError(message);
        notify('error', message);
        throw err;
      }
    },
    [workspaces.length, setCache, notify]
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      try {
        await deleteWorkspaceApi(id);
      } catch (err) {
        // The server still holds this workspace. Leaving it in the local list is
        // the whole point: dropping it here is what used to make it "reappear"
        // on the next read.
        const message = err instanceof Error ? err.message : 'Failed to delete workspace';
        setMutationError(message);
        notify('error', message);
        throw err;
      }
      // A queued autosave for the workspace we just removed would PUT against a
      // dead id, 404, and invalidate the whole list — a refetch on top of a
      // delete. Drop it.
      clearQueuedSave(id);
      knownVersionRef.current.delete(id);
      if (conflictRef.current.has(id)) setConflict(id, false);
      // No selection logic here by design — `activeWorkspaceId` is derived from
      // this list, so removing the row moves the selection on its own.
      setCache(list => list.filter(w => w.id !== id));
      setMutationError(null);
    },
    [clearQueuedSave, setConflict, setCache, notify]
  );

  const restoreWorkspace = useCallback(
    async (workspace: Workspace) => {
      try {
        const restored = await createWorkspace(workspace.name, workspace);
        const restoredVersion = workspaceVersion(restored);
        if (restoredVersion !== undefined) knownVersionRef.current.set(restored.id, restoredVersion);
        setCache(list => [...list, restored]);
        setStoredWorkspaceId(restored.id);
        setMutationError(null);
        return restored;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to restore workspace';
        setMutationError(message);
        notify('error', message);
        throw err;
      }
    },
    [setCache, notify]
  );

  const refreshWorkspaces = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const value = useMemo(
    (): SuiteWorkspaceContextValue => ({
      workspaces,
      activeWorkspaceId,
      activeWorkspace,
      activeGender,
      isLoading,
      error,
      setActiveWorkspaceId,
      setActiveGender,
      createWorkspace: handleCreateWorkspace,
      updateWorkspace,
      saveWorkspace,
      deleteWorkspace,
      restoreWorkspace,
      refreshWorkspaces,
      versionConflictIds,
      reloadWorkspace,
      rosterNames,
    }),
    [
      workspaces,
      activeWorkspaceId,
      activeWorkspace,
      activeGender,
      isLoading,
      error,
      setActiveWorkspaceId,
      setActiveGender,
      handleCreateWorkspace,
      updateWorkspace,
      saveWorkspace,
      deleteWorkspace,
      restoreWorkspace,
      refreshWorkspaces,
      versionConflictIds,
      reloadWorkspace,
      rosterNames,
    ]
  );

  return (
    <SuiteWorkspaceContext.Provider value={value}>{children}</SuiteWorkspaceContext.Provider>
  );
}

/** The workspace context, or `null` outside a provider. For leaf views that only read the active workspace. */
export function useSuiteWorkspaceOptional(): SuiteWorkspaceContextValue | null {
  return useContext(SuiteWorkspaceContext);
}

export function useSuiteWorkspace(): SuiteWorkspaceContextValue {
  const ctx = useContext(SuiteWorkspaceContext);
  if (!ctx) throw new Error('useSuiteWorkspace must be used within SuiteWorkspaceProvider');
  return ctx;
}
