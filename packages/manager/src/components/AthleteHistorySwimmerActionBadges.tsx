/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-swimmer action badges ("new recruit", "matched", …) above the preview
 * table in AthleteHistoryImportPanel — split out of the panel's own function
 * body.
 */
import type { ImportSwimmerPreview } from '@omniswim/core/lib/historyImportRoster';
import { actionBadge } from './athleteHistoryImportView';

type Props = {
  swimmerActions: ImportSwimmerPreview[];
};

export default function AthleteHistorySwimmerActionBadges({ swimmerActions }: Props) {
  if (swimmerActions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {swimmerActions.map(s => {
        const badge = actionBadge(s.action);
        return (
          <span
            key={`${s.name}|${s.action}`}
            className={`text-ui-caption px-2 py-1 rounded-lg border max-w-full truncate ${badge.className}`}
            title={`${s.name}: ${badge.label} · ${s.swimCount} swim(s)`}
          >
            {s.name}: {badge.label}
          </span>
        );
      })}
    </div>
  );
}
