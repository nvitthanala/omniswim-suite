import { useState } from 'react';
import { Settings } from 'lucide-react';
import type { ScoringSettings } from '@omniswim/core/types';
import { fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import { Button, useOpenScoringRules } from '@omniswim/ui';
import { SuggestedPresetBanner } from './ScoringSettingsBanners';

type Props = {
  settings: ScoringSettings;
  onSave: (s: ScoringSettings) => void;
  suggestedPresetId?: string | null;
  onClearSuggestedPreset?: () => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
  scoringView?: 'merged' | 'pdf_only';
  onScoringViewChange?: (view: 'merged' | 'pdf_only') => void;
  conference?: string;
};

export default function ScoringSettingsPanel({ settings, onSave, suggestedPresetId, onClearSuggestedPreset }: Props) {
  const openScoringRules = useOpenScoringRules();
  const [presetError, setPresetError] = useState<string | null>(null);
  const eligibility = settings.scorerEligibilityMode === 'roster' ? 'Team scorer list' : 'Points pool';
  return (
    <div className="surface-card rounded-xl p-5">
      {suggestedPresetId ? (
        <SuggestedPresetBanner
          suggestedPresetId={suggestedPresetId}
          onLoadAndSave={() => {
            setPresetError(null);
            fetchScoringPresetSettings(suggestedPresetId)
              .then(next => {
                onSave(next);
                onClearSuggestedPreset?.();
              })
              .catch(err => {
                setPresetError(
                  `Could not load the suggested rule set${err instanceof Error && err.message ? `: ${err.message}` : ''}. Try again, or choose one in Edit scoring rules.`
                );
              });
          }}
        />
      ) : null}
      {presetError ? (
        <p role="alert" className="mb-3 text-ui-caption text-[var(--color-warning)]">
          {presetError}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-ui-label font-medium text-theme-secondary">Scoring rules</h4>
          <p className="mt-1 text-ui-body text-theme-secondary">{eligibility} · {settings.scoringPoints.length} scoring places</p>
        </div>
        <Button variant="outline" onClick={openScoringRules} leadingIcon={<Settings size={14} />}>
          Edit scoring rules
        </Button>
      </div>
    </div>
  );
}
