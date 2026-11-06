/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard shell (D6 section 1): one frame with slots, two layouts.
 *
 * - `DockedShell`: the 360 by 240 px iframe in the simulator page. A tab bar over its panels. A tab renders for the first time when the coach
 *   opens it, so nothing a tab computes or loads runs before that. After that it stays mounted and hidden, so a build that runs in the Build
 *   tab goes on when the coach looks at the chart. A button asks the overlay for the larger "expanded" size.
 * - `HostShell`: the browser tab. A left nav and the open section.
 *
 * Both are plain: a tab is an id, a label and a render function. The shell knows nothing of scoring or storage.
 */
import * as React from 'react';

/** What a tab is told when it renders. */
export interface TabContext {
  /** The docked panel is in its larger size. */
  readonly expanded: boolean;
  /** This tab is the one showing. A hidden tab that stays mounted sees `false`. */
  readonly active: boolean;
}

export interface ShellTab {
  readonly id: string;
  readonly label: string;
  /** Not called before the tab is first opened. */
  readonly render: (context: TabContext) => React.ReactNode;
}

interface TabListProps {
  readonly tabs: readonly ShellTab[];
  readonly active: string;
  readonly onSelect: (id: string) => void;
  readonly label: string;
  readonly orientation: 'horizontal' | 'vertical';
  readonly className: string;
  readonly idPrefix: string;
}

const panelId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

/** An accessible tab list: arrows, Home and End move between tabs; the open tab is named by `aria-selected`, not by colour alone. */
function TabList({ tabs, active, onSelect, label, orientation, className, idPrefix }: TabListProps): React.ReactElement {
  const refs = React.useRef(new Map<string, HTMLButtonElement>());
  const move = (event: React.KeyboardEvent, index: number): void => {
    const next = orientation === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    let target = -1;
    if (event.key === next[1]) target = (index + 1) % tabs.length;
    else if (event.key === next[0]) target = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = tabs.length - 1;
    if (target < 0) return;
    event.preventDefault();
    const tab = tabs[target] as ShellTab;
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} aria-orientation={orientation} className={className}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(el) => { if (el) refs.current.set(tab.id, el); else refs.current.delete(tab.id); }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={panelId(idPrefix, tab.id)}
          tabIndex={tab.id === active ? 0 : -1}
          className="osx-tab"
          data-testid={`tab-${tab.id}`}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => move(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export interface DockedShellProps {
  readonly tabs: readonly ShellTab[];
  /** The page's own words about the host, shown small ("host: docked"). */
  readonly hostLabel: string;
  /** The coach asked for the compact or the expanded size. Called with `compact` once, at the start. */
  readonly onSize?: (size: 'compact' | 'expanded') => void;
  /** The tab shown first. */
  readonly initial?: string;
}

export function DockedShell({ tabs, hostLabel, onSize, initial }: DockedShellProps): React.ReactElement {
  const [active, setActive] = React.useState(initial ?? (tabs[0] as ShellTab).id);
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => { onSize?.(expanded ? 'expanded' : 'compact'); }, [expanded, onSize]);
  const current = tabs.find((t) => t.id === active) ?? (tabs[0] as ShellTab);
  // A tab is rendered once it has been opened, and kept.
  const [opened, setOpened] = React.useState<ReadonlySet<string>>(() => new Set([current.id]));
  if (!opened.has(current.id)) setOpened(new Set([...opened, current.id]));
  return (
    <main className="osx-shell osx-shell--docked" data-testid="docked-shell" data-size={expanded ? 'expanded' : 'compact'}>
      <header className="osx-shell-head">
        <h1>OmniSwim</h1>
        <p className="osx-shell-host" data-testid="host">{hostLabel}</p>
        <button type="button" className="osx-shell-size" data-testid="size-toggle" aria-pressed={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Smaller' : 'Larger'}
        </button>
      </header>
      <TabList tabs={tabs} active={current.id} onSelect={setActive} label="OmniSwim panel" orientation="horizontal" className="osx-tabbar" idPrefix="docked" />
      {tabs.filter((tab) => opened.has(tab.id)).map((tab) => (
        <section key={tab.id} role="tabpanel" id={panelId('docked', tab.id)} aria-labelledby={`docked-tab-${tab.id}`} hidden={tab.id !== current.id} className="osx-tabpanel" data-testid={`panel-${tab.id}`}>
          {tab.render({ expanded, active: tab.id === current.id })}
        </section>
      ))}
    </main>
  );
}

export interface HostShellProps {
  readonly tabs: readonly ShellTab[];
  readonly hostLabel: string;
  readonly initial?: string;
}

export function HostShell({ tabs, hostLabel, initial }: HostShellProps): React.ReactElement {
  const [active, setActive] = React.useState(initial ?? (tabs[0] as ShellTab).id);
  const current = tabs.find((t) => t.id === active) ?? (tabs[0] as ShellTab);
  return (
    <div className="osx-shell osx-shell--tab" data-testid="host-shell">
      <aside className="osx-hostnav">
        <h1>OmniSwim</h1>
        <p className="osx-shell-host" data-testid="host">{hostLabel}</p>
        <TabList tabs={tabs} active={current.id} onSelect={setActive} label="OmniSwim sections" orientation="vertical" className="osx-sidenav" idPrefix="host" />
      </aside>
      <main role="tabpanel" id={panelId('host', current.id)} aria-labelledby={`host-tab-${current.id}`} className="osx-hostpanel" data-testid={`panel-${current.id}`}>
        {current.render({ expanded: false, active: true })}
      </main>
    </div>
  );
}
