import React, { useRef, useState, useEffect } from 'react';
import { tagsOfKind } from '@omniswim/core/lib/raceAnalysis';
import { formatTime } from '../lib/utils';
import { Play, Pause, Maximize, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { OperatorKey, RaceTag } from '../types';
import { TagTimeline } from './TagTimeline';

const ASSUMED_FPS_OPTIONS = [24, 25, 30, 50, 59.94, 60, 120];

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
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        if (e.code === 'Enter') (document.activeElement as HTMLElement).blur();
        return;
      }

      if (!videoRef.current) return;
      const time = videoRef.current.currentTime;

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        onUndo();
        return;
      }

      switch (e.code) {
        case 'KeyS':
          e.preventDefault();
          onSequentialKey('S', time);
          break;
        case 'KeyD':
          e.preventDefault();
          onSequentialKey('D', time);
          break;
        case 'KeyA':
          e.preventDefault();
          onSequentialKey('A', time);
          break;
        case 'KeyR':
          e.preventDefault();
          onOneShotKey('Signal', time);
          break;
        case 'KeyG':
          e.preventDefault();
          onOneShotKey('Flags', time);
          break;
        case 'KeyK':
          e.preventDefault();
          onOneShotKey('Kick', time);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSequentialKey, onOneShotKey, onUndo]);

  const liveSpm = calculateLiveSPM(tags);

  return (
    <div className="relative group w-full h-full flex items-center justify-center bg-transparent">
      {!videoUrl ? (
        <div className="text-center p-8 surface-card rounded-2xl max-w-sm shadow-[var(--ui-shadow-lg)] transition-colors">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--surface-muted)] mb-4 text-accent-500">
            <Play className="w-8 h-8 ml-1" />
          </div>
          <h3 className="text-lg font-medium text-[var(--text-primary)]">Upload a video</h3>
          <p className="text-ui-body text-theme-secondary mt-2">
            Select a raw video of a swimming performance. All analysis is performed entirely locally on your device.
          </p>
        </div>
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

          <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-slate-900/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity z-20">
            <div className="flex flex-col gap-2">
              <div className="relative w-full h-2 group/progress cursor-pointer flex items-center">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={progress}
                  onChange={handleSeek}
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
                  onSeek={seekTo}
                  onTagTimeChange={onTagDragCommit}
                />
              </div>

              <div className="flex items-center justify-between text-white flex-wrap gap-y-2 mt-1">
                <div className="flex items-center gap-3">
                  <button onClick={() => stepFrame(-1)} disabled={effectiveFps === null} className="hover:text-accent-400 transition-colors focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed" title="Previous Frame">
                    <SkipBack className="w-4 h-4 fill-current opacity-80 hover:opacity-100" />
                  </button>
                  <button onClick={togglePlay} className="hover:text-accent-400 transition-colors focus:outline-none bg-accent-500/20 p-1.5 rounded-full backdrop-blur-sm border border-accent-500/30 text-accent-100">
                    {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
                  </button>
                  <button onClick={() => stepFrame(1)} disabled={effectiveFps === null} className="hover:text-accent-400 transition-colors focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed" title="Next Frame">
                    <SkipForward className="w-4 h-4 fill-current opacity-80 hover:opacity-100" />
                  </button>

                  <div className="text-xs font-mono font-medium tracking-wide opacity-90 drop-shadow-md ml-2 border-l border-white/20 pl-4 py-0.5 flex items-center gap-4">
                    <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
                    <span className="text-accent-300">FR: {effectiveFps !== null ? Math.floor(currentTime * effectiveFps) : '—'}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs font-mono">
                  <div className="bg-black/40 backdrop-blur-sm rounded border border-white/10 px-2 flex items-center h-8">
                    <span className="text-ui-micro text-white/60 mr-2 uppercase">FPS:</span>
                    <select
                      value={fpsOverride ?? ''}
                      onChange={(e) => onFpsOverrideChange(e.target.value ? parseFloat(e.target.value) : null)}
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
                    <select value={playbackRate} onChange={changePlaybackRate} className="bg-transparent text-white focus:outline-none cursor-pointer appearance-none pr-3">
                      <option value={0.1} className="bg-slate-900 text-white">0.1x</option>
                      <option value={0.25} className="bg-slate-900 text-white">0.25x</option>
                      <option value={0.5} className="bg-slate-900 text-white">0.5x</option>
                      <option value={1} className="bg-slate-900 text-white">1.0x</option>
                      <option value={1.5} className="bg-slate-900 text-white">1.5x</option>
                      <option value={2} className="bg-slate-900 text-white">2.0x</option>
                    </select>
                  </div>

                  <div className="hidden md:flex items-center gap-2 border-l border-white/20 pl-4 ml-2 h-8 group">
                    <button onClick={toggleMute} className="hover:text-accent-400 transition-colors focus:outline-none">
                      {isMuted || volume === 0 ? <VolumeX className="w-4 h-4 drop-shadow-md" /> : <Volume2 className="w-4 h-4 drop-shadow-md" />}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={isMuted ? 0 : volume}
                      onChange={handleVolumeChange}
                      className="w-0 opacity-0 group-hover:w-16 group-hover:opacity-100 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-white/40 transition-all duration-300 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full focus:outline-none"
                    />
                  </div>

                  <button className="hover:text-accent-400 transition-colors ml-2 border-l border-white/20 pl-4">
                    <Maximize className="w-4 h-4 drop-shadow-md" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
