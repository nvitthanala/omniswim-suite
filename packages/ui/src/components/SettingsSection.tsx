import type { ReactNode } from 'react';

type SettingsSectionProps = {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={['surface-card rounded-2xl p-5 space-y-4', className].filter(Boolean).join(' ')}>
      <div>
        <h2 className="text-lg font-black tracking-tight text-[var(--text-primary)]">{title}</h2>
        {description ? <p className="mt-1 text-ui-body text-theme-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
