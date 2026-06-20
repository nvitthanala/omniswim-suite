import { Link } from 'react-router-dom';
import { Settings, Globe, LogOut, User, TrendingUp } from 'lucide-react';
import { Gender } from '@omniswim/core/types';
import { ThemeToggle, useSwimCloudWindow } from '@omniswim/ui';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { useAuth } from '../context/AuthContext';
import AppletNav from './AppletNav';

type Props = {
  theme: 'dark' | 'light';
  onThemeToggle: () => void;
  showWorkspaceControls?: boolean;
  onOpenScoringSettings?: () => void;
};

export default function SuiteHeader({
  theme,
  onThemeToggle,
  showWorkspaceControls,
  onOpenScoringSettings,
}: Props) {
  const { activeWorkspace, activeGender, setActiveGender } = useSuiteWorkspace();
  const { open, toggleWindow } = useSwimCloudWindow();
  const { user, authRequired, logout } = useAuth();

  return (
    <header className="app-header h-16 flex items-center justify-between px-6 z-20 shrink-0">
      <div className="flex items-center gap-4">
        <Link to="/" className="flex items-center gap-4 group">
          <div
            className="w-10 h-10 flex items-center justify-center bg-[var(--surface-muted)] rounded shadow border border-[var(--border)] overflow-hidden"
            style={{ boxShadow: '0 4px 12px var(--shadow)' }}
          >
            <img src="/OMNISWIMLOGO.png" alt="Omni Swim Logo" className="w-full h-full object-contain p-1" />
          </div>
          <h1 className="text-xl font-black tracking-tighter text-[var(--text-primary)] group-hover:text-[var(--text-accent)] transition-colors">
            Omni Swim <span className="text-[var(--text-muted)] font-semibold text-base">Suite</span>
          </h1>
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <AppletNav />

        {showWorkspaceControls ? (
          <nav className="hidden md:flex gap-1 bg-[var(--surface)] p-1 rounded-md border border-[var(--border)] ml-2">
            <button
              type="button"
              onClick={() => setActiveGender(Gender.MEN)}
              className={`px-3 py-1.5 text-ui-caption font-semibold rounded-sm transition-all ${
                activeGender === Gender.MEN ? 'nav-tab-active' : 'nav-tab-inactive'
              }`}
            >
              Men
            </button>
            <button
              type="button"
              onClick={() => setActiveGender(Gender.WOMEN)}
              className={`px-3 py-1.5 text-ui-caption font-semibold rounded-sm transition-all ${
                activeGender === Gender.WOMEN ? 'nav-tab-active' : 'nav-tab-inactive'
              }`}
            >
              Women
            </button>
          </nav>
        ) : null}

        <Link to="/analytics" className="btn-ghost p-1.5 rounded hidden sm:flex" title="Season analytics">
          <TrendingUp size={14} />
        </Link>

        {user ? (
          <div className="hidden md:flex items-center gap-2 px-2 py-1 rounded-full border border-theme-soft text-ui-caption">
            <User size={12} className="text-theme-muted" />
            <span className="truncate max-w-[100px]">{user.displayName}</span>
            <button type="button" onClick={() => void logout()} className="p-1 theme-hover-row rounded" title="Sign out">
              <LogOut size={12} />
            </button>
          </div>
        ) : authRequired ? (
          <Link to="/login" className="btn-ghost px-3 py-1.5 rounded text-ui-caption font-semibold">
            Sign in
          </Link>
        ) : null}

        <ThemeToggle theme={theme} onToggle={onThemeToggle} className="ml-1" />

        <button
          type="button"
          onClick={toggleWindow}
          className={`p-1.5 rounded transition-colors ${open ? 'btn-accent-outline' : 'btn-ghost'}`}
          title="SwimCloud reference window"
        >
          <Globe size={14} />
        </button>

        {showWorkspaceControls && activeWorkspace && onOpenScoringSettings ? (
          <button
            type="button"
            onClick={onOpenScoringSettings}
            className="p-1.5 theme-hover-row rounded btn-accent-outline transition-colors"
            title="Configure Scoring Model"
          >
            <Settings size={14} />
          </button>
        ) : null}

        {showWorkspaceControls && activeWorkspace ? (
          <div className="hidden lg:flex px-3 py-1.5 text-ui-caption bg-[var(--surface-muted)] text-[var(--text-primary)] border border-theme-soft rounded-full items-center">
            <span className="truncate max-w-[160px]">{activeWorkspace.name}</span>
          </div>
        ) : null}

        <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse ml-1" title="System ready" />
      </div>
    </header>
  );
}
