import React from 'react';
import { RaceConfig, CourseType, StrokeType } from '../types';
import { Settings2, User, Activity, Ruler, Target, Clock, SplitSquareHorizontal } from 'lucide-react';

interface Props {
  config: RaceConfig;
  onChange: (config: RaceConfig) => void;
  onAnalyze: () => void;
  isAnalyzing: boolean;
}

export function RaceSetupForm({ config, onChange, onAnalyze, isAnalyzing }: Props) {
  
  const handleUpdate = (updates: Partial<RaceConfig>) => {
    onChange({ ...config, ...updates });
  };

  const isReady = (config.videoStartTime !== null && config.videoEndTime !== null) || config.manualRaceTime !== null;

  return (
    <div className="flex flex-col h-full space-y-6">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 mb-4 flex items-center gap-2">
          <Settings2 className="w-4 h-4" /> Local Analysis Setup
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Configure the race parameters. Either tag the start/end points in the video player or enter the manual race time / splits.
        </p>
      </div>

      <div className="space-y-4 flex-1 overflow-y-auto pr-2 pb-10">
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
             <User className="w-3 h-3" /> Swimmer Name
          </label>
          <input
            type="text"
            value={config.swimmerName}
            onChange={(e) => handleUpdate({ swimmerName: e.target.value })}
            placeholder="e.g. Filtered from auto-detection or manual"
            className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
               <Activity className="w-3 h-3" /> Stroke
            </label>
            <select
              value={config.stroke}
              onChange={(e) => handleUpdate({ stroke: e.target.value as StrokeType })}
              className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white"
            >
              <option value="Freestyle">Freestyle</option>
              <option value="Backstroke">Backstroke</option>
              <option value="Breaststroke">Breaststroke</option>
              <option value="Butterfly">Butterfly</option>
              <option value="IM">IM</option>
            </select>
          </div>
          
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
               <Ruler className="w-3 h-3" /> Course
            </label>
            <select
              value={config.course}
              onChange={(e) => handleUpdate({ course: e.target.value as CourseType })}
              className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white"
            >
              <option value="LCM">Long Course (50m)</option>
              <option value="SCM">Short Course (25m)</option>
              <option value="SCY">Short Course (25y)</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
             <Target className="w-3 h-3" /> Distance (m/y)
          </label>
          <select
            value={config.distance}
            onChange={(e) => handleUpdate({ distance: Number(e.target.value) })}
            className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={400}>400</option>
            <option value={800}>800</option>
            <option value={1500}>1500</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-2">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
               <Clock className="w-3 h-3" /> Override Time (s)
            </label>
            <input
              type="number"
              step="0.01"
              value={config.manualRaceTime || ''}
              onChange={(e) => handleUpdate({ manualRaceTime: e.target.value ? parseFloat(e.target.value) : null })}
              placeholder="e.g. 50.45"
              className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white"
            />
          </div>
          
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
               <SplitSquareHorizontal className="w-3 h-3" /> Splts override
            </label>
            <input
              type="text"
              value={config.manualSplits}
              onChange={(e) => handleUpdate({ manualSplits: e.target.value })}
              placeholder="24.5, 26.0"
              className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white"
            />
          </div>
        </div>

        <div className="border border-slate-200 dark:border-white/10 rounded-lg p-3 space-y-3 mt-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">Dive Entry Parameters</h3>
          <p className="text-[9px] text-slate-500 leading-tight mb-2">
            Auto-calculated using video event tracking (D, B markers). You can override them below if needed.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Init Velocity (m/s)
              </label>
              <input
                type="number"
                step="0.01"
                value={config.manualDiveVelocity || ''}
                onChange={(e) => handleUpdate({ manualDiveVelocity: e.target.value ? parseFloat(e.target.value) : null })}
                placeholder="Auto"
                className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Breakout Dist (m)
              </label>
              <input
                type="number"
                step="0.01"
                value={config.manualBreakoutDistance || ''}
                onChange={(e) => handleUpdate({ manualBreakoutDistance: e.target.value ? parseFloat(e.target.value) : null })}
                placeholder="Auto"
                className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white font-mono"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Total UW Kicks
              </label>
              <input
                type="number"
                value={config.manualKickCount || ''}
                onChange={(e) => handleUpdate({ manualKickCount: e.target.value ? parseInt(e.target.value) : null })}
                placeholder="Auto"
                className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-accent-500 focus:border-accent-500 dark:text-white font-mono"
              />
            </div>
          </div>
        </div>

        <div className="bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg p-3 space-y-3 mt-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Video Markers</h3>
          
          <div className="flex justify-between items-center text-sm">
             <span className="text-slate-600 dark:text-slate-400">Start Time:</span>
             <span className={`font-mono font-bold ${config.videoStartTime === null ? 'text-rose-500' : 'text-emerald-500'}`}>
                {config.videoStartTime !== null ? `${config.videoStartTime.toFixed(3)}s` : 'Not Set'}
             </span>
          </div>
          
          <div className="flex justify-between items-center text-sm">
             <span className="text-slate-600 dark:text-slate-400">End Time:</span>
             <span className={`font-mono font-bold ${config.videoEndTime === null ? 'text-rose-500' : 'text-emerald-500'}`}>
                {config.videoEndTime !== null ? `${config.videoEndTime.toFixed(3)}s` : 'Not Set'}
             </span>
          </div>
          
          {config.videoStartTime !== null && config.videoEndTime !== null && (
             <div className="flex justify-between items-center text-sm border-t border-slate-200 dark:border-white/10 pt-2 mt-2">
               <span className="text-slate-600 dark:text-slate-400 font-bold">Video Race Duration:</span>
               <span className="font-mono font-bold text-accent-500">
                  {Math.max(0, config.videoEndTime - config.videoStartTime).toFixed(3)}s
               </span>
             </div>
          )}
        </div>
      </div>

      <div className="mt-auto pt-6 border-t border-slate-200 dark:border-white/10 shrink-0">
        <button
          onClick={onAnalyze}
          disabled={!isReady || isAnalyzing}
          className={`w-full py-3 rounded-md text-sm font-bold uppercase tracking-wider transition-colors shadow-sm flex items-center justify-center gap-2
            ${isReady && !isAnalyzing 
              ? 'bg-accent-600 hover:bg-accent-500 text-white shadow-[0_0_15px_var(--accent-500)] shadow-accent-500/20' 
              : 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'}`}
        >
          {isAnalyzing ? 'Simulating Analytics...' : isReady ? 'Run Local Analysis' : 'Complete Setup to Run'}
        </button>
        {!isReady && (
           <p className="text-[10px] text-center text-slate-500 mt-2">
             Please mark Start & End times or enter manual overrides.
           </p>
        )}
      </div>
    </div>
  );
}
