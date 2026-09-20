import { NavLink } from 'react-router-dom';
import { Badge } from '@omniswim/ui';
import { prefetchApplet } from '../lib/appletPrefetch';

const APPLETS = [
  { id: 'manager' as const, to: '/manager', label: 'Manager', experimental: false },
  { id: 'matrix' as const, to: '/matrix', label: 'Matrix', experimental: false },
  { id: 'metrics' as const, to: '/metrics', label: 'Metrics', experimental: true },
];

export default function AppletNav() {
  return (
    <nav
      className="flex gap-1 bg-[var(--surface)] p-1 rounded-lg border border-[var(--border)]"
      aria-label="Suite applets"
    >
      {APPLETS.map(applet => (
        <NavLink
          key={applet.id}
          to={applet.to}
          onMouseEnter={() => prefetchApplet(applet.id)}
          onFocus={() => prefetchApplet(applet.id)}
          className={({ isActive }) =>
            `applet-nav-item px-4 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md transition-colors ${
              isActive ? 'nav-tab-active' : 'nav-tab-inactive'
            }`
          }
        >
          {applet.label}
          {applet.experimental ? (
            <Badge
              tone="warning"
              className="ml-1.5 px-1.5 py-0.5 text-[9px] normal-case tracking-normal align-middle"
            >
              Experimental
            </Badge>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}
