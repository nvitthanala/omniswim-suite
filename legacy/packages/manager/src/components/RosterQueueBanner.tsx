/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "Roster queue" checklist banner atop RosterImportWizard — split out of
 * the wizard's own function body so this region's branching lives here.
 */
import { Download } from 'lucide-react';
import type { RosterQueue } from '../lib/rosterQueueImport';

type Props = {
  rosterQueue: RosterQueue;
  isImportingFromClipboard: boolean;
  team: string;
  onCaptureNext: () => void;
  onClear: () => void;
};

export default function RosterQueueBanner({
  rosterQueue,
  isImportingFromClipboard,
  team,
  onCaptureNext,
  onClear,
}: Props) {
  return (
    <div className="border border-theme-soft rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-ui-caption font-bold">
          Roster queue — {rosterQueue.teamLabel} (
          {rosterQueue.entries.filter(e => e.captured).length}/{rosterQueue.entries.length} captured)
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCaptureNext}
            disabled={isImportingFromClipboard || !team.trim()}
            title="Copy a swimmer's Times page from SwimCloud — swimcloud.com/swimmer/{id}/times/, via Copy for Omniswim — then click this to pull it in and check them off."
            className="px-2.5 py-1 text-ui-micro font-bold rounded-md nav-tab-inactive hover:text-[var(--text-primary)] transition-colors disabled:opacity-40 flex items-center gap-1"
          >
            <Download size={12} /> {isImportingFromClipboard ? 'Reading…' : 'Capture next swimmer'}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="px-2.5 py-1 text-ui-micro font-bold rounded-md nav-tab-inactive hover:text-[var(--text-primary)] transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {rosterQueue.entries.map(e => (
          <span
            key={e.swimCloudSwimmerId ?? e.name}
            className={`text-ui-micro px-1.5 py-0.5 rounded-full border ${
              e.captured
                ? 'border-[var(--text-accent)]/40 text-[var(--text-accent)]'
                : 'border-theme-soft text-theme-muted'
            }`}
          >
            {e.captured ? '✓ ' : ''}
            {e.name}
          </span>
        ))}
      </div>
    </div>
  );
}
