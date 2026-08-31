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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gender, type Workspace } from '../types';
import {
  createWorkspace,
  deleteWorkspaceApi,
  fetchWorkspaces,
  updateWorkspaceApi,
} from '../api/workspaces';

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
  updateWorkspace: (patch: Partial<Workspace>) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  restoreWorkspace: (workspace: Workspace) => Promise<Workspace>;
  refreshWorkspaces: () => Promise<void>;
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

  const {
    data: workspaces = [],
    isLoading,
    isSuccess,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: fetchWorkspaces,
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
  const pendingPatchRef = useRef<Partial<Workspace> | null>(null);
  const pendingPatchTargetRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (workspaces.length === 0) return null;
    if (storedWorkspaceId != null && workspaces.some(w => w.id === storedWorkspaceId)) {
      return storedWorkspaceId;
    }
    return workspaces[0].id;
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
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

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

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Workspace> }) =>
      updateWorkspaceApi(id, patch),
    onSuccess: updated => {
      setCache(list => list.map(w => (w.id === updated.id ? updated : w)));
      setMutationError(null);
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Save failed';
      setMutationError(message);
      notify('error', message);
      // Re-sync from server to roll back the optimistic edit.
      void queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
  });

  const flushUpdate = useCallback(
    async (id: string, patch: Partial<Workspace>) => {
      await updateMutation.mutateAsync({ id, patch }).catch(() => undefined);
    },
    [updateMutation]
  );

  const updateWorkspace = useCallback(
    async (patch: Partial<Workspace>) => {
      if (!activeWorkspaceId) return;
      setCache(list => list.map(w => (w.id === activeWorkspaceId ? { ...w, ...patch } : w)));
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
      pendingPatchTargetRef.current = activeWorkspaceId;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const merged = pendingPatchRef.current;
        pendingPatchRef.current = null;
        pendingPatchTargetRef.current = null;
        debounceRef.current = null;
        if (merged) void flushUpdate(activeWorkspaceId, merged);
      }, 300);
    },
    [activeWorkspaceId, flushUpdate, setCache]
  );

  const handleCreateWorkspace = useCallback(
    async (name?: string) => {
      try {
        const newWs = await createWorkspace(name ?? `Blank Workspace ${workspaces.length + 1}`);
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
      if (pendingPatchTargetRef.current === id) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = null;
        pendingPatchRef.current = null;
        pendingPatchTargetRef.current = null;
      }
      // No selection logic here by design — `activeWorkspaceId` is derived from
      // this list, so removing the row moves the selection on its own.
      setCache(list => list.filter(w => w.id !== id));
      setMutationError(null);
    },
    [setCache, notify]
  );

  const restoreWorkspace = useCallback(
    async (workspace: Workspace) => {
      try {
        const restored = await createWorkspace(workspace.name, workspace);
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
      deleteWorkspace,
      restoreWorkspace,
      refreshWorkspaces,
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
      deleteWorkspace,
      restoreWorkspace,
      refreshWorkspaces,
      rosterNames,
    ]
  );

  return (
    <SuiteWorkspaceContext.Provider value={value}>{children}</SuiteWorkspaceContext.Provider>
  );
}

export function useSuiteWorkspace(): SuiteWorkspaceContextValue {
  const ctx = useContext(SuiteWorkspaceContext);
  if (!ctx) throw new Error('useSuiteWorkspace must be used within SuiteWorkspaceProvider');
  return ctx;
}
