import { Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { AppletSkeleton, ScoringRulesOpenerProvider, TheoreticalMeetOpenerProvider, useToast } from '@omniswim/ui';
import { SuitePreferencesProvider, useSuitePreferences } from '@omniswim/core';
import { SuiteWorkspaceProvider, useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import ScoringSettingsModal from '@omniswim/matrix/components/ScoringSettingsModal';
import { writeStoredMatrixStep } from '@omniswim/matrix/components/matrixStepState';
import type { Workspace } from '@omniswim/core/types';
import SuiteHeader from './components/SuiteHeader';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import SuiteHome from './pages/SuiteHome';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import SharePage from './pages/SharePage';
import AnalyticsPage from './pages/AnalyticsPage';
import SwimCloudWindow from './components/SwimCloudWindow';
import CommandPalette from './components/CommandPalette';
import { AuthProvider } from './context/AuthContext';
import {
  ManagerAppLazy,
  MatrixAppLazy,
  MetricsAppLazy,
  TheoreticalMeetBannerLazy,
  TheoreticalMeetDialogLazy,
  prefetchLastApplet,
} from './lib/appletPrefetch';
import { installDataLossWatcher } from './lib/dataLossWatcher';
import { useWorkspaceScoringDialogProps } from './lib/workspaceScoringSettings';
import { planRouteSync, type RouteSyncSnapshot } from './lib/workspaceRouteSync';

const ManagerApp = ManagerAppLazy;
const MatrixApp = MatrixAppLazy;
const MetricsApp = MetricsAppLazy;

function RouteSkeleton({ path }: { path: string }) {
  if (path === '/manager') return <AppletSkeleton kind="manager" />;
  if (path === '/matrix') return <AppletSkeleton kind="matrix" />;
  if (path === '/metrics') return <AppletSkeleton kind="metrics" />;
  return <AppletSkeleton kind="suite" />;
}

function WorkspaceRouteSync() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeWorkspaceId, setActiveWorkspaceId, workspaces, activeGender, setActiveGender } =
    useSuiteWorkspace();
  const workspaceParam = searchParams.get('workspace');
  const genderParam = searchParams.get('gender');

  // One effect, one decision. `planRouteSync` (lib/workspaceRouteSync.ts) works out which
  // side moved since the last run and who leads; this effect only carries the plan out.
  // The previous two-effect version compared URL and state against each other and swapped
  // the workspace id about 30 times a second on a cold `?workspace=<id>` load. The handlers
  // and search params are read through refs so a re-render cannot re-arm the effect.
  const prevRef = useRef<RouteSyncSnapshot | null>(null);
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;
  const setActiveWorkspaceIdRef = useRef(setActiveWorkspaceId);
  setActiveWorkspaceIdRef.current = setActiveWorkspaceId;
  const setActiveGenderRef = useRef(setActiveGender);
  setActiveGenderRef.current = setActiveGender;

  useEffect(() => {
    const cur: RouteSyncSnapshot = {
      urlWorkspace: workspaceParam,
      urlGender: genderParam,
      activeWorkspaceId,
      activeGender,
    };
    const plan = planRouteSync(
      prevRef.current,
      cur,
      workspaces.map(w => w.id)
    );
    prevRef.current = cur;
    if (plan.setActiveWorkspaceId) {
      // Deferred past this commit's effect flush on purpose. `SuiteWorkspaceProvider` has a
      // parent effect that mirrors its derived selection back into its stored intent with a
      // functional update. This child effect runs first, so a synchronous set here is queued
      // before that mirror update and then overwritten by it (the mirror writes the stale
      // derived id back). The selection would never leave the stored workspace and the URL
      // would never win. A microtask lands after the whole flush. Not cancelled on cleanup:
      // StrictMode's second mount run is a no-op by design, so cancelling would lose the set.
      const id = plan.setActiveWorkspaceId;
      queueMicrotask(() => setActiveWorkspaceIdRef.current(id));
    }
    if (plan.setActiveGender) setActiveGenderRef.current(plan.setActiveGender);
    if (plan.writeUrl) {
      const next = new URLSearchParams(searchParamsRef.current);
      if (plan.writeUrl.workspace) next.set('workspace', plan.writeUrl.workspace);
      if (plan.writeUrl.gender) next.set('gender', plan.writeUrl.gender);
      setSearchParamsRef.current(next, { replace: true });
    }
  }, [workspaceParam, genderParam, activeWorkspaceId, activeGender, workspaces]);

  return null;
}

