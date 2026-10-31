/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Footer button row for RosterImportWizard — Back/Cancel plus the
 * Preview/Import (or replace-review) primary action. Split out of the
 * wizard's own function body so this region's branching lives here.
 */
import { Button } from '@omniswim/ui';

type Props = {
  step: 'paste' | 'preview';
  onBack: () => void;
  onClose: () => void;
  onParse: () => void;
  pasteEmpty: boolean;
  onMerge: () => void;
  previewEmpty: boolean;
  isReplaceMode: boolean;
};

export default function RosterImportFooterActions({
  step,
  onBack,
  onClose,
  onParse,
  pasteEmpty,
  onMerge,
  previewEmpty,
  isReplaceMode,
}: Props) {
  return (
    <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-soft">
      {step === 'preview' ? (
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-ui-micro font-bold nav-tab-inactive hover:text-[var(--text-primary)]"
        >
          Back
        </button>
      ) : null}
      <button type="button" onClick={onClose} className="px-4 py-2 text-ui-micro font-bold nav-tab-inactive">
        Cancel
      </button>
      {step === 'paste' ? (
        <Button variant="primary" size="md" onClick={onParse} disabled={pasteEmpty}>
          Preview
        </Button>
      ) : (
        <Button variant="primary" size="md" onClick={onMerge} disabled={previewEmpty}>
          {isReplaceMode ? 'Review replace…' : 'Import & add to roster'}
        </Button>
      )}
    </div>
  );
}
