import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

type BadgeTone = 'accent' | 'success' | 'warning' | 'info' | 'neutral' | 'danger';

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  children: ReactNode;
};

const TONE_CLASSES: Record<BadgeTone, string> = {
  accent: 'border-[var(--text-accent)]/30 bg-[var(--text-accent)]/10 text-[var(--text-accent)]',
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  warning: 'badge-warning',
  info: 'badge-info',
  neutral: 'border-theme-soft bg-[var(--surface-muted)] text-theme-secondary',
  danger: 'border-red-400/30 bg-red-500/10 text-red-300',
};

/**
 * Default shape is a `px-2.5 py-1 rounded-full` pill. A caller migrating a
 * denser hand-rolled badge (commonly `px-2 py-0.5 rounded text-[10px]`, see
 * `plans/2026-09-10/03-MANAGER-DIAGNOSIS.md` §4d) passes its own sizing
 * classes in `className` to preserve that site's exact visual size — `cn()`
 * resolves the conflict by utility group, so the override reliably wins
 * however it's ordered, unlike the plain string-join this used before.
 */
export function Badge({ tone = 'neutral', className, children, ...props }: BadgeProps) {
  const classes = cn(
    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-ui-micro font-bold uppercase tracking-widest',
    TONE_CLASSES[tone],
    className
  );

  return (
    <span className={classes} {...props}>
      {children}
    </span>
  );
}
