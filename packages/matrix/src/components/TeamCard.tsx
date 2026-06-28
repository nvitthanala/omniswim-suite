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
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';
import { ChartShell } from '@omniswim/ui';
import { TeamScore, SwimmerResult, ClassYear, Gender, RelayLegStroke } from '@omniswim/core/types';
import { getYearsRemaining, convertTimeToSeconds, relaySplitQualificationCutEvent, formatEventChartAxisLabel, stripEventGenderMarker, colorForChartStroke } from '@omniswim/core/lib/utils';
import { displayTimeForRelayLeg, formatLegSplitSummary } from '@omniswim/core/lib/relaySplits';
import { compareTimeToCutline, getCutlinesForSwim, normalizeEventForCutline } from '@omniswim/core/lib/cutlineUtils';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import ProjectedActualScore from './ProjectedActualScore';

const EMPTY_EVENTS_LIST: string[] = [];

function relayMissingStrokeLabel(stroke: RelayLegStroke | undefined): string {
  if (!stroke) return '';
  const m: Record<RelayLegStroke, string> = { back: 'Back', breast: 'Breast', fly: 'Fly', free: 'Free' };
  return m[stroke] ?? stroke;
}

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
  eventThrough?: number;
  onUpdateTime?: (id: string, newTime: string) => void;
  /** Opens delete confirmation (individual rows only; parent removes swims + marks departed). */
  onRequestDeleteSwimmer?: (name: string) => void;
}

