/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `MeetOperationsView`'s "analyze" step: the chronological team-score
 * timeline chart (with its custom tooltip), the meet momentum chart, and the
 * score-differences table (diff vs. prelims). Pure extraction from
 * `MeetOperationsView.tsx` — no behavior change. `TimelineTooltipContent`
 * moved here unchanged; it is only ever used by this step's chart.
 */

import { TrendingUp, GitCompareArrows } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { ChartFrame, ChartShell, SegmentedControl } from '@omniswim/ui';
import type { TeamScore } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/scoringEngine';
import type { ThemeColors } from '@omniswim/core/lib/useThemeColors';
import MeetDiffTable from './MeetDiffTable';
import PrelimsDiffTable from './PrelimsDiffTable';
import MomentumChartCard from './MomentumChartCard';
import { TeamName } from './matrixPresentation';

type TimelineTooltipContentProps = {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: string; dataKey?: string; value?: unknown; color?: string }>;
  label?: string;
  teamsWithLineStyles: TeamScore[];
  prelimsDeltaByTeam?: Record<string, number>;
};

function TimelineTooltipContent({
  active,
  payload,
  label,
  teamsWithLineStyles,
  prelimsDeltaByTeam,
}: TimelineTooltipContentProps) {
  if (!active || !payload?.length) return null;
  const dashByTeam = Object.fromEntries(teamsWithLineStyles.map(t => [t.teamName, t.strokeDasharray]));
  const rows = [...payload]
    .map(p => ({
      name: String(p.name ?? p.dataKey ?? ''),
      value: typeof p.value === 'number' ? p.value : Number(p.value),
      color: String(p.color ?? ''),
      strokeDasharray: dashByTeam[String(p.name ?? p.dataKey ?? '')] as string | undefined,
      prelimsDelta: prelimsDeltaByTeam?.[String(p.name ?? p.dataKey ?? '')],
    }))
    .filter(r => !Number.isNaN(r.value))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  return (
    <div className="theme-popover rounded-lg p-3 max-w-sm">
      <div className="text-[var(--text-accent)] font-bold mb-2 text-ui-label uppercase tracking-wide border-b border-theme-soft pb-1">
        {label}
      </div>
      <ul className="space-y-1.5 font-mono text-ui-caption">
        {rows.map((r, index) => {
          const teamBelow = rows[index + 1];
          const gapBelow = teamBelow ? r.value - teamBelow.value : null;
          const prelimsOu = r.prelimsDelta != null && Math.abs(r.prelimsDelta) > 0.05 ? r.prelimsDelta : null;
          return (
            <li key={r.name} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 text-[var(--text-primary)]">
              <span className="flex items-center gap-2 min-w-0">
                <svg width="22" height="8" className="shrink-0" aria-hidden>
                  <line x1="0" y1="4" x2="22" y2="4" stroke={r.color} strokeWidth="2.5" strokeDasharray={r.strokeDasharray} />
                </svg>
                <span className="truncate font-sans text-ui-body">{r.name}</span>
              </span>
              <span
                className={`text-ui-micro text-right tabular-nums shrink-0 ${
                  prelimsOu != null ? (prelimsOu > 0 ? 'text-points-positive' : 'text-points-negative') : 'text-theme-secondary'
                }`}
              >
                {prelimsOu != null
                  ? `${prelimsOu > 0 ? '+' : ''}${prelimsOu.toFixed(1)} vs prelims`
                  : gapBelow != null && gapBelow > 0
                    ? `+${gapBelow.toFixed(1)}`
                    : index === rows.length - 1
                      ? '—'
                      : ''}
              </span>
              <span className="text-points-positive font-bold shrink-0 tabular-nums">{r.value.toFixed(1)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface MeetOpsAnalyzeStepProps {
  chartTheme: ThemeColors;
  showPrelimsPerformance: boolean;
  showPsychPerformance: boolean;
  timelineData: Record<string, unknown>[];
  timelineChartKey: string;
  teamsWithLineStyles: TeamScore[];
  prelimsDeltaByLabel: Map<string, Record<string, number>>;
  meetMomentumAnchor: 'prelims' | 'psych';
  onMeetMomentumAnchorChange: (anchor: 'prelims' | 'psych') => void;
  meetMomentumData: Record<string, unknown>[];
  momentumEmptyMessage?: string;
  analysisView: 'diff' | 'prelims';
  onAnalysisViewChange: (view: 'diff' | 'prelims') => void;
  baselineBundle: ScoringBundle;
  prelimsProjectedBundle: ScoringBundle;
  searchQuery: string;
}

export function MeetOpsAnalyzeStep({
  chartTheme,
  showPrelimsPerformance,
  showPsychPerformance,
  timelineData,
  timelineChartKey,
  teamsWithLineStyles,
  prelimsDeltaByLabel,
  meetMomentumAnchor,
  onMeetMomentumAnchorChange,
  meetMomentumData,
  momentumEmptyMessage,
  analysisView,
  onAnalysisViewChange,
  baselineBundle,
  prelimsProjectedBundle,
  searchQuery,
}: MeetOpsAnalyzeStepProps) {
  return (
    <>
      <div className="surface-card rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp size={16} className="text-[var(--text-accent)]" />
          <h3 className="text-[12px] font-bold text-[var(--text-primary)] uppercase tracking-tight">
            Chronological Team Score Timeline
          </h3>
          {showPrelimsPerformance ? (
            <p className="text-[10px] text-theme-muted mt-1 normal-case tracking-normal">
              Tooltip middle column shows baseline over/under vs prelims projection at each event.
            </p>
          ) : null}
        </div>

        <ChartShell size="md" className="surface-overlay p-2 rounded-lg border border-theme-soft">
          {({ width, height }) =>
            timelineData.length > 0 ? (
              <ChartFrame width={width} height={height}>
                <LineChart
                  key={timelineChartKey}
                  width={Math.floor(width)}
                  height={Math.floor(height)}
                  responsive={false}
                  data={timelineData}
                  margin={{ top: 8, right: 12, left: 4, bottom: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: chartTheme.chartTick, fontSize: 9, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }}
                    // `preserveStartEnd` forces the final tick even when it collides
                    // with its neighbour, which ran the last two event labels together
                    // and clipped the result at the plot edge. Equidistant spacing with
                    // a measured minimum gap keeps them apart.
                    interval="equidistantPreserveStart"
                    minTickGap={24}
                    tickMargin={8}
                  />
                  <YAxis width={48} axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 10, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} />
                  <Tooltip
                    cursor={{ stroke: chartTheme.chartGrid, strokeWidth: 2 }}
                    content={props => (
                      <TimelineTooltipContent
                        active={props.active}
                        label={props.label != null ? String(props.label) : undefined}
                        payload={props.payload as TimelineTooltipContentProps['payload']}
                        teamsWithLineStyles={teamsWithLineStyles}
                        prelimsDeltaByTeam={
                          showPrelimsPerformance && props.label != null ? prelimsDeltaByLabel.get(String(props.label)) : undefined
                        }
                      />
                    )}
                  />
                  {teamsWithLineStyles.map(team => (
                    <Line
                      key={team.teamName}
                      type="monotone"
                      dataKey={team.teamName}
                      name={team.teamName}
                      stroke={team.lineColor ?? team.color}
                      strokeWidth={2.5}
                      strokeDasharray={team.strokeDasharray}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                      activeDot={{ r: 5, strokeWidth: 0, fill: team.lineColor ?? team.color }}
                    />
                  ))}
                </LineChart>
              </ChartFrame>
            ) : (
              <div className="flex h-full items-center justify-center text-center text-ui-caption text-theme-muted">
                Load meet results to see team score progression.
              </div>
            )
          }
        </ChartShell>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 justify-center pointer-events-none select-none border-t border-theme-soft pt-3" aria-hidden>
          {teamsWithLineStyles.map(t => (
            <span key={t.teamName} className="inline-flex items-center gap-2 text-ui-caption text-theme-secondary max-w-[220px]">
              <svg width="28" height="10" className="shrink-0 overflow-visible">
                <line x1="0" y1="5" x2="28" y2="5" stroke={t.lineColor ?? t.color} strokeWidth="2.5" strokeDasharray={t.strokeDasharray} />
              </svg>
              <TeamName name={t.teamName} />
            </span>
          ))}
        </div>
      </div>

      {showPrelimsPerformance || showPsychPerformance ? (
        <div className="mb-6">
          {showPrelimsPerformance && showPsychPerformance ? (
            <div className="mb-2 px-1">
              <SegmentedControl
                layout="inline"
                ariaLabel="Meet momentum anchor"
                value={meetMomentumAnchor}
                onChange={onMeetMomentumAnchorChange}
                options={[
                  { value: 'prelims', label: 'vs Prelims', ariaLabel: 'Show meet momentum versus prelims' },
                  { value: 'psych', label: 'vs Psych', ariaLabel: 'Show meet momentum versus psych sheet' },
                ]}
              />
            </div>
          ) : null}
          <MomentumChartCard
            mode="multi"
            title={meetMomentumAnchor === 'psych' ? 'Meet Momentum vs Psych' : 'Meet Momentum vs Prelims'}
            data={meetMomentumData}
            teams={teamsWithLineStyles}
            size="md"
            emptyMessage={momentumEmptyMessage}
          />
        </div>
      ) : null}
      <div className="surface-card rounded-xl p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">Score differences</h3>
            <p className="text-xs text-theme-secondary">Compare the projection with the loaded meet and prelims.</p>
          </div>
          <SegmentedControl
            layout="inline"
            ariaLabel="Score differences view"
            value={analysisView}
            onChange={onAnalysisViewChange}
            options={[
              {
                value: 'diff',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <GitCompareArrows size={12} /> Diff
                  </span>
                ),
                ariaLabel: 'Show projected versus baseline score differences',
              },
              ...(showPrelimsPerformance
                ? [
                    {
                      value: 'prelims' as const,
                      label: (
                        <span className="inline-flex items-center gap-1.5">
                          <TrendingUp size={12} /> Prelims
                        </span>
                      ),
                      ariaLabel: 'Show score differences versus prelims',
                    },
                  ]
                : []),
            ]}
          />
        </div>
        {analysisView === 'prelims' && showPrelimsPerformance ? (
          <PrelimsDiffTable
            projectedTeams={teamsWithLineStyles}
            baselineTeams={baselineBundle.sortedTeams}
            prelimsTeams={prelimsProjectedBundle.sortedTeams}
            searchQuery={searchQuery}
          />
        ) : (
          <MeetDiffTable projectedTeams={teamsWithLineStyles} baselineTeams={baselineBundle.sortedTeams} searchQuery={searchQuery} />
        )}
      </div>
    </>
  );
}
