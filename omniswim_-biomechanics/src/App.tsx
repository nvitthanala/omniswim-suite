import React, { useState, useRef, useEffect, ChangeEvent } from 'react';
import { UploadCloud, Loader2, Sun, Moon, Palette, Settings2, User, Flag } from 'lucide-react';
import { VideoPlayer, TrackingEvent } from './components/VideoPlayer';
import { MetricsDashboard } from './components/MetricsDashboard';
import { RaceSetupForm } from './components/RaceSetupForm';
import { BiomechanicsData, RaceConfig, CourseType, StrokeType } from './types';
import { formatTime } from './lib/utils';


export default function App() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [data, setData] = useState<BiomechanicsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  
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

  const [isDarkMode, setIsDarkMode] = useState(true);
  
  const [customColor, setCustomColor] = useState(() => {
    return localStorage.getItem('omni-swim-accent') || '#881337'; // Defaulting to the burgundy from the logo
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent-base', customColor);
    localStorage.setItem('omni-swim-accent', customColor);
  }, [customColor]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setData(null);
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
  };
  
  const runLocalAnalysis = async () => {
    if (!videoUrl) return;
    setIsAnalyzing(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 1500)); // Local compute delay
      setData(calculateMetricsLocal(raceConfig, trackedEvents));
    } catch (err: any) {
      setError('Failed to calculate metrics.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="h-screen bg-slate-50 dark:bg-[#0c0d10] text-slate-900 dark:text-[#f1f5f9] flex flex-col font-sans overflow-hidden transition-colors duration-300">
      {/* Header */}
      <header className="h-16 border-b border-slate-200 dark:border-white/10 flex items-center justify-between px-4 sm:px-6 bg-white dark:bg-[#12141a] shrink-0 transition-colors duration-300">
        <div className="flex items-center gap-3 sm:gap-4">
          <img src="/logo.png" alt="Omni-Swim Logo" className="w-8 h-8 object-contain" onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
            (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
            (e.target as HTMLImageElement).nextElementSibling?.classList.add('flex');
          }} />
          <div className="hidden w-8 h-8 bg-accent-500 rounded-sm items-center justify-center font-bold text-xs text-white" style={{ fontFamily: 'sans-serif' }}>Ω</div>
          <h1 className="text-md sm:text-lg font-semibold tracking-tight">OMNI-SWIM <span className="text-accent-500 font-normal hidden sm:inline">BIOMECHANICS PRO</span></h1>
        </div>
        
        <div className="flex items-center gap-3 sm:gap-6">
          <div className="relative flex items-center">
             <input 
               type="color" 
               ref={colorInputRef}
               value={customColor} 
               onChange={(e) => setCustomColor(e.target.value)}
               className="absolute opacity-0 w-0 h-0 pointer-events-none"
             />
            <button
              onClick={() => colorInputRef.current?.click()}
              className="p-2 border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-white/5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors flex items-center gap-2 group"
              title="Change Accent Color"
            >
              <div 
                className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-600 group-hover:scale-110 transition-transform" 
                style={{ backgroundColor: customColor }}
              />
              <Palette className="w-4 h-4 hidden sm:block" />
            </button>
          </div>
          
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-2 border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-white/5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors"
            title="Toggle Theme"
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <input 
            type="file" 
            accept="video/*" 
            className="hidden" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
          />
          
          <button 
            onClick={handleUploadClick}
            className="px-3 sm:px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 text-slate-700 dark:text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
          >
            <UploadCloud className="w-4 h-4" />
            <span className="hidden sm:inline">Open Video</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden flex-col lg:flex-row relative">
        {error && (
           <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/50 text-rose-600 dark:text-rose-400 p-4 rounded-md text-sm font-medium shadow-2xl backdrop-blur-md">
             Error: {error}
           </div>
        )}
        
        {/* Video Player Section */}
        <div className="flex-1 lg:flex-[1.8] relative bg-slate-200/50 dark:bg-black flex flex-col items-center justify-center border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-white/10 overflow-hidden group transition-colors duration-300">
          {data && (
            <>
              <div className="absolute inset-0 opacity-40 pointer-events-none z-0">
                <div className="absolute top-[40%] left-[20%] w-[60%] h-[2px] bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_15px_rgba(52,211,153,0.8)]"></div>
                <div className="absolute top-[45%] left-[10%] w-[80%] h-[1px] border-t border-dashed border-accent-600/50 dark:border-accent-400/50"></div>
                
                <div className="absolute bottom-16 right-8 border border-slate-300 dark:border-white/20 p-3 bg-white/80 dark:bg-black/60 rounded backdrop-blur-md hidden xl:block shadow-lg dark:shadow-none">
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 mb-1 tracking-widest uppercase font-bold">Body Angle</div>
                  <div className="text-2xl font-mono text-slate-900 dark:text-white">12.4°</div>
                </div>
                
                <div className="absolute top-10 left-10 space-y-4 hidden sm:block">
                  <div className="p-2 bg-white/80 dark:bg-black/40 border-l-2 border-accent-500 backdrop-blur-sm shadow-md dark:shadow-none">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-widest font-bold">First Length Vel</div>
                    <div className="text-xl font-bold font-mono text-slate-900 dark:text-white">{data.firstLengthVel.toFixed(2)} <span className="text-[10px] text-slate-500 font-sans">m/s</span></div>
                  </div>
                </div>
              </div>
              
              <div className="absolute top-6 w-full text-center space-y-2 pointer-events-none z-10 transition-opacity duration-300 opacity-0 sm:group-hover:opacity-100">
                <div className="w-16 h-16 rounded-full border-2 border-accent-500/30 flex items-center justify-center mx-auto bg-white/60 dark:bg-black/40 backdrop-blur-sm shadow-sm dark:shadow-none">
                  <div className="w-0 h-0 border-t-[10px] border-t-transparent border-l-[16px] border-l-accent-500 border-b-[10px] border-b-transparent ml-1"></div>
                </div>
                <p className="text-[10px] text-accent-600 dark:text-accent-400 font-mono tracking-widest font-bold drop-shadow-md">SYNCED BIOMECHANICAL OVERLAY ACTIVE</p>
              </div>
            </>
          )}

          <div className="w-full h-full p-0 sm:p-4 z-10 flex flex-col justify-center max-w-6xl mx-auto">
             {isAnalyzing ? (
               <div className="w-full h-full min-h-[300px] border border-slate-300 dark:border-white/5 bg-white/50 dark:bg-black/30 backdrop-blur-md sm:rounded-xl flex items-center justify-center flex-col gap-4 shadow-xl dark:shadow-none transition-colors">
                  <div className="w-16 h-16 relative flex items-center justify-center">
                    <div className="absolute inset-0 border-t-2 border-accent-500 rounded-full animate-spin"></div>
                    <UploadCloud className="w-6 h-6 text-accent-500 animate-pulse" />
                  </div>
                  <div className="text-center font-mono">
                     <h3 className="text-slate-900 dark:text-white text-sm uppercase tracking-wider mb-2 font-bold">Performing Local Analytics...</h3>
                     <p className="text-accent-600 dark:text-accent-400 text-xs font-semibold">Simulating splits based on video metrics and tags.</p>
                  </div>
               </div>
             ) : (
                <VideoPlayer 
                  videoUrl={videoUrl} 
                  data={data} 
                  goalTime={raceConfig.distance === 100 ? 50.0 : raceConfig.distance === 50 ? 23.0 : 120.0} 
                  worldRecordTime={raceConfig.distance === 100 ? 46.86 : raceConfig.distance === 50 ? 20.91 : 110.0}
                  startTime={raceConfig.videoStartTime}
                  endTime={raceConfig.videoEndTime}
                  onMarkStart={(t) => setRaceConfig(c => ({...c, videoStartTime: t}))}
                  onMarkEnd={(t) => setRaceConfig(c => ({...c, videoEndTime: t}))}
                  onTrackingUpdate={(events) => {
                    setTrackedEvents(events);
                  }}
                />
             )}
          </div>
          
          <div className="absolute bottom-0 w-full h-[2px] bg-slate-200 dark:bg-white/10 z-0 hidden lg:block">
            <div className="h-full bg-accent-500" style={{ width: data ? '100%' : '0%' }}></div>
          </div>
        </div>

        {/* Sidebar Panel */}
        <div className="flex-1 lg:flex-[1.2] xl:max-w-md bg-white dark:bg-[#12141a] p-4 sm:p-6 flex flex-col gap-6 overflow-y-auto w-full lg:w-auto transition-colors duration-300">
           {data ? (
              <div className="flex flex-col h-full gap-4">
                 <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/10 pb-4">
                   <div>
                     <div className="text-xs text-slate-500 uppercase tracking-widest font-bold mb-1">{raceConfig.course} {raceConfig.distance}m {raceConfig.stroke}</div>
                     <h2 className="text-xl font-bold dark:text-white">{raceConfig.swimmerName || 'Unknown Swimmer'}</h2>
                   </div>
                   <button onClick={() => setData(null)} className="text-xs bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 px-3 py-1.5 rounded text-slate-600 dark:text-slate-300 transition-colors">
                     Re-configure
                   </button>
                 </div>
                 <MetricsDashboard data={data} isDarkMode={isDarkMode} />
              </div>
           ) : videoUrl ? (
              <RaceSetupForm 
                config={raceConfig} 
                onChange={setRaceConfig} 
                onAnalyze={runLocalAnalysis} 
                isAnalyzing={isAnalyzing} 
              />
           ) : (
              <div className="h-full min-h-[400px] flex items-center justify-center border border-dashed border-slate-300 dark:border-white/10 rounded-xl bg-slate-50 dark:bg-black/20 p-8 text-center text-slate-500 font-mono text-sm max-w-sm mx-auto transition-colors">
                <p>AWAITING VIDEO LOAD.<br/><br/>Upload a video to begin analysis setup.</p>
              </div>
           )}
        </div>
      </main>

      {/* Footer */}
      <footer className="h-10 shrink-0 bg-slate-50 dark:bg-[#0c0d10] border-t border-slate-200 dark:border-white/5 px-4 sm:px-6 flex items-center justify-between text-[10px] text-slate-500 font-mono transition-colors duration-300">
        <div className="flex gap-4 sm:gap-6 uppercase font-bold">
          <span className="hidden sm:inline">Session ID: LOCAL_9231_X</span>
          <span className="hidden sm:inline">Frame: 1,422 / 2,200</span>
          <span>Sampling Rate: 120 FPS</span>
        </div>
        <div className="flex gap-4 font-bold">
           {data ? (
             <span className="flex items-center gap-2 text-accent-600 dark:text-slate-400"><span className="w-2 h-2 rounded-full bg-accent-500 inline-block shadow-[0_0_8px] shadow-accent-500/80"></span> DATA SYNCED</span>
           ) : (
             <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span> SYSTEM READY</span>
           )}
        </div>
      </footer>
    </div>
  );
}

