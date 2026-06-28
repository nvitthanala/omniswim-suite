import { Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AppletSkeleton, useToast } from '@omniswim/ui';
import { SuitePreferencesProvider, useSuitePreferences } from '@omniswim/core';
import { SuiteWorkspaceProvider, useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { Gender } from '@omniswim/core/types';
import ScoringSettingsModal from '@omniswim/matrix/components/ScoringSettingsModal';
import SuiteHeader from './components/SuiteHeader';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import SuiteHome from './pages/SuiteHome';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import SharePage from './pages/SharePage';
import AnalyticsPage from './pages/AnalyticsPage';
import SwimCloudWindow from './components/SwimCloudWindow';
import { AuthProvider } from './context/AuthContext';
import { ManagerAppLazy, MatrixAppLazy, MetricsAppLazy, prefetchLastApplet } from './lib/appletPrefetch';

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

  useEffect(() => {
    if (workspaceParam && workspaces.some(w => w.id === workspaceParam) && workspaceParam !== activeWorkspaceId) {
      setActiveWorkspaceId(workspaceParam);
    }
  }, [workspaceParam, workspaces, activeWorkspaceId, setActiveWorkspaceId]);

  useEffect(() => {
    if (genderParam === Gender.MEN || genderParam === Gender.WOMEN) {
      if (genderParam !== activeGender) setActiveGender(genderParam);
    }
  }, [genderParam, activeGender, setActiveGender]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const next = new URLSearchParams(searchParams);
    let changed = false;
    if (next.get('workspace') !== activeWorkspaceId) {
      next.set('workspace', activeWorkspaceId);
      changed = true;
    }
    if (next.get('gender') !== activeGender) {
      next.set('gender', activeGender);
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [activeWorkspaceId, activeGender, searchParams, setSearchParams]);

  return null;
}

function ShellLayout() {
  const location = useLocation();
  const { preferences, toggleThemeMode } = useSuitePreferences();
  const toast = useToast();
  const [showScoringModal, setShowScoringModal] = useState(false);
  const { isLoading, error, activeWorkspace, updateWorkspace } = useSuiteWorkspace();

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

  if (isLoading) {
    return <AppletSkeleton kind="suite" />;
  }

  return (
    <div className={`app-shell flex flex-col h-screen overflow-hidden ${showWorkspaceChrome ? '' : ''}`}>
      <WorkspaceRouteSync />
      <SuiteHeader
        theme={preferences.colorMode}
        onThemeToggle={toggleThemeMode}
        showWorkspaceControls={showWorkspaceControls}
        onOpenScoringSettings={showWorkspaceControls ? () => setShowScoringModal(true) : undefined}
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

      {showScoringModal && activeWorkspace && (
        <ScoringSettingsModal
          settings={mergeScoringSettings(activeWorkspace.scoringSettings, {
            conference: activeWorkspace.conference,
            resultsForPdfHint: [
              ...(activeWorkspace.menResults ?? []),
              ...(activeWorkspace.womenResults ?? []),
            ],
          })}
          onSave={settings => {
            void updateWorkspace({ scoringSettings: settings });
            toast.push('success', 'Scoring settings saved');
            setShowScoringModal(false);
          }}
          onClose={() => setShowScoringModal(false)}
        />
      )}

      <SwimCloudWindow />
    </div>
  );
}

export default function App() {
  const toast = useToast();
  return (
    <BrowserRouter>
      <SuitePreferencesProvider>
        <AuthProvider>
          <SuiteWorkspaceProvider onNotify={toast.push}>
            <ShellLayout />
          </SuiteWorkspaceProvider>
        </AuthProvider>
      </SuitePreferencesProvider>
    </BrowserRouter>
  );
}
