import { Link } from 'react-router-dom';
import { Cog, Globe, Settings, TrendingUp } from 'lucide-react';
import { ThemeToggle, useSwimCloudWindow } from '@omniswim/ui';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { useAuth } from '../context/AuthContext';
import AppletNav from './AppletNav';
import { CommandPaletteButton, GenderToggleNav, UserAuthControl } from './SuiteHeaderControls';

type Props = {
  theme: 'dark' | 'light';
  onThemeToggle: () => void;
  showWorkspaceControls?: boolean;
  onOpenScoringSettings?: () => void;
  onOpenCommandPalette?: () => void;
};

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

export default function SuiteHeader({
  theme,
  onThemeToggle,
  showWorkspaceControls,
  onOpenScoringSettings,
  onOpenCommandPalette,
}: Props) {
  const { activeWorkspace, activeGender, setActiveGender } = useSuiteWorkspace();
  const { open, toggleWindow } = useSwimCloudWindow();
  const { user, authRequired, logout } = useAuth();

  return (
    <header className="app-header h-16 flex items-center justify-between px-6 z-20 shrink-0">
      <div className="flex items-center gap-4">
        <Link to="/" className="flex items-center gap-4 group">
          <div
            className="w-10 h-10 flex items-center justify-center bg-[var(--surface-muted)] rounded-lg border border-[var(--border)] overflow-hidden"
            style={{ boxShadow: 'var(--ui-shadow-sm)' }}
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

        {showWorkspaceControls ? <GenderToggleNav activeGender={activeGender} onChange={setActiveGender} /> : null}

        {onOpenCommandPalette ? <CommandPaletteButton isMac={IS_MAC} onOpen={onOpenCommandPalette} /> : null}

        <Link
          to="/analytics"
          className="btn-ghost p-1.5 rounded hidden sm:flex"
          title="Season analytics"
          aria-label="Season analytics"
        >
          <TrendingUp size={14} />
        </Link>

        <UserAuthControl user={user} authRequired={authRequired} onLogout={() => void logout()} />

        <ThemeToggle theme={theme} onToggle={onThemeToggle} className="ml-1" />

        <Link
          to="/settings"
          className="p-1.5 theme-hover-row rounded-lg btn-accent-outline transition-colors"
          title="Suite Settings"
          aria-label="Open suite settings"
        >
          <Cog size={14} />
        </Link>

        <button
          type="button"
          onClick={toggleWindow}
          className={`p-1.5 rounded-lg transition-colors ${open ? 'btn-accent-outline' : 'btn-ghost'}`}
          title="SwimCloud reference window"
          aria-label="SwimCloud reference window"
          aria-pressed={open}
        >
          <Globe size={14} />
        </button>

        {showWorkspaceControls && activeWorkspace && onOpenScoringSettings ? (
          <button
            type="button"
            onClick={onOpenScoringSettings}
            className="p-1.5 theme-hover-row rounded-lg btn-accent-outline transition-colors"
            title="Configure Scoring Model"
            aria-label="Configure Scoring Model"
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