function ShellLayout() {
  const location = useLocation();
  const { preferences, toggleThemeMode } = useSuitePreferences();
  const toast = useToast();
  const [showScoringModal, setShowScoringModal] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showTheoreticalMeet, setShowTheoreticalMeet] = useState(false);
  const navigate = useNavigate();
  const { isLoading, error, activeWorkspace, updateWorkspace } = useSuiteWorkspace();

  // Global Ctrl+K / Cmd+K toggle for the command palette.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const path = location.pathname;
  const showWorkspaceChrome = path === '/manager' || path === '/matrix';
  const showWorkspaceControls = showWorkspaceChrome;

  useEffect(() => {
    window.localStorage.setItem('omni-last-applet', path);
  }, [path]);

  useEffect(() => {
    const id = window.requestIdleCallback?.(() => prefetchLastApplet()) ?? window.setTimeout(prefetchLastApplet, 2000);
    return () => {
      if (typeof id === 'number') window.clearTimeout(id);
      else window.cancelIdleCallback?.(id);
    };
  }, []);

  const scoringDialogProps = useWorkspaceScoringDialogProps(activeWorkspace);

  // The new workspace is already active (the provider selects it). Open it on Matrix Standings.
  const handleTheoreticalMeetCreated = (workspace: Workspace) => {
    writeStoredMatrixStep(workspace.id, 'standings');
    setShowTheoreticalMeet(false);
    navigate({ pathname: '/matrix', search: `?workspace=${encodeURIComponent(workspace.id)}` });
    toast.push('success', `Created ${workspace.name}`);
  };

  if (isLoading) {
    return <AppletSkeleton kind="suite" />;
  }

  return (
    <ScoringRulesOpenerProvider onOpen={() => setShowScoringModal(true)}>
    <TheoreticalMeetOpenerProvider onOpen={() => setShowTheoreticalMeet(true)}>
    <div className={`app-shell flex flex-col h-screen overflow-hidden ${showWorkspaceChrome ? '' : ''}`}>
      <WorkspaceRouteSync />
      <SuiteHeader
        theme={preferences.colorMode}
        onThemeToggle={toggleThemeMode}
        showWorkspaceControls={showWorkspaceControls}
        onOpenScoringSettings={showWorkspaceControls ? () => setShowScoringModal(true) : undefined}
        onOpenCommandPalette={() => setShowCommandPalette(true)}
      />

      {error ? (
        <div className="px-6 py-2 bg-[var(--toast-bg)] border-b border-[var(--toast-border)] text-[var(--toast-text)] text-ui-caption">
          {error}
        </div>
      ) : null}

      <div className="flex-1 flex overflow-hidden min-w-0">
        {showWorkspaceChrome ? <WorkspaceSidebar /> : null}
        <main className="main-content flex-1 min-w-0 overflow-y-auto custom-scrollbar">
          <Suspense fallback={<RouteSkeleton path={path} />}>
            <AnimatePresence mode="wait">
              <motion.div
                key={path}
                initial={preferences.reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={preferences.reducedMotion ? undefined : { opacity: 0 }}
                transition={{ duration: preferences.reducedMotion ? 0 : 0.15 }}
                className={showWorkspaceChrome ? 'p-4 lg:p-6' : ''}
              >
                {showWorkspaceChrome && activeWorkspace?.loadedMeet ? (
                  <Suspense fallback={null}>
                    <TheoreticalMeetBannerLazy workspace={activeWorkspace} />
                  </Suspense>
                ) : null}
                <Routes location={location}>
                  <Route path="/" element={<SuiteHome />} />
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/share/:token" element={<SharePage />} />
                  <Route path="/analytics" element={<AnalyticsPage />} />
                  <Route path="/manager" element={<ManagerApp />} />
                  <Route path="/matrix" element={<MatrixApp />} />
                  <Route path="/metrics" element={<MetricsApp />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </motion.div>
            </AnimatePresence>
          </Suspense>
        </main>
      </div>

      <footer className="app-footer min-h-8 px-4 py-1 flex items-center justify-between text-ui-caption gap-4 shrink-0">
        <div className="flex flex-wrap gap-4 text-theme-muted">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full" /> Ready
          </span>
          <span>SQLite · local-first</span>
        </div>
        <span className="hidden sm:block text-theme-muted truncate">
          © 2026 Omni Swim Suite
        </span>
      </footer>

      {showScoringModal && activeWorkspace && scoringDialogProps && (
        <ScoringSettingsModal
          settings={scoringDialogProps.settings}
          pdfPlacePointsLocked={scoringDialogProps.pdfPlacePointsLocked}
          resultsCarryPdfPlacePoints={scoringDialogProps.resultsCarryPdfPlacePoints}
          scoringView={activeWorkspace.scoringView}
          conference={activeWorkspace.conference}
          onScoringViewChange={view => {
            void updateWorkspace({ scoringView: view });
          }}
          onSave={settings => {
            void updateWorkspace({ scoringSettings: settings });
            toast.push('success', 'Scoring settings saved');
            setShowScoringModal(false);
          }}
          onClose={() => setShowScoringModal(false)}
        />
      )}

      {showTheoreticalMeet ? (
        <Suspense fallback={null}>
          <TheoreticalMeetDialogLazy onClose={() => setShowTheoreticalMeet(false)} onCreated={handleTheoreticalMeetCreated} />
        </Suspense>
      ) : null}

      <CommandPalette open={showCommandPalette} onClose={() => setShowCommandPalette(false)} />

      <SwimCloudWindow />
    </div>
    </TheoreticalMeetOpenerProvider>
    </ScoringRulesOpenerProvider>
  );
}

export default function App() {
  const toast = useToast();

  // Data-loss guard (2026-09-22 incident): surface a `dataLossWarning` on any
  // PUT /api/workspaces/:id response as a persistent toast with a Restore
  // action. See apps/shell/src/lib/dataLossWatcher.ts for why this patches
  // fetch instead of wiring through SuiteWorkspaceProvider's onNotify.
  useEffect(() => {
    installDataLossWatcher(toast.push);
  }, [toast.push]);

  return (
    <BrowserRouter>
      <SuitePreferencesProvider>
        <MotionConfig reducedMotion="user">
          <AuthProvider>
            <SuiteWorkspaceProvider onNotify={toast.push}>
              <ShellLayout />
            </SuiteWorkspaceProvider>
          </AuthProvider>
        </MotionConfig>
      </SuitePreferencesProvider>
    </BrowserRouter>
  );
}