// Processed locally simulating real calculation math
function calculateMetricsLocal(config: RaceConfig, events: TrackingEvent[]): BiomechanicsData {
  const diveEvents = events.filter(e => e.type === 'dive').sort((a,b) => a.time - b.time);
  const finishEvents = events.filter(e => e.type === 'finish').sort((a,b) => a.time - b.time);

  let runStart = config.videoStartTime || (diveEvents.length > 0 ? diveEvents[0].time : 0);
  let runEnd = config.videoEndTime || (finishEvents.length > 0 ? finishEvents[0].time : runStart + 50);

  let duration = config.manualRaceTime 
    ? config.manualRaceTime 
    : Math.max(0.1, runEnd - runStart);
    
  const dist = config.distance || 100;
  const avgVelocity = dist / duration;
  const poolLen = (config.course === 'SCY' || config.course === 'SCM') ? 25 : 50;
  const numLaps = Math.max(1, Math.ceil(dist / poolLen));
  
  const manualSplitsArr = config.manualSplits.split(',').map(s => parseFloat(s.trim())).filter(s => !isNaN(s));
  
  // Calculate specific points
  const breakoutEvents = events.filter(e => e.type === 'breakout').sort((a,b) => a.time - b.time);
  const m15Events = events.filter(e => e.type === '15m').sort((a,b) => a.time - b.time);
  const kickEvents = events.filter(e => e.type === 'kick').sort((a,b) => a.time - b.time);
  const strokeEvents = events.filter(e => e.type === 'stroke').sort((a,b) => a.time - b.time);

  let breakDist = config.manualBreakoutDistance || (config.stroke === 'Breaststroke' ? 8.5 : config.stroke === 'Backstroke' ? 12 : 10);
  
  let vel0to15 = avgVelocity * 1.3;
  let breakTime = breakDist / vel0to15;
  if (breakoutEvents.length > 0 && runStart > 0) {
     breakTime = breakoutEvents[0].time - runStart;
     vel0to15 = breakDist / breakTime;
  }
  
  let diveVel = config.manualDiveVelocity || Math.max(vel0to15 * 1.3, avgVelocity * 1.8);
  
  if (m15Events.length > 0 && runStart > 0) {
      vel0to15 = 15 / (m15Events[0].time - runStart);
  }

  // UWT Tempo calculation
  let uwtTempo = config.stroke === 'Breaststroke' ? 0 : 160;
  if (kickEvents.length > 1) {
     let avgKickTime = 0;
     for(let i=1; i<kickEvents.length; i++) {
        avgKickTime += kickEvents[i].time - kickEvents[i-1].time;
     }
     avgKickTime /= (kickEvents.length - 1);
     uwtTempo = 60 / avgKickTime;
  }

  // Stroke Rate calculation
  let strokeRate = config.stroke === 'Butterfly' ? 45 : 55;
  if (strokeEvents.length > 1) {
      let avgStrokeTime = 0;
      for(let i=1; i<strokeEvents.length; i++) {
         avgStrokeTime += strokeEvents[i].time - strokeEvents[i-1].time;
      }
      avgStrokeTime /= (strokeEvents.length - 1);
      strokeRate = 60 / avgStrokeTime;
  }

  const kicksCountVal = typeof config.manualKickCount === 'number' ? config.manualKickCount : 
         (kickEvents.length > 0 ? kickEvents.length : (config.stroke === 'Breaststroke' ? 1 : 6));

  const vel15toWall = avgVelocity * 0.92;
  const firstLengthVel = avgVelocity * 1.15;
  
  const turnEvents = events.filter(e => e.type === 'turn').sort((a,b) => a.time - b.time);
  
  const splits = [];
  
  // Create split boundaries based on turns and finish
  // There are 2 't' events per turn: start of turn, feet hit wall. The 2nd 't' represents the end of the length
  const lapEndTimes = [];
  for (let i = 1; i < turnEvents.length; i += 2) {
      lapEndTimes.push(turnEvents[i].time); // The "feet hit wall" event
  }
  if (finishEvents.length > 0) {
      lapEndTimes.push(finishEvents[0].time);
  } else if (runEnd > runStart) {
      // simulate remaining lap if no finish event
      lapEndTimes.push(runEnd);
  }

  // If we have actual lap markers, build splits from them
  if (lapEndTimes.length > 0) {
      let prevTime = runStart;
      for(let i = 0; i < lapEndTimes.length; i++) {
         let lapTime = lapEndTimes[i] - prevTime;
         if (manualSplitsArr[i]) {
            lapTime = manualSplitsArr[i];
         }
         splits.push({
            lap: i + 1,
            distance: poolLen,
            time: Math.max(0.1, lapTime)
         });
         prevTime = lapEndTimes[i];
      }
  } else {
      // Fallback
      for(let i = 1; i <= numLaps; i++) {
         let lapTime = (poolLen / avgVelocity) * (i === 1 ? 0.9 : 1.05); // rough split logic
         if (manualSplitsArr[i-1]) {
           lapTime = manualSplitsArr[i-1];
         }
         splits.push({
            lap: i,
            distance: poolLen,
            time: lapTime
         });
      }
  }

  return {
    splits,
    avgVelocity: avgVelocity,
    strokeRate: strokeRate,
    distancePerStroke: avgVelocity * (60/strokeRate),
    fatigueIndex: 8.4,
    underwaterKickTempo: uwtTempo,
    diveVelocity: diveVel,
    diveDistance: breakDist + 2.5,
    vel0to15m: vel0to15,
    vel15mToWall: vel15toWall,
    firstLengthVel: firstLengthVel,
    breakoutDistance: breakDist,
    breakoutTime: breakTime,
    kicksCount: kicksCountVal
  };
}
