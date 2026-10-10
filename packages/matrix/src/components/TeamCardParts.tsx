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

import { CutlineTag, CutlineNearMissChip, SegmentedControl } from '@omniswim/ui';
import type { CutlineTagResult } from '@omniswim/core/lib/cutlineTags';
import type { SwimmerResult } from '@omniswim/core/types';
import { isEstimatedRelayRow } from '@omniswim/core/lib/theoreticalMeetLabel';
import { useSuiteWorkspaceOptional } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { RELAY_ESTIMATE_NOT_JUDGED_LABEL, RELAY_ESTIMATE_NOT_JUDGED_TITLE, type TeamRowCutlineTags } from './teamCardView';

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

/**
 * Whether this row is an estimated relay of the active workspace (`isEstimatedRelayRow`). False outside a
 * provider, and for every row of a real meet.
 */
export function useIsEstimatedRelayRow(res: Pick<SwimmerResult, 'isRelay' | 'event'>): boolean {
  const ctx = useSuiteWorkspaceOptional();
  return isEstimatedRelayRow(ctx?.activeWorkspace, res);
}

/**
 * The relay team's own verdict slot. An estimated relay shows "Estimate, not judged" here: no cut tag and no
 * miss. Any other relay row shows its cutline verdict as before.
 */
export function RelayVerdict({ tags }: { tags: Extract<TeamRowCutlineTags, { kind: 'relay' }> }) {
  if (tags.tags.relay === null) {
    return (
      <span
        className="inline-flex items-center rounded border border-theme-soft px-1 text-ui-micro text-theme-muted font-sans"
        title={RELAY_ESTIMATE_NOT_JUDGED_TITLE}
        data-relay-estimate-not-judged
      >
        {RELAY_ESTIMATE_NOT_JUDGED_LABEL}
      </span>
    );
  }
  return <CutlineVerdict result={tags.tags.relay} />;
}

/** The "Chart: By event / By class" toggle above a team's points chart. */
export function TeamCardChartToggle({
  value,
  onChange,
}: {
  value: 'event' | 'class';
  onChange: (next: 'event' | 'class') => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-ui-micro text-theme-secondary">Chart:</span>
      <SegmentedControl
        layout="inline"
        ariaLabel="Points chart grouping"
        value={value}
        onChange={onChange}
        options={[
          { value: 'event', label: 'By event', ariaLabel: 'Show points chart by event' },
          { value: 'class', label: 'By class', ariaLabel: 'Show points chart by class year' },
        ]}
      />
    </div>
  );
}
