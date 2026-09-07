import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Tags, UploadCloud } from 'lucide-react';
import { analyzeRace, createTagStateMachine, raceLengthCount } from '@omniswim/core/lib/raceAnalysis';
import { MetricsHeader } from './components/MetricsHeader';
import { SessionsPanel } from './components/SessionsPanel';
import { VideoStage } from './components/VideoStage';
import { MetricsStepContent } from './components/MetricsStepPanels';
import { STROKE_LABEL } from './components/RaceSetupForm';
import { useTagKeyboardHandlers } from './hooks/useTagKeyboardHandlers';
import type { RaceAnalysisResult, RaceConfig, RaceTag } from './types';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import type { Workspace } from '@omniswim/core/types';
import { useToast, WizardShell, type WizardStep } from '@omniswim/ui';
import { extractVideoMeta, type VideoMeta } from './lib/videoMeta';
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

type MetricsStepId = 'setup' | 'tag' | 'review';

const METRICS_STEPS: readonly WizardStep<MetricsStepId>[] = [
  { id: 'setup', label: 'Setup', title: 'Open the race', hint: 'Open a video and describe the race before tagging.', icon: <UploadCloud size={16} /> },
  { id: 'tag', label: 'Tag', title: 'Tag the race', hint: 'Mark each landmark frame by frame with the keyboard.', icon: <Tags size={16} /> },
  { id: 'review', label: 'Review', title: 'Read the result', hint: 'Check the splits, tempo and velocity, and compare against a saved session.', icon: <BarChart3 size={16} /> },
];

function lengthCountForConfig(config: RaceConfig): number {
  const raw = raceLengthCount(config);
  return Number.isInteger(raw) ? Math.round(raw) : config.strokePerLength.length;
}

/** SCY races need an explicit 15 m reference confirmation before the "A" key is legal. */
function computeFifteenMetreGateReason(config: RaceConfig): string | undefined {
  const needsConfirmation = config.course === 'SCY' && !config.fifteenMetreReferenceConfirmed;
  return needsConfirmation ? '15 m reference not confirmed for SCY' : undefined;
}

/** The step to show: locked to "setup" until a confirmed race is loaded. */
function resolveActiveStep(raceSetupComplete: boolean, step: MetricsStepId): MetricsStepId {
  return raceSetupComplete ? step : 'setup';
}

interface SessionRecordInput {
  sessionId: string | null;
  sessionCreatedAt: number | null;
  swimmerName: string;
  videoFileName: string | undefined;
  videoMeta: VideoMeta;
  raceConfig: RaceConfig;
  tags: RaceTag[];
}

