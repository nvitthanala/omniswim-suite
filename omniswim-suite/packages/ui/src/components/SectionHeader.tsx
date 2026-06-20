import type { ReactNode } from 'react';

type Props = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
};

export function SectionHeader({ title, subtitle, actions, className = '' }: Props) {
  return (
    <div className={`section-header ${className}`.trim()}>
      <div className="min-w-0">
        <h3 className="section-header-title">{title}</h3>
        {subtitle ? <p className="section-header-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="toolbar shrink-0">{actions}</div> : null}
    </div>
  );
}
