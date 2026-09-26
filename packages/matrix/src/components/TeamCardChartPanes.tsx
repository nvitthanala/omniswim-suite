/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TeamCard's two chart surfaces (points-by-event line chart, points-by-class
 * bar chart), each with its floating/pinned custom tooltip overlay and empty
 * state. Pure extraction from `TeamCard.tsx` — no behavior change. State
 * (which tooltip is active/pinned, the drag split) stays in `TeamCard`; these
 * components only render from it and report gestures back via callbacks.
 */

import type { RefObject } from 'react';
import { motion } from 'motion/react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid } from 'recharts';
import { ChartFrame } from '@omniswim/ui';
import type { Gender } from '@omniswim/core/types';
import type { PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import type { ThemeColors } from '@omniswim/core/lib/useThemeColors';
import { TeamCardChartTooltip } from './TeamCardTooltips';

interface TooltipCommonProps {
  gender: Gender | string;
  teamName: string;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
}

interface TeamEventChartPaneProps extends TooltipCommonProps {
  surfaceRef: RefObject<HTMLDivElement | null>;
  activeTooltip: any;
  pinnedTooltip: any;
  onClosePinned: () => void;
  eventData: any[];
  teamChartColor: string;
  chartTheme: ThemeColors;
  chartPanePercent: number;
  scoringRefreshKey: number;
  teamName: string;
  width: number;
  height: number;
  onMouseMove: (state: any) => void;
  onMouseLeave: () => void;
  onClick: (state: any) => void;
}

/** The "Points by Event" line chart, its hover/pinned tooltip overlays, and empty state. */
export function TeamEventChartPane({
  surfaceRef,
  activeTooltip,
  pinnedTooltip,
  onClosePinned,
  eventData,
  teamChartColor,
  chartTheme,
  chartPanePercent,
  scoringRefreshKey,
  teamName,
  width,
  height,
  onMouseMove,
  onMouseLeave,
  onClick,
  gender,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
}: TeamEventChartPaneProps) {
  return (
    <div ref={surfaceRef} className="relative h-full w-full min-h-0 min-w-0">
      {!pinnedTooltip && activeTooltip && (
        <div
          className="absolute pointer-events-none rounded-lg overflow-hidden"
          style={{
            left: `${Math.min(Math.max(10, activeTooltip.x - 125), activeTooltip.containerWidth - 260)}px`,
            top: `${Math.max(10, activeTooltip.y - 140)}px`,
            width: '250px',
            zIndex: 999,
          }}
        >
          <TeamCardChartTooltip
            data={activeTooltip.payload}
            gender={gender}
            teamName={teamName}
            showPrelimsPerformance={showPrelimsPerformance}
            prelimsOuByEntry={prelimsOuByEntry}
            showPsychPerformance={showPsychPerformance}
            psychOuByEntry={psychOuByEntry}
            onClose={onClosePinned}
          />
        </div>
      )}

      {pinnedTooltip && (
        <motion.div
          drag
          dragConstraints={{ left: -100, right: 300, top: -50, bottom: 200 }}
          className="absolute z-[1000] rounded-lg shadow-2xl overflow-hidden"
          style={{
            left: `${Math.min(Math.max(10, pinnedTooltip.x - 125), pinnedTooltip.containerWidth - 260)}px`,
            top: `${Math.max(10, pinnedTooltip.y - 140)}px`,
          }}
        >
          <TeamCardChartTooltip
            data={pinnedTooltip.payload}
            isPinned
            gender={gender}
            teamName={teamName}
            showPrelimsPerformance={showPrelimsPerformance}
            prelimsOuByEntry={prelimsOuByEntry}
            showPsychPerformance={showPsychPerformance}
            psychOuByEntry={psychOuByEntry}
            onClose={onClosePinned}
          />
        </motion.div>
      )}

      {eventData.length > 0 ? (
        <ChartFrame width={width} height={height}>
          <LineChart
            key={`event-${teamName}-${eventData.length}-${Math.round(chartPanePercent)}-${scoringRefreshKey}`}
            width={Math.floor(width)}
            height={Math.floor(height)}
            responsive={false}
            data={eventData}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            onClick={onClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
            <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 8, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} interval="equidistantPreserveStart" minTickGap={20} tickMargin={8} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 8, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} width={30} />
            <Tooltip content={() => null} cursor={{ stroke: chartTheme.chartGrid, strokeWidth: 1 }} />
            <Line
              type="monotone"
              dataKey="points"
              stroke={teamChartColor}
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
              activeDot={false}
            />
          </LineChart>
        </ChartFrame>
      ) : (
        <div className="flex items-center justify-center text-center text-ui-caption text-theme-muted" style={{ width, height }}>
          No scoring events yet.
        </div>
      )}
    </div>
  );
}

