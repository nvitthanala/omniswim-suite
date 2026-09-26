/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One shared badge for "how this time was recorded" — extracted from a
 * longer swim's splits, self-reported, altitude-adjusted, or an SCY estimate
 * converted from a metric swim. Every athlete view that shows a swim or a
 * best time (`AthleteHistorySection`, `AthleteEntriesSection`,
 * `AthleteCreditedSwimsRow`) renders the same chips from the same rules
 * instead of five hand-rolled copies.
 *
 * `buildProvenanceBadges` is pure (no JSX) so a caller can also use it to
 * decide whether a row needs a disabled reason, without rendering anything.
 */
import type { ReactNode } from 'react';
import type { ScyConversionProvenance, SwimCloudBadge } from '@omniswim/core/types';
import { isExtractedSplitSwim, isUserInputtedSwim } from '@omniswim/core/lib/bestTimeEligibility';
import { NCAA_SCM_CONVERSION_TABLES } from '@omniswim/core/constants';
import { cn } from '../lib/cn';
import { Badge } from './Badge';

/** The fields any provenance-carrying row may supply. All optional so a
 * `PlannedSwimEntry`, an `AthleteCreditedSwim` and a `HistoricalSwim` — which
 * each carry a different subset — can all be passed directly. */
export type ProvenanceBadgeInput = {
  isExtractedSplit?: boolean;
  isUserInputted?: true;
  swimcloudBadge?: SwimCloudBadge;
  /** `HistoricalSwim`'s spelling. */
  isAltitudeAdjusted?: boolean;
  /** `AthleteEventBest`'s spelling. */
  altitudeAdjusted?: boolean;
  convertedFrom?: ScyConversionProvenance;
  /**
   * True for a relay-leg candidate built from athlete history rather than a
   * loaded meet or recruit swim (`SwimmerResult.relayLegHistory`,
   * `RelayLegSwap.inFromHistory`). Renders "From history".
   */
  fromHistory?: boolean;
};

export type ProvenanceBadgeKey =
  | 'extracted'
  | 'self_reported'
  | 'altitude_adjusted'
  | 'converted_lcm'
  | 'converted_scm'
  | 'from_history';

export type ProvenanceBadgeSpec = {
  key: ProvenanceBadgeKey;
  label: string;
  tooltip?: string;
};

/** The tooltip for a converted-time badge: the source time, the SCY result,
 * and the conversion basis — the LCM factor table or the specific NCAA SCM
 * table (with division, when known). Never a bare "converted". */
export function describeConversionBasis(conv: ScyConversionProvenance): string {
  const { sourceCourse, sourceTime, scyTime, basis } = conv;
  if (basis.method === 'lcm_factor_table') {
    return `${sourceCourse} ${sourceTime} → SCY ${scyTime}, Colorado Time Systems factor (estimate)`;
  }
  if (basis.method === 'ncaa_scm_table') {
    const table = NCAA_SCM_CONVERSION_TABLES[basis.tableId];
    const divisionSuffix = basis.division ? ` (${basis.division})` : '';
    const label = table ? table.label : basis.tableId;
    return `${sourceCourse} ${sourceTime} → ${scyTime}, ${label}${divisionSuffix}`;
  }
  // `identity` never reaches here — `convertedFrom` is only ever set for a
  // non-identity basis (see `provenanceFor` in core's utils.ts) — but a
  // future basis kind should still describe itself rather than say nothing.
  return `${sourceCourse} ${sourceTime} → ${scyTime}`;
}

/** Which badges apply to one swim/best/entry, in a fixed display order. Pure:
 * no JSX, so a caller can also use this to gate selectability (see
 * `isRankableSwim` in `athleteEntriesView.ts` for the paste-preview guard). */
export function buildProvenanceBadges(input: ProvenanceBadgeInput): ProvenanceBadgeSpec[] {
  const specs: ProvenanceBadgeSpec[] = [];

  if (isExtractedSplitSwim(input)) {
    specs.push({
      key: 'extracted',
      label: 'Extracted',
      tooltip: "Taken from a longer swim's splits — not swum as a race at this distance.",
    });
  }

  if (isUserInputtedSwim(input)) {
    specs.push({
      key: 'self_reported',
      label: 'Self-reported',
      tooltip: 'Typed in by the swimmer or a coach — not taken from a meet result.',
    });
  }

  if (input.isAltitudeAdjusted === true || input.altitudeAdjusted === true) {
    specs.push({
      key: 'altitude_adjusted',
      label: 'Altitude-adj.',
      tooltip: 'NCAA altitude-adjusted time. The time actually swum is not published.',
    });
  }

  if (input.convertedFrom) {
    const course = input.convertedFrom.sourceCourse;
    specs.push({
      key: course === 'LCM' ? 'converted_lcm' : 'converted_scm',
      label: `Est. from ${course}`,
      tooltip: describeConversionBasis(input.convertedFrom),
    });
  }

  if (input.fromHistory) {
    specs.push({
      key: 'from_history',
      label: 'From history',
      tooltip: 'No meet or recruit swim at this event — filled from the athlete’s recorded history.',
    });
  }

  return specs;
}

type ProvenanceBadgesProps = {
  swim: ProvenanceBadgeInput;
  /** Tighter padding/type to match a dense table/list row. */
  compact?: boolean;
  className?: string;
};

/**
 * Renders every applicable {@link buildProvenanceBadges} chip for one row.
 * Built on the shared `Badge` (neutral tone), restyled to the small
 * sentence-case pill this repo's existing diff/tag chips use (see
 * `SwimRowTags` in `AthleteHistoryImportPanelParts.tsx`) rather than `Badge`'s
 * default bold uppercase pill, which would be too loud repeated per row.
 * Renders nothing when the swim carries no provenance flags.
 */
export function ProvenanceBadges({ swim, compact = false, className }: ProvenanceBadgesProps): ReactNode {
  const specs = buildProvenanceBadges(swim);
  if (specs.length === 0) return null;

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {specs.map(spec => (
        <Badge
          key={spec.key}
          tone="neutral"
          title={spec.tooltip}
          className={cn(
            'font-normal normal-case tracking-normal',
            compact ? 'px-1.5 py-0.5 text-[0.65rem] gap-0.5' : 'text-ui-micro'
          )}
        >
          {spec.label}
        </Badge>
      ))}
    </span>
  );
}
