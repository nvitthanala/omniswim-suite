import React, { useState, useRef, useEffect, useMemo } from 'react';
import { UploadCloud, Save, FolderOpen, Download, Trash2, X } from 'lucide-react';
import { VideoPlayer, type TrackingEvent } from './components/VideoPlayer';
import { MetricsDashboard } from './components/MetricsDashboard';
import { SessionComparePanel, LapCompareTable } from './components/SessionComparePanel';
import { RaceSetupForm } from './components/RaceSetupForm';
import { BiomechanicsData, RaceConfig } from './types';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { useToast } from '@omniswim/ui';
import {
  deleteSession,
  isIndexedDbAvailable,
  listSessions,
  saveSession,
  type MetricsSession,
} from './lib/sessionStore';
import { extractVideoMeta, formatMeta, type VideoMeta } from './lib/videoMeta';
import { buildMetricsReport } from './lib/reportExport';

function downloadText(filename: string, mimeType: string, content: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function MetricsApp() {
  const { rosterNames, activeWorkspace } = useSuiteWorkspace();
  const toast = useToast();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | undefined>(undefined);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [data, setData] = useState<BiomechanicsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<MetricsSession[]>([]);
  const [showSessions, setShowSessions] = useState(false);

  const [raceConfig, setRaceConfig] = useState<RaceConfig>({
    swimmerName: '',
    stroke: 'Freestyle',
    distance: 100,
    course: 'LCM',
    videoStartTime: null,
    videoEndTime: null,
    manualRaceTime: null,
    manualSplits: '',
    manualDiveVelocity: null,
    manualBreakoutDistance: null,
    manualKickCount: null,
  });

  const [trackedEvents, setTrackedEvents] = useState<TrackingEvent[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const refreshSessions = React.useCallback(() => {
    if (!isIndexedDbAvailable()) return;
    listSessions().then(setSessions).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Best comparison time for the configured swimmer + event from the workspace.
  const comparisonTime = useMemo(() => {
    if (!activeWorkspace || !raceConfig.swimmerName) return null;
    const target = raceConfig.swimmerName.trim().toLowerCase();
    const distanceStr = String(raceConfig.distance);
    const strokeStr = raceConfig.stroke.toLowerCase();
    const matches = (event: string) =>
      event.toLowerCase().includes(strokeStr.slice(0, 4)) && event.includes(distanceStr);
    const candidates: string[] = [];
    for (const h of activeWorkspace.athleteHistory ?? []) {
      if (h.name.trim().toLowerCase() === target && matches(h.event)) candidates.push(h.time);
    }
    for (const r of [...(activeWorkspace.menResults ?? []), ...(activeWorkspace.womenResults ?? [])]) {
      if (r.name.trim().toLowerCase() === target && matches(r.event) && typeof r.time === 'string') {
        candidates.push(r.time);
      }
    }
    return candidates.length > 0 ? candidates[0] : null;
  }, [activeWorkspace, raceConfig.swimmerName, raceConfig.distance, raceConfig.stroke]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setData(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setVideoName(file.name);
    setVideoMeta(null);
    extractVideoMeta(url)
      .then(setVideoMeta)
      .catch(() => undefined);
  };

  const handleSaveSession = async () => {
    if (!isIndexedDbAvailable()) {
      toast.push('error', 'Session storage is unavailable in this browser.');
      return;
    }
    const name = raceConfig.swimmerName?.trim()
      ? `${raceConfig.swimmerName} — ${raceConfig.distance}${raceConfig.stroke}`
      : `Session ${new Date().toLocaleString()}`;
    const session: MetricsSession = {
      id: `metrics_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      savedAt: Date.now(),
      videoName,
      videoMeta: videoMeta ?? undefined,
      config: raceConfig,
      events: trackedEvents,
      data,
    };
    try {
      await saveSession(session);
      toast.push('success', `Saved session "${name}".`);
      refreshSessions();
    } catch (err) {
      toast.push('error', `Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleLoadSession = (session: MetricsSession) => {
    setRaceConfig(session.config);
    setTrackedEvents(session.events ?? []);
    setData(session.data ?? null);
    setVideoMeta(session.videoMeta ?? null);
    setVideoName(session.videoName);
    setShowSessions(false);
    toast.push('info', `Loaded "${session.name}". Re-open the video to view playback.`);
  };

  const handleDeleteSession = async (id: string) => {
    await deleteSession(id);
    refreshSessions();
  };

  const handleExportReport = () => {
    if (!data) return;
    const report = buildMetricsReport(raceConfig, data, comparisonTime);
    downloadText(report.filename, report.mimeType, report.content);
    toast.push('success', `Exported ${report.filename}`);
  };

  const runLocalAnalysis = async () => {
    if (!videoUrl) return;
    setIsAnalyzing(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 800));
      setData(calculateMetricsLocal(raceConfig, trackedEvents));
    } catch {
      setError('Failed to calculate metrics.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] min-h-[480px] overflow-hidden rounded-lg border border-theme surface-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-soft shrink-0">
        <div>
          <h2 className="text-ui-label font-black uppercase tracking-widest text-[var(--text-primary)]">
            Swim Metrics
          </h2>
          <p className="text-ui-caption text-theme-muted">Video analysis & split metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSessions(s => !s)}
            className="px-3 py-2 rounded text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)]"
            title="Saved sessions"
          >
            <FolderOpen size={14} />
            Sessions{sessions.length ? ` (${sessions.length})` : ''}
          </button>
          {videoUrl ? (
            <button
              type="button"
              onClick={() => void handleSaveSession()}
              className="px-3 py-2 rounded text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)]"
              title="Save this analysis session"
            >
              <Save size={14} />
              Save
            </button>
          ) : null}
          {data ? (
            <button
              type="button"
              onClick={handleExportReport}
              className="px-3 py-2 rounded text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)]"
              title="Export metrics report as CSV"
            >
              <Download size={14} />
              Report
            </button>
          ) : null}
          <input type="file" accept="video/*" className="hidden" ref={fileInputRef} onChange={handleFileChange} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-2 btn-primary rounded text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2"
          >
            <UploadCloud size={14} />
            Open Video
          </button>
        </div>
      </div>

      {showSessions ? (
        <div className="mx-4 mt-4 border border-theme-soft rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface-strong)]">
            <span className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">
              Saved Sessions
            </span>
            <button type="button" onClick={() => setShowSessions(false)} className="p-1 theme-hover-row rounded" aria-label="Close">
              <X size={14} />
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className="p-4 text-ui-caption text-theme-muted">No saved sessions yet.</div>
          ) : (
            <ul className="max-h-48 overflow-y-auto custom-scrollbar divide-y divide-[var(--border-soft)]">
              {sessions.map(s => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-ui-caption">
                  <button
                    type="button"
                    onClick={() => handleLoadSession(s)}
                    className="flex-1 text-left hover:text-[var(--text-accent)]"
                  >
                    <span className="font-bold">{s.name}</span>
                    <span className="text-theme-muted ml-2">{new Date(s.savedAt).toLocaleString()}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteSession(s.id)}
                    className="p-1 theme-hover-row rounded text-theme-muted hover:text-red-400"
                    aria-label="Delete session"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="mx-4 mt-4 p-3 toast-undo rounded text-ui-caption">{error}</div>
      ) : null}

      <main className="flex-1 flex overflow-hidden flex-col lg:flex-row min-h-0">
        <div className="flex-1 lg:flex-[1.8] relative bg-[var(--surface-muted)] flex flex-col items-center justify-center border-b lg:border-b-0 lg:border-r border-theme-soft overflow-hidden">
          {isAnalyzing ? (
            <div className="flex flex-col items-center gap-4 p-8">
              <div className="w-12 h-12 border-2 border-[var(--text-accent)] border-t-transparent rounded-full animate-spin" />
              <p className="text-ui-caption uppercase tracking-widest text-theme-muted font-bold">
                Calculating metrics…
              </p>
            </div>
          ) : (
            <VideoPlayer
              videoUrl={videoUrl}
              data={data}
              goalTime={raceConfig.distance === 100 ? 50.0 : raceConfig.distance === 50 ? 23.0 : 120.0}
              worldRecordTime={raceConfig.distance === 100 ? 46.86 : raceConfig.distance === 50 ? 20.91 : 110.0}
              startTime={raceConfig.videoStartTime}
              endTime={raceConfig.videoEndTime}
              onMarkStart={t => setRaceConfig(c => ({ ...c, videoStartTime: t }))}
              onMarkEnd={t => setRaceConfig(c => ({ ...c, videoEndTime: t }))}
              onTrackingUpdate={setTrackedEvents}
            />
          )}
        </div>

        <div className="flex-1 lg:flex-[1.2] xl:max-w-md p-4 sm:p-6 flex flex-col gap-4 overflow-y-auto custom-scrollbar bg-[var(--surface)]">
          {data ? (
            <>
              <div className="flex items-center justify-between border-b border-theme-soft pb-3">
                <div>
                  <div className="text-ui-micro text-theme-muted uppercase tracking-widest font-bold mb-1">
                    {raceConfig.course} {raceConfig.distance}m {raceConfig.stroke}
                  </div>
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">
                    {raceConfig.swimmerName || 'Unknown Swimmer'}
                  </h3>
                  {comparisonTime ? (
                    <div className="text-ui-caption text-theme-muted mt-0.5">
                      Workspace best: <span className="font-mono text-[var(--text-accent)]">{comparisonTime}</span>
                    </div>
                  ) : null}
                  {videoMeta ? (
                    <div className="text-ui-caption text-theme-muted mt-0.5 font-mono">{formatMeta(videoMeta)}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setData(null)}
                  className="text-ui-micro px-3 py-1.5 rounded border border-theme-soft theme-hover-row uppercase font-bold tracking-widest"
                >
                  Re-configure
                </button>
              </div>
              <MetricsDashboard data={data} />
              <LapCompareTable data={data} />
              <SessionComparePanel
                current={data}
                sessions={sessions}
                currentLabel={raceConfig.swimmerName || 'Current'}
              />
            </>
          ) : videoUrl ? (
            <RaceSetupForm
              config={raceConfig}
              rosterNames={rosterNames}
              onChange={setRaceConfig}
              onAnalyze={runLocalAnalysis}
              isAnalyzing={isAnalyzing}
            />
          ) : (
            <div className="h-full min-h-[280px] flex items-center justify-center border border-dashed border-theme-soft rounded-xl bg-[var(--surface-muted)] p-8 text-center text-theme-muted font-mono text-ui-caption">
              Upload a video to begin metrics analysis.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function calculateMetricsLocal(config: RaceConfig, events: TrackingEvent[]): BiomechanicsData {
  const diveEvents = events.filter(e => e.type === 'dive').sort((a, b) => a.time - b.time);
  const finishEvents = events.filter(e => e.type === 'finish').sort((a, b) => a.time - b.time);

  const runStart = config.videoStartTime ?? (diveEvents.length > 0 ? diveEvents[0].time : 0);
  const runEnd = config.videoEndTime ?? (finishEvents.length > 0 ? finishEvents[0].time : runStart + 50);

  const duration = config.manualRaceTime ?? Math.max(0.1, runEnd - runStart);
  const dist = config.distance || 100;
  const avgVelocity = dist / duration;
  const poolLen = config.course === 'SCY' || config.course === 'SCM' ? 25 : 50;
  const manualSplitsArr = config.manualSplits.split(',').map(s => parseFloat(s.trim())).filter(s => !isNaN(s));

  const breakoutEvents = events.filter(e => e.type === 'breakout').sort((a, b) => a.time - b.time);
  const m15Events = events.filter(e => e.type === '15m').sort((a, b) => a.time - b.time);
  const kickEvents = events.filter(e => e.type === 'kick').sort((a, b) => a.time - b.time);
  const strokeEvents = events.filter(e => e.type === 'stroke').sort((a, b) => a.time - b.time);
  const turnEvents = events.filter(e => e.type === 'turn').sort((a, b) => a.time - b.time);

  let breakDist =
    config.manualBreakoutDistance ??
    (config.stroke === 'Breaststroke' ? 8.5 : config.stroke === 'Backstroke' ? 12 : 10);

  let vel0to15 = avgVelocity * 1.3;
  let breakTime = breakDist / vel0to15;
  if (breakoutEvents.length > 0 && runStart > 0) {
    breakTime = breakoutEvents[0].time - runStart;
    vel0to15 = breakDist / breakTime;
  }

  const diveVel = config.manualDiveVelocity ?? Math.max(vel0to15 * 1.3, avgVelocity * 1.8);
  if (m15Events.length > 0 && runStart > 0) {
    vel0to15 = 15 / (m15Events[0].time - runStart);
  }

  let uwtTempo = config.stroke === 'Breaststroke' ? 0 : 160;
  if (kickEvents.length > 1) {
    let avgKickTime = 0;
    for (let i = 1; i < kickEvents.length; i++) {
      avgKickTime += kickEvents[i].time - kickEvents[i - 1].time;
    }
    avgKickTime /= kickEvents.length - 1;
    uwtTempo = 60 / avgKickTime;
  }

  let strokeRate = config.stroke === 'Butterfly' ? 45 : 55;
  if (strokeEvents.length > 1) {
    let avgStrokeTime = 0;
    for (let i = 1; i < strokeEvents.length; i++) {
      avgStrokeTime += strokeEvents[i].time - strokeEvents[i - 1].time;
    }
    avgStrokeTime /= strokeEvents.length - 1;
    strokeRate = 60 / avgStrokeTime;
  }

  const kicksCountVal =
    typeof config.manualKickCount === 'number'
      ? config.manualKickCount
      : kickEvents.length > 0
        ? kickEvents.length
        : config.stroke === 'Breaststroke'
          ? 1
          : 6;

  const lapEndTimes: number[] = [];
  for (let i = 1; i < turnEvents.length; i += 2) {
    lapEndTimes.push(turnEvents[i].time);
  }
  if (finishEvents.length > 0) lapEndTimes.push(finishEvents[0].time);
  else if (runEnd > runStart) lapEndTimes.push(runEnd);

  const splits: BiomechanicsData['splits'] = [];
  if (lapEndTimes.length > 0) {
    let prevTime = runStart;
    for (let i = 0; i < lapEndTimes.length; i++) {
      let lapTime = lapEndTimes[i] - prevTime;
      if (manualSplitsArr[i]) lapTime = manualSplitsArr[i];
      splits.push({ lap: i + 1, distance: poolLen, time: Math.max(0.1, lapTime) });
      prevTime = lapEndTimes[i];
    }
  } else {
    const numLaps = Math.max(1, Math.ceil(dist / poolLen));
    for (let i = 1; i <= numLaps; i++) {
      let lapTime = (poolLen / avgVelocity) * (i === 1 ? 0.9 : 1.05);
      if (manualSplitsArr[i - 1]) lapTime = manualSplitsArr[i - 1];
      splits.push({ lap: i, distance: poolLen, time: lapTime });
    }
  }

  return {
    splits,
    avgVelocity,
    strokeRate,
    distancePerStroke: avgVelocity * (60 / strokeRate),
    fatigueIndex: 8.4,
    underwaterKickTempo: uwtTempo,
    diveVelocity: diveVel,
    diveDistance: breakDist + 2.5,
    vel0to15m: vel0to15,
    vel15mToWall: avgVelocity * 0.92,
    firstLengthVel: avgVelocity * 1.15,
    breakoutDistance: breakDist,
    breakoutTime: breakTime,
    kicksCount: kicksCountVal,
  };
}