interface TeamClassChartPaneProps extends TooltipCommonProps {
  surfaceRef: RefObject<HTMLDivElement | null>;
  activeClassTooltip: any;
  pinnedClassTooltip: any;
  onClosePinned: () => void;
  classData: any[];
  chartTheme: ThemeColors;
  chartPanePercent: number;
  scoringRefreshKey: number;
  teamName: string;
  width: number;
  height: number;
  onBarClick: (data: any, index: number, e: any) => void;
  onBarMouseEnter: (data: any, index: number, e: any) => void;
  onBarMouseLeave: () => void;
}

/** The "Points by Class" bar chart, its hover/pinned tooltip overlays, and empty state. */
export function TeamClassChartPane({
  surfaceRef,
  activeClassTooltip,
  pinnedClassTooltip,
  onClosePinned,
  classData,
  chartTheme,
  chartPanePercent,
  scoringRefreshKey,
  teamName,
  width,
  height,
  onBarClick,
  onBarMouseEnter,
  onBarMouseLeave,
  gender,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
}: TeamClassChartPaneProps) {
  return (
    <div ref={surfaceRef} className="relative h-full w-full min-h-0 min-w-0">
      {!pinnedClassTooltip && activeClassTooltip && (
        <div
          className="absolute pointer-events-none rounded-lg overflow-hidden"
          style={{
            left: `${Math.min(Math.max(10, activeClassTooltip.x - 110), activeClassTooltip.containerWidth - 230)}px`,
            top: `${Math.max(10, activeClassTooltip.y - 120)}px`,
            width: '220px',
            zIndex: 999,
          }}
        >
          <TeamCardChartTooltip
            data={activeClassTooltip.payload}
            isClass
            gender={gender}
            teamName={teamName}
            showPrelimsPerformance={showPrelimsPerformance}
            prelimsOuByEntry={prelimsOuByEntry}
            showPsychPerformance={showPsychPerformance}
            psychOuByEntry={psychOuByEntry}
            onClose={onClosePinned}
          />
        </div>
      )}

      {pinnedClassTooltip && (
        <motion.div
          drag
          dragConstraints={{ left: -100, right: 300, top: -100, bottom: 200 }}
          className="absolute z-[1000] rounded-lg shadow-2xl overflow-hidden"
          style={{
            left: `${Math.min(Math.max(10, pinnedClassTooltip.x - 110), pinnedClassTooltip.containerWidth - 230)}px`,
            top: `${Math.max(10, pinnedClassTooltip.y - 120)}px`,
          }}
        >
          <TeamCardChartTooltip
            data={pinnedClassTooltip.payload}
            isPinned
            isClass
            gender={gender}
            teamName={teamName}
            showPrelimsPerformance={showPrelimsPerformance}
            prelimsOuByEntry={prelimsOuByEntry}
            showPsychPerformance={showPsychPerformance}
            psychOuByEntry={psychOuByEntry}
            onClose={onClosePinned}
          />
        </motion.div>
      )}

      {classData.length > 0 ? (
        <ChartFrame width={width} height={height}>
          <BarChart
            key={`class-${teamName}-${classData.reduce((n, d) => n + d.points, 0)}-${Math.round(chartPanePercent)}-${scoringRefreshKey}`}
            width={Math.floor(width)}
            height={Math.floor(height)}
            responsive={false}
            data={classData}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onMouseLeave={onBarMouseLeave}
          >
            <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 10, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} />
            <Tooltip content={<></>} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Bar
              dataKey="points"
              radius={[2, 2, 0, 0]}
              onClick={onBarClick}
              onMouseEnter={onBarMouseEnter}
              onMouseLeave={onBarMouseLeave}
              style={{ cursor: 'pointer' }}
            >
              {classData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} opacity={0.8} />
              ))}
            </Bar>
          </BarChart>
        </ChartFrame>
      ) : (
        <div className="flex items-center justify-center text-center text-ui-caption text-theme-muted" style={{ width, height }}>
          No class year data yet.
        </div>
      )}
    </div>
  );
}
