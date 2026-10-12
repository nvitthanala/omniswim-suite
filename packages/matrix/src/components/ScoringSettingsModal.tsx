import React, { useEffect, useState } from 'react';
import { X, Save, Settings2 } from 'lucide-react';
import { ScoringSettings } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import type { FinalizeScoringDraftResult } from '@omniswim/core/lib/scoringPlaceTables';
import { ScoringSettingsFields } from './ScoringSettingsFields';
import { BlankPlacesNotice } from './NullablePlacePointInput';
import { ScoringPresetManagerModal } from './ScoringPresetManagerModal';
import { Button, Modal } from '@omniswim/ui';

const BLANK_NOTICE_ID = 'scoring-settings-blank-places';
const noop = () => undefined;

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
  pdfPlacePointsLocked?: boolean;
  /** The results carry HyTek place points; lets a draft Auto lock before saving. */
  resultsCarryPdfPlacePoints?: boolean;
}

/**
 * The shell's "Suite Settings" full-screen chrome around the fields shared
 * with `ScoringSettingsPanel.tsx` — see `ScoringSettingsFields.tsx`'s own
 * file header. This entry point never receives a `suggestedPresetId` (that's
 * a meet-import-triggered flow, and this dialog isn't one).
 *
 * Uses the shared `Modal` for dialog role, aria-modal, Escape, and focus
 * handling — the previous hand-rolled backdrop had none of those.
 */
export default function ScoringSettingsModal({ settings, onSave, onClose, scoringView, onScoringViewChange, conference, pdfPlacePointsLocked, resultsCarryPdfPlacePoints }: Props) {
  // The latest finalized draft. Starts as the merged stored settings, untouched: an unedited form
  // saves exactly what it loaded, and a blank place cell turns this into `{ ok: false }`.
  const [result, setResult] = useState<FinalizeScoringDraftResult>(() => ({
    ok: true,
    settings: mergeScoringSettings(settings),
  }));
  const [manageOpen, setManageOpen] = useState(false);
  const [presetListRefreshToken, setPresetListRefreshToken] = useState(0);

  // The draft resets when the modal opens (it mounts only while open) or when
  // the incoming settings change in content. An equal-but-new object from the
  // parent must not wipe unsaved edits.
  const settingsKey = JSON.stringify(settings);
  useEffect(() => {
    setResult({ ok: true, settings: mergeScoringSettings(settings) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settingsKey is the content identity of `settings`
  }, [settingsKey]);

  return (
    <>
      <Modal
        onClose={onClose}
        ariaLabel="Scoring rules"
        className="rounded-2xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col"
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-medium text-[var(--text-primary)]">Scoring rules</h2>
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
            className="text-theme-secondary hover:text-[var(--text-primary)]"
            aria-label="Close"
            leadingIcon={<X size={20} />}
          />
        </div>

        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6 text-sm">
          <ScoringSettingsFields
            settings={settings}
            onChange={noop}
            onDraftChange={(_draft, next) => setResult(next)}
            conference={conference}
            pdfPlacePointsLocked={pdfPlacePointsLocked}
            resultsCarryPdfPlacePoints={resultsCarryPdfPlacePoints}
            scoringView={scoringView}
            onScoringViewChange={onScoringViewChange}
            presetPickerExtra={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setManageOpen(true)}
                aria-label="Manage scoring rule sets"
                className="shrink-0"
                leadingIcon={<Settings2 size={10} aria-hidden />}
              >
                Manage rule sets
              </Button>
            }
            presetListRefreshToken={presetListRefreshToken}
          />
        </div>

        <div className="pt-6 mt-2 border-t border-theme-soft flex items-center justify-end gap-3">
          {result.ok ? null : <BlankPlacesNotice blanks={result.blanks} id={BLANK_NOTICE_ID} />}
          <Button variant="ghost" onClick={onClose} className="shrink-0">
            Cancel
          </Button>
          <Button
            variant="primary"
            className="shrink-0"
            disabled={!result.ok}
            aria-describedby={result.ok ? undefined : BLANK_NOTICE_ID}
            onClick={() => {
              if (result.ok) onSave(result.settings);
            }}
            leadingIcon={<Save size={16} />}
          >
            Update scoring model
          </Button>
        </div>
      </Modal>

      {manageOpen ? (
        <ScoringPresetManagerModal
          onClose={() => setManageOpen(false)}
          onPresetsChanged={() => setPresetListRefreshToken(v => v + 1)}
        />
      ) : null}
    </>
  );
}
