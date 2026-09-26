/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ChartShell, SegmentedControl } from '@omniswim/ui';
import { TeamScore, SwimmerResult, Gender } from '@omniswim/core/types';
import { formatEventChartAxisLabel, colorForChartStroke } from '@omniswim/core/lib/utils';
import type { PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import { buildMomentumSeriesForTeam } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { TeamMomentumSection } from './TeamMomentumSection';
import { TeamCardHeader } from './TeamCardHeader';
import { TeamEventChartPane, TeamClassChartPane } from './TeamCardChartPanes';
import { TeamCardMatrixControls, TeamCardMatrixList } from './TeamCardMatrixList';
import { classChartTooltipPosition } from './teamCardView';

const EMPTY_EVENTS_LIST: string[] = [];

interface Props {
  team: TeamScore;
  index: number;
  gender: Gender;
  eventsList?: string[];
  conference?: string;
  key?: string | number;
  searchQuery?: string;
  actualScore?: number;
  baselineScore?: number;
  prelimsProjectedScore?: number;
  baselineOverUnder?: number;
  projectedOverUnder?: number;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
  psychProjectedScore?: number;
  eventThrough?: number;
  scoringRefreshKey?: number;
  onUpdateTime?: (id: string, newTime: string) => void;
  /** Opens delete confirmation (individual rows only; parent removes swims + marks departed). */
  onRequestDeleteSwimmer?: (name: string) => void;
}

function TeamCard({ team, index, gender, eventsList = EMPTY_EVENTS_LIST, conference, searchQuery, actualScore, baselineScore, prelimsProjectedScore, baselineOverUnder, projectedOverUnder, showPrelimsPerformance, prelimsOuByEntry, showPsychPerformance, psychOuByEntry, psychProjectedScore, eventThrough, scoringRefreshKey = 0, onUpdateTime, onRequestDeleteSwimmer }: Props) {
  const chartTheme = useThemeColors();
  const [momentumAnchor, setMomentumAnchor] = useState<'prelims' | 'psych'>('prelims');
  const teamChartColor = useMemo(
    () => colorForChartStroke(team.color || '#F43F5E', chartTheme.isDark ? 'dark' : 'light'),
    [team.color, chartTheme.isDark]
  );
  const [isExpanded, setIsExpanded] = useState(index === 0);
  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [viewMode, setViewMode] = useState<'swimmer'|'event'>('event');
  const [chartView, setChartView] = useState<'event' | 'class'>('event');
  const [sortMode, setSortMode] = useState<'chrono'|'eventDesc'|'eventAsc'|'swimmerDesc'|'swimmerAsc'>('eventDesc');
  
  // Custom Tooltip State
  const [activeTooltip, setActiveTooltip] = useState<any>(null);
  const [pinnedTooltip, setPinnedTooltip] = useState<any>(null);
  const [activeClassTooltip, setActiveClassTooltip] = useState<any>(null);
  const [pinnedClassTooltip, setPinnedClassTooltip] = useState<any>(null);
  const [chartPanePercent, setChartPanePercent] = useState(67);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const chartSplitRowRef = useRef<HTMLDivElement>(null);
  const eventChartSurfaceRef = useRef<HTMLDivElement>(null);
  const classChartSurfaceRef = useRef<HTMLDivElement>(null);
  const isDraggingSplitRef = useRef(false);
  const lastTooltipIndexRef = useRef<number | null>(null);

  const clearChartTooltips = () => {
    setActiveTooltip(null);
    setPinnedTooltip(null);
    setActiveClassTooltip(null);
    setPinnedClassTooltip(null);
    lastTooltipIndexRef.current = null;
  };

  useEffect(() => {
    isDraggingSplitRef.current = isDraggingSplit;
  }, [isDraggingSplit]);

  useEffect(() => {
    if (!isDraggingSplit) return;
    document.body.style.userSelect = 'none';
    const onMove = (e: MouseEvent) => {
      const el = chartSplitRowRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      if (w < 80) return;
      const raw = ((e.clientX - rect.left) / w) * 100;
      setChartPanePercent(Math.min(82, Math.max(28, raw)));
    };
    const onUp = () => setIsDraggingSplit(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingSplit]);

  const filteredSwimmers = useMemo(() => team.swimmers.filter(s => !s.isTimeTrial), [team.swimmers]);

  const psychMomentumHasData = (psychOuByEntry?.size ?? 0) > 0;
  const prelimsMomentumHasData = (prelimsOuByEntry?.size ?? 0) > 0;

  const momentumSeries = useMemo(
    () => {
      const lookup =
        momentumAnchor === 'psych' && showPsychPerformance && psychOuByEntry && psychMomentumHasData
          ? psychOuByEntry
          : momentumAnchor !== 'psych' && showPrelimsPerformance && prelimsOuByEntry && prelimsMomentumHasData
            ? prelimsOuByEntry
            : undefined;
      return lookup ? buildMomentumSeriesForTeam(team.teamName, lookup, eventsList) : [];
    },
    [
      team.teamName,
      showPrelimsPerformance,
      showPsychPerformance,
      prelimsOuByEntry,
      psychOuByEntry,
      psychMomentumHasData,
      prelimsMomentumHasData,
      eventsList,
      momentumAnchor,
    ]
  );

  const teamMomentumEmptyMessage =
    momentumAnchor === 'psych' && showPsychPerformance && !psychMomentumHasData
      ? 'No psych momentum for this team — psych sheet team names may not match meet results.'
      : momentumAnchor === 'prelims' && showPrelimsPerformance && !prelimsMomentumHasData
        ? 'No prelims momentum for this team.'
        : undefined;

  const momentumMeetTotal = useMemo(() => {
    if (momentumAnchor === 'psych' && showPsychPerformance && psychProjectedScore != null && baselineScore != null) {
      return baselineScore - psychProjectedScore;
    }
    return baselineOverUnder;
  }, [momentumAnchor, showPsychPerformance, psychProjectedScore, baselineScore, baselineOverUnder]);

  const { eventData, classData, topSwimmersBase, topEventsBase } = useMemo(() => {
    const eventPointsMap: Record<string, number> = {};
    const eventSwimmersMap = new Map<string, SwimmerResult[]>();
    const ouByEvent = new Map(momentumSeries.map(m => [m.rawEvent, m]));
    const classData = [
      { name: 'FR', points: 0, color: '#39FF14', swimmers: [] as SwimmerResult[] },
      { name: 'SO', points: 0, color: '#00F5FF', swimmers: [] as SwimmerResult[] },
      { name: 'JR', points: 0, color: '#FF00FF', swimmers: [] as SwimmerResult[] },
      { name: 'SR', points: 0, color: '#FFD700', swimmers: [] as SwimmerResult[] },
    ];

    const swimmerGroups: Record<string, any> = {};
    const eventGroups: Record<string, any> = {};

    filteredSwimmers.forEach(s => {
      const points = typeof s.points === 'number' ? s.points : 0;
      eventPointsMap[s.event] = (eventPointsMap[s.event] ?? 0) + points;
      if (!eventSwimmersMap.has(s.event)) eventSwimmersMap.set(s.event, []);
      eventSwimmersMap.get(s.event)!.push(s);

      const classEntry = classData.find(d => d.name === s.classYear);
      if (classEntry) {
        classEntry.points += points;
        classEntry.swimmers.push(s);
      }

      if (!swimmerGroups[s.name]) {
        swimmerGroups[s.name] = { name: s.name, points: 0, swimmers: [], classYear: s.classYear };
      }
      swimmerGroups[s.name].points += points;
      swimmerGroups[s.name].swimmers.push(s);

      if (!eventGroups[s.event]) {
        eventGroups[s.event] = { event: s.event, points: 0, swimmers: [] };
      }
      eventGroups[s.event].points += points;
      eventGroups[s.event].swimmers.push(s);
    });

    const eventData = Object.entries(eventPointsMap).map(([name, points]) => {
      const ou = ouByEvent.get(name);
      return {
        name: formatEventChartAxisLabel(name, { maxLength: 20 }),
        rawEvent: name,
        points,
        overUnder: ou?.delta ?? 0,
        cumulativeOu: ou?.cumulative ?? 0,
        swimmers: eventSwimmersMap.get(name) ?? [],
      };
    });

    if (eventsList.length > 0) {
      eventData.sort((a, b) => eventsList.indexOf(a.rawEvent) - eventsList.indexOf(b.rawEvent));
    } else {
      eventData.sort((a, b) => b.points - a.points);
    }

    let cumulativeOu = 0;
    for (const row of eventData) {
      cumulativeOu += row.overUnder;
      row.cumulativeOu = row.cumulativeOu || cumulativeOu;
    }

    return {
      eventData,
      classData,
      topSwimmersBase: Object.values(swimmerGroups).sort((a: any, b: any) => b.points - a.points),
      topEventsBase: Object.values(eventGroups).sort((a: any, b: any) => b.points - a.points),
    };
  }, [filteredSwimmers, eventsList, momentumSeries]);

  const normalizedSearchQuery = searchQuery?.trim().toLowerCase() ?? '';
  const topSwimmers = useMemo(() => {
    const list = normalizedSearchQuery
      ? topSwimmersBase.filter((s: any) => s.name.toLowerCase().includes(normalizedSearchQuery))
      : [...topSwimmersBase];
    if (viewMode === 'swimmer') {
      list.sort((a: any, b: any) => sortMode === 'swimmerAsc' ? a.points - b.points : b.points - a.points);
    }
    return list;
  }, [normalizedSearchQuery, sortMode, topSwimmersBase, viewMode]);

  const topEvents = useMemo(() => {
    const list = normalizedSearchQuery
      ? topEventsBase.filter((e: any) => e.event.toLowerCase().includes(normalizedSearchQuery))
      : [...topEventsBase];
    if (viewMode !== 'event') return list;
    if (sortMode === 'chrono' && eventsList.length > 0) {
      list.sort((a: any, b: any) => eventsList.indexOf(a.event) - eventsList.indexOf(b.event));
    } else if (sortMode === 'eventAsc') {
      list.sort((a: any, b: any) => a.points - b.points);
    } else {
      list.sort((a: any, b: any) => b.points - a.points);
    }
    return list;
  }, [eventsList, normalizedSearchQuery, sortMode, topEventsBase, viewMode]);

  const handleEventChartMouseMove = (state: any) => {
    if (isDraggingSplitRef.current) return;
    const idx = state?.activeTooltipIndex;
    if (idx == null || idx < 0 || !eventData[idx]) {
      if (lastTooltipIndexRef.current !== null) {
        lastTooltipIndexRef.current = null;
        setActiveTooltip(null);
      }
      return;
    }
    if (lastTooltipIndexRef.current === idx) return;
    lastTooltipIndexRef.current = idx;
    const payload = eventData[idx];
    const x = state.activeCoordinate?.x ?? 0;
    const y = state.activeCoordinate?.y ?? 0;
    const w = eventChartSurfaceRef.current?.clientWidth ?? 500;
    setActiveTooltip({ x, y, payload, containerWidth: w });
  };

  const handleEventChartMouseLeave = () => {
    if (!isDraggingSplitRef.current) {
      lastTooltipIndexRef.current = null;
      setActiveTooltip(null);
    }
  };

  const handleEventChartClick = (state: any) => {
    if (isDraggingSplitRef.current) return;
    if (!state || state.activeTooltipIndex == null || state.activeTooltipIndex < 0 || !eventData[state.activeTooltipIndex]) {
      return;
    }
    const payload = eventData[state.activeTooltipIndex];
    const x = state.activeCoordinate?.x ?? 0;
    const y = state.activeCoordinate?.y ?? 0;
    const w = eventChartSurfaceRef.current?.clientWidth ?? 500;
    setPinnedTooltip({ x, y, payload, containerWidth: w });
    setActiveTooltip(null);
  };

  const handleClassBarClick = (data: any, _index: number, e: any) => {
    setPinnedClassTooltip({ ...classChartTooltipPosition(e), payload: data });
    setActiveClassTooltip(null);
  };

  const handleClassBarMouseEnter = (data: any, _index: number, e: any) => {
    setActiveClassTooltip({ ...classChartTooltipPosition(e), payload: data });
  };

  const handleClassBarMouseLeave = () => setActiveClassTooltip(null);

  return (
    <div className={`neon-card rounded-xl overflow-hidden mb-4`} style={{ borderLeftColor: teamChartColor }}>
      <TeamCardHeader
        team={team}
        isExpanded={isExpanded}
        conference={conference}
        athleteCount={topSwimmers.length}
        actualScore={actualScore}
        baselineScore={baselineScore}
        prelimsProjectedScore={prelimsProjectedScore}
        baselineOverUnder={baselineOverUnder}
        projectedOverUnder={projectedOverUnder}
        showPrelimsPerformance={showPrelimsPerformance}
        eventThrough={eventThrough}
        onToggle={() => {
          const nextExpanded = !isExpanded;
          setIsExpanded(nextExpanded);
          if (!nextExpanded) clearChartTooltips();
        }}
      />

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="border-t border-theme-soft surface-overlay"
          >
            <div
              ref={chartSplitRowRef}
              className="p-6 flex flex-col lg:flex-row lg:items-stretch gap-4 lg:gap-0 min-h-0"
              style={{ ['--chartPane' as string]: `${chartPanePercent}%` }}
            >
              {/* Stats & Charts */}
              <div
                className={`min-w-0 w-full space-y-4 lg:w-[var(--chartPane)] lg:max-w-[82%] lg:min-w-[200px] ${isDraggingSplit ? 'pointer-events-none' : ''}`}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <BarChart3 size={14} className="text-[var(--text-accent)]" />
                    <span className="text-ui-micro font-medium uppercase tracking-widest text-theme-secondary">
                      {chartView === 'event' ? 'Points by Event' : 'Points by Class'}
                    </span>
                  </div>
                  <SegmentedControl
                    layout="inline"
                    ariaLabel="Points chart grouping"
                    value={chartView}
                    onChange={next => { setChartView(next); clearChartTooltips(); }}
                    options={[
                      { value: 'event', label: 'By Event', ariaLabel: 'Show points chart by event' },
                      { value: 'class', label: 'By Class', ariaLabel: 'Show points chart by class year' },
                    ]}
                  />
                </div>
                
                <ChartShell size="lg" className="surface-overlay p-2 rounded-lg border border-theme-soft group/chart">
                  {({ width, height }) =>
                    chartView === 'event' ? (
                      <TeamEventChartPane
                        surfaceRef={eventChartSurfaceRef}
                        activeTooltip={activeTooltip}
                        pinnedTooltip={pinnedTooltip}
                        onClosePinned={() => setPinnedTooltip(null)}
                        eventData={eventData}
                        teamChartColor={teamChartColor}
                        chartTheme={chartTheme}
                        chartPanePercent={chartPanePercent}
                        scoringRefreshKey={scoringRefreshKey}
                        teamName={team.teamName}
                        width={width}
                        height={height}
                        onMouseMove={handleEventChartMouseMove}
                        onMouseLeave={handleEventChartMouseLeave}
                        onClick={handleEventChartClick}
                        gender={gender}
                        showPrelimsPerformance={showPrelimsPerformance}
                        prelimsOuByEntry={prelimsOuByEntry}
                        showPsychPerformance={showPsychPerformance}
                        psychOuByEntry={psychOuByEntry}
                      />
                    ) : (
                      <TeamClassChartPane
                        surfaceRef={classChartSurfaceRef}
                        activeClassTooltip={activeClassTooltip}
                        pinnedClassTooltip={pinnedClassTooltip}
                        onClosePinned={() => setPinnedClassTooltip(null)}
                        classData={classData}
                        chartTheme={chartTheme}
                        chartPanePercent={chartPanePercent}
                        scoringRefreshKey={scoringRefreshKey}
                        teamName={team.teamName}
                        width={width}
                        height={height}
                        onBarClick={handleClassBarClick}
                        onBarMouseEnter={handleClassBarMouseEnter}
                        onBarMouseLeave={handleClassBarMouseLeave}
                        gender={gender}
                        showPrelimsPerformance={showPrelimsPerformance}
                        prelimsOuByEntry={prelimsOuByEntry}
                        showPsychPerformance={showPsychPerformance}
                        psychOuByEntry={psychOuByEntry}
                      />
                    )
                  }
                </ChartShell>

                <div className="flex flex-wrap justify-between items-center gap-2 mt-2 px-2 text-ui-micro text-theme-secondary font-mono border-t border-theme-soft pt-2 italic uppercase">
                  <span>
                    {chartView === 'event'
                      ? 'Chronological Event Scoring Timeline'
                      : 'Class Year Contribution'}
                  </span>
                  <div className="flex items-center gap-2 not-italic">
                    <span>
                      {(
                        chartView === 'event'
                          ? eventData.reduce((acc, d) => acc + d.points, 0)
                          : classData.reduce((acc, d) => acc + d.points, 0)
                      ).toFixed(1)}{' '}
                      PTS TOTAL
                    </span>
                  </div>
                </div>

                <TeamMomentumSection
                  showPrelimsPerformance={showPrelimsPerformance}
                  showPsychPerformance={showPsychPerformance}
                  momentumAnchor={momentumAnchor}
                  onMomentumAnchorChange={setMomentumAnchor}
                  momentumSeries={momentumSeries}
                  momentumMeetTotal={momentumMeetTotal}
                  teamMomentumEmptyMessage={teamMomentumEmptyMessage}
                />
              </div>

              <div
                className="hidden lg:flex shrink-0 w-3 items-stretch justify-center cursor-col-resize group/split select-none touch-none"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize charts and team matrix"
                onMouseDown={e => {
                  e.preventDefault();
                  setIsDraggingSplit(true);
                }}
              >
                <span className="w-px my-1 h-full bg-theme-soft group-hover/split:bg-[var(--text-accent)]/80 rounded-full transition-colors" />
              </div>

              {/* Individual/Event Matrix */}
              <div className="min-w-0 w-full flex-1">
                {/* Wraps like the chart header above it: in the split layout this
                    row could not fit the sort select plus both toggles, and the
                    trailing "By Swimmer" label was clipped at the column edge.
                    Wraps rather than `shrink-0`: at 1024px the select plus both
                    toggles are wider than the column, and refusing to shrink
                    pushed them past its right edge instead of onto a new line. */}
                <TeamCardMatrixControls
                  viewMode={viewMode}
                  sortMode={sortMode}
                  onSortModeChange={setSortMode}
                  onViewModeChange={next => {
                    setViewMode(next);
                    setSortMode(next === 'event' ? 'eventDesc' : 'swimmerDesc');
                  }}
                />

                <TeamCardMatrixList
                  groups={viewMode === 'swimmer' ? topSwimmers : topEvents}
                  viewMode={viewMode}
                  gender={gender}
                  teamName={team.teamName}
                  onUpdateTime={onUpdateTime}
                  onRequestDeleteSwimmer={onRequestDeleteSwimmer}
                  editingResultId={editingResultId}
                  editValue={editValue}
                  onStartEdit={(id, time) => { setEditingResultId(id); setEditValue(time); }}
                  onEditValueChange={setEditValue}
                  onCancelEdit={() => setEditingResultId(null)}
                  showPrelimsPerformance={showPrelimsPerformance}
                  prelimsOuByEntry={prelimsOuByEntry}
                  showPsychPerformance={showPsychPerformance}
                  psychOuByEntry={psychOuByEntry}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default React.memo(TeamCard);
