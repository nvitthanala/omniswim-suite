import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { BarChart3, Users, Activity, ArrowRight, Zap, Database, GitBranch } from 'lucide-react';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { prefetchApplet } from '../lib/appletPrefetch';

const CARDS = [
  {
    id: 'manager' as const,
    to: '/manager',
    title: 'Manager',
    subtitle: 'Roster tables, scorer flags, entry plans, relay legs, and SwimCloud paste import.',
    icon: Users,
    accent: 'text-[var(--color-info)]',
    borderHover: 'group-hover:border-[var(--color-info)]/40',
  },
  {
    id: 'matrix' as const,
    to: '/matrix',
    title: 'Matrix',
    subtitle: 'Upload HyTek PDFs, score meets, chart team totals, and run what-if simulations.',
    icon: BarChart3,
    accent: 'text-[var(--text-accent)]',
    borderHover: 'group-hover:border-[var(--text-accent)]/40',
  },
  {
    id: 'metrics' as const,
    to: '/metrics',
    title: 'Metrics',
    subtitle: 'Tag video events locally, compute splits and velocity — no cloud keys required.',
    icon: Activity,
    accent: 'text-[var(--color-success)]',
    borderHover: 'group-hover:border-[var(--color-success)]/40',
  },
] as const;

const WORKFLOW = [
  { step: '1', title: 'Load meet', body: 'Matrix parses your HyTek PDF into a shared workspace.' },
  { step: '2', title: 'Shape roster', body: 'Manager edits scorers, entries, and imports SwimCloud bests.' },
  { step: '3', title: 'Simulate', body: 'Matrix charts update instantly from Manager changes.' },
  { step: '4', title: 'Analyze', body: 'Metrics tags race video; roster names auto-suggest from workspace.' },
];

export default function SuiteHome() {
  const { workspaces, activeWorkspace, rosterNames } = useSuiteWorkspace();
  const lastApplet = typeof window !== 'undefined' ? localStorage.getItem('omni-last-applet') : null;
  const lastLabel =
    lastApplet === '/manager' ? 'Manager' : lastApplet === '/matrix' ? 'Matrix' : lastApplet === '/metrics' ? 'Metrics' : null;

  const swimmerCount = activeWorkspace
    ? new Set(
        [...(activeWorkspace.menResults ?? []), ...(activeWorkspace.womenResults ?? [])]
          .filter(r => !r.isRelay)
          .map(r => r.name)
      ).size
    : 0;

  return (
    <div className="suite-hero-bg relative overflow-hidden">
      <div className="suite-hero-grid absolute inset-0 pointer-events-none" aria-hidden />

      <div className="relative max-w-6xl mx-auto px-4 py-10 lg:py-16">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="text-center mb-10 lg:mb-14"
        >
          <p className="text-ui-micro font-bold uppercase tracking-[0.35em] text-[var(--text-accent)] mb-4">
            Omni Swim Analytics
          </p>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight text-[var(--text-primary)] mb-4">
            One suite. Three tools.
            <span className="block text-[var(--text-muted)] font-semibold text-xl sm:text-2xl mt-2">
              Meet ops, roster control, and video metrics — unified.
            </span>
          </h2>
          <p className="text-ui-body text-theme-muted max-w-2xl mx-auto leading-relaxed">
            Workspaces persist locally. Manager and Matrix share live data; switch applets without losing context.
          </p>

          {lastLabel && lastApplet ? (
            <Link
              to={lastApplet}
              className="inline-flex items-center gap-2 mt-8 px-5 py-2.5 rounded-full border border-[var(--text-accent)]/30 bg-[var(--text-accent)]/10 text-[var(--text-accent)] text-ui-micro font-bold uppercase tracking-widest hover:bg-[var(--text-accent)]/20 transition-colors"
            >
              <Zap size={14} />
              Resume {lastLabel}
              <ArrowRight size={14} />
            </Link>
          ) : null}
        </motion.div>

        {/* Live stats */}
        {activeWorkspace ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15 }}
            className="flex flex-wrap justify-center gap-3 mb-10"
          >
            <div className="suite-stat-pill px-4 py-2 rounded-full flex items-center gap-2 text-ui-caption">
              <Database size={14} className="text-[var(--text-accent)]" />
              <span className="text-theme-muted">Workspace</span>
              <span className="font-bold text-[var(--text-primary)] truncate max-w-[160px]">{activeWorkspace.name}</span>
            </div>
            <div className="suite-stat-pill px-4 py-2 rounded-full flex items-center gap-2 text-ui-caption">
              <Users size={14} className="text-[var(--color-info)]" />
              <span className="font-mono font-bold">{swimmerCount}</span>
              <span className="text-theme-muted">athletes in meet</span>
            </div>
            <div className="suite-stat-pill px-4 py-2 rounded-full flex items-center gap-2 text-ui-caption">
              <GitBranch size={14} className="text-[var(--color-success)]" />
              <span className="font-mono font-bold">{rosterNames.length}</span>
              <span className="text-theme-muted">roster-linked</span>
            </div>
            <div className="suite-stat-pill px-4 py-2 rounded-full text-ui-caption text-theme-muted">
              {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'} total
            </div>
          </motion.div>
        ) : null}

        {/* Applet cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6 mb-14">
          {CARDS.map((card, i) => {
            const Icon = card.icon;
            return (
              <motion.div
                key={card.to}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.08 }}
              >
                <Link
                  to={card.to}
                  onMouseEnter={() => prefetchApplet(card.id)}
                  onFocus={() => prefetchApplet(card.id)}
                  className={`suite-home-card rounded-xl p-6 flex flex-col gap-4 text-left group h-full border border-theme-soft ${card.borderHover}`}
                >
                  <div
                    className={`w-12 h-12 rounded-lg bg-[var(--surface-muted)] flex items-center justify-center border border-theme-soft ${card.accent}`}
                  >
                    <Icon size={24} />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-black uppercase tracking-tight text-[var(--text-primary)] group-hover:text-[var(--text-accent)] transition-colors">
                      {card.title}
                    </h3>
                    <p className="text-ui-caption text-theme-muted mt-2 leading-relaxed">{card.subtitle}</p>
                  </div>
                  <span className="text-ui-micro font-bold uppercase tracking-widest text-[var(--text-accent)] flex items-center gap-1">
                    Open <ArrowRight size={12} className="group-hover:translate-x-0.5 transition-transform" />
                  </span>
                </Link>
              </motion.div>
            );
          })}
        </div>

        {/* Workflow */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="surface-card rounded-xl p-6 lg:p-8 border border-theme-soft max-w-3xl mx-auto"
        >
          <h3 className="text-ui-label font-black uppercase tracking-widest text-[var(--text-primary)] mb-6 text-center">
            Typical workflow
          </h3>
          <div className="grid sm:grid-cols-2 gap-6">
            {WORKFLOW.map(item => (
              <div key={item.step} className="suite-workflow-step">
                <span className="text-ui-micro font-mono text-[var(--text-accent)] font-bold">Step {item.step}</span>
                <h4 className="text-ui-body font-bold text-[var(--text-primary)] mt-1">{item.title}</h4>
                <p className="text-ui-caption text-theme-muted mt-1 leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
