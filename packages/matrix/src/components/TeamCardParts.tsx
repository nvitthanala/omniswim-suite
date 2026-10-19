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
import { classifyRoundTier, parseRankInt } from '@omniswim/core/lib/scoringRules';
import { useSuiteWorkspaceOptional } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { RELAY_ESTIMATE_NOT_JUDGED_LABEL, RELAY_ESTIMATE_NOT_JUDGED_TITLE, type TeamRowCutlineTags } from './teamCardView';

const PODIUM_MEDALS: Record<number, { color: string; label: string }> = {
  1: { color: 'var(--ui-medal-gold)', label: '1st place' },
  2: { color: 'var(--ui-medal-silver)', label: '2nd place' },
  3: { color: 'var(--ui-medal-bronze)', label: '3rd place' },
};

/** The legacy `podium` strings, kept so an older caller still renders. */
const LEGACY_PODIUM_PLACE: Record<string, number> = { gold: 1, silver: 2, bronze: 3 };

// Rounds whose rank is an overall finish. A prelim, B/C/D final or time trial
// restarts or does not decide the podium, so its rank 1 is not a gold medal.
const PODIUM_TIERS = new Set(['A', 'FIN', 'UNK']);

/**
 * The podium place (1, 2 or 3) a result row earned, or `undefined`. It reads the
 * rank the meet recorded and does not compute standings. An exhibition swim, a
 * time trial, a row from a prelim or a consolation final, and a recruit row (its
 * rank is a projection) have no podium place.
 */
export function podiumPlaceOf(
  row: Pick<SwimmerResult, 'rank' | 'roundSwam' | 'isExhibition' | 'isTimeTrial' | 'isRecruit'>
): 1 | 2 | 3 | undefined {
  if (row.isExhibition || row.isTimeTrial || row.isRecruit) return undefined;
  if (!PODIUM_TIERS.has(classifyRoundTier(row.roundSwam))) return undefined;
  const place = parseRankInt(row.rank);
  return place === 1 || place === 2 || place === 3 ? place : undefined;
}

/**
 * Medal for a podium finish: gold, silver or bronze for place 1, 2 or 3, and
 * nothing for any other place or an absent one. Colors are the `--ui-medal-*`
 * theme tokens, and the label ("1st place") is on the image for assistive tech.
 * `podium` is the older prop; `place` wins when both are given.
 */
export function PodiumMedal({ place, podium }: { place?: number | null; podium?: string }) {
  const resolved = place ?? (podium ? LEGACY_PODIUM_PLACE[podium] : undefined);
  const medal = resolved === undefined || resolved === null ? undefined : PODIUM_MEDALS[resolved];
  if (!medal) return null;
  return (
    <span
      role="img"
      aria-label={medal.label}
      title={medal.label}
      data-podium-place={resolved}
      className="inline-flex"
      style={{ color: medal.color }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        <path d="M3.5 0.5h3L8 5H5.2z M10.5 0.5h-3L6 5h2.8z" fill="currentColor" opacity="0.55" />
        <circle cx="7" cy="9" r="4.5" fill="currentColor" />
      </svg>
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
