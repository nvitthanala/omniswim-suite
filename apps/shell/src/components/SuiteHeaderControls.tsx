import { Link } from 'react-router-dom';
import { LogOut, Search, User } from 'lucide-react';
import { Gender } from '@omniswim/core/types';
import type { AuthUser } from '@omniswim/core/api/auth';

interface GenderToggleNavProps {
  activeGender: Gender;
  onChange: (gender: Gender) => void;
}

/** The Men/Women segmented toggle shown when workspace controls are on. */
export function GenderToggleNav({ activeGender, onChange }: GenderToggleNavProps) {
  return (
    <nav className="hidden md:flex gap-1 bg-[var(--surface)] p-1 rounded-lg border border-[var(--border)] ml-2">
      <button
        type="button"
        onClick={() => onChange(Gender.MEN)}
        className={`px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md transition-colors ${
          activeGender === Gender.MEN ? 'nav-tab-active' : 'nav-tab-inactive'
        }`}
      >
        Men
      </button>
      <button
        type="button"
        onClick={() => onChange(Gender.WOMEN)}
        className={`px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md transition-colors ${
          activeGender === Gender.WOMEN ? 'nav-tab-active' : 'nav-tab-inactive'
        }`}
      >
        Women
      </button>
    </nav>
  );
}

/** Keyboard hint for the command palette shortcut: ⌘K on Mac, Ctrl K elsewhere. */
export function shortcutHintLabel(isMac: boolean): string {
  return isMac ? '⌘K' : 'Ctrl K';
}

interface CommandPaletteButtonProps {
  isMac: boolean;
  onOpen: () => void;
}

/** The command-palette launcher button in the header. */
export function CommandPaletteButton({ isMac, onOpen }: CommandPaletteButtonProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="btn-ghost hidden sm:flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-theme-soft text-theme-muted hover:text-[var(--text-primary)] transition-colors"
      title="Command palette"
      aria-label="Open command palette"
    >
      <Search size={12} />
      <kbd className="text-ui-micro font-mono">{shortcutHintLabel(isMac)}</kbd>
    </button>
  );
}

interface UserAuthControlProps {
  user: AuthUser | null;
  authRequired: boolean;
  onLogout: () => void;
}

/** Signed-in user chip with sign-out, the "Sign in" link, or nothing. */
export function UserAuthControl({ user, authRequired, onLogout }: UserAuthControlProps) {
  if (user) {
    return (
      <div className="hidden md:flex items-center gap-2 px-2 py-1 rounded-full border border-theme-soft text-ui-caption">
        <User size={12} className="text-theme-muted" />
        <span className="truncate max-w-[100px]">{user.displayName}</span>
        <button type="button" onClick={onLogout} className="p-1 theme-hover-row rounded" title="Sign out">
          <LogOut size={12} />
        </button>
      </div>
    );
  }
  if (authRequired) {
    return (
      <Link to="/login" className="btn-ghost px-3 py-1.5 rounded text-ui-caption font-semibold">
        Sign in
      </Link>
    );
  }
  return null;
}
