import { NavLink } from 'react-router-dom';
import { prefetchApplet } from '../lib/appletPrefetch';

const APPLETS = [
  { id: 'manager' as const, to: '/manager', label: 'Manager' },
  { id: 'matrix' as const, to: '/matrix', label: 'Matrix' },
  { id: 'metrics' as const, to: '/metrics', label: 'Metrics' },
];

export default function AppletNav() {
  return (
    <nav
      className="flex gap-1 bg-[var(--surface)] p-1 rounded-md border border-[var(--border)]"
      aria-label="Suite applets"
    >
      {APPLETS.map(applet => (
        <NavLink
          key={applet.id}
          to={applet.to}
          onMouseEnter={() => prefetchApplet(applet.id)}
          onFocus={() => prefetchApplet(applet.id)}
          className={({ isActive }) =>
            `applet-nav-item px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-sm transition-all ${
              isActive ? 'nav-tab-active' : 'nav-tab-inactive'
            }`
          }
        >
          {applet.label}
        </NavLink>
      ))}
    </nav>
  );
}
