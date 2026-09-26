/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Title + "How to copy from SwimCloud" info popover atop
 * AthleteHistoryImportPanel — split out of the panel's own function body.
 */
import type { RefObject } from 'react';
import { ClipboardPaste, Info } from 'lucide-react';
import { Button } from '@omniswim/ui';

type Props = {
  infoRef: RefObject<HTMLDivElement | null>;
  showInfo: boolean;
  onToggleInfo: () => void;
};

export default function AthleteHistoryImportHeader({ infoRef, showInfo, onToggleInfo }: Props) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3 relative" ref={infoRef}>
      <div className="min-w-0">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <ClipboardPaste size={16} className="text-[var(--text-accent)] shrink-0" />
          SwimCloud import
        </h4>
        <p className="text-ui-body text-theme-secondary mt-1 leading-relaxed">
          Paste Personal Bests (or a roster table). We add new swimmers to the roster and line up
          events for athletes already on the team.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="p-2 text-theme-secondary hover:text-[var(--text-accent)] shrink-0"
        aria-label="How to copy from SwimCloud"
        onClick={onToggleInfo}
        leadingIcon={<Info size={16} />}
      />
      {showInfo ? (
        <div className="theme-popover absolute right-0 top-full mt-2 z-20 w-full max-w-md p-4 rounded-xl shadow-lg text-ui-body">
          <p className="text-ui-label font-semibold text-[var(--text-primary)] mb-2">Copy from SwimCloud</p>
          <ol className="list-decimal list-inside space-y-1.5 text-theme-secondary mb-3">
            <li>Open the swimmer profile on SwimCloud</li>
            <li>
              Go to the <strong className="text-[var(--text-primary)]">Times</strong> tab
            </li>
            <li>
              Select <strong className="text-[var(--text-primary)]">Personal Bests</strong>
            </li>
            <li>
              Sort by <strong className="text-[var(--text-primary)]">Best</strong>
            </li>
            <li>Copy the table → paste below → Parse</li>
          </ol>
          <p className="text-theme-muted">Header lines are fine. Stamps: X official · U manual · A/B cuts.</p>
        </div>
      ) : null}
    </div>
  );
}