function TeamCard({ team, index, gender, eventsList = EMPTY_EVENTS_LIST, conference, searchQuery, actualScore, baselineScore, eventThrough, onUpdateTime, onRequestDeleteSwimmer }: Props) {
  const chartTheme = useThemeColors();
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
  const [chartsReady, setChartsReady] = useState(false);
  
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

  const { eventData, classData, topSwimmersBase, topEventsBase } = useMemo(() => {
    const eventPointsMap: Record<string, number> = {};
    const eventSwimmersMap = new Map<string, SwimmerResult[]>();
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

    const eventData = Object.entries(eventPointsMap).map(([name, points]) => ({
      name: formatEventChartAxisLabel(name, { maxLength: 20 }),
      fullEvent: stripEventGenderMarker(name),
      points,
      swimmers: eventSwimmersMap.get(name) ?? [],
    }));

    if (eventsList.length > 0) {
      eventData.sort((a, b) => eventsList.indexOf(a.fullEvent) - eventsList.indexOf(b.fullEvent));
    } else {
      eventData.sort((a, b) => b.points - a.points);
    }

    return {
      eventData,
      classData,
      topSwimmersBase: Object.values(swimmerGroups).sort((a: any, b: any) => b.points - a.points),
      topEventsBase: Object.values(eventGroups).sort((a: any, b: any) => b.points - a.points),
    };
  }, [filteredSwimmers, eventsList]);

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

  // Custom tooltips renderer logic to avoid recharts z-index and positioning issues
  const renderTooltipContent = (data: any, isPinned = false, isClass = false) => {
    let topPerformers: [string, number][] = [];
    if (isClass && data.swimmers) {
      const swimmerPts: Record<string, number> = {};
      data.swimmers.forEach((s: SwimmerResult) => {
        if (!swimmerPts[s.name]) swimmerPts[s.name] = 0;
        swimmerPts[s.name] += typeof s.points === 'number' ? s.points : 0;
      });
      topPerformers = Object.entries(swimmerPts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
    }

    const swimmersSorted =
      !isClass && data.swimmers
        ? [...data.swimmers].sort((a: any, b: any) => {
            const pa = typeof a.points === 'number' ? a.points : 0;
            const pb = typeof b.points === 'number' ? b.points : 0;
            return pb - pa;
          })
        : [];

    return (
      <div 
        className="relative theme-popover p-3 z-[999] pointer-events-auto h-full flex flex-col"
        style={{ 
          resize: isPinned ? 'both' : 'none', 
          overflow: 'hidden',
          minWidth: '220px',
          minHeight: '120px',
          containerType: 'size', // Container queries for dynamic resizing
        }}
      >
        {isPinned && (
          <div className="absolute top-1 right-1 cursor-pointer text-theme-muted hover:text-[var(--text-primary)]" onClick={() => isClass ? setPinnedClassTooltip(null) : setPinnedTooltip(null)}>
            ✕
          </div>
        )}
        <div className="flex justify-between items-center mb-2 pb-2 border-b border-theme-soft shrink-0">
          <h4 className="font-bold text-[var(--text-accent)] uppercase tracking-widest" style={{ fontSize: 'clamp(8px, 5cqi, 12px)' }}>
            {isClass ? `Class of ${data.name}` : data.fullEvent}
          </h4>
          <span className="font-mono font-black" style={{ fontSize: 'clamp(9px, 6cqi, 14px)' }}>{data.points.toFixed(1)} PTS</span>
        </div>
        
        <div className="space-y-1 mt-2 flex-1 overflow-y-auto custom-scrollbar">
          {isClass ? (
            <>
              <div className="text-theme-muted font-bold uppercase mb-1" style={{ fontSize: 'clamp(7px, 4cqi, 10px)' }}>Top Performers</div>
              {topPerformers.length > 0 ? topPerformers.map(([name, pts], idx) => (
                <div key={idx} className="flex items-center justify-between py-0.5 border-b border-theme-soft/50 last:border-0 swimmer-row" style={{ fontSize: 'clamp(8px, 4.5cqi, 11px)' }}>
                  <span className="font-medium text-[var(--text-primary)] truncate pr-2 max-w-[150px]">{name}</span>
                  <span className="font-mono text-points-positive font-bold">{pts.toFixed(1)}</span>
                </div>
              )) : (
                <div className="text-theme-muted text-ui-micro italic">No scoring swimmers</div>
              )}
            </>
          ) : (
            swimmersSorted.length > 0 ? swimmersSorted.map((s: any, idx: number) => {
              const qualEv = relaySplitQualificationCutEvent(s);
              const timeStrForCuts = qualEv && s.relayLegSplit ? s.relayLegSplit : s.finalsTime || s.time;
              const timeSec = convertTimeToSeconds(timeStrForCuts);
              const cleanEventBase = s.event.replace(" (Avg Split)", "").replace(/ Yard /i, " ").replace(/ Meter /i, " ").trim();
              const cleanEvent = normalizeEventForCutline(qualEv ?? cleanEventBase);
              const { achieved: cutAchieved } = compareTimeToCutline(timeSec, gender, cleanEvent);
              const isACut = cutAchieved === 'A';
              const isBCut = cutAchieved === 'B';

              return (
                <div key={idx} className="flex items-center justify-between py-1 border-b border-theme-soft/50 last:border-0 swimmer-row text-ui-caption">
                  <div className="flex items-center gap-2">
                    <span className="w-4 font-mono text-theme-muted">{s.rank || '-'}</span>
                    <span className="w-4 shrink-0 inline-flex justify-center">
                      {s.podium === 'gold' && <span className="text-yellow-400" title="Gold">🥇</span>}
                      {s.podium === 'silver' && <span className="text-theme-secondary" title="Silver">🥈</span>}
                      {s.podium === 'bronze' && <span className="text-orange-400" title="Bronze">🥉</span>}
                    </span>
                    <span className="font-medium text-[var(--text-primary)] truncate max-w-[120px]">{s.name}</span>
                    {s.isRelay && (s.relayLegSplitDetail || s.relayLegSplit) && (
                      <span className="text-ui-micro text-theme-muted font-mono" title="Relay leg split">Split</span>
                    )}
                    {s.relayMissingLeg && (
                      <span className="text-ui-micro bg-amber-500/15 text-amber-400 px-1 border border-amber-500/30 rounded-sm ml-1" title="Missing relay leg">
                        Missing L{(s.relayMissingLeg.legIndex ?? 0) + 1}: {relayMissingStrokeLabel(s.relayMissingLeg.stroke)}
                      </span>
                    )}
                    {isACut && <span className="text-ui-micro btn-accent-outline px-1 rounded-sm ml-1" title="A CUT">A CUT</span>}
                    {isBCut && <span className="text-ui-micro bg-amber-400/10 text-amber-400 px-1 border border-amber-400/30 rounded-sm ml-1" title="B CUT">B CUT</span>}
                  </div>
                  <div className="flex gap-3 text-right">
                    <span className="font-mono text-theme-muted">{s.prelimsTime ? `P:${s.prelimsTime}` : ''}</span>
                    <span className="font-mono text-theme-secondary">
                      {s.isRelay && (s.relayLegSplitDetail || s.relayLegSplit) ? (
                        <>
                          <span className="text-points-positive">{displayTimeForRelayLeg(s)}</span>
                          {s.relayLegSplitDetail ? (
                            <span className="block text-ui-micro text-theme-muted font-sans">
                              {formatLegSplitSummary(s.relayLegSplitDetail)}
                            </span>
                          ) : null}
                          <span className="text-theme-muted ml-1">R:{s.relayTeamTime || s.finalsTime || s.time}</span>
                        </>
                      ) : s.finalsTime ? (
                        `F:${s.finalsTime}`
                      ) : (
                        s.time
                      )}
                    </span>
                    <span className="font-mono text-points-positive font-bold">{typeof s.points === 'number' ? s.points.toFixed(1) : s.points}</span>
                  </div>
                </div>
              );
            }) : (
              <div className="text-theme-muted text-ui-micro italic">No scoring swimmers</div>
            )
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`neon-card rounded-md overflow-hidden mb-4`} style={{ borderLeftColor: teamChartColor }}>
      <button 
        onClick={() => {
          const nextExpanded = !isExpanded;
          setIsExpanded(nextExpanded);
          if (!nextExpanded) {
            setChartsReady(false);
            clearChartTooltips();
          }
        }}
        className="w-full flex items-center justify-between p-5 theme-hover-row transition-colors"
      >
        <div className="flex flex-col items-start gap-1">
          <h3 className="text-sm font-black uppercase tracking-tighter text-[var(--text-primary)]">{team.teamName}</h3>
          <div className="flex flex-col gap-1">
            <span className="text-ui-caption text-theme-secondary uppercase tracking-widest font-medium">
              {conference ? `${conference} • ` : ''}{topSwimmers.length} Athletes
            </span>
            {(actualScore != null || baselineScore != null) ? (
              <ProjectedActualScore
                actual={actualScore}
                baseline={baselineScore}
                projected={team.totalPoints}
                compact
                eventThrough={eventThrough}
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
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            onAnimationStart={() => setChartsReady(false)}
            onAnimationComplete={() => setChartsReady(true)}
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
                  <div className="flex items-center surface-overlay border border-theme-soft rounded p-0.5">
                    <button
                      type="button"
                      onClick={() => { setChartView('event'); clearChartTooltips(); }}
                      className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded ${chartView === 'event' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                    >
                      By Event
                    </button>
                    <button
                      type="button"
                      onClick={() => { setChartView('class'); clearChartTooltips(); }}
                      className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded ${chartView === 'class' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                    >
                      By Class
                    </button>
                  </div>
                </div>
                
                <ChartShell size="lg" className="surface-overlay p-2 rounded border border-theme-soft group/chart">
                  {chartsReady ? (
                  chartView === 'event' ? (
                  <div ref={eventChartSurfaceRef} className="h-full w-full relative">
                    {/* Hover Tooltip (Absolute relative to chart) */}
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
                        {renderTooltipContent(activeTooltip.payload)}
                      </div>
                    )}
                    
                    {/* Pinned Tooltip (Draggable, Resizable) */}
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
                        {renderTooltipContent(pinnedTooltip.payload, true)}
                      </motion.div>
                    )}

                    {eventData.length > 0 ? (
                    <ResponsiveContainer key={`event-${Math.round(chartPanePercent)}`} width="100%" height="100%" debounce={50}>
                      <LineChart
                        data={eventData}
                        onMouseMove={(state: any) => {
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
                        }}
                        onMouseLeave={() => {
                          if (!isDraggingSplitRef.current) {
                            lastTooltipIndexRef.current = null;
                            setActiveTooltip(null);
                          }
                        }}
                        onClick={(state: any) => {
                          if (isDraggingSplitRef.current) return;
                          if (
                            state &&
                            state.activeTooltipIndex != null &&
                            state.activeTooltipIndex >= 0 &&
                            eventData[state.activeTooltipIndex]
                          ) {
                            const payload = eventData[state.activeTooltipIndex];
                            const x = state.activeCoordinate?.x ?? 0;
                            const y = state.activeCoordinate?.y ?? 0;
                            const w = eventChartSurfaceRef.current?.clientWidth ?? 500;
                            setPinnedTooltip({ x, y, payload, containerWidth: w });
                            setActiveTooltip(null);
                          }
                        }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 8, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} interval="preserveStartEnd" />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 8, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} width={30} />
                        <Tooltip content={() => null} cursor={{ stroke: 'rgba(255,255,255,0.05)', strokeWidth: 1 }} />
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
                    </ResponsiveContainer>
                    ) : (
                      <div className="flex h-full items-center justify-center text-center text-ui-caption text-theme-muted">
                        No scoring events yet.
                      </div>
                    )}
                  </div>
                  ) : (
                  <div ref={classChartSurfaceRef} className="h-full w-full relative">
                    {/* Hover Tooltip (Absolute relative to chart) */}
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
                        {renderTooltipContent(activeClassTooltip.payload, false, true)}
                      </div>
                    )}
                    
                    {/* Pinned Tooltip (Draggable, Resizable) */}
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
                        {renderTooltipContent(pinnedClassTooltip.payload, true, true)}
                      </motion.div>
                    )}

                    <ResponsiveContainer key={`class-${Math.round(chartPanePercent)}`} width="100%" height="100%" debounce={50}>
                      <BarChart data={classData} onMouseLeave={() => setActiveClassTooltip(null)}>
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: chartTheme.chartTick, fontSize: 10, fontStyle: 'bold', fontFamily: 'JetBrains Mono' }} />
                        <Tooltip content={<></>} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                        <Bar 
                          dataKey="points" 
                          radius={[2, 2, 0, 0]}
                          onClick={(data, index, e) => {
                            const rect = (e.target as Element).closest('.recharts-wrapper')?.getBoundingClientRect();
                            setPinnedClassTooltip({ 
                              x: (e as any).clientX - (rect?.left || 0), 
                              y: (e as any).clientY - (rect?.top || 0), 
                              payload: data, 
                              containerWidth: rect?.width || 500 
                            });
                            setActiveClassTooltip(null);
                          }}
                          onMouseEnter={(data, index, e) => {
                            const rect = (e.target as Element).closest('.recharts-wrapper')?.getBoundingClientRect();
                            setActiveClassTooltip({ 
                              x: (e as any).clientX - (rect?.left || 0), 
                              y: (e as any).clientY - (rect?.top || 0), 
                              payload: data, 
                              containerWidth: rect?.width || 500 
                            });
                          }}
                          onMouseLeave={() => setActiveClassTooltip(null)}
                          style={{ cursor: 'pointer' }}
                        >
                          {classData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} opacity={0.8} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  )
                  ) : (
                    <div className="flex h-full items-center justify-center text-center text-ui-caption text-theme-muted">
                      Preparing chart surface...
                    </div>
                  )}
                </ChartShell>

                <div className="flex justify-between mt-2 px-2 text-ui-micro text-theme-secondary font-mono border-t border-theme-soft pt-2 italic uppercase">
                  <span>{chartView === 'event' ? 'Chronological Event Scoring Timeline' : 'Class Year Contribution'}</span>
                  <span>
                    {(chartView === 'event'
                      ? eventData.reduce((acc, d) => acc + d.points, 0)
                      : classData.reduce((acc, d) => acc + d.points, 0)
                    ).toFixed(1)} PTS TOTAL
                  </span>
                </div>
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
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <List size={14} className="text-[var(--text-accent)]" />
                    <span className="text-ui-micro font-medium uppercase tracking-widest text-theme-secondary">Team Matrix</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select 
                      className="glass-input text-ui-micro uppercase tracking-widest text-theme-secondary rounded p-1 outline-none"
                      value={sortMode}
                      onChange={(e) => setSortMode(e.target.value as any)}
                    >
                      {viewMode === 'event' && <option value="chrono">Chronological</option>}
                      {viewMode === 'event' && <option value="eventDesc">High to Low</option>}
                      {viewMode === 'event' && <option value="eventAsc">Low to High</option>}
                      {viewMode === 'swimmer' && <option value="swimmerDesc">High to Low</option>}
                      {viewMode === 'swimmer' && <option value="swimmerAsc">Low to High</option>}
                    </select>

                    <div className="flex items-center surface-overlay border border-theme-soft rounded p-0.5">
                      <button 
                        onClick={() => { setViewMode('event'); setSortMode('eventDesc'); }}
                        className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded ${viewMode === 'event' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                      >
                        By Event
                      </button>
                      <button 
                        onClick={() => { setViewMode('swimmer'); setSortMode('swimmerDesc'); }}
                        className={`text-ui-micro px-2 py-1 uppercase tracking-widest rounded ${viewMode === 'swimmer' ? 'bg-[var(--surface-strong)]/60 text-[var(--text-primary)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}
                      >
                        By Swimmer
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  {(viewMode === 'swimmer' ? topSwimmers : topEvents).map((group: any) => (
                    <div key={group.name || group.event} className="p-3 rounded surface-overlay border border-theme-soft group transition-all hover:border-[var(--border)]">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <h4 className="text-xs font-medium text-[var(--text-primary)] uppercase group-hover:text-[var(--text-accent)] transition-colors">
                            {viewMode === 'swimmer' ? group.name : group.event}
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
                              className="p-1 rounded border border-theme-soft text-theme-secondary hover:text-[var(--text-accent)] hover:border-[var(--text-accent)]/40 transition-colors"
                              onClick={() => onRequestDeleteSwimmer(group.name)}
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="font-mono font-black text-[var(--text-primary)] text-xs">{group.points.toFixed(1)} <span className="text-ui-micro text-theme-secondary">PTS</span></span>
                        </div>
                      </div>

                      <div className="space-y-1">
                        {group.swimmers.map((res: SwimmerResult, i: number) => {
                          const qualEv = relaySplitQualificationCutEvent(res);
                          const timeStrForCuts = qualEv && res.relayLegSplit ? res.relayLegSplit : res.time;
                          const timeSec = convertTimeToSeconds(timeStrForCuts);
                          const cleanEventBase = res.event.replace(" (Avg Split)", "").replace(/ Yard /i, " ").replace(/ Meter /i, " ").trim();
                          const cleanEvent = normalizeEventForCutline(qualEv ?? cleanEventBase);
                          const { achieved: cutAchieved } = compareTimeToCutline(timeSec, gender, cleanEvent);
                          const isACut = cutAchieved === 'A';
                          const isBCut = cutAchieved === 'B';
                          const { aCut, bCut } = getCutlinesForSwim(gender, cleanEvent);

                          const yearsRemaining = getYearsRemaining(res.classYear as ClassYear);
                          const targetProp = yearsRemaining === 1 ? 'proj_26_27' : yearsRemaining === 2 ? 'proj_27_28' : yearsRemaining >= 3 ? 'proj_28_29' : null;
                          let willMakeFutureCut = null;
                          if (targetProp && !res.isRelay) {
                             const futureACutSec = aCut ? convertTimeToSeconds((aCut as any)[targetProp]) : 0;
                             const futureBCutSec = bCut ? convertTimeToSeconds((bCut as any)[targetProp]) : 0;
                             if (futureACutSec > 0 && timeSec <= futureACutSec) willMakeFutureCut = 'A';
                             else if (futureBCutSec > 0 && timeSec <= futureBCutSec) willMakeFutureCut = 'B';
                          }

                          const relaySplitPrimary = res.isRelay && (res.relayLegSplitDetail || res.relayLegSplit);

                          return (
                            <div key={i} className="flex items-center justify-between text-ui-caption py-1.5 border-t border-theme-soft">
                              <div className="flex items-center gap-2 text-theme-secondary font-mono w-1/3">
                                <span className="w-4 font-medium text-theme-secondary">{res.rank || '-'}</span>
                                <span className="truncate max-w-[150px]" title={viewMode === 'swimmer' ? res.event : res.name}>
                                  {viewMode === 'swimmer' ? res.event : res.name}
                                </span>
                                {res.relayMissingLeg && (
                                  <span className="text-ui-micro text-amber-400 shrink-0" title="Missing relay leg">
                                    Missing L{(res.relayMissingLeg.legIndex ?? 0) + 1}{' '}
                                    {relayMissingStrokeLabel(res.relayMissingLeg.stroke)}
                                  </span>
                                )}
                                {res.roundSwam && <span className="text-ui-micro surface-overlay px-1 rounded truncate max-w-[60px]">{res.roundSwam}</span>}
                              </div>
                              <div className="flex flex-col items-end gap-0.5 justify-center w-1/3 text-right">
                                {res.prelimsTime && (
                                  <div className="text-ui-micro text-theme-secondary font-mono">
                                    Prelim: {res.prelimsTime}
                                  </div>
                                )}
                                {relaySplitPrimary && (
                                  <div
                                    className={`font-mono font-medium cursor-pointer hover:underline ${isACut ? 'text-[var(--text-accent)]' : isBCut ? 'text-amber-400' : 'text-theme-secondary'}`}
                                    onClick={() => { if(onUpdateTime && res.id) { setEditingResultId(res.id); setEditValue(res.time); } }}
                                  >
                                    Split: {displayTimeForRelayLeg(res)}
                                    {res.relayLegSplitDetail ? (
                                      <span className="block text-ui-micro text-theme-muted font-sans">
                                        {formatLegSplitSummary(res.relayLegSplitDetail)}
                                      </span>
                                    ) : null}
                                    <span className="block text-ui-micro text-theme-secondary font-normal">Relay {res.relayTeamTime || res.finalsTime || res.time}</span>
                                  </div>
                                )}
                                {res.finalsTime && !relaySplitPrimary && (
                                  <div 
                                    className={`font-mono font-medium cursor-pointer hover:underline ${isACut ? 'text-[var(--text-accent)]' : isBCut ? 'text-amber-400' : 'text-theme-secondary'}`}
                                    onClick={() => { if(onUpdateTime && res.id) { setEditingResultId(res.id); setEditValue(res.time); } }}
                                  >
                                    Final: {res.finalsTime}
                                  </div>
                                )}
                                {!res.finalsTime && !res.prelimsTime && !relaySplitPrimary && (
                                  <div 
                                    className={`font-mono font-medium cursor-pointer hover:underline ${isACut ? 'text-[var(--text-accent)]' : isBCut ? 'text-amber-400' : 'text-theme-secondary'}`}
                                    onClick={() => { if(onUpdateTime && res.id) { setEditingResultId(res.id); setEditValue(res.time); } }}
                                  >
                                    {res.time}
                                  </div>
                                )}
                                {willMakeFutureCut && (
                                  <div className="text-ui-micro text-[var(--text-accent)] font-mono mt-0.5">
                                    Beats Future {willMakeFutureCut}-Cut ({targetProp?.replace('proj_', "'").replace('_', "-'")})
                                  </div>
                                )}
                                {editingResultId === res.id && (
                                  <form 
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      if(onUpdateTime && res.id) onUpdateTime(res.id, editValue);
                                      setEditingResultId(null);
                                    }}
                                    className="flex w-full mt-1 border border-theme-soft rounded overflow-hidden"
                                  >
                                    <input 
                                      type="text" 
                                      autoFocus
                                      value={editValue} 
                                      onChange={e => setEditValue(e.target.value)} 
                                      className="surface-muted-bg text-ui-micro px-1 py-0.5 outline-none font-mono flex-1 text-[var(--text-primary)]" 
                                      onBlur={() => setEditingResultId(null)}
                                    />
                                  </form>
                                )}
                              </div>
                              <div className="flex items-center justify-end gap-2 w-1/3 flex-wrap">
                                {isACut && <span title="Current A Cut Achieved" className="text-ui-micro btn-accent-outline px-1 rounded-sm">A CUT</span>}
                                {isBCut && <span title="Current B Cut Achieved" className="text-ui-micro bg-amber-400/10 text-amber-400 px-1 border border-amber-400/30 rounded-sm">B CUT</span>}
                                <span className={`font-mono font-medium w-8 text-right ${res.points === 'N/A' || res.points === 0 ? 'text-theme-secondary' : 'text-points-positive'}`}>
                                  {res.points === 'N/A' ? 'N/A' : `+${res.points}`}
                                </span>
                              </div>
                            </div>
                          );
                        })}
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
