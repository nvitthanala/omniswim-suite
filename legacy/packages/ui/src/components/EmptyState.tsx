import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from './Button';

type EmptyStateProps = {
  icon?: ReactNode;
  eyebrow?: string;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryAction?: ReactNode;
  className?: string;
};

export function EmptyState({
  icon,
  eyebrow,
  title,
  description,
  actionLabel,
  onAction,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <section
      className={[
        'surface-card flex min-h-[16rem] flex-col items-center justify-center rounded-3xl p-8 text-center',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon ? (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--text-accent)]/30 bg-[var(--text-accent)]/10 text-[var(--text-accent)]">
          {icon}
        </div>
      ) : null}
      {eyebrow ? <p className="label-caps mb-2">{eyebrow}</p> : null}
      <h2 className="max-w-xl text-2xl font-black tracking-tight text-[var(--text-primary)]">{title}</h2>
      <p className="mt-3 max-w-xl text-ui-body text-theme-secondary">{description}</p>
      {actionLabel && onAction ? (
        <div className="mt-6">
          <Button onClick={onAction} trailingIcon={<ArrowRight size={16} />}>
            {actionLabel}
          </Button>
        </div>
      ) : null}
      {secondaryAction ? <div className="mt-3">{secondaryAction}</div> : null}
    </section>
  );
}
