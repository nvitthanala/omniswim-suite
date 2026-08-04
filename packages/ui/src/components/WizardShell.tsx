import React, { useId, useRef } from 'react';
import { CheckCircle2 } from 'lucide-react';

export type WizardStep<T extends string = string> = {
  id: T;
  label: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
};

export type WizardShellProps<T extends string> = {
  steps: readonly WizardStep<T>[];
  eyebrow: string;
  ariaLabel: string;
  step: T;
  onStepChange: (step: T) => void;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
};

/** A reusable, accessible step workflow shell. */
export function WizardShell<T extends string>({
  steps,
  eyebrow,
  ariaLabel,
  step,
  onStepChange,
  toolbar,
  children,
}: WizardShellProps<T>) {
  const reactId = useId().replace(/:/g, '');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = steps.find(s => s.id === step) ?? steps[0];
  const stepIndex = steps.findIndex(s => s.id === step);
  const activeIndex = stepIndex >= 0 ? stepIndex : 0;
  const panelId = `wizard-panel-${reactId}`;

  const selectStep = (index: number) => {
    const nextIndex = (index + steps.length) % steps.length;
    onStepChange(steps[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="flex flex-col gap-5 flex-1 min-h-0">
      <div className="surface-card rounded-xl p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-ui-caption text-theme-muted mb-1">{eyebrow}</p>
            <h3 className="text-heading-2 truncate">{active.title}</h3>
            <p className="text-ui-body text-theme-secondary mt-1 max-w-2xl leading-relaxed">{active.hint}</p>
          </div>
          {toolbar ? <div className="shrink-0 flex flex-wrap gap-2">{toolbar}</div> : null}
        </div>

        <div
          className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2"
          role="tablist"
          aria-label={ariaLabel}
        >
          {steps.map((s, i) => {
            const isActive = i === activeIndex;
            const isDone = i < activeIndex;
            const tabId = `wizard-tab-${reactId}-${s.id}`;
            return (
              <button
                key={s.id}
                ref={element => { tabRefs.current[i] = element; }}
                type="button"
                role="tab"
                id={tabId}
                aria-controls={panelId}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onStepChange(s.id)}
                onKeyDown={event => {
                  switch (event.key) {
                    case 'ArrowLeft':
                      event.preventDefault();
                      selectStep(i - 1);
                      break;
                    case 'ArrowRight':
                      event.preventDefault();
                      selectStep(i + 1);
                      break;
                    case 'Home':
                      event.preventDefault();
                      selectStep(0);
                      break;
                    case 'End':
                      event.preventDefault();
                      selectStep(steps.length - 1);
                      break;
                  }
                }}
                className={`text-left rounded-xl border px-3.5 py-3 transition-colors min-w-0 ${
                  isActive
                    ? 'border-[var(--text-accent)]/50 bg-[var(--text-accent)]/10'
                    : isDone
                      ? 'border-theme-soft surface-overlay hover:border-[var(--text-accent)]/30'
                      : 'border-theme-soft surface-muted-bg hover:border-theme'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                      isActive
                        ? 'bg-[var(--text-accent)]/20 text-[var(--text-accent)]'
                        : isDone
                          ? 'bg-[var(--text-accent)]/10 text-[var(--text-accent)]'
                          : 'surface-overlay text-theme-secondary'
                    }`}
                  >
                    {isDone && !isActive ? <CheckCircle2 size={16} /> : s.icon}
                  </span>
                  <div className="min-w-0">
                    <p className={`text-ui-label font-semibold truncate ${isActive ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]'}`}>
                      {i + 1}. {s.label}
                    </p>
                    <p className="text-ui-caption text-theme-muted truncate">{s.title}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`wizard-tab-${reactId}-${active.id}`}
        tabIndex={0}
        className="flex-1 min-h-0 flex flex-col"
      >
        {children}
      </div>
    </div>
  );
}
