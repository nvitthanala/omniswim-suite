/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TeamCard's momentum section: the prelims/psych anchor toggle (only shown
 * when both are available) and the momentum chart itself. Pure extraction
 * from `TeamCard.tsx` — no behavior change.
 */

import { SegmentedControl } from '@omniswim/ui';
import MomentumChartCard from './MomentumChartCard';
import { SeedsPastTableNote } from './matrixPresentation';

interface TeamMomentumSectionProps {
  showPrelimsPerformance?: boolean;
  showPsychPerformance?: boolean;
  momentumAnchor: 'prelims' | 'psych';
  onMomentumAnchorChange: (anchor: 'prelims' | 'psych') => void;
  momentumSeries: any[];
  momentumMeetTotal?: number;
  teamMomentumEmptyMessage?: string;
  /** Entries left out of the momentum line because they have no result yet. */
  noActualCount?: number;
  /**
   * Seeds of this team past the end of the place-point table, for the active
   * anchor. They have no expected points, so the line leaves them out.
   */
  withoutExpectationCount?: number;
}

export function TeamMomentumSection({
  showPrelimsPerformance,
  showPsychPerformance,
  momentumAnchor,
  onMomentumAnchorChange,
  momentumSeries,
  momentumMeetTotal,
  teamMomentumEmptyMessage,
  noActualCount,
  withoutExpectationCount,
}: TeamMomentumSectionProps) {
  if (!showPrelimsPerformance && !showPsychPerformance) return null;
  return (
    <div className="mt-3">
      {showPrelimsPerformance && showPsychPerformance ? (
        <div className="mb-2">
          <SegmentedControl
            layout="inline"
            ariaLabel="Team momentum anchor"
            value={momentumAnchor}
            onChange={onMomentumAnchorChange}
            options={[
              { value: 'prelims', label: 'vs Prelims', ariaLabel: 'Show team momentum versus prelims' },
              { value: 'psych', label: 'vs Psych', ariaLabel: 'Show team momentum versus psych sheet' },
            ]}
          />
        </div>
      ) : null}
      <MomentumChartCard
        title={momentumAnchor === 'psych' ? 'Momentum vs Psych' : 'Momentum vs Prelims'}
        series={momentumSeries}
        meetTotalOu={momentumMeetTotal}
        size="md"
        emptyMessage={teamMomentumEmptyMessage}
        noActualCount={noActualCount}
      />
      {withoutExpectationCount != null && withoutExpectationCount > 0 ? (
        <p
          className="text-ui-micro text-theme-muted mt-1 normal-case tracking-normal"
          data-testid="momentum-no-expectation-note"
        >
          <SeedsPastTableNote count={withoutExpectationCount} />. {withoutExpectationCount === 1 ? 'It has' : 'They have'} no
          expected points and {withoutExpectationCount === 1 ? 'is' : 'are'} left out of this chart, not counted as 0.
        </p>
      ) : null}
    </div>
  );
}
