import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { BarChart3, Users, Activity, ArrowRight, Zap, TrendingUp } from 'lucide-react';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { prefetchApplet } from '../lib/appletPrefetch';

const CARDS = [
  {
    id: 'manager' as const,
    to: '/manager',
    title: 'Manager',
    subtitle: 'Rosters, entries, and SwimCloud import.',
    icon: Users,
    accent: 'text-[var(--color-info)]',
    borderHover: 'group-hover:border-[var(--color-info)]/40',
  },
  {
    id: 'matrix' as const,
    to: '/matrix',
    title: 'Matrix',
    subtitle: 'Score meets, chart standings, run what-if.',
    icon: BarChart3,
    accent: 'text-[var(--text-accent)]',
    borderHover: 'group-hover:border-[var(--text-accent)]/40',
  },
  {
    id: 'metrics' as const,
    to: '/metrics',
    title: 'Metrics',
    subtitle: 'Tag video locally — splits and velocity.',
    icon: Activity,
    accent: 'text-[var(--color-success)]',
    borderHover: 'group-hover:border-[var(--color-success)]/40',
  },
] as const;

const STEPS = [
  { n: '1', title: 'Load meet', desc: 'Upload a HyTek PDF in Matrix.' },
  { n: '2', title: 'Shape roster', desc: 'Edit scorers and entries in Manager.' },
  { n: '3', title: 'Simulate', desc: 'Charts update from roster changes.' },
  { n: '4', title: 'Analyze', desc: 'Review trends or tag race video.' },
];

export default function SuiteHome() {
  const { workspaces, activeWorkspace } = useSuiteWorkspace();
  const lastApplet = typeof window !== 'undefined' ? localStorage.getItem('omni-last-applet') : null;
  const lastLabel =
    lastApplet === '/manager' ? 'Manager' : lastApplet === '/matrix' ? 'Matrix' : lastApplet === '/metrics' ? 'Metrics' : null;

  return (
    <div className="suite-pool-hero relative overflow-hidden min-h-[calc(100vh-8rem)]">
      <div className="suite-pool-lanes absolute inset-0 pointer-events-none" aria-hidden />
      <div className="suite-pool-shimmer absolute inset-0 pointer-events-none" aria-hidden />

      <div className="relative max-w-5xl mx-auto px-4 py-12 lg:py-20">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <p className="text-ui-micro font-bold uppercase tracking-[0.3em] text-[var(--text-accent)] mb-3">
            Omni Swim Suite
          </p>
          <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-[var(--text-primary)] mb-3">
            Your meet command center
          </h2>
          <p className="text-ui-body text-theme-muted max-w-xl mx-auto">
            Load results, manage rosters, and analyze performance — one clean workflow.
          </p>

          <div className="flex flex-wrap justify-center gap-3 mt-8">
            {lastLabel && lastApplet ? (
              <Link to={lastApplet} className="btn-primary px-5 py-2.5 rounded-full text-ui-caption font-bold flex items-center gap-2">
                <Zap size={14} /> Resume {lastLabel}
              </Link>
            ) : null}
            <Link to="/matrix" className="btn-secondary px-5 py-2.5 rounded-full text-ui-caption font-bold flex items-center gap-2">
              Load a meet <ArrowRight size={14} />
            </Link>
            <Link to="/analytics" className="btn-ghost px-5 py-2.5 rounded-full text-ui-caption font-bold flex items-center gap-2 border border-theme-soft">
              <TrendingUp size={14} /> Season trends
            </Link>
          </div>
        </motion.div>

        {activeWorkspace ? (
          <p className="text-center text-ui-caption text-theme-muted mb-8">
            Active: <span className="font-semibold text-[var(--text-primary)]">{activeWorkspace.name}</span>
            {' · '}{workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}
          </p>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
          {CARDS.map((card, i) => {
            const Icon = card.icon;
            return (
              <motion.div key={card.to} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 * i }}>
                <Link
                  to={card.to}
                  onMouseEnter={() => prefetchApplet(card.id)}
                  className={`suite-home-card rounded-xl p-5 flex flex-col gap-3 h-full border border-theme-soft ${card.borderHover}`}
                >
                  <div className={`w-10 h-10 rounded-lg bg-[var(--surface-muted)] flex items-center justify-center border border-theme-soft ${card.accent}`}>
                    <Icon size={20} />
                  </div>
                  <div>
                    <h3 className="font-black text-[var(--text-primary)] group-hover:text-[var(--text-accent)]">{card.title}</h3>
                    <p className="text-ui-caption text-theme-muted mt-1">{card.subtitle}</p>
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>

        <div className="panel max-w-2xl mx-auto p-6">
          <h3 className="text-ui-label font-bold text-[var(--text-primary)] mb-4 text-center">How it flows</h3>
          <ol className="space-y-4">
            {STEPS.map(s => (
              <li key={s.n} className="flex gap-4 items-start">
                <span className="w-8 h-8 shrink-0 rounded-full bg-[var(--text-accent)]/15 text-[var(--text-accent)] font-mono font-bold text-ui-caption flex items-center justify-center">
                  {s.n}
                </span>
                <div>
                  <div className="font-bold text-[var(--text-primary)]">{s.title}</div>
                  <div className="text-ui-caption text-theme-muted">{s.desc}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
