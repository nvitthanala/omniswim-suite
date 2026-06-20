import React from 'react';
import { RaceConfig, CourseType, StrokeType } from '../types';
import { Settings2, User, Activity, Ruler, Target, Clock, SplitSquareHorizontal } from 'lucide-react';

interface Props {
  config: RaceConfig;
  onChange: (config: RaceConfig) => void;
  onAnalyze: () => void;
  isAnalyzing: boolean;
  rosterNames?: string[];
}

const fieldClass =
  'glass-input-compact w-full px-3 py-2 rounded text-ui-body text-[var(--text-primary)]';

export function RaceSetupForm({ config, onChange, onAnalyze, isAnalyzing, rosterNames = [] }: Props) {
  const handleUpdate = (updates: Partial<RaceConfig>) => {
    onChange({ ...config, ...updates });
  };

  const isReady =
    (config.videoStartTime !== null && config.videoEndTime !== null) || config.manualRaceTime !== null;

  return (
    <div className="flex flex-col h-full space-y-6">
      <div>
        <h2 className="text-ui-label font-bold uppercase tracking-widest text-theme-muted mb-4 flex items-center gap-2">
          <Settings2 className="w-4 h-4" /> Local Analysis Setup
        </h2>
        <p className="text-ui-caption text-theme-muted">
          Configure the race parameters. Either tag the start/end points in the video player or enter the
          manual race time / splits.
        </p>
      </div>

      <div className="space-y-4 flex-1 overflow-y-auto pr-2 pb-10">
        <div className="space-y-1.5">
          <label className="label-caps flex items-center gap-1.5">
            <User className="w-3 h-3" /> Swimmer Name
          </label>
          <input
            type="text"
            list="metrics-roster-names"
            value={config.swimmerName}
            onChange={e => handleUpdate({ swimmerName: e.target.value })}
            placeholder="Select from roster or type name"
            className={fieldClass}
          />
          {rosterNames.length > 0 ? (
            <datalist id="metrics-roster-names">
              {rosterNames.map(n => (
                <option key={n} value={n} />
              ))}
            </datalist>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted flex items-center gap-1.5">
              <Activity className="w-3 h-3" /> Stroke
            </label>
            <select
              value={config.stroke}
              onChange={e => handleUpdate({ stroke: e.target.value as StrokeType })}
              className={fieldClass}
            >
              <option value="Freestyle">Freestyle</option>
              <option value="Backstroke">Backstroke</option>
              <option value="Breaststroke">Breaststroke</option>
              <option value="Butterfly">Butterfly</option>
              <option value="IM">IM</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted flex items-center gap-1.5">
              <Ruler className="w-3 h-3" /> Course
            </label>
            <select
              value={config.course}
              onChange={e => handleUpdate({ course: e.target.value as CourseType })}
              className={fieldClass}
            >
              <option value="LCM">Long Course (50m)</option>
              <option value="SCM">Short Course (25m)</option>
              <option value="SCY">Short Course (25y)</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted flex items-center gap-1.5">
            <Target className="w-3 h-3" /> Distance (m/y)
          </label>
          <select
            value={config.distance}
            onChange={e => handleUpdate({ distance: Number(e.target.value) })}
            className={fieldClass}
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
            <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> Override Time (s)
            </label>
            <input
              type="number"
              step="0.01"
              value={config.manualRaceTime || ''}
              onChange={e =>
                handleUpdate({ manualRaceTime: e.target.value ? parseFloat(e.target.value) : null })
              }
              placeholder="e.g. 50.45"
              className={fieldClass}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted flex items-center gap-1.5">
              <SplitSquareHorizontal className="w-3 h-3" /> Splts override
            </label>
            <input
              type="text"
              value={config.manualSplits}
              onChange={e => handleUpdate({ manualSplits: e.target.value })}
              placeholder="24.5, 26.0"
              className={fieldClass}
            />
          </div>
        </div>

        <div className="border border-theme-soft rounded-lg p-3 space-y-3 mt-4 bg-[var(--surface-muted)]">
          <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted mb-1">
            Dive Entry Parameters
          </h3>
          <p className="text-ui-micro text-theme-muted leading-tight mb-2">
            Auto-calculated using video event tracking (D, B markers). You can override them below if needed.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">
                Init Velocity (m/s)
              </label>
              <input
                type="number"
                step="0.01"
                value={config.manualDiveVelocity || ''}
                onChange={e =>
                  handleUpdate({ manualDiveVelocity: e.target.value ? parseFloat(e.target.value) : null })
                }
                placeholder="Auto"
                className={`${fieldClass} font-mono text-ui-caption`}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">
                Breakout Dist (m)
              </label>
              <input
                type="number"
                step="0.01"
                value={config.manualBreakoutDistance || ''}
                onChange={e =>
                  handleUpdate({
                    manualBreakoutDistance: e.target.value ? parseFloat(e.target.value) : null,
                  })
                }
                placeholder="Auto"
                className={`${fieldClass} font-mono text-ui-caption`}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">
                Total UW Kicks
              </label>
              <input
                type="number"
                value={config.manualKickCount || ''}
                onChange={e =>
                  handleUpdate({ manualKickCount: e.target.value ? parseInt(e.target.value) : null })
                }
                placeholder="Auto"
                className={`${fieldClass} font-mono text-ui-caption`}
              />
            </div>
          </div>
        </div>

        <div className="bg-[var(--surface-muted)] border border-theme-soft rounded-lg p-3 space-y-3 mt-4">
          <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted mb-2">
            Video Markers
          </h3>

          <div className="flex justify-between items-center text-ui-caption">
            <span className="text-theme-muted">Start Time:</span>
            <span
              className={`font-mono font-bold ${config.videoStartTime === null ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'}`}
            >
              {config.videoStartTime !== null ? `${config.videoStartTime.toFixed(3)}s` : 'Not Set'}
            </span>
          </div>

          <div className="flex justify-between items-center text-ui-caption">
            <span className="text-theme-muted">End Time:</span>
            <span
              className={`font-mono font-bold ${config.videoEndTime === null ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'}`}
            >
              {config.videoEndTime !== null ? `${config.videoEndTime.toFixed(3)}s` : 'Not Set'}
            </span>
          </div>

          {config.videoStartTime !== null && config.videoEndTime !== null ? (
            <div className="flex justify-between items-center text-ui-caption border-t border-theme-soft pt-2 mt-2">
              <span className="text-theme-muted font-bold">Video Race Duration:</span>
              <span className="font-mono font-bold text-[var(--text-accent)]">
                {Math.max(0, config.videoEndTime - config.videoStartTime).toFixed(3)}s
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-auto pt-6 border-t border-theme-soft shrink-0">
        <button
          onClick={onAnalyze}
          disabled={!isReady || isAnalyzing}
          className={`w-full py-3 rounded-md text-ui-caption font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2
            ${
              isReady && !isAnalyzing
                ? 'btn-primary'
                : 'bg-[var(--surface-muted)] text-theme-muted cursor-not-allowed border border-theme-soft'
            }`}
        >
          {isAnalyzing ? 'Simulating Analytics...' : isReady ? 'Run Local Analysis' : 'Complete Setup to Run'}
        </button>
        {!isReady ? (
          <p className="text-ui-micro text-center text-theme-muted mt-2">
            Please mark Start & End times or enter manual overrides.
          </p>
        ) : null}
      </div>
    </div>
  );
}
