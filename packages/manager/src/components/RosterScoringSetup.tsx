import { Settings } from 'lucide-react';
import type { ScoringSettings, Workspace } from '@omniswim/core/types';
import { Button, useOpenScoringRules } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  settings: ScoringSettings;
  onSave: (patch: Partial<Workspace>) => void;
};

export default function RosterScoringSetup({ workspace, settings }: Props) {
  const openScoringRules = useOpenScoringRules();
  const eligibility = settings.scorerEligibilityMode === 'roster' ? 'Team scorer list' : 'Points pool';
  return (
    <div className="surface-overlay border border-theme-soft rounded-xl mb-0 px-3.5 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-ui-label font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Settings size={14} className="shrink-0 text-[var(--text-accent)]" />
          <span>Scoring rules</span>
          {workspace.conference ? <span className="text-theme-muted font-normal truncate">({workspace.conference})</span> : null}
        </div>
        <p className="mt-1 text-ui-caption text-theme-secondary">{eligibility} · {settings.scoringPoints.length} scoring places</p>
      </div>
      <Button variant="outline" size="sm" onClick={openScoringRules}>Edit scoring rules</Button>
    </div>
  );
}
