/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  ChevronDown, 
  ChevronUp, 
  User, 
  Award,
  BarChart3,
  List,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid } from 'recharts';
import { ChartFrame, ChartShell } from '@omniswim/ui';
import { TeamScore, SwimmerResult, Gender } from '@omniswim/core/types';
import { formatEventChartAxisLabel, colorForChartStroke } from '@omniswim/core/lib/utils';
import type { PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import {
  buildMomentumSeriesForTeam,
  sumPrelimsOuForSwimmers,
} from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { CompactEventLabel, PrelimsOuValue } from './matrixPresentation';
import ProjectedActualScore from './ProjectedActualScore';
import MomentumChartCard from './MomentumChartCard';
import { TeamMatrixSwimmerRow } from './TeamCardMatrixRow';
import { TeamCardChartTooltip } from './TeamCardTooltips';
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
      <button 
        type="button"
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${team.teamName} team details`}
        aria-expanded={isExpanded}
        onClick={() => {
          const nextExpanded = !isExpanded;
          setIsExpanded(nextExpanded);
          if (!nextExpanded) clearChartTooltips();
        }}
        className="w-full flex items-center justify-between p-5 theme-hover-row transition-colors"
      >
        <div className="flex flex-col items-start gap-1">
          <h3 className="text-sm font-black uppercase tracking-tighter text-[var(--text-primary)]">{team.teamName}</h3>
          <div className="flex flex-col gap-1">
            <span className="text-ui-caption text-theme-secondary uppercase tracking-widest font-medium">
              {conference ? `${conference} • ` : ''}{topSwimmers.length} Athletes
            </span>
            {(actualScore != null || baselineScore != null || showPrelimsPerformance) ? (
              <ProjectedActualScore
                actual={actualScore}
                baseline={baselineScore}
                projected={team.totalPoints}
                compact
                eventThrough={eventThrough}
                prelimsProjected={prelimsProjectedScore}
                baselineOverUnder={baselineOverUnder}
                projectedOverUnder={projectedOverUnder}
              />
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <span className="block text-2xl font-black text-[var(--text-accent)] font-mono tracking-tighter leading-none">
              {team.totalPoints.toFixed(1)}
            </span>
            <span className="text-ui-micro text-theme-secondary uppercase tracking-widest font-medium font-mono">Projected Points</span>
          </div>
          {isExpanded ? <ChevronUp size={16} className="text-theme-secondary" /> : <ChevronDown size={16} className="text-theme-secondary" />}
        </div>
      </button>

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
                  <div className="flex items-center surface-overlay border border-theme-soft rounded-md p-0.5">
                    <button
                      type="button"
                      onClick={() => { setChartView('event'); clearChartTooltips(); }}
                      aria-label="Show points chart by event"
                      className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded transition-colors ${chartView === 'event' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                    >
                      By Event
                    </button>
                    <button
                      type="button"
                      onClick={() => { setChartView('class'); clearChartTooltips(); }}
                      aria-label="Show points chart by class year"
                      className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded transition-colors ${chartView === 'class' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                    >
                      By Class
                    </button>
                  </div>
                </div>
                
                <ChartShell size="lg" className="surface-overlay p-2 rounded-lg border border-theme-soft group/chart">
                  {({ width, height }) =>
                    chartView === 'event' ? (
                  <div ref={eventChartSurfaceRef} className="relative h-full w-full min-h-0 min-w-0">
                    {!pinnedTooltip && activeTooltip && (
                      <div 
                        className="absolute pointer-events-none rounded-lg overflow-hidden"
                        style={{ 
                          left: `${Math.min(Math.max(10, activeTooltip.x - 125), activeTooltip.containerWidth - 260)}px`, 
                          top: `${Math.max(10, activeTooltip.y - 140)}px`,
                          width: '250px',
                          zIndex: 999 
                        }}
                      >
                        <TeamCardChartTooltip
                          data={activeTooltip.payload}
                          gender={gender}
                          teamName={team.teamName}
                          showPrelimsPerformance={showPrelimsPerformance}
                          prelimsOuByEntry={prelimsOuByEntry}
                          showPsychPerformance={showPsychPerformance}
                          psychOuByEntry={psychOuByEntry}
                          onClose={() => setPinnedTooltip(null)}
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
                          top: `${Math.max(10, pinnedTooltip.y - 140)}px`
                        }}
                      >
                        <TeamCardChartTooltip
                          data={pinnedTooltip.payload}
                          isPinned
                          gender={gender}
                          teamName={team.teamName}
                          showPrelimsPerformance={showPrelimsPerformance}
                          prelimsOuByEntry={prelimsOuByEntry}
                          showPsychPerformance={showPsychPerformance}
                          psychOuByEntry={psychOuByEntry}
                          onClose={() => setPinnedTooltip(null)}
                        />
                      </motion.div>
                    )}

                    {eventData.length > 0 ? (
                      <ChartFrame width={width} height={height}>
                      <LineChart
                        key={`event-${team.teamName}-${eventData.length}-${Math.round(chartPanePercent)}-${scoringRefreshKey}`}
                        width={Math.floor(width)}
                        height={Math.floor(height)}
                        responsive={false}
                        data={eventData}
                        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                        onMouseMove={handleEventChartMouseMove}
                        onMouseLeave={handleEventChartMouseLeave}
                        onClick={handleEventChartClick}
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
                  ) : (
                  <div ref={classChartSurfaceRef} className="relative h-full w-full min-h-0 min-w-0">
                    {!pinnedClassTooltip && activeClassTooltip && (
                      <div 
                        className="absolute pointer-events-none rounded-lg overflow-hidden"
                        style={{ 
                          left: `${Math.min(Math.max(10, activeClassTooltip.x - 110), activeClassTooltip.containerWidth - 230)}px`, 
                          top: `${Math.max(10, activeClassTooltip.y - 120)}px`,
                          width: '220px',
                          zIndex: 999 
                        }}
                      >
                        <TeamCardChartTooltip
                          data={activeClassTooltip.payload}
                          isClass
                          gender={gender}
                          teamName={team.teamName}
                          showPrelimsPerformance={showPrelimsPerformance}
                          prelimsOuByEntry={prelimsOuByEntry}
                          showPsychPerformance={showPsychPerformance}
                          psychOuByEntry={psychOuByEntry}
                          onClose={() => setPinnedClassTooltip(null)}
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
                          top: `${Math.max(10, pinnedClassTooltip.y - 120)}px`
                        }}
                      >
                        <TeamCardChartTooltip
                          data={pinnedClassTooltip.payload}
                          isPinned
                          isClass
                          gender={gender}
                          teamName={team.teamName}
                          showPrelimsPerformance={showPrelimsPerformance}
                          prelimsOuByEntry={prelimsOuByEntry}
                          showPsychPerformance={showPsychPerformance}
                          psychOuByEntry={psychOuByEntry}
                          onClose={() => setPinnedClassTooltip(null)}
                        />
                      </motion.div>
                    )}

                    {classData.length > 0 ? (
                      <ChartFrame width={width} height={height}>
                      <BarChart
                        key={`class-${team.teamName}-${classData.reduce((n, d) => n + d.points, 0)}-${Math.round(chartPanePercent)}-${scoringRefreshKey}`}
                        width={Math.floor(width)}
                        height={Math.floor(height)}
                        responsive={false}
                        data={classData}
                        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                        onMouseLeave={() => setActiveClassTooltip(null)}
                      >
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 10, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} />
                        <Tooltip content={<></>} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                        <Bar 
                          dataKey="points" 
                          radius={[2, 2, 0, 0]}
                          onClick={handleClassBarClick}
                          onMouseEnter={handleClassBarMouseEnter}
                          onMouseLeave={handleClassBarMouseLeave}
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

                {(showPrelimsPerformance || showPsychPerformance) ? (
                  <div className="mt-3">
                    {showPrelimsPerformance && showPsychPerformance ? (
                      <div className="flex items-center gap-1 mb-2">
                        <button
                          type="button"
                          onClick={() => setMomentumAnchor('prelims')}
                          aria-label="Show team momentum versus prelims"
                          className={`text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${
                            momentumAnchor === 'prelims'
                              ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                              : 'text-theme-muted hover:text-theme-secondary'
                          }`}
                        >
                          vs Prelims
                        </button>
                        <button
                          type="button"
                          onClick={() => setMomentumAnchor('psych')}
                          aria-label="Show team momentum versus psych sheet"
                          className={`text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${
                            momentumAnchor === 'psych'
                              ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                              : 'text-theme-muted hover:text-theme-secondary'
                          }`}
                        >
                          vs Psych
                        </button>
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
                ) : null}
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
                    trailing "By Swimmer" label was clipped at the column edge. */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <List size={14} className="text-[var(--text-accent)] shrink-0" />
                    <span className="text-ui-micro font-medium uppercase tracking-widest text-theme-secondary truncate">Team Matrix</span>
                  </div>
                  {/* Wraps rather than `shrink-0`: at 1024px the select plus both
                      toggles are wider than the column, and refusing to shrink
                      pushed them past its right edge instead of onto a new line. */}
                  <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
                    <select
                      className="glass-input text-ui-micro uppercase tracking-widest text-theme-secondary rounded p-1 outline-none"
                      value={sortMode}
                      onChange={(e) => setSortMode(e.target.value as any)}
                      aria-label="Sort team matrix"
                    >
                      {viewMode === 'event' && <option value="chrono">Chronological</option>}
                      {viewMode === 'event' && <option value="eventDesc">High to Low</option>}
                      {viewMode === 'event' && <option value="eventAsc">Low to High</option>}
                      {viewMode === 'swimmer' && <option value="swimmerDesc">High to Low</option>}
                      {viewMode === 'swimmer' && <option value="swimmerAsc">Low to High</option>}
                    </select>

                    <div className="flex items-center surface-overlay border border-theme-soft rounded-md p-0.5">
                      <button 
                        type="button"
                        onClick={() => { setViewMode('event'); setSortMode('eventDesc'); }}
                        aria-label="Group team matrix by event"
                        className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded transition-colors ${viewMode === 'event' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                      >
                        By Event
                      </button>
                      <button 
                        type="button"
                        onClick={() => { setViewMode('swimmer'); setSortMode('swimmerDesc'); }}
                        aria-label="Group team matrix by swimmer"
                        className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded transition-colors ${viewMode === 'swimmer' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                      >
                        By Swimmer
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  {(viewMode === 'swimmer' ? topSwimmers : topEvents).map((group: any) => (
                    <div key={group.name || group.event} className="p-3 rounded-lg surface-overlay border border-theme-soft group transition-colors hover:border-[var(--border)]">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <h4 className="text-xs font-medium text-[var(--text-primary)] uppercase group-hover:text-[var(--text-accent)] transition-colors">
                            {viewMode === 'swimmer' ? group.name : <CompactEventLabel event={group.event} className="font-mono" />}
                          </h4>
                          {viewMode === 'swimmer' && (
                            <span className="px-1.5 py-0.5 rounded surface-overlay border border-theme-soft text-ui-micro font-mono font-medium text-theme-secondary">
                              {group.classYear}
                            </span>
                          )}
                          {viewMode === 'swimmer' && onRequestDeleteSwimmer && (
                            <button
                              type="button"
                              title="Remove swimmer from workspace"
                              aria-label={`Remove ${group.name} from workspace`}
                              className="p-1 rounded border border-theme-soft text-theme-secondary hover:text-[var(--text-accent)] hover:border-[var(--text-accent)]/40 transition-colors"
                              onClick={() => onRequestDeleteSwimmer(group.name)}
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                        <div className="text-right flex flex-col items-end gap-0.5">
                          <span className="font-mono font-black text-[var(--text-primary)] text-xs">{group.points.toFixed(1)} <span className="text-ui-micro text-theme-secondary">PTS</span></span>
                          {showPrelimsPerformance && prelimsOuByEntry ? (
                            <PrelimsOuValue
                              value={sumPrelimsOuForSwimmers(group.swimmers, prelimsOuByEntry, {
                                includeRelay: viewMode === 'event',
                              })}
                              compact
                            />
                          ) : null}
                        </div>
                      </div>

                      <div className="space-y-1">
                        {group.swimmers.map((res: SwimmerResult, i: number) => (
                          <TeamMatrixSwimmerRow
                            key={i}
                            res={res}
                            gender={gender}
                            teamName={team.teamName}
                            viewMode={viewMode}
                            onUpdateTime={onUpdateTime}
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
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default React.memo(TeamCard);
