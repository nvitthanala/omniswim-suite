/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Leaf glyph/badge components for TeamCard's two render trees.
 *
 * `CutlineVerdict` is drawn by both the chart tooltip (`TeamCardTooltips.tsx`)
 * and the team matrix row (`TeamCardMatrixRow.tsx`), so it cannot live in
 * either without one importing the other. `PodiumMedal` sits alongside it
 * because it is the same kind of thing — a single-glyph leaf with no layout of
 * its own. Pure extraction from `TeamCard.tsx` — no behavior change.
 */

import { CutlineTag, CutlineNearMissChip } from '@omniswim/ui';
import type { CutlineTagResult } from '@omniswim/core/lib/cutlineTags';

const PODIUM_MEDALS: Record<string, { emoji: string; className: string; label: string }> = {
  gold: { emoji: '🥇', className: 'text-yellow-400', label: 'Gold' },
  silver: { emoji: '🥈', className: 'text-theme-secondary', label: 'Silver' },
  bronze: { emoji: '🥉', className: 'text-orange-400', label: 'Bronze' },
};

/** Medal glyph for a swimmer's podium finish, or nothing when there isn't one. */
export function PodiumMedal({ podium }: { podium?: string }) {
  const medal = podium ? PODIUM_MEDALS[podium] : undefined;
  if (!medal) return null;
  return (
    <span className={medal.className} title={medal.label}>
      {medal.emoji}
    </span>
  );
}

/** A cutline tag plus its near-miss chip, the pairing repeated at every verdict slot. */
export function CutlineVerdict({ result, className }: { result: CutlineTagResult; className?: string }) {
  return (
    <>
      <CutlineTag result={result} compact className={className} />
      <CutlineNearMissChip nextTier={result.nextTier} compact className={className} />
    </>
  );
}
