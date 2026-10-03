/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `ScoringSettingsFields`'s three optional banners: the merged/PDF-only
 * scoring-view toggle, the "some fields are fixed by competition rule"
 * notice, and the meet-import flow's suggested-preset banner. Pure
 * extraction from `ScoringSettingsFields.tsx` — no behavior change.
 */

import { Lock } from 'lucide-react';
import { Button, SegmentedControl } from '@omniswim/ui';

interface ScoringViewBannerProps {
  scoringView: 'merged' | 'pdf_only';
  onScoringViewChange: (view: 'merged' | 'pdf_only') => void;
}

export function ScoringViewBanner({ scoringView, onScoringViewChange }: ScoringViewBannerProps) {
  return (
    <div className="mb-4 p-3 rounded-lg border border-theme-soft surface-overlay">
      <label className="block text-ui-caption text-theme-secondary font-medium mb-2">
        Scoring view
      </label>
      <SegmentedControl
        layout="inline"
        ariaLabel="Scoring view"
        value={scoringView}
        onChange={onScoringViewChange}
        options={[
          {
            value: 'merged',
            label: 'Merged',
            ariaLabel: 'Use merged scoring view',
            title: "Imported/planned/recruit entries remap onto the loaded meet's events and compete for points",
          },
          {
            value: 'pdf_only',
            label: 'PDF only',
            ariaLabel: 'Use PDF-only scoring view',
            title: 'Plans and recruits are excluded from scoring — original PDF-base scoring only',
          },
        ]}
      />
      <p className="text-[9px] text-theme-muted mt-2 normal-case tracking-normal">
        {scoringView === 'merged'
          ? 'Plans, imports, and recruits remap onto the loaded meet and compete for points.'
          : 'Plans and recruits are excluded from scoring — only the original meet results score.'}
      </p>
    </div>
  );
}

export function ScoringLockBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 p-3 rounded-lg border border-theme-soft surface-overlay flex items-start gap-2">
      <Lock size={12} className="text-theme-muted mt-0.5 shrink-0" aria-hidden />
      <p className="text-[10px] text-theme-secondary leading-relaxed normal-case tracking-normal">
        {message}
        <span className="text-theme-muted">
          {' '}
          Editing them here would have no effect, so they are shown fixed rather than accepting a change that is
          discarded before scoring.
        </span>
      </p>
    </div>
  );
}

interface SuggestedPresetBannerProps {
  suggestedPresetId: string;
  onLoadAndSave: () => void;
}

export function SuggestedPresetBanner({ suggestedPresetId, onLoadAndSave }: SuggestedPresetBannerProps) {
  return (
    <div className="mb-4 p-3 rounded badge-warning text-[10px]">
      <span className="font-medium">Suggested preset: </span>
      {suggestedPresetId}
      <Button
        variant="ghost"
        size="sm"
        className="ml-2 underline hover:text-[var(--text-primary)]"
        onClick={onLoadAndSave}
        aria-label={`Load and save suggested ${suggestedPresetId} scoring preset`}
      >
        Load & save
      </Button>
    </div>
  );
}
