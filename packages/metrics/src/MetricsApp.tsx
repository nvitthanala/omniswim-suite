import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UploadCloud, Settings2, FolderOpen, Save, Download, Trash2, X } from 'lucide-react';
import { analyzeRace, createTagStateMachine, raceLengthCount } from '@omniswim/core/lib/raceAnalysis';
import { VideoPlayer } from './components/VideoPlayer';
import { MetricsDashboard } from './components/MetricsDashboard';
import { RaceSetupForm, STROKE_LABEL } from './components/RaceSetupForm';
import { TagDeck } from './components/TagDeck';
import { TagTable, updateTagTime } from './components/TagTable';
import { SessionComparePanel } from './components/SessionComparePanel';
import type { OperatorKey, RaceAnalysisResult, RaceConfig, RaceTag } from './types';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { EmptyState, useToast } from '@omniswim/ui';
import { extractVideoMeta, formatMeta, type VideoMeta } from './lib/videoMeta';
import {
  deleteSession,
  isIndexedDbAvailable,
  listSessions,
  loadSession,
  saveSession,
  type SessionRecord,
  type SessionSummary,
} from './lib/sessionStore';
import { buildRaceReport } from './lib/reportExport';

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

const DEFAULT_RACE_CONFIG: RaceConfig = {
  course: 'LCM',
  raceDistance: 100,
  strokePerLength: ['free', 'free'],
  cycleDefinition: 'same-hand',
  fifteenMetreReferenceConfirmed: true,
  isRelayLeg: false,
};

function lengthCountForConfig(config: RaceConfig): number {
  const raw = raceLengthCount(config);
  return Number.isInteger(raw) ? Math.round(raw) : config.strokePerLength.length;
}

function insertSorted(tags: readonly RaceTag[], tag: RaceTag): RaceTag[] {
  return [...tags, tag].sort((a, b) => a.time - b.time);
}

