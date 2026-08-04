import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { CornerDownLeft, FileText, Home, Search, Settings, TrendingUp, User, Users } from 'lucide-react';
import { Gender } from '@omniswim/core/types';
import { foldDiacritics } from '@omniswim/core/lib/utils';
import { requestAthleteJump } from '@omniswim/core/lib/athleteJumpSignal';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';

type Props = {
  open: boolean;
  onClose: () => void;
};

type PaletteGroup = 'Pages' | 'Workspaces' | 'Athletes';

type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Right-aligned detail text (path, gender, active marker). */
  hint?: string;
  /** Extra text matched by search but not displayed. */
  keywords?: string;
  icon: React.ReactNode;
  run: () => void;
};

const GROUP_ORDER: PaletteGroup[] = ['Pages', 'Workspaces', 'Athletes'];
const MAX_PER_GROUP = 8;

/** Case- and diacritic-insensitive fold for matching. */
function fold(s: string): string {
  return foldDiacritics(s.toLowerCase());
}

/**
 * Match score: lower is better; null means no match.
 * Prefix beats word-start beats substring beats keyword hit.
 */
function scoreItem(item: PaletteItem, foldedQuery: string): number | null {
  const label = fold(item.label);
  if (label.startsWith(foldedQuery)) return 0;
  const wordStart = label.split(/\s+/).some(w => w.startsWith(foldedQuery));
  if (wordStart) return 1;
  if (label.includes(foldedQuery)) return 2;
  if (item.keywords && fold(item.keywords).includes(foldedQuery)) return 3;
  return null;
}

