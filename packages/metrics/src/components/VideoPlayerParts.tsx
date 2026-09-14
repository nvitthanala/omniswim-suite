/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Presentational pieces of `VideoPlayer.tsx`'s render tree, pulled out so the
 * ~260-line JSX body isn't one inline block (`plans/2026-09-10/05-METRICS-DIAGNOSIS.md`
 * §3/§5 item 1). Pure extraction: every className, attribute and conditional
 * below is unchanged from where it used to sit inline in `VideoPlayer.tsx` —
 * no visual or behavioral change. All state, refs and event handlers stay in
 * `VideoPlayer` itself; each component here only receives plain values and
 * callbacks, so there is no local state to fall out of sync with the parent.
 */
import type { ChangeEvent } from 'react';
import { Play, Pause, Maximize, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { formatTime } from '../lib/utils';
import type { RaceTag } from '../types';
import { TagTimeline } from './TagTimeline';

export const ASSUMED_FPS_OPTIONS = [24, 25, 30, 50, 59.94, 60, 120];

export function VideoPlayerEmptyState() {
  return (
    <div className="text-center p-8 surface-card rounded-2xl max-w-sm shadow-[var(--ui-shadow-lg)] transition-colors">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--surface-muted)] mb-4 text-accent-500">
        <Play className="w-8 h-8 ml-1" />
      </div>
      <h3 className="text-lg font-medium text-[var(--text-primary)]">Upload a video</h3>
      <p className="text-ui-body text-theme-secondary mt-2">
        Select a raw video of a swimming performance. All analysis is performed entirely locally on your device.
      </p>
    </div>
  );
}