/** Assembles the persisted session record from current editor state. */
function buildSessionRecord({
  sessionId,
  sessionCreatedAt,
  swimmerName,
  videoFileName,
  videoMeta,
  raceConfig,
  tags,
}: SessionRecordInput): SessionRecord {
  const now = Date.now();
  const id = sessionId ?? `metrics_${now}_${Math.random().toString(36).slice(2, 7)}`;
  return {
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
}

/** Does `event` name match the race's primary stroke and distance? */
function eventMatchesRace(event: string, strokeSearch: string, distanceStr: string): boolean {
  return event.toLowerCase().includes(strokeSearch) && event.includes(distanceStr);
}

/** Athlete-history times for `target` whose event matches the race. */
function findHistoryComparisonTimes(
  history: Workspace['athleteHistory'],
  target: string,
  strokeSearch: string,
  distanceStr: string,
): string[] {
  const matches: string[] = [];
  for (const h of history ?? []) {
    if (h.name.trim().toLowerCase() === target && eventMatchesRace(h.event, strokeSearch, distanceStr)) {
      matches.push(h.time);
    }
  }
  return matches;
}

/** Meet-result times for `target` whose event matches the race. */
function findResultComparisonTimes(
  results: readonly { name: string; event: string; time?: unknown }[],
  target: string,
  strokeSearch: string,
  distanceStr: string,
): string[] {
  const matches: string[] = [];
  for (const r of results) {
    if (r.name.trim().toLowerCase() === target && eventMatchesRace(r.event, strokeSearch, distanceStr) && typeof r.time === 'string') {
      matches.push(r.time as string);
    }
  }
  return matches;
}

/**
 * Best known time for the current swimmer/race from the active workspace:
 * checks athlete history first, then meet results, and returns the first
 * match found (or null if the workspace or swimmer name is unset).
 */
function computeComparisonTime(
  activeWorkspace: Workspace | undefined,
  swimmerName: string,
  raceConfig: RaceConfig,
): string | null {
  if (!activeWorkspace || !swimmerName) return null;
  const target = swimmerName.trim().toLowerCase();
  const primaryStroke = raceConfig.strokePerLength[0];
  const strokeSearch = primaryStroke === undefined ? '' : STROKE_LABEL[primaryStroke].toLowerCase().slice(0, 4);
  const distanceStr = String(raceConfig.raceDistance);
  const historyMatches = findHistoryComparisonTimes(activeWorkspace.athleteHistory, target, strokeSearch, distanceStr);
  if (historyMatches.length > 0) return historyMatches[0];
  const resultMatches = findResultComparisonTimes(
    [...(activeWorkspace.menResults ?? []), ...(activeWorkspace.womenResults ?? [])],
    target,
    strokeSearch,
    distanceStr,
  );
  return resultMatches.length > 0 ? resultMatches[0] : null;
}

export default function MetricsApp() {
  const { rosterNames, activeWorkspace } = useSuiteWorkspace();
  const toast = useToast();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);
  const [step, setStep] = useState<MetricsStepId>('setup');

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

  const raceSetupComplete = videoUrl !== null && setupConfirmed;
  const activeStep: MetricsStepId = resolveActiveStep(raceSetupComplete, step);
  const metricsSteps = useMemo(
    () => METRICS_STEPS.map((wizardStep) => (
      wizardStep.id === 'setup' ? wizardStep : { ...wizardStep, disabled: !raceSetupComplete }
    )),
    [raceSetupComplete],
  );

  useEffect(() => {
    if (!raceSetupComplete) {
      setStep('setup');
      return;
    }
    setStep((currentStep) => currentStep === 'setup' ? 'tag' : currentStep);
  }, [raceSetupComplete]);

  const handleStepChange = useCallback((nextStep: MetricsStepId) => {
    if (nextStep === 'setup' || raceSetupComplete) setStep(nextStep);
  }, [raceSetupComplete]);

  const comparisonTime = useMemo(
    () => computeComparisonTime(activeWorkspace, swimmerName, raceConfig),
    [activeWorkspace, swimmerName, raceConfig.raceDistance, raceConfig.strokePerLength],
  );

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

  const measuredFps = videoMeta?.fps;
  const effectiveFps = fpsOverride ?? measuredFps ?? null;
  const frameSeconds = effectiveFps !== null ? 1 / effectiveFps : null;

  const lengthCount = lengthCountForConfig(raceConfig);
  const machine = useMemo(() => createTagStateMachine(raceConfig, tags), [raceConfig, tags]);
  const result = useMemo(() => analyzeRace(raceConfig, tags), [raceConfig, tags]);
  const fifteenMetreGateReason = computeFifteenMetreGateReason(raceConfig);

  const { handleSequentialKey, handleOneShotKey, handleUndo, handleTagDragCommit } = useTagKeyboardHandlers({
    setupConfirmed,
    fifteenMetreGateReason,
    machine,
    lengthCount,
    toast,
    setTags,
  });

  const handleSaveSession = useCallback(async () => {
    if (!isIndexedDbAvailable()) {
      toast.push('error', 'Session storage is unavailable in this browser.');
      return;
    }
    if (!videoMeta) {
      toast.push('error', 'Open a video before saving a session.');
      return;
    }
    const record = buildSessionRecord({
      sessionId,
      sessionCreatedAt,
      swimmerName,
      videoFileName,
      videoMeta,
      raceConfig,
      tags,
    });
    try {
      await saveSession(record);
      setSessionId(record.id);
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

  const canManageSession = Boolean(videoUrl && setupConfirmed);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] min-h-[480px] overflow-hidden rounded-lg border border-theme surface-card">
      <MetricsHeader
        sessionCount={sessions.length}
        showSessions={showSessions}
        onToggleSessions={() => setShowSessions((s) => !s)}
        canSave={canManageSession}
        onSaveSession={() => void handleSaveSession()}
        canExport={setupConfirmed}
        onExportReport={handleExportReport}
        canReconfigure={canManageSession}
        onReconfigure={() => setSetupConfirmed(false)}
        onFileChange={handleFileChange}
      />

      {showSessions ? (
        <SessionsPanel
          sessions={sessions}
          onClose={() => setShowSessions(false)}
          onLoad={(id) => void handleLoadSession(id)}
          onDelete={(id) => void handleDeleteSession(id)}
        />
      ) : null}

      <main className="flex-1 flex overflow-hidden flex-col lg:flex-row min-h-0">
        <VideoStage
          videoUrl={videoUrl}
          setupConfirmed={setupConfirmed}
          tags={tags}
          measuredFps={measuredFps}
          fpsOverride={fpsOverride}
          onFpsOverrideChange={setFpsOverride}
          onSequentialKey={handleSequentialKey}
          onOneShotKey={handleOneShotKey}
          onUndo={handleUndo}
          onTagDragCommit={handleTagDragCommit}
          machine={machine}
          lengthCount={lengthCount}
          fifteenMetreGateReason={fifteenMetreGateReason}
          isDragOverVideo={isDragOverVideo}
          onDragEnter={handleVideoDragEnter}
          onDragOver={handleVideoDragOver}
          onDragLeave={handleVideoDragLeave}
          onDrop={handleVideoDrop}
        />

        <div className="flex-1 lg:flex-[1.2] xl:max-w-md p-4 sm:p-6 flex flex-col gap-4 overflow-y-auto custom-scrollbar bg-[var(--surface)]">
          <WizardShell
            steps={metricsSteps}
            eyebrow="Race workflow"
            ariaLabel="Race steps"
            step={activeStep}
            onStepChange={handleStepChange}
          >
            <MetricsStepContent
              activeStep={activeStep}
              videoUrl={videoUrl}
              raceConfig={raceConfig}
              swimmerName={swimmerName}
              rosterNames={rosterNames}
              onSwimmerNameChange={setSwimmerName}
              onChangeConfig={setRaceConfig}
              onConfirmSetup={() => setSetupConfirmed(true)}
              comparisonTime={comparisonTime}
              videoMeta={videoMeta}
              tags={tags}
              frameSeconds={frameSeconds}
              onChangeTags={setTags}
              result={result}
              sessions={sessions}
              compareSessionId={compareSessionId}
              onSelectCompareSession={handleSelectCompareSession}
              compareData={compareData}
            />
          </WizardShell>
        </div>
      </main>
    </div>
  );
}