export default function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    activeGender,
    setActiveWorkspaceId,
    setActiveGender,
  } = useSuiteWorkspace();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // On open: remember the focused element, reset state, focus the input.
  // On close (cleanup): restore focus to where the user was.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setSelectedIndex(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(t);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  const pageItems = useMemo<PaletteItem[]>(() => {
    // URL-first page navigation; the current search string (workspace/gender params)
    // is carried along so WorkspaceRouteSync sees no param change.
    const go = (pathname: string) => {
      navigate({ pathname, search: location.search });
      onClose();
    };
    const pages: Array<{ to: string; label: string; keywords: string; icon: React.ReactNode }> = [
      { to: '/', label: 'Suite home', keywords: 'home start overview', icon: <Home size={14} /> },
      { to: '/manager', label: 'Manager', keywords: 'roster lineup team entries', icon: <Users size={14} /> },
      { to: '/matrix', label: 'Matrix', keywords: 'scoring matrix meet', icon: <FileText size={14} /> },
      { to: '/metrics', label: 'Metrics', keywords: 'charts momentum analytics', icon: <TrendingUp size={14} /> },
      { to: '/analytics', label: 'Season analytics', keywords: 'season trends', icon: <TrendingUp size={14} /> },
      { to: '/settings', label: 'Settings', keywords: 'preferences theme suite', icon: <Settings size={14} /> },
    ];
    return pages.map(p => ({
      id: `page:${p.to}`,
      group: 'Pages' as const,
      label: p.label,
      hint: location.pathname === p.to ? 'Current' : p.to,
      keywords: p.keywords,
      icon: p.icon,
      run: () => go(p.to),
    }));
  }, [navigate, location.pathname, location.search, onClose]);

  const workspaceItems = useMemo<PaletteItem[]>(
    () =>
      workspaces.map(w => ({
        id: `workspace:${w.id}`,
        group: 'Workspaces' as const,
        label: w.name,
        hint: w.id === activeWorkspaceId ? 'Active' : 'Switch',
        keywords: 'workspace switch',
        icon: <FileText size={14} />,
        // State-first, matching WorkspaceSidebar: the WorkspaceRouteSync state→URL
        // effect is the single authoritative URL writer for the workspace param.
        // Writing ?workspace= from here would add a second writer and re-create
        // the oscillation documented in MATRIX_RESCORE_OVERHAUL_HANDOFF.md §5.
        run: () => {
          setActiveWorkspaceId(w.id);
          onClose();
        },
      })),
    [workspaces, activeWorkspaceId, setActiveWorkspaceId, onClose]
  );

  const athleteItems = useMemo<PaletteItem[]>(() => {
    if (!activeWorkspace) return [];
    const byName = new Map<string, { gender: Gender; source: string; team?: string }>();
    for (const r of activeWorkspace.menResults ?? []) {
      if (r.name && !r.isRelay && !byName.has(r.name)) {
        byName.set(r.name, { gender: Gender.MEN, source: 'Roster', team: r.team });
      }
    }
    for (const r of activeWorkspace.womenResults ?? []) {
      if (r.name && !r.isRelay && !byName.has(r.name)) {
        byName.set(r.name, { gender: Gender.WOMEN, source: 'Roster', team: r.team });
      }
    }
    for (const r of activeWorkspace.recruits ?? []) {
      if (r.name && !byName.has(r.name)) {
        byName.set(r.name, { gender: r.gender, source: 'Recruit', team: r.team });
      }
    }
    return [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, meta]) => ({
        id: `athlete:${name}`,
        group: 'Athletes' as const,
        label: name,
        hint: `${meta.source} · ${meta.gender === Gender.MEN ? 'Men' : 'Women'}`,
        icon: <User size={14} />,
        // Jump hand-off travels via athleteJumpSignal (sessionStorage + event):
        // Manager consumes it once its scored team list is ready and opens the
        // athlete drawer. Gender preselect is state-first, same sync as above.
        run: () => {
          if (meta.gender !== activeGender) setActiveGender(meta.gender);
          requestAthleteJump({ name, team: meta.team, gender: meta.gender });
          navigate({ pathname: '/manager', search: location.search });
          onClose();
        },
      }));
  }, [activeWorkspace, activeGender, setActiveGender, navigate, location.search, onClose]);

  const visibleGroups = useMemo(() => {
    const all = [...pageItems, ...workspaceItems, ...athleteItems];
    const foldedQuery = fold(query.trim());
    let matched: PaletteItem[];
    if (!foldedQuery) {
      matched = all;
    } else {
      matched = all
        .map(item => ({ item, score: scoreItem(item, foldedQuery) }))
        .filter((x): x is { item: PaletteItem; score: number } => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .map(x => x.item);
    }
    return GROUP_ORDER.map(group => ({
      group,
      items: matched.filter(i => i.group === group).slice(0, MAX_PER_GROUP),
    })).filter(g => g.items.length > 0);
  }, [pageItems, workspaceItems, athleteItems, query]);

  const flatItems = useMemo(() => visibleGroups.flatMap(g => g.items), [visibleGroups]);

  // Clamp the selection when the result set shrinks; reset on query change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);
  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, flatItems.length - 1)));
  }, [flatItems.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, open, flatItems.length]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (flatItems.length === 0 ? 0 : (prev + 1) % flatItems.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev =>
        flatItems.length === 0 ? 0 : (prev - 1 + flatItems.length) % flatItems.length
      );
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      flatItems[selectedIndex]?.run();
      return;
    }
    if (e.key === 'Tab') {
      // Focus is trapped in the search input while the palette is open.
      e.preventDefault();
    }
  };

  let flatIndex = -1;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center modal-backdrop backdrop-blur-sm pt-[14vh] px-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="surface-card rounded-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[62vh]"
        style={{ boxShadow: 'var(--ui-shadow-lg)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-theme-soft shrink-0">
          <Search size={16} className="text-theme-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to a page, workspace, or athlete…"
            className="flex-1 bg-transparent outline-none text-ui-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            aria-label="Search commands"
          />
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-theme-soft bg-[var(--surface-muted)] text-ui-micro font-mono text-theme-muted">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          className="overflow-y-auto custom-scrollbar py-2 flex-1 min-h-0"
          // Keep focus in the search input while clicking results.
          onMouseDown={e => e.preventDefault()}
        >
          {flatItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-ui-caption text-theme-muted italic">
              No matches for “{query}”
            </p>
          ) : (
            visibleGroups.map(({ group, items }) => (
              <div key={group} className="mb-1">
                <h3 className="px-4 pt-2 pb-1 text-ui-micro uppercase tracking-widest text-theme-muted font-bold">
                  {group}
                </h3>
                {items.map(item => {
                  flatIndex += 1;
                  const isSelected = flatIndex === selectedIndex;
                  const myIndex = flatIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-selected={isSelected || undefined}
                      onClick={item.run}
                      onMouseMove={() => setSelectedIndex(myIndex)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left text-ui-label transition-colors ${
                        isSelected
                          ? 'bg-[var(--text-accent)]/12 text-[var(--text-accent)]'
                          : 'text-[var(--text-primary)] theme-hover-row'
                      }`}
                    >
                      <span className={isSelected ? 'text-[var(--text-accent)]' : 'text-theme-muted'}>
                        {item.icon}
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.hint ? (
                        <span className="text-ui-micro text-theme-muted shrink-0">{item.hint}</span>
                      ) : null}
                      {isSelected ? (
                        <CornerDownLeft size={12} className="text-theme-muted shrink-0" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-theme-soft text-ui-micro text-theme-muted shrink-0">
          <span className="inline-flex items-center gap-1">
            <kbd className="px-1 rounded border border-theme-soft bg-[var(--surface-muted)] font-mono">↑↓</kbd>
            Navigate
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="px-1 rounded border border-theme-soft bg-[var(--surface-muted)] font-mono">↵</kbd>
            Select
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="px-1 rounded border border-theme-soft bg-[var(--surface-muted)] font-mono">Esc</kbd>
            Close
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
