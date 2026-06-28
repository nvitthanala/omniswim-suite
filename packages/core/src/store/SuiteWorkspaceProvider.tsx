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
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: fetchWorkspaces,
  });

  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(() => {
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const error = mutationError ?? (queryError ? 'Failed to load workspaces' : null);

  // Keep a valid active workspace selected as the list changes.
  useEffect(() => {
    setActiveWorkspaceIdState(current => {
      if (workspaces.length === 0) return null;
      if (current != null && workspaces.some(w => w.id === current)) return current;
      return workspaces[0].id;
    });
  }, [workspaces]);

  useEffect(() => {
    if (activeWorkspaceId) {
      window.localStorage.setItem(WORKSPACE_KEY, activeWorkspaceId);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    window.localStorage.setItem(GENDER_KEY, activeGender);
  }, [activeGender]);

  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId]
  );

  const rosterNames = useMemo(() => collectRosterNames(activeWorkspace), [activeWorkspace]);

  const setActiveWorkspaceId = useCallback((id: string | null) => {
    setActiveWorkspaceIdState(id);
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
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const merged = pendingPatchRef.current;
        pendingPatchRef.current = null;
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
        setActiveWorkspaceIdState(newWs.id);
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
        setCache(list => list.filter(w => w.id !== id));
        setActiveWorkspaceIdState(current => {
          if (current !== id) return current;
          const remaining = (queryClient.getQueryData<Workspace[]>(WORKSPACES_KEY) ?? []).filter(
            w => w.id !== id
          );
          return remaining[0]?.id ?? null;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete workspace';
        setMutationError(message);
        notify('error', message);
        throw err;
      }
    },
    [setCache, queryClient, notify]
  );

  const restoreWorkspace = useCallback(
    async (workspace: Workspace) => {
      const restored = await createWorkspace(workspace.name, workspace);
      setCache(list => [...list, restored]);
      setActiveWorkspaceIdState(restored.id);
      return restored;
    },
    [setCache]
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
