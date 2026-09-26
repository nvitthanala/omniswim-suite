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

interface TeamMomentumSectionProps {
  showPrelimsPerformance?: boolean;
  showPsychPerformance?: boolean;
  momentumAnchor: 'prelims' | 'psych';
  onMomentumAnchorChange: (anchor: 'prelims' | 'psych') => void;
  momentumSeries: any[];
  momentumMeetTotal?: number;
  teamMomentumEmptyMessage?: string;
}

export function TeamMomentumSection({
  showPrelimsPerformance,
  showPsychPerformance,
  momentumAnchor,
  onMomentumAnchorChange,
  momentumSeries,
  momentumMeetTotal,
  teamMomentumEmptyMessage,
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
      />
    </div>
  );
}
