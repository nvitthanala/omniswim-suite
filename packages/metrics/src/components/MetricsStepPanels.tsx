import React from 'react';
import { UploadCloud } from 'lucide-react';
import { EmptyState } from '@omniswim/ui';
import { RaceSetupForm } from './RaceSetupForm';
import { TagTable } from './TagTable';
import { MetricsDashboard } from './MetricsDashboard';
import { SessionComparePanel } from './SessionComparePanel';
import type { RaceAnalysisResult, RaceConfig, RaceTag } from '../types';
import type { VideoMeta } from '../lib/videoMeta';
import { formatMeta } from '../lib/videoMeta';
import type { SessionSummary } from '../lib/sessionStore';

interface SetupStepPanelProps {
  videoUrl: string | null;
  config: RaceConfig;
  swimmerName: string;
  rosterNames: string[];
  onSwimmerNameChange: (name: string) => void;
  onChange: (config: RaceConfig) => void;
  onConfirm: () => void;
}

/** The "Setup" wizard step: prompt to open a video, then the race setup form. */
export function SetupStepPanel({
  videoUrl,
  config,
  swimmerName,
  rosterNames,
  onSwimmerNameChange,
  onChange,
  onConfirm,
}: SetupStepPanelProps) {
  if (!videoUrl) {
    return (
      <EmptyState
        className="h-full min-h-[280px] border-dashed bg-[var(--surface-muted)]"
        icon={<UploadCloud size={28} />}
        eyebrow="Metrics"
        title="Upload a race video to begin"
        description="Open a local video, configure the race, then tag it frame by frame with the keyboard."
        actionLabel="Open Video"
        onAction={() => document.getElementById('metrics-file-input')?.click()}
      />
    );
  }
  return (
    <RaceSetupForm
      config={config}
      swimmerName={swimmerName}
      rosterNames={rosterNames}
      onSwimmerNameChange={onSwimmerNameChange}
      onChange={onChange}
      onConfirm={onConfirm}
    />
  );
}

interface TagStepPanelProps {
  raceConfig: RaceConfig;
  swimmerName: string;
  comparisonTime: string | null;
  videoMeta: VideoMeta | null;
  tags: RaceTag[];
  frameSeconds: number | null;
  onChangeTags: (tags: RaceTag[]) => void;
}

/** The "Tag" wizard step: race header info plus the editable tag table. */
export function TagStepPanel({
  raceConfig,
  swimmerName,
  comparisonTime,
  videoMeta,
  tags,
  frameSeconds,
  onChangeTags,
}: TagStepPanelProps) {
  return (
    <div className="flex flex-col gap-4">
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
      <TagTable config={raceConfig} tags={tags} frameSeconds={frameSeconds} onChange={onChangeTags} />
    </div>
  );
}

interface MetricsStepContentProps {
  activeStep: 'setup' | 'tag' | 'review';
  videoUrl: string | null;
  raceConfig: RaceConfig;
  swimmerName: string;
  rosterNames: string[];
  onSwimmerNameChange: (name: string) => void;
  onChangeConfig: (config: RaceConfig) => void;
  onConfirmSetup: () => void;
  comparisonTime: string | null;
  videoMeta: VideoMeta | null;
  tags: RaceTag[];
  frameSeconds: number | null;
  onChangeTags: (tags: RaceTag[]) => void;
  result: RaceAnalysisResult;
  sessions: SessionSummary[];
  compareSessionId: string;
  onSelectCompareSession: (id: string) => void;
  compareData: { label: string; config: RaceConfig; result: RaceAnalysisResult } | null;
}

/**
 * Picks which wizard step panel to render. Kept as its own component so the
 * setup/tag/review selection lives outside MetricsApp's render body.
 */
export function MetricsStepContent(props: MetricsStepContentProps) {
  if (props.activeStep === 'setup') {
    return (
      <SetupStepPanel
        videoUrl={props.videoUrl}
        config={props.raceConfig}
        swimmerName={props.swimmerName}
        rosterNames={props.rosterNames}
        onSwimmerNameChange={props.onSwimmerNameChange}
        onChange={props.onChangeConfig}
        onConfirm={props.onConfirmSetup}
      />
    );
  }
  if (props.activeStep === 'tag') {
    return (
      <TagStepPanel
        raceConfig={props.raceConfig}
        swimmerName={props.swimmerName}
        comparisonTime={props.comparisonTime}
        videoMeta={props.videoMeta}
        tags={props.tags}
        frameSeconds={props.frameSeconds}
        onChangeTags={props.onChangeTags}
      />
    );
  }
  return (
    <ReviewStepPanel
      result={props.result}
      sessions={props.sessions}
      compareSessionId={props.compareSessionId}
      onSelectCompareSession={props.onSelectCompareSession}
      compareData={props.compareData}
      swimmerName={props.swimmerName}
      raceConfig={props.raceConfig}
    />
  );
}

interface ReviewStepPanelProps {
  result: RaceAnalysisResult;
  sessions: SessionSummary[];
  compareSessionId: string;
  onSelectCompareSession: (id: string) => void;
  compareData: { label: string; config: RaceConfig; result: RaceAnalysisResult } | null;
  swimmerName: string;
  raceConfig: RaceConfig;
}

/** The "Review" wizard step: dashboard, compare-session picker, and comparison panel. */
export function ReviewStepPanel({
  result,
  sessions,
  compareSessionId,
  onSelectCompareSession,
  compareData,
  swimmerName,
  raceConfig,
}: ReviewStepPanelProps) {
  const comparableSessions = sessions.filter((s) => !s.legacy);
  return (
    <div className="flex flex-col gap-4">
      <MetricsDashboard data={result} />
      {comparableSessions.length > 0 ? (
        <section className="panel p-4 border border-theme-soft rounded-xl">
          <label htmlFor="metrics-compare-session" className="label-caps flex items-center gap-1.5 mb-1.5">Compare against saved session</label>
          <select
            id="metrics-compare-session"
            value={compareSessionId}
            onChange={(e) => onSelectCompareSession(e.target.value)}
            className="glass-input w-full"
          >
            <option value="">Select a session…</option>
            {comparableSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </section>
      ) : null}
      {compareData ? (
        <SessionComparePanel left={{ label: swimmerName || 'Current', config: raceConfig, result }} right={compareData} />
      ) : null}
    </div>
  );
}