export function VideoTelemetryOverlay({
  liveSpm,
  measuredFps,
}: {
  liveSpm: number;
  measuredFps: number | undefined;
}) {
  return (
    <div className="absolute top-4 right-4 z-30 bg-black/80 backdrop-blur-md border border-accent-500/50 p-3 rounded-xl shadow-2xl min-w-[180px] text-ui-micro font-mono text-slate-300">
      <div className="flex justify-between items-center">
        <span className="opacity-60 uppercase tracking-widest">Live tempo</span>
        <span className="text-accent-400 font-bold">
          {liveSpm > 0 ? liveSpm.toFixed(1) : '—'} <span className="text-white/50">cycles/min</span>
        </span>
      </div>
      <div className="flex justify-between items-center mt-1.5 pt-1.5 border-t border-white/10">
        <span className="opacity-60 uppercase tracking-widest">Frame rate</span>
        <span className={measuredFps ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
          {measuredFps ? `${measuredFps} measured` : 'not measured'}
        </span>
      </div>
    </div>
  );
}

export function VideoScrubber({
  progress,
  onSeek,
  tags,
  duration,
  frameSeconds,
  onTagSeek,
  onTagDragCommit,
}: {
  progress: number;
  onSeek: (e: ChangeEvent<HTMLInputElement>) => void;
  tags: readonly RaceTag[];
  duration: number;
  frameSeconds: number | null;
  onTagSeek: (time: number) => void;
  onTagDragCommit: (index: number, nextTime: number) => void;
}) {
  return (
    <div className="relative w-full h-2 group/progress cursor-pointer flex items-center">
      <input
        type="range"
        min="0"
        max="100"
        value={progress}
        onChange={onSeek}
        aria-label="Video progress"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
      />
      <div className="w-full h-1.5 bg-white/30 dark:bg-slate-800 rounded-full overflow-hidden backdrop-blur-sm border border-black/20">
        <div
          className="h-full bg-accent-500 rounded-full transition-all duration-100 ease-linear shadow-[0_0_8px_var(--accent-500)]"
          style={{ width: `${progress}%` }}
        />
      </div>
      <TagTimeline
        tags={tags}
        duration={duration}
        frameSeconds={frameSeconds}
        onSeek={onTagSeek}
        onTagTimeChange={onTagDragCommit}
      />
    </div>
  );
}

export function VideoTransportControls({
  effectiveFps,
  onStepFrame,
  isPlaying,
  onTogglePlay,
  currentTime,
  duration,
  fpsOverride,
  measuredFps,
  onFpsOverrideChange,
  playbackRate,
  onPlaybackRateChange,
  isMuted,
  volume,
  onToggleMute,
  onVolumeChange,
}: {
  effectiveFps: number | null;
  onStepFrame: (frames: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  currentTime: number;
  duration: number;
  fpsOverride: number | null;
  measuredFps: number | undefined;
  onFpsOverrideChange: (fps: number | null) => void;
  playbackRate: number;
  onPlaybackRateChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  isMuted: boolean;
  volume: number;
  onToggleMute: () => void;
  onVolumeChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex items-center justify-between text-white flex-wrap gap-y-2 mt-1">
      <div className="flex items-center gap-3">
        <button
          onClick={() => onStepFrame(-1)}
          disabled={effectiveFps === null}
          className="hover:text-accent-400 transition-colors focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
          title="Previous Frame"
          aria-label="Previous frame"
        >
          <SkipBack className="w-4 h-4 fill-current opacity-80 hover:opacity-100" />
        </button>
        <button
          onClick={onTogglePlay}
          aria-label={isPlaying ? 'Pause video' : 'Play video'}
          className="hover:text-accent-400 transition-colors focus:outline-none bg-accent-500/20 p-1.5 rounded-full backdrop-blur-sm border border-accent-500/30 text-accent-100"
        >
          {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
        </button>
        <button
          onClick={() => onStepFrame(1)}
          disabled={effectiveFps === null}
          className="hover:text-accent-400 transition-colors focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
          title="Next Frame"
          aria-label="Next frame"
        >
          <SkipForward className="w-4 h-4 fill-current opacity-80 hover:opacity-100" />
        </button>

        <div className="text-xs font-mono font-medium tracking-wide opacity-90 drop-shadow-md ml-2 border-l border-white/20 pl-4 py-0.5 flex items-center gap-4">
          <span>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <span className="text-accent-300">
            FR: {effectiveFps !== null ? Math.floor(currentTime * effectiveFps) : '—'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs font-mono">
        <div className="bg-black/40 backdrop-blur-sm rounded border border-white/10 px-2 flex items-center h-8">
          <span className="text-ui-micro text-white/60 mr-2 uppercase">FPS:</span>
          <select
            value={fpsOverride ?? ''}
            onChange={(e) => onFpsOverrideChange(e.target.value ? parseFloat(e.target.value) : null)}
            aria-label="Frames per second"
            className="bg-transparent text-white focus:outline-none cursor-pointer appearance-none pr-3"
          >
            <option value="" className="bg-slate-900 text-white">
              {measuredFps ? `Measured (${measuredFps})` : 'Not measured — select'}
            </option>
            {ASSUMED_FPS_OPTIONS.map((f) => (
              <option key={f} value={f} className="bg-slate-900 text-white">
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="bg-black/40 backdrop-blur-sm rounded border border-white/10 px-2 flex items-center h-8">
          <span className="text-ui-micro text-white/60 mr-2 uppercase">Speed:</span>
          <select
            value={playbackRate}
            onChange={onPlaybackRateChange}
            aria-label="Playback speed"
            className="bg-transparent text-white focus:outline-none cursor-pointer appearance-none pr-3"
          >
            <option value={0.1} className="bg-slate-900 text-white">
              0.1x
            </option>
            <option value={0.25} className="bg-slate-900 text-white">
              0.25x
            </option>
            <option value={0.5} className="bg-slate-900 text-white">
              0.5x
            </option>
            <option value={1} className="bg-slate-900 text-white">
              1.0x
            </option>
            <option value={1.5} className="bg-slate-900 text-white">
              1.5x
            </option>
            <option value={2} className="bg-slate-900 text-white">
              2.0x
            </option>
          </select>
        </div>

        <div className="hidden md:flex items-center gap-2 border-l border-white/20 pl-4 ml-2 h-8 group">
          <button
            onClick={onToggleMute}
            aria-label={isMuted || volume === 0 ? 'Unmute video' : 'Mute video'}
            className="hover:text-accent-400 transition-colors focus:outline-none"
          >
            {isMuted || volume === 0 ? (
              <VolumeX className="w-4 h-4 drop-shadow-md" />
            ) : (
              <Volume2 className="w-4 h-4 drop-shadow-md" />
            )}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={isMuted ? 0 : volume}
            onChange={onVolumeChange}
            aria-label="Volume"
            className="w-0 opacity-0 group-hover:w-16 group-hover:opacity-100 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-white/40 transition-all duration-300 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full focus:outline-none"
          />
        </div>

        <button aria-label="Maximize video" className="hover:text-accent-400 transition-colors ml-2 border-l border-white/20 pl-4">
          <Maximize className="w-4 h-4 drop-shadow-md" />
        </button>
      </div>
    </div>
  );
}
