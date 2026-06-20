import React, { useRef, useState, useEffect } from 'react';
import { formatTime } from '../lib/utils';
import { BiomechanicsData } from '../types';
import { Play, Pause, Maximize, SkipBack, SkipForward, FastForward, Flag, Volume2, VolumeX } from 'lucide-react';

export type TrackingEvent = { type: 'dive' | 'breakout' | 'kick' | 'turn' | '15m' | 'stroke' | 'finish', time: number };

interface VideoPlayerProps {
  videoUrl: string | null;
  data: BiomechanicsData | null;
  goalTime?: number;
  worldRecordTime?: number;
  onMarkStart?: (time: number) => void;
  onMarkEnd?: (time: number) => void;
  startTime?: number | null;
  endTime?: number | null;
  onTrackingUpdate?: (events: TrackingEvent[]) => void;
}

export function VideoPlayer({ 
  videoUrl, 
  data, 
  goalTime = 120, 
  worldRecordTime = 110,
  onMarkStart,
  onMarkEnd,
  startTime,
  endTime,
  onTrackingUpdate
}: VideoPlayerProps & { selectedLane?: number | null, onSelectLane?: (id: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [fps, setFps] = useState(30);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted, videoUrl]);

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) {
      setIsMuted(false);
    } else if (newVolume === 0 && !isMuted) {
      setIsMuted(true);
    }
  };

  // moved below

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
    if (!videoRef.current) return;
    videoRef.current.pause();
    setIsPlaying(false);
    const newTime = Math.max(0, Math.min(videoRef.current.duration, videoRef.current.currentTime + (frames / fps)));
    videoRef.current.currentTime = newTime;
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
    setProgress((videoRef.current.currentTime / videoRef.current.duration) * 100);
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
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
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done'>('done');
  const [detectedLanes, setDetectedLanes] = useState<{id: number, x: number, y: number, w: number, h: number}[]>([]);

  const runBodyDetect = () => {
    // Legacy stub
  };

  const selectLane = (id: number) => {
    // Legacy stub
  };

  const [trackingEvents, setTrackingEvents] = useState<TrackingEvent[]>([]);
  const [trackingActive, setTrackingActive] = useState(true);

  useEffect(() => {
    if (onTrackingUpdate) {
      onTrackingUpdate(trackingEvents);
    }
  }, [trackingEvents, onTrackingUpdate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // If user typing in a different input, ignore (unless they pressed space in our specific input context to do something, but let's just ignore all inputs for video hotkeys)
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
          // exception: if they press enter in kick count, we remove focus
          if (e.code === 'Enter') {
             (document.activeElement as HTMLElement).blur();
          }
          return;
      }

      if (!trackingActive) return;

      const time = videoRef.current?.currentTime || 0;

      switch(e.code) {
        case 'KeyD':
          e.preventDefault();
          setTrackingEvents(prev => [...prev, { type: 'dive', time }]);
          if (onMarkStart) onMarkStart(time);
          break;
        case 'KeyB':
          e.preventDefault();
          setTrackingEvents(prev => [...prev, { type: 'breakout', time }]);
          break;
        case 'KeyK':
          e.preventDefault();
          setTrackingEvents(prev => [...prev, { type: 'kick', time }]);
          break;
        case 'KeyT':
          e.preventDefault();
          setTrackingEvents(prev => [...prev, { type: 'turn', time }]);
          break;
        case 'KeyF':
          e.preventDefault();
          setTrackingEvents(prev => [...prev, { type: '15m', time }]);
          break;
        case 'KeyS':
          e.preventDefault();
          setTrackingEvents(prev => [...prev, { type: 'stroke', time }]);
          break;
        case 'KeyX':
          e.preventDefault();
          setTrackingEvents(prev => [...prev, { type: 'finish', time }]);
          if (onMarkEnd) onMarkEnd(time);
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [trackingActive, onMarkEnd]);

  const calculateLiveSPM = () => {
    const strokes = trackingEvents.filter(e => e.type === 'stroke').sort((a,b) => a.time - b.time);
    if (strokes.length < 2) return 0;
    const last = strokes[strokes.length - 1].time;
    const prev = strokes[strokes.length - 2].time;
    const diff = last - prev;
    if (diff <= 0) return 0;
    return 60 / diff;
  };

  const interpolatedPace = data ? data.avgVelocity + Math.sin(currentTime * 2) * 0.1 : 0;
  const interpolatedSR = data ? data.strokeRate + Math.cos(currentTime * 1.5) * 2 : 0;

  return (
    <div className="relative group w-full h-full flex items-center justify-center bg-transparent">
      {!videoUrl ? (
        <div className="text-center p-8 bg-[var(--surface)] border border-theme-soft rounded-xl max-w-sm">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--surface-muted)] mb-4 text-[var(--text-accent)] border border-theme-soft">
            <Play className="w-8 h-8 ml-1" />
          </div>
          <h3 className="text-lg font-medium text-[var(--text-primary)]">Upload a video</h3>
          <p className="text-ui-caption text-theme-muted mt-2">
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

          {!data && (
             <div className="absolute top-4 right-4 z-30 bg-black/80 backdrop-blur-md border border-[var(--text-accent)]/50 p-4 rounded-xl shadow-2xl min-w-[200px]">
               <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/10">
                 <div className="flex items-center gap-2 cursor-pointer" onClick={() => setTrackingActive(!trackingActive)}>
                   <div className={`w-2 h-2 rounded-full ${trackingActive ? 'bg-red-500 animate-pulse' : 'bg-slate-500'}`} />
                   <span className="text-white font-mono text-xs font-bold tracking-widest uppercase">Manual Tracking</span>
                 </div>
                 <button 
                   onClick={() => setTrackingEvents([])} 
                   className="text-[9px] uppercase tracking-widest text-slate-400 hover:text-white transition-colors"
                 >
                   Reset
                 </button>
               </div>
               
               <div className="space-y-2 text-[10px] font-mono text-slate-300">
                 <div className="flex justify-between items-center group">
                   <span className="opacity-60 group-hover:opacity-100 flex items-center gap-2">
                     <span className="bg-white/10 px-1 py-0.5 rounded border border-white/20 font-bold min-w-[20px] text-center">D</span> Dive Entry
                   </span>
                   <span className="text-[var(--text-accent)] font-bold">{trackingEvents.filter(e => e.type === 'dive').length}</span>
                 </div>
                 <div className="flex justify-between items-center group">
                   <span className="opacity-60 group-hover:opacity-100 flex items-center gap-2">
                     <span className="bg-white/10 px-1 py-0.5 rounded border border-white/20 font-bold min-w-[20px] text-center">B</span> Breakout
                   </span>
                   <span className="text-[var(--text-accent)] font-bold">{trackingEvents.filter(e => e.type === 'breakout').length}</span>
                 </div>
                 <div className="flex justify-between items-center group">
                   <span className="opacity-60 group-hover:opacity-100 flex items-center gap-2">
                     <span className="bg-white/10 px-1 py-0.5 rounded border border-white/20 font-bold min-w-[20px] text-center">K</span> UW Kick
                   </span>
                   <span className="text-[var(--text-accent)] font-bold">{trackingEvents.filter(e => e.type === 'kick').length}</span>
                 </div>
                 <div className="flex justify-between items-center group">
                   <span className="opacity-60 group-hover:opacity-100 flex items-center gap-2">
                     <span className="bg-white/10 px-1 py-0.5 rounded border border-white/20 font-bold min-w-[20px] text-center">S</span> Stroke
                   </span>
                   <span className="text-[var(--text-accent)] font-bold">{trackingEvents.filter(e => e.type === 'stroke').length}</span>
                 </div>
                 <div className="flex justify-between items-center group">
                   <span className="opacity-60 group-hover:opacity-100 flex items-center gap-2">
                     <span className="bg-white/10 px-1 py-0.5 rounded border border-white/20 font-bold min-w-[20px] text-center">F</span> 15m Mark
                   </span>
                   <span className="text-[var(--text-accent)] font-bold">{trackingEvents.filter(e => e.type === '15m').length}</span>
                 </div>
                 <div className="flex justify-between items-center group">
                   <span className="opacity-60 group-hover:opacity-100 flex items-center gap-2">
                     <span className="bg-white/10 px-1 py-0.5 rounded border border-white/20 font-bold min-w-[20px] text-center">T</span> Turn
                   </span>
                   <span className="text-[var(--text-accent)] font-bold">{trackingEvents.filter(e => e.type === 'turn').length}</span>
                 </div>
                 <div className="flex justify-between items-center group">
                   <span className="opacity-60 group-hover:opacity-100 flex items-center gap-2">
                     <span className="bg-white/10 px-1 py-0.5 rounded border border-white/20 font-bold min-w-[20px] text-center">X</span> Finish
                   </span>
                   <span className="text-[var(--text-accent)] font-bold">{trackingEvents.filter(e => e.type === 'finish').length}</span>
                 </div>
               </div>

               {trackingEvents.length > 0 && (
                 <div className="mt-4 pt-3 border-t border-white/10 flex justify-between items-end">
                   <div>
                     <div className="text-[9px] text-emerald-400 uppercase tracking-widest font-bold mb-1">Live SPM</div>
                     <div className="text-xl font-bold text-white leading-none">
                       {calculateLiveSPM().toFixed(1)} <span className="text-[10px] text-white/50">s/m</span>
                     </div>
                   </div>
                   
                   <div className="text-right">
                     <div className="text-[9px] text-[var(--text-accent)] uppercase tracking-widest font-bold mb-1">Latest Tag</div>
                     <div className="text-sm font-mono text-white/90">
                       {formatTime(trackingEvents[trackingEvents.length - 1].time)}
                     </div>
                   </div>
                 </div>
               )}
             </div>
          )}

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
                <div className="w-full h-1.5 bg-white/30 rounded-full overflow-hidden backdrop-blur-sm border border-black/20">
                  <div
                    className="h-full rounded-full transition-all duration-100 ease-linear"
                    style={{
                      width: `${progress}%`,
                      backgroundColor: 'var(--text-accent)',
                      boxShadow: '0 0 8px color-mix(in srgb, var(--text-accent) 60%, transparent)',
                    }}
                  />
                </div>
                {startTime !== null && startTime !== undefined && duration > 0 && (
                   <div 
                     className="absolute w-0.5 h-3 bg-emerald-400 z-0 pointer-events-none shadow-[0_0_5px_rgba(52,211,153,0.8)]" 
                     style={{ left: `${(startTime / duration) * 100}%` }}
                     title="Race Start"
                   />
                )}
                {endTime !== null && endTime !== undefined && duration > 0 && (
                   <div 
                     className="absolute w-0.5 h-3 bg-red-500 z-0 pointer-events-none shadow-[0_0_5px_rgba(239,68,68,0.8)]" 
                     style={{ left: `${(endTime / duration) * 100}%` }}
                     title="Race End"
                   />
                )}
                
                {trackingEvents.map((event, i) => (
                  <div
                    key={i}
                    className={`absolute w-0.5 h-3 z-0 pointer-events-none ${
                        event.type === 'dive' ? 'bg-cyan-400 shadow-[0_0_5px_rgba(34,211,238,0.8)]' :
                        event.type === 'breakout' ? 'bg-orange-400 shadow-[0_0_5px_rgba(251,146,60,0.8)]' :
                        event.type === 'kick' ? 'bg-blue-400 shadow-[0_0_5px_rgba(96,165,250,0.8)]' :
                        event.type === 'stroke' ? 'bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.8)]' :
                        event.type === '15m' ? 'bg-pink-400 shadow-[0_0_5px_rgba(244,114,182,0.8)]' :
                        event.type === 'turn' ? 'bg-purple-400 shadow-[0_0_5px_rgba(192,132,252,0.8)]' :
                        'bg-red-400 shadow-[0_0_5px_rgba(248,113,113,0.8)]'
                    }`}
                    style={{ left: `${(event.time / duration) * 100}%` }}
                    title={event.type.toUpperCase()}
                  />
                ))}
              </div>
              
              <div className="flex items-center justify-between text-white flex-wrap gap-y-2 mt-1">
                <div className="flex items-center gap-3">
                  <button onClick={() => stepFrame(-1)} className="hover:text-[var(--text-accent)] transition-colors focus:outline-none" title="Previous Frame">
                    <SkipBack className="w-4 h-4 fill-current opacity-80 hover:opacity-100" />
                  </button>
                  <button onClick={togglePlay} className="hover:text-[var(--text-accent)] transition-colors focus:outline-none bg-[var(--text-accent)]/20 p-1.5 rounded-full backdrop-blur-sm border border-[var(--text-accent)]/30 text-white">
                    {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
                  </button>
                  <button onClick={() => stepFrame(1)} className="hover:text-[var(--text-accent)] transition-colors focus:outline-none" title="Next Frame">
                    <SkipForward className="w-4 h-4 fill-current opacity-80 hover:opacity-100" />
                  </button>
                  
                  <div className="text-xs font-mono font-medium tracking-wide opacity-90 drop-shadow-md ml-2 border-l border-white/20 pl-4 py-0.5 flex items-center gap-4">
                    <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
                    <span className="text-[var(--text-accent)] opacity-80">FR: {Math.floor(currentTime * fps)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs font-mono">
                  <div className="bg-black/40 backdrop-blur-sm rounded border border-white/10 px-2 flex items-center h-8">
                     <span className="text-[10px] text-white/60 mr-2 uppercase">FPS:</span>
                     <select 
                        value={fps}
                        onChange={(e) => setFps(parseInt(e.target.value))}
                        className="bg-transparent text-white focus:outline-none cursor-pointer appearance-none pr-3"
                     >
                       <option value={24} className="bg-slate-900 text-white">24</option>
                       <option value={30} className="bg-slate-900 text-white">30</option>
                       <option value={50} className="bg-slate-900 text-white">50</option>
                       <option value={60} className="bg-slate-900 text-white">60</option>
                       <option value={120} className="bg-slate-900 text-white">120</option>
                     </select>
                  </div>
                  <div className="bg-black/40 backdrop-blur-sm rounded border border-white/10 px-2 flex items-center h-8">
                     <span className="text-[10px] text-white/60 mr-2 uppercase">Speed:</span>
                     <select 
                        value={playbackRate}
                        onChange={changePlaybackRate}
                        className="bg-transparent text-white focus:outline-none cursor-pointer appearance-none pr-3"
                     >
                       <option value={0.1} className="bg-slate-900 text-white">0.1x</option>
                       <option value={0.25} className="bg-slate-900 text-white">0.25x</option>
                       <option value={0.5} className="bg-slate-900 text-white">0.5x</option>
                       <option value={1} className="bg-slate-900 text-white">1.0x</option>
                       <option value={1.5} className="bg-slate-900 text-white">1.5x</option>
                       <option value={2} className="bg-slate-900 text-white">2.0x</option>
                     </select>
                  </div>

                  <div className="hidden sm:flex border-l border-white/20 pl-4 ml-2 gap-2 h-8 items-center">
                    <button 
                      onClick={() => onMarkStart?.(currentTime)}
                      className="px-2 py-1 text-[10px] uppercase font-bold bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 border border-emerald-500/30 rounded transition-colors"
                      title="Set race start exactly at current time"
                    >
                      <Flag className="w-3 h-3 inline mr-1" /> Mark Start
                    </button>
                    <button 
                      onClick={() => onMarkEnd?.(currentTime)}
                      className="px-2 py-1 text-[10px] uppercase font-bold bg-red-500/20 hover:bg-red-500/40 text-red-300 border border-red-500/30 rounded transition-colors"
                      title="Set race end exactly at current time"
                    >
                      <Flag className="w-3 h-3 inline mr-1" /> Mark End
                    </button>
                  </div>
                  
                  <div className="hidden md:flex items-center gap-2 border-l border-white/20 pl-4 ml-2 h-8 group">
                    <button onClick={toggleMute} className="hover:text-[var(--text-accent)] transition-colors focus:outline-none">
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

                  <button className="hover:text-[var(--text-accent)] transition-colors ml-2 border-l border-white/20 pl-4">
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
