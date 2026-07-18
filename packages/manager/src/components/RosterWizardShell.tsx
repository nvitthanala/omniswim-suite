/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Roster management wizard — Source → Lineup → Relays → Optimize.
 */

import React from 'react';
import { ClipboardPaste, LayoutList, Sparkles, Waves } from 'lucide-react';

export type RosterWizardStepId = 'source' | 'lineup' | 'relays' | 'optimize';

const STEPS: {
  id: RosterWizardStepId;
  label: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    id: 'source',
    label: 'Source',
    title: 'Bring in swimmers',
    hint: 'Meet PDF status, scoring rules, SwimCloud import, and recruits.',
    icon: <ClipboardPaste size={16} />,
  },
  {
    id: 'lineup',
    label: 'Lineup',
    title: 'Build the roster',
    hint: 'Pick scorers, plan entries, and clear checklist warnings.',
    icon: <LayoutList size={16} />,
  },
  {
    id: 'relays',
    label: 'Relays',
    title: 'Fill relay legs',
    hint: 'Replace vacant legs and build relays from the individual lineup.',
    icon: <Waves size={16} />,
  },
  {
    id: 'optimize',
    label: 'Optimize',
    title: 'Find more points',
    hint: 'Review trade-offs and apply the strongest lineup.',
    icon: <Sparkles size={16} />,
  },
];

type Props = {
  step: RosterWizardStepId;
  onStepChange: (step: RosterWizardStepId) => void;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
};

export default function RosterWizardShell({ step, onStepChange, toolbar, children }: Props) {
  const active = STEPS.find(s => s.id === step) ?? STEPS[0];
  const stepIndex = STEPS.findIndex(s => s.id === step);

  return (
    <div className="flex flex-col gap-5 flex-1 min-h-0">
      <div className="surface-card rounded-xl p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-ui-caption text-theme-muted mb-1">Roster workflow</p>
            <h3 className="text-lg sm:text-xl font-semibold text-[var(--text-primary)] tracking-tight truncate">
              {active.title}
            </h3>
            <p className="text-ui-body text-theme-secondary mt-1 max-w-2xl leading-relaxed">
              {active.hint}
            </p>
          </div>
          {toolbar ? <div className="shrink-0 flex flex-wrap gap-2">{toolbar}</div> : null}
        </div>

        <div
          className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2"
          role="tablist"
          aria-label="Roster steps"
        >
          {STEPS.map((s, i) => {
            const isActive = s.id === step;
            const isDone = i < stepIndex;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onStepChange(s.id)}
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
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      isActive
                        ? 'bg-[var(--text-accent)]/20 text-[var(--text-accent)]'
                        : 'surface-overlay text-theme-secondary'
                    }`}
                  >
                    {s.icon}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-ui-label font-semibold truncate ${
                        isActive ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]'
                      }`}
                    >
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

      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}
