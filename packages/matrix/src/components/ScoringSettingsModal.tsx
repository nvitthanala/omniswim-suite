import React, { useState } from 'react';
import { X, Save } from 'lucide-react';
import { ScoringSettings } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { ScoringSettingsFields } from './ScoringSettingsFields';

interface Props {
  settings: ScoringSettings;
  onSave: (s: ScoringSettings) => void;
  onClose: () => void;
  /** Workspace-level scoring view (absent = 'merged'); omit the callback to hide the toggle. */
  scoringView?: 'merged' | 'pdf_only';
  onScoringViewChange?: (view: 'merged' | 'pdf_only') => void;
  /**
   * Workspace conference. Decides which controls the engine will overwrite —
   * without it this modal offers edits that `mergeScoringSettings` discards.
   */
  conference?: string;
}

/**
 * The shell's "Suite Settings" full-screen chrome around the fields shared
 * with `ScoringSettingsPanel.tsx` — see `ScoringSettingsFields.tsx`'s own
 * file header. This entry point never receives a `suggestedPresetId` (that's
 * a meet-import-triggered flow, and this dialog isn't one).
 */
export default function ScoringSettingsModal({ settings, onSave, onClose, scoringView, onScoringViewChange, conference }: Props) {
  const [draft, setDraft] = useState<ScoringSettings>(() => mergeScoringSettings(settings));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop backdrop-blur-sm">
      <div className="surface-card rounded-2xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">Scoring Matrix Configuration</h2>
          <button onClick={onClose} className="text-theme-secondary hover:text-[var(--text-primary)] transition-colors" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6 text-sm">
          <ScoringSettingsFields
            settings={settings}
            onChange={setDraft}
            conference={conference}
            scoringView={scoringView}
            onScoringViewChange={onScoringViewChange}
          />
        </div>

        <div className="pt-6 mt-2 border-t border-theme-soft flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 theme-hover-row rounded-lg text-theme-secondary transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            className="px-6 py-2 bg-[var(--text-accent)] border border-[var(--text-accent)]/25 text-white rounded-lg font-medium flex items-center gap-2 transition-colors hover:bg-[var(--btn-action-hover)]"
          >
            <Save size={16} />
            Update scoring model
          </button>
        </div>
      </div>
    </div>
  );
}
