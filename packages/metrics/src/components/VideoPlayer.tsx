import React, { useRef, useState, useEffect } from 'react';
import { tagsOfKind } from '@omniswim/core/lib/raceAnalysis';
import type { OperatorKey, RaceTag } from '../types';
import {
  VideoPlayerEmptyState,
  VideoTelemetryOverlay,
  VideoScrubber,
  VideoTransportControls,
} from './VideoPlayerParts';

/** KeyboardEvent.code -> sequential operator key, for the tagging shortcuts. */
const SEQUENTIAL_KEY_CODES: Partial<Record<string, OperatorKey>> = { KeyS: 'S', KeyD: 'D', KeyA: 'A' };

/** KeyboardEvent.code -> one-shot tag kind, for the tagging shortcuts. */
const ONE_SHOT_KEY_CODES: Partial<Record<string, 'Signal' | 'Flags' | 'Kick'>> = {
  KeyR: 'Signal',
  KeyG: 'Flags',
  KeyK: 'Kick',
};

/** True while the user is typing into a text field (shortcuts should not fire). */
function isTypingTarget(el: Element | null): boolean {
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA';
}

/** True for the Ctrl/Cmd+Z undo chord. */
function isUndoShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.code === 'KeyZ';
}

interface VideoPlayerProps {
  videoUrl: string | null;
  tags: readonly RaceTag[];
  measuredFps?: number;
  fpsOverride: number | null;
  onFpsOverrideChange: (fps: number | null) => void;
  onSequentialKey: (key: OperatorKey, time: number) => void;
  onOneShotKey: (kind: 'Signal' | 'Flags' | 'Kick', time: number) => void;
  onUndo: () => void;
  onTagDragCommit: (index: number, nextTime: number) => void;
}

function calculateLiveSPM(tags: readonly RaceTag[]): number {
  const strokes = tagsOfKind(tags, 'Stroke');
  if (strokes.length < 2) return 0;
  const last = strokes[strokes.length - 1].time;
  const prev = strokes[strokes.length - 2].time;
  const diff = last - prev;
  if (diff <= 0) return 0;
  return 60 / diff;
}

export function VideoPlayer({
  videoUrl,
  tags,
  measuredFps,
  fpsOverride,
  onFpsOverrideChange,
  onSequentialKey,
  onOneShotKey,
  onUndo,
  onTagDragCommit,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const effectiveFps = fpsOverride ?? measuredFps ?? null;
  const frameSeconds = effectiveFps !== null ? 1 / effectiveFps : null;

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted, videoUrl]);

  const toggleMute = () => setIsMuted(!isMuted);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) setIsMuted(false);
    else if (newVolume === 0 && !isMuted) setIsMuted(true);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const stepFrame = (frames: number) => {
    if (!videoRef.current || effectiveFps === null) return;
    videoRef.current.pause();
    setIsPlaying(false);
    const newTime = Math.max(0, Math.min(videoRef.current.duration, videoRef.current.currentTime + frames / effectiveFps));
    videoRef.current.currentTime = newTime;
  };

  const seekTo = (time: number) => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    setIsPlaying(false);
    videoRef.current.currentTime = time;
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
    setProgress((videoRef.current.currentTime / videoRef.current.duration) * 100);
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) setDuration(videoRef.current.duration);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const newTime = (parseFloat(e.target.value) / 100) * duration;
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
    setProgress(parseFloat(e.target.value));
  };

  const changePlaybackRate = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const rate = parseFloat(e.target.value);
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) {
        if (e.code === 'Enter') (document.activeElement as HTMLElement).blur();
        return;
      }

      if (!videoRef.current) return;
      const time = videoRef.current.currentTime;

      if (isUndoShortcut(e)) {
        e.preventDefault();
        onUndo();
        return;
      }

      const sequentialKey = SEQUENTIAL_KEY_CODES[e.code];
      if (sequentialKey !== undefined) {
        e.preventDefault();
        onSequentialKey(sequentialKey, time);
        return;
      }

      const oneShotKind = ONE_SHOT_KEY_CODES[e.code];
      if (oneShotKind !== undefined) {
        e.preventDefault();
        onOneShotKey(oneShotKind, time);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSequentialKey, onOneShotKey, onUndo]);

  const liveSpm = calculateLiveSPM(tags);

  return (
    <div className="relative group w-full h-full flex items-center justify-center bg-transparent">
      {!videoUrl ? (
        <VideoPlayerEmptyState />
      ) : (
        <>
          <video
            ref={videoRef}
            src={videoUrl}
            className="w-full h-full object-contain"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onClick={togglePlay}
          />

          <VideoTelemetryOverlay liveSpm={liveSpm} measuredFps={measuredFps} />

          <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-slate-900/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity z-20">
            <div className="flex flex-col gap-2">
              <VideoScrubber
                progress={progress}
                onSeek={handleSeek}
                tags={tags}
                duration={duration}
                frameSeconds={frameSeconds}
                onTagSeek={seekTo}
                onTagDragCommit={onTagDragCommit}
              />

              <VideoTransportControls
                effectiveFps={effectiveFps}
                onStepFrame={stepFrame}
                isPlaying={isPlaying}
                onTogglePlay={togglePlay}
                currentTime={currentTime}
                duration={duration}
                fpsOverride={fpsOverride}
                measuredFps={measuredFps}
                onFpsOverrideChange={onFpsOverrideChange}
                playbackRate={playbackRate}
                onPlaybackRateChange={changePlaybackRate}
                isMuted={isMuted}
                volume={volume}
                onToggleMute={toggleMute}
                onVolumeChange={handleVolumeChange}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
