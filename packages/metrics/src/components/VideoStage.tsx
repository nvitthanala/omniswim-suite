import React from 'react';
import { UploadCloud } from 'lucide-react';
import { VideoPlayer } from './VideoPlayer';
import { TagDeck } from './TagDeck';
import type { OperatorKey, RaceTag } from '../types';
import type { RaceTagStateMachine } from '@omniswim/core/lib/raceAnalysis';

interface VideoStageProps {
  videoUrl: string | null;
  setupConfirmed: boolean;
  tags: RaceTag[];
  measuredFps: number | undefined;
  fpsOverride: number | null;
  onFpsOverrideChange: (fps: number | null) => void;
  onSequentialKey: (key: OperatorKey, time: number) => void;
  onOneShotKey: (kind: 'Signal' | 'Flags' | 'Kick', time: number) => void;
  onUndo: () => void;
  onTagDragCommit: (index: number, nextTime: number) => void;
  machine: RaceTagStateMachine;
  lengthCount: number;
  fifteenMetreGateReason: string | undefined;
  isDragOverVideo: boolean;
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}

/**
 * Left-hand video panel: the drag-and-drop drop zone, the video player and
 * keyboard tagging surface, the floating tag deck (once setup is confirmed),
 * and the "drop to open" overlay while a file is being dragged over it.
 */
export function VideoStage({
  videoUrl,
  setupConfirmed,
  tags,
  measuredFps,
  fpsOverride,
  onFpsOverrideChange,
  onSequentialKey,
  onOneShotKey,
  onUndo,
  onTagDragCommit,
  machine,
  lengthCount,
  fifteenMetreGateReason,
  isDragOverVideo,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: VideoStageProps) {
  return (
    <div
      className="flex-1 lg:flex-[1.8] relative bg-[var(--surface-muted)] flex flex-col items-center justify-center border-b lg:border-b-0 lg:border-r border-theme-soft overflow-hidden"
      role="region"
      aria-label="Video drop zone. Drag and drop a video file here, or use the Open Video button."
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <VideoPlayer
        videoUrl={videoUrl}
        tags={tags}
        measuredFps={measuredFps}
        fpsOverride={fpsOverride}
        onFpsOverrideChange={onFpsOverrideChange}
        onSequentialKey={onSequentialKey}
        onOneShotKey={onOneShotKey}
        onUndo={onUndo}
        onTagDragCommit={onTagDragCommit}
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
  );
}
