import { Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { LoadingSpinner, useToast } from '@omniswim/ui';
import { SuiteWorkspaceProvider, useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { Gender } from '@omniswim/core/types';
import ScoringSettingsModal from '@omniswim/matrix/components/ScoringSettingsModal';
import SuiteHeader from './components/SuiteHeader';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import SuiteHome from './pages/SuiteHome';
import LoginPage from './pages/LoginPage';
import SharePage from './pages/SharePage';
import AnalyticsPage from './pages/AnalyticsPage';
import SwimCloudWindow from './components/SwimCloudWindow';
import { AuthProvider } from './context/AuthContext';
import { ManagerAppLazy, MatrixAppLazy, MetricsAppLazy, prefetchLastApplet } from './lib/appletPrefetch';

const ManagerApp = ManagerAppLazy;
const MatrixApp = MatrixAppLazy;
const MetricsApp = MetricsAppLazy;

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
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = window.localStorage.getItem('omni-theme');
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [showScoringModal, setShowScoringModal] = useState(false);
  const { isLoading, error, activeWorkspace, updateWorkspace } = useSuiteWorkspace();

  const path = location.pathname;
  const showWorkspaceChrome = path === '/manager' || path === '/matrix';
  const showWorkspaceControls = showWorkspaceChrome;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('omni-theme', theme);
  }, [theme]);

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
    return <LoadingSpinner label="Loading suite…" />;
  }

  return (
    <div className={`app-shell flex flex-col h-screen overflow-hidden ${showWorkspaceChrome ? '' : ''}`}>
      <WorkspaceRouteSync />
      <SuiteHeader
        theme={theme}
        onThemeToggle={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
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
          <Suspense fallback={<LoadingSpinner label="Loading applet…" />}>
            <AnimatePresence mode="wait">
              <motion.div
                key={path}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
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
      <AuthProvider>
        <SuiteWorkspaceProvider onNotify={toast.push}>
          <ShellLayout />
        </SuiteWorkspaceProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
