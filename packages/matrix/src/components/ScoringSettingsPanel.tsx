import React, { useState } from 'react';
import { ChevronDown, Settings, Settings2, Save } from 'lucide-react';
import { ScoringSettings } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { ScoringSettingsFields } from './ScoringSettingsFields';
import { ScoringPresetManagerModal } from './ScoringPresetManagerModal';
import { Button } from '@omniswim/ui';

type Props = {
  settings: ScoringSettings;
  onSave: (s: ScoringSettings) => void;
  suggestedPresetId?: string | null;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Workspace-level scoring view (absent = 'merged'); omit to hide the toggle. */
  scoringView?: 'merged' | 'pdf_only';
  onScoringViewChange?: (view: 'merged' | 'pdf_only') => void;
  /**
   * Workspace conference. Decides which controls the engine will overwrite —
   * without it this panel offers edits that `mergeScoringSettings` discards.
   */
  conference?: string;
};

/**
 * Matrix's own "Score" step chrome (collapsible section, small Save badge)
 * around the fields shared with `ScoringSettingsModal.tsx` — see
 * `ScoringSettingsFields.tsx`'s own file header for why the fields moved out
 * of this file and what changed for this editor's own users along the way
 * (the points-editing UI, most visibly).
 */
export default function ScoringSettingsPanel({
  settings,
  onSave,
  suggestedPresetId,
  collapsible = false,
  defaultOpen = false,
  scoringView,
  onScoringViewChange,
  conference,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<ScoringSettings>(() => mergeScoringSettings(settings));
  const [manageOpen, setManageOpen] = useState(false);
  const [presetListRefreshToken, setPresetListRefreshToken] = useState(0);

  const headerTitle = (
    <h4 className="text-ui-label font-medium text-theme-secondary uppercase tracking-widest flex items-center gap-2">
      <Settings size={12} />
      Custom Scoring Logic
    </h4>
  );

  const saveButton = (
    <Button
      variant="primary"
      size="sm"
      onClick={() => onSave(draft)}
      aria-label="Save scoring settings"
      className="shrink-0"
      leadingIcon={<Save size={10} />}
    >
      Save
    </Button>
  );

  const header = (
    <div className="flex items-center justify-between gap-3 w-full">
      {headerTitle}
      <div className="flex items-center gap-2">
        {!collapsible ? saveButton : null}
        {collapsible ? (
          <ChevronDown
            size={14}
            className={`text-theme-secondary transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );

  const manageRuleSetsButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setManageOpen(true)}
      aria-label="Manage scoring rule sets"
      className="uppercase tracking-widest shrink-0"
      leadingIcon={<Settings2 size={10} aria-hidden />}
    >
      Manage rule sets
    </Button>
  );

  const body = (
    <ScoringSettingsFields
      settings={settings}
      onChange={setDraft}
      conference={conference}
      scoringView={scoringView}
      onScoringViewChange={onScoringViewChange}
      suggestedPresetId={suggestedPresetId}
      onApplyAndSaveSuggestedPreset={onSave}
      presetPickerExtra={manageRuleSetsButton}
      presetListRefreshToken={presetListRefreshToken}
    />
  );

  const manageModal = manageOpen ? (
    <ScoringPresetManagerModal
      onClose={() => setManageOpen(false)}
      onPresetsChanged={() => setPresetListRefreshToken(v => v + 1)}
    />
  ) : null;

  if (collapsible) {
    return (
      <div className="surface-card rounded-xl overflow-hidden shrink-0">
        <div className="flex items-center gap-2 p-4">
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-label={`${open ? 'Collapse' : 'Expand'} custom scoring logic`}
            aria-expanded={open}
            className="flex-1 min-w-0 text-left hover:opacity-90 transition-opacity"
          >
            {header}
          </button>
          {open ? saveButton : null}
        </div>
        {open ? <div className="px-5 pb-5 border-t border-theme-soft pt-4">{body}</div> : null}
        {manageModal}
      </div>
    );
  }

  return (
    <div className="surface-card rounded-xl p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        {headerTitle}
        {saveButton}
      </div>
      {body}
      {manageModal}
    </div>
  );
}
