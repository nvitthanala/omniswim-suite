import { Link } from 'react-router-dom';
import { Cog, Globe, MoreHorizontal, Search, Settings, TrendingUp, User } from 'lucide-react';
import { Button, Menu, MenuItem, ThemeToggle, useSwimCloudWindow } from '@omniswim/ui';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { useAuth } from '../context/AuthContext';
import AppletNav from './AppletNav';
import { GenderToggleNav, shortcutHintLabel } from './SuiteHeaderControls';

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

        {showWorkspaceControls && activeWorkspace && onOpenScoringSettings ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenScoringSettings}
            className="p-1.5"
            title="Configure Scoring Model"
            aria-label="Configure Scoring Model"
            leadingIcon={<Settings size={14} />}
          />
        ) : null}

        {showWorkspaceControls && activeWorkspace ? (
          <div className="hidden lg:flex px-3 py-1.5 text-ui-caption bg-[var(--surface-muted)] text-[var(--text-primary)] border border-theme-soft rounded-full items-center">
            <span className="truncate max-w-[160px]">{activeWorkspace.name}</span>
          </div>
        ) : null}

        <ThemeToggle theme={theme} onToggle={onThemeToggle} className="ml-1" />

        <Menu label="More" icon={<MoreHorizontal size={14} />} triggerClassName="btn-ghost p-1.5 rounded-lg">
          {onOpenCommandPalette ? (
            <MenuItem
              icon={<Search size={14} />}
              onSelect={onOpenCommandPalette}
              className="justify-between"
            >
              Command palette
              <kbd className="text-ui-micro font-mono text-theme-muted">{shortcutHintLabel(IS_MAC)}</kbd>
            </MenuItem>
          ) : null}

          <Link
            to="/analytics"
            role="menuitem"
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-ui-caption text-left theme-hover-row transition-colors text-[var(--text-primary)]"
          >
            <TrendingUp size={14} />
            <span className="truncate">Season analytics</span>
          </Link>

          {user ? (
            <MenuItem icon={<User size={14} />} onSelect={() => void logout()}>
              Sign out ({user.displayName})
            </MenuItem>
          ) : authRequired ? (
            <Link
              to="/login"
              role="menuitem"
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-ui-caption text-left theme-hover-row transition-colors text-[var(--text-primary)]"
            >
              <User size={14} />
              <span className="truncate">Sign in</span>
            </Link>
          ) : null}

          <Link
            to="/settings"
            role="menuitem"
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-ui-caption text-left theme-hover-row transition-colors text-[var(--text-primary)]"
          >
            <Cog size={14} />
            <span className="truncate">Suite settings</span>
          </Link>

          <MenuItem icon={<Globe size={14} />} onSelect={toggleWindow} active={open}>
            SwimCloud reference window
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}