export default function MetricsApp() {
  const { rosterNames, activeWorkspace } = useSuiteWorkspace();
  const toast = useToast();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);

  const [swimmerName, setSwimmerName] = useState('');
  const [raceConfig, setRaceConfig] = useState<RaceConfig>(DEFAULT_RACE_CONFIG);
  const [setupConfirmed, setSetupConfirmed] = useState(false);
  const [tags, setTags] = useState<RaceTag[]>([]);
  const [videoFileName, setVideoFileName] = useState<string | undefined>(undefined);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCreatedAt, setSessionCreatedAt] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  const [compareSessionId, setCompareSessionId] = useState<string>('');
  const [compareData, setCompareData] = useState<{ label: string; config: RaceConfig; result: RaceAnalysisResult } | null>(
    null
  );

  const refreshSessions = useCallback(() => {
    if (!isIndexedDbAvailable()) return;
    listSessions().then(setSessions).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const comparisonTime = useMemo(() => {
    if (!activeWorkspace || !swimmerName) return null;
    const target = swimmerName.trim().toLowerCase();
    const primaryStroke = raceConfig.strokePerLength[0];
    const strokeSearch = primaryStroke === undefined ? '' : STROKE_LABEL[primaryStroke].toLowerCase().slice(0, 4);
    const distanceStr = String(raceConfig.raceDistance);
    const matches = (event: string) => event.toLowerCase().includes(strokeSearch) && event.includes(distanceStr);
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
  }, [activeWorkspace, swimmerName, raceConfig.raceDistance, raceConfig.strokePerLength]);

  const openVideoFile = useCallback(
    (file: File) => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      setVideoFileName(file.name);
      setVideoMeta(null);
      setFpsOverride(null);
      setTags([]);
      setSetupConfirmed(false);
      setSessionId(null);
      setSessionCreatedAt(null);
      extractVideoMeta(url)
        .then(setVideoMeta)
        .catch(() => undefined);
      toast.push('success', `Video "${file.name}" opened`);
    },
    [videoUrl, toast],
  );

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    openVideoFile(file);
  };

  const dragCounter = useRef(0);
  const [isDragOverVideo, setIsDragOverVideo] = useState(false);

  const handleVideoDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragCounter.current += 1;
    setIsDragOverVideo(true);
  }, []);

  const handleVideoDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleVideoDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragOverVideo(false);
  }, []);

  const handleVideoDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      dragCounter.current = 0;
      setIsDragOverVideo(false);
      const file = event.dataTransfer.files[0];
      if (!file) return;
      if (!file.type.startsWith('video/')) {
        toast.push('error', `"${file.name}" is not a video file.`);
        return;
      }
      openVideoFile(file);
    },
    [openVideoFile, toast],
  );

  const handleTagDragCommit = useCallback((index: number, nextTime: number) => {
    setTags((prev) => updateTagTime(prev, index, nextTime));
  }, []);

  const measuredFps = videoMeta?.fps;
  const effectiveFps = fpsOverride ?? measuredFps ?? null;
  const frameSeconds = effectiveFps !== null ? 1 / effectiveFps : null;

  const lengthCount = lengthCountForConfig(raceConfig);
  const machine = useMemo(() => createTagStateMachine(raceConfig, tags), [raceConfig, tags]);
  const result = useMemo(() => analyzeRace(raceConfig, tags), [raceConfig, tags]);
  const fifteenMetreGateReason =
    raceConfig.course === 'SCY' && !raceConfig.fifteenMetreReferenceConfirmed
      ? '15 m reference not confirmed for SCY'
      : undefined;

  const handleSaveSession = useCallback(async () => {
    if (!isIndexedDbAvailable()) {
      toast.push('error', 'Session storage is unavailable in this browser.');
      return;
    }
    if (!videoMeta) {
      toast.push('error', 'Open a video before saving a session.');
      return;
    }
    const now = Date.now();
    const id = sessionId ?? `metrics_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const record: SessionRecord = {
      id,
      swimmerName,
      video: {
        fileName: videoFileName ?? 'unknown',
        duration: videoMeta.duration,
        width: videoMeta.width,
        height: videoMeta.height,
        fps: videoMeta.fps,
      },
      config: raceConfig,
      tags,
      createdAt: sessionCreatedAt ?? now,
      updatedAt: now,
    };
    try {
      await saveSession(record);
      setSessionId(id);
      setSessionCreatedAt(record.createdAt);
      toast.push('success', `Saved session for ${swimmerName || 'Unknown Swimmer'}.`);
      refreshSessions();
    } catch (err) {
      toast.push('error', `Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [videoMeta, videoFileName, raceConfig, tags, swimmerName, sessionId, sessionCreatedAt, toast, refreshSessions]);

  const handleLoadSession = useCallback(
    async (id: string) => {
      const loaded = await loadSession(id);
      if (!loaded) return;
      if (loaded.legacy) {
        toast.push('info', `"${loaded.label}" ${loaded.reason}`);
        return;
      }
      setSwimmerName(loaded.record.swimmerName);
      setRaceConfig(loaded.record.config);
      setTags(loaded.record.tags);
      setVideoMeta({
        duration: loaded.record.video.duration,
        width: loaded.record.video.width,
        height: loaded.record.video.height,
        fps: loaded.record.video.fps,
      });
      setVideoFileName(loaded.record.video.fileName);
      setSessionId(loaded.record.id);
      setSessionCreatedAt(loaded.record.createdAt);
      setSetupConfirmed(true);
      setShowSessions(false);
      toast.push('info', `Loaded "${loaded.record.swimmerName || 'Unnamed swimmer'}". Re-open "${loaded.record.video.fileName}" to view playback.`);
    },
    [toast],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      await deleteSession(id);
      if (sessionId === id) {
        setSessionId(null);
        setSessionCreatedAt(null);
      }
      if (compareSessionId === id) {
        setCompareSessionId('');
        setCompareData(null);
      }
      refreshSessions();
      toast.push('success', 'Saved session deleted');
    },
    [sessionId, compareSessionId, refreshSessions, toast],
  );

  const handleSelectCompareSession = useCallback(
    (id: string) => {
      setCompareSessionId(id);
      if (!id) {
        setCompareData(null);
        return;
      }
      loadSession(id)
        .then((loaded) => {
          if (!loaded) return;
          if (loaded.legacy) {
            toast.push('info', 'That session used an earlier schema and cannot be compared.');
            setCompareData(null);
            return;
          }
          setCompareData({
            label: loaded.record.swimmerName || 'Unnamed swimmer',
            config: loaded.record.config,
            result: loaded.analysis,
          });
        })
        .catch(() => toast.push('error', 'Failed to load session for comparison.'));
    },
    [toast],
  );

  const handleExportReport = useCallback(() => {
    const report = buildRaceReport({ swimmerName, config: raceConfig, result });
    downloadText(report.filename, report.mimeType, report.content);
    toast.push('success', `Exported ${report.filename}`);
  }, [swimmerName, raceConfig, result, toast]);

  const handleSequentialKey = useCallback(
    (key: OperatorKey, time: number) => {
      if (!setupConfirmed) return;
      if (key === 'A' && fifteenMetreGateReason !== undefined) {
        toast.push('info', fifteenMetreGateReason);
        return;
      }
      const pressResult = machine.press(key, time);
      if (pressResult.status === 'illegal') {
        toast.push('error', pressResult.reason);
        return;
      }
      setTags((prev) => insertSorted(prev, pressResult.tag));
    },
    [setupConfirmed, fifteenMetreGateReason, machine, toast],
  );

  const handleOneShotKey = useCallback(
    (kind: 'Signal' | 'Flags' | 'Kick', time: number) => {
      if (!setupConfirmed) return;
      let lengthIndex: number | undefined;
      if (kind === 'Kick') {
        lengthIndex = machine.nextS().lengthIndex ?? machine.nextD().lengthIndex;
      } else if (kind === 'Flags') {
        lengthIndex = lengthCount;
      }
      const tag: RaceTag = lengthIndex === undefined ? { kind, time } : { kind, time, lengthIndex };
      setTags((prev) => insertSorted(prev, tag));
    },
    [setupConfirmed, machine, lengthCount],
  );

  const handleUndo = useCallback(() => {
    if (!setupConfirmed) return;
    const undoResult = machine.undo();
    if (undoResult.status === 'illegal') {
      toast.push('info', undoResult.reason);
      return;
    }
    setTags((prev) => prev.filter((tag) => tag !== undoResult.tag));
  }, [setupConfirmed, machine, toast]);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] min-h-[480px] overflow-hidden rounded-lg border border-theme surface-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-soft shrink-0">
        <div>
          <h2 className="text-ui-label font-black uppercase tracking-widest text-[var(--text-primary)]">
            Swim Metrics
          </h2>
          <p className="text-ui-caption text-theme-muted">Frame-accurate race tagging & analysis</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSessions((s) => !s)}
            className="px-3 py-2 rounded-lg text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)] transition-colors"
            title="Saved sessions"
          >
            <FolderOpen size={14} />
            Sessions{sessions.length ? ` (${sessions.length})` : ''}
          </button>
          {videoUrl && setupConfirmed ? (
            <button
              type="button"
              onClick={() => void handleSaveSession()}
              className="px-3 py-2 rounded-lg text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)] transition-colors"
              title="Save this analysis session"
            >
              <Save size={14} />
              Save
            </button>
          ) : null}
          {setupConfirmed ? (
            <button
              type="button"
              onClick={handleExportReport}
              className="px-3 py-2 rounded-lg text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)] transition-colors"
              title="Export metrics report as CSV"
            >
              <Download size={14} />
              Report
            </button>
          ) : null}
          {videoUrl && setupConfirmed ? (
            <button
              type="button"
              onClick={() => setSetupConfirmed(false)}
              className="px-3 py-2 rounded-lg text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 border border-theme-soft nav-tab-inactive hover:text-[var(--text-primary)] transition-colors"
            >
              <Settings2 size={14} />
              Re-configure
            </button>
          ) : null}
          <input type="file" accept="video/*" className="hidden" id="metrics-file-input" onChange={handleFileChange} />
          <label
            htmlFor="metrics-file-input"
            className="px-3 py-2 btn-primary rounded-lg text-ui-micro font-bold uppercase tracking-widest flex items-center gap-2 cursor-pointer"
          >
            <UploadCloud size={14} />
            Open Video
          </label>
        </div>
      </div>

      {showSessions ? (
        <div className="mx-4 mt-4 border border-theme-soft rounded-lg overflow-hidden shrink-0">
          <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface-strong)]">
            <span className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">Saved Sessions</span>
            <button
              type="button"
              onClick={() => setShowSessions(false)}
              className="p-1 theme-hover-row rounded"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className="p-4 text-ui-caption text-theme-muted">No saved sessions yet.</div>
          ) : (
            <ul className="max-h-48 overflow-y-auto custom-scrollbar divide-y divide-[var(--border-soft)]">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-ui-caption">
                  <button
                    type="button"
                    onClick={() => void handleLoadSession(s.id)}
                    className="flex-1 text-left hover:text-[var(--text-accent)]"
                  >
                    <span className="font-bold">{s.label}</span>
                    {s.legacy ? (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-ui-micro uppercase tracking-widest bg-[var(--surface-muted)] text-theme-muted">
                        Legacy
                      </span>
                    ) : null}
                    <span className="text-theme-muted ml-2">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}</span>
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

      <main className="flex-1 flex overflow-hidden flex-col lg:flex-row min-h-0">
        <div
          className="flex-1 lg:flex-[1.8] relative bg-[var(--surface-muted)] flex flex-col items-center justify-center border-b lg:border-b-0 lg:border-r border-theme-soft overflow-hidden"
          role="region"
          aria-label="Video drop zone. Drag and drop a video file here, or use the Open Video button."
          onDragEnter={handleVideoDragEnter}
          onDragOver={handleVideoDragOver}
          onDragLeave={handleVideoDragLeave}
          onDrop={handleVideoDrop}
        >
          <VideoPlayer
            videoUrl={videoUrl}
            tags={tags}
            measuredFps={measuredFps}
            fpsOverride={fpsOverride}
            onFpsOverrideChange={setFpsOverride}
            onSequentialKey={handleSequentialKey}
            onOneShotKey={handleOneShotKey}
            onUndo={handleUndo}
            onTagDragCommit={handleTagDragCommit}
          />
          {videoUrl && setupConfirmed ? (
            <div className="absolute top-4 left-4 z-30 w-64 max-h-[calc(100%-2rem)] overflow-y-auto custom-scrollbar">
              <TagDeck machine={machine} tags={tags} lengthCount={lengthCount} fifteenMetreGateReason={fifteenMetreGateReason} />
            </div>
          ) : null}
          {isDragOverVideo ? (
            <div className="absolute inset-2 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--text-accent)] bg-[var(--surface)]/90 pointer-events-none">
              <div className="flex flex-col items-center gap-2 text-center px-4">
                <UploadCloud size={28} className="text-[var(--text-accent)]" />
                <span className="text-ui-label font-bold uppercase tracking-widest text-[var(--text-primary)]">
                  Drop video to open
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex-1 lg:flex-[1.2] xl:max-w-md p-4 sm:p-6 flex flex-col gap-4 overflow-y-auto custom-scrollbar bg-[var(--surface)]">
          {!videoUrl ? (
            <EmptyState
              className="h-full min-h-[280px] border-dashed bg-[var(--surface-muted)]"
              icon={<UploadCloud size={28} />}
              eyebrow="Metrics"
              title="Upload a race video to begin"
              description="Open a local video, configure the race, then tag it frame by frame with the keyboard."
              actionLabel="Open Video"
              onAction={() => document.getElementById('metrics-file-input')?.click()}
            />
          ) : !setupConfirmed ? (
            <RaceSetupForm
              config={raceConfig}
              swimmerName={swimmerName}
              rosterNames={rosterNames}
              onSwimmerNameChange={setSwimmerName}
              onChange={setRaceConfig}
              onConfirm={() => setSetupConfirmed(true)}
            />
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-theme-soft pb-3">
                <div>
                  <div className="text-ui-micro text-theme-muted uppercase tracking-widest font-bold mb-1">
                    {raceConfig.course} {raceConfig.raceDistance}
                    {raceConfig.course === 'SCY' ? 'y' : 'm'}
                  </div>
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">{swimmerName || 'Unknown Swimmer'}</h3>
                  {comparisonTime ? (
                    <div className="text-ui-caption text-theme-muted mt-0.5">
                      Workspace best: <span className="font-mono text-[var(--text-accent)]">{comparisonTime}</span>
                    </div>
                  ) : null}
                  {videoMeta ? <div className="text-ui-caption text-theme-muted mt-0.5 font-mono">{formatMeta(videoMeta)}</div> : null}
                </div>
              </div>
              <TagTable config={raceConfig} tags={tags} frameSeconds={frameSeconds} onChange={setTags} />
              <MetricsDashboard data={result} />
              {sessions.filter((s) => !s.legacy).length > 0 ? (
                <section className="panel p-4 border border-theme-soft rounded-xl">
                  <label className="label-caps flex items-center gap-1.5 mb-1.5">Compare against saved session</label>
                  <select
                    value={compareSessionId}
                    onChange={(e) => handleSelectCompareSession(e.target.value)}
                    className="glass-input w-full"
                  >
                    <option value="">Select a session…</option>
                    {sessions
                      .filter((s) => !s.legacy)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                  </select>
                </section>
              ) : null}
              {compareData ? (
                <SessionComparePanel
                  left={{ label: swimmerName || 'Current', config: raceConfig, result }}
                  right={compareData}
                />
              ) : null}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
