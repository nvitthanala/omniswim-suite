import { useEffect, useState } from 'react';
import { proposeStandardImStrokeOrder, raceLengthCount } from '@omniswim/core/lib/raceAnalysis';
import { Settings2, User, Activity, Ruler, Target, Waves } from 'lucide-react';
import type { CycleDefinition, ImProposal, RaceConfig, RaceCourse, Stroke } from '../types';

interface Props {
  config: RaceConfig;
  swimmerName: string;
  rosterNames?: string[];
  onSwimmerNameChange: (name: string) => void;
  onChange: (config: RaceConfig) => void;
  onConfirm: () => void;
}

const SELECT_CLASS = 'glass-input w-full';
const INPUT_CLASS = 'glass-input w-full';

export const STROKE_LABEL: Record<Stroke, string> = { fly: 'Butterfly', back: 'Backstroke', breast: 'Breaststroke', free: 'Freestyle' };
const STROKES: readonly Stroke[] = ['free', 'back', 'breast', 'fly'];

function defaultCycleDefinition(stroke: Stroke): CycleDefinition {
  return stroke === 'fly' || stroke === 'breast' ? 'single-pull' : 'same-hand';
}

function resizeStrokeArray(length: number, current: readonly Stroke[], fallback: Stroke): Stroke[] {
  const next: Stroke[] = [];
  for (let i = 0; i < length; i += 1) next.push(current[i] ?? fallback);
  return next;
}

function breakoutRecord(config: RaceConfig): Record<number, number> {
  const distances = config.breakoutDistanceByLength;
  if (distances === undefined || Array.isArray(distances)) return {};
  return { ...distances };
}

export function RaceSetupForm({ config, swimmerName, rosterNames = [], onSwimmerNameChange, onChange, onConfirm }: Props) {
  const [eventType, setEventType] = useState<'single' | 'im'>('single');
  const [singleStroke, setSingleStroke] = useState<Stroke>(config.strokePerLength[0] ?? 'free');
  const [cycleDefinitionManual, setCycleDefinitionManual] = useState(false);
  const [imProposal, setImProposal] = useState<ImProposal | null>(null);
  const [imConfirmedForLengthCount, setImConfirmedForLengthCount] = useState<number | null>(null);
  const [flagDistanceConfirmed, setFlagDistanceConfirmed] = useState(config.flagDistance !== undefined);
  const [flagDistanceInput, setFlagDistanceInput] = useState(config.flagDistance !== undefined ? String(config.flagDistance) : '');

  const rawLengthCount = raceLengthCount(config);
  const lengthCountValid = Number.isInteger(rawLengthCount) && Math.round(rawLengthCount) === config.strokePerLength.length;
  const lengthCountForRows = Number.isInteger(rawLengthCount) ? Math.round(rawLengthCount) : config.strokePerLength.length;

  useEffect(() => {
    if (eventType !== 'im') {
      setImProposal(null);
      return;
    }
    setImProposal(proposeStandardImStrokeOrder(lengthCountForRows));
  }, [eventType, lengthCountForRows]);

  const handleUpdate = (updates: Partial<RaceConfig>) => {
    onChange({ ...config, ...updates });
  };

  const handleCourseChange = (course: RaceCourse) => {
    const nextConfig: RaceConfig = { ...config, course };
    const nextRaw = raceLengthCount(nextConfig);
    const nextLength = Number.isInteger(nextRaw) ? Math.round(nextRaw) : config.strokePerLength.length;
    nextConfig.strokePerLength = resizeStrokeArray(nextLength, config.strokePerLength, singleStroke);
    if (course !== 'SCY') nextConfig.fifteenMetreReferenceConfirmed = true;
    else nextConfig.fifteenMetreReferenceConfirmed = false;
    onChange(nextConfig);
    setImConfirmedForLengthCount(null);
  };

  const handleDistanceChange = (raceDistance: number) => {
    const nextConfig: RaceConfig = { ...config, raceDistance };
    const nextRaw = raceLengthCount(nextConfig);
    const nextLength = Number.isInteger(nextRaw) ? Math.round(nextRaw) : config.strokePerLength.length;
    nextConfig.strokePerLength = resizeStrokeArray(nextLength, config.strokePerLength, singleStroke);
    onChange(nextConfig);
    setImConfirmedForLengthCount(null);
  };

  const handleEventTypeChange = (next: 'single' | 'im') => {
    setEventType(next);
    setImConfirmedForLengthCount(null);
    if (next === 'single') {
      handleUpdate({ strokePerLength: resizeStrokeArray(lengthCountForRows, config.strokePerLength, singleStroke) });
    }
  };

  const handleSingleStrokeChange = (stroke: Stroke) => {
    setSingleStroke(stroke);
    handleUpdate({
      strokePerLength: new Array<Stroke>(lengthCountForRows).fill(stroke),
      cycleDefinition: cycleDefinitionManual ? config.cycleDefinition : defaultCycleDefinition(stroke),
    });
  };

  const handleConfirmImProposal = () => {
    if (imProposal === null || imProposal.strokePerLength.length === 0) return;
    handleUpdate({ strokePerLength: [...imProposal.strokePerLength] });
    setImConfirmedForLengthCount(lengthCountForRows);
  };

  const handleLengthStrokeChange = (index: number, stroke: Stroke) => {
    const next = [...config.strokePerLength];
    next[index] = stroke;
    handleUpdate({ strokePerLength: next });
  };

  const handleCycleDefinitionChange = (value: CycleDefinition) => {
    setCycleDefinitionManual(true);
    handleUpdate({ cycleDefinition: value });
  };

  const handleBreakoutDistanceChange = (lengthIndex: number, value: string) => {
    const record = breakoutRecord(config);
    if (value.trim() === '') {
      delete record[lengthIndex];
    } else {
      const parsed = parseFloat(value);
      if (!Number.isNaN(parsed)) record[lengthIndex] = parsed;
    }
    handleUpdate({ breakoutDistanceByLength: Object.keys(record).length > 0 ? record : undefined });
  };

  const handleFlagDistanceConfirmedChange = (confirmed: boolean) => {
    setFlagDistanceConfirmed(confirmed);
    if (!confirmed) {
      handleUpdate({ flagDistance: undefined });
      return;
    }
    const parsed = parseFloat(flagDistanceInput);
    handleUpdate({ flagDistance: Number.isNaN(parsed) ? undefined : parsed });
  };

  const handleFlagDistanceInputChange = (value: string) => {
    setFlagDistanceInput(value);
    if (!flagDistanceConfirmed) return;
    const parsed = parseFloat(value);
    handleUpdate({ flagDistance: Number.isNaN(parsed) ? undefined : parsed });
  };

  const imReady = eventType !== 'im' || imConfirmedForLengthCount === lengthCountForRows;
  const canConfirm = lengthCountValid && imReady && config.strokePerLength.length > 0;

  return (
    <div className="flex flex-col h-full space-y-6">
      <div>
        <h2 className="text-ui-label font-bold uppercase tracking-widest text-theme-muted mb-4 flex items-center gap-2">
          <Settings2 className="w-4 h-4" /> Race Setup
        </h2>
        <p className="text-ui-body text-theme-secondary">
          Configure the race exactly as swum. All splits and rates are computed by the analysis engine from the tags you place
          — nothing here is guessed.
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
            value={swimmerName}
            onChange={(e) => onSwimmerNameChange(e.target.value)}
            placeholder="Select from roster or type name"
            className="glass-input w-full px-3 py-2 rounded text-ui-body"
          />
          {rosterNames.length > 0 ? (
            <datalist id="metrics-roster-names">
              {rosterNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="label-caps flex items-center gap-1.5">
              <Ruler className="w-3 h-3" /> Course
            </label>
            <select value={config.course} onChange={(e) => handleCourseChange(e.target.value as RaceCourse)} className={SELECT_CLASS}>
              <option value="LCM">Long Course (50m)</option>
              <option value="SCM">Short Course (25m)</option>
              <option value="SCY">Short Course (25y)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="label-caps flex items-center gap-1.5">
              <Target className="w-3 h-3" /> Distance
            </label>
            <select value={config.raceDistance} onChange={(e) => handleDistanceChange(Number(e.target.value))} className={SELECT_CLASS}>
              {[50, 100, 200, 400, 800, 1500].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-ui-caption text-theme-muted">
          Lengths: <span className="font-mono font-bold text-[var(--text-primary)]">{lengthCountForRows}</span>
          {!lengthCountValid ? <span className="text-red-500 dark:text-red-400 ml-2">distance ÷ pool length is not a whole number of lengths</span> : null}
        </div>

        <div className="space-y-1.5">
          <label className="label-caps flex items-center gap-1.5">
            <Activity className="w-3 h-3" /> Event
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleEventTypeChange('single')}
              className={`px-3 py-2 rounded text-ui-caption font-bold uppercase tracking-wide border ${eventType === 'single' ? 'border-[var(--text-accent)] text-[var(--text-accent)]' : 'border-theme-soft text-theme-muted'}`}
            >
              Single Stroke
            </button>
            <button
              type="button"
              onClick={() => handleEventTypeChange('im')}
              className={`px-3 py-2 rounded text-ui-caption font-bold uppercase tracking-wide border ${eventType === 'im' ? 'border-[var(--text-accent)] text-[var(--text-accent)]' : 'border-theme-soft text-theme-muted'}`}
            >
              IM
            </button>
          </div>
        </div>

        {eventType === 'single' ? (
          <div className="space-y-1.5">
            <label className="label-caps">Stroke</label>
            <select value={singleStroke} onChange={(e) => handleSingleStrokeChange(e.target.value as Stroke)} className={SELECT_CLASS}>
              {STROKES.map((s) => (
                <option key={s} value={s}>
                  {STROKE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="border border-theme-soft rounded-lg p-3 space-y-2">
            <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted">Standard IM Order (proposed)</h3>
            {imProposal !== null && imProposal.strokePerLength.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {imProposal.strokePerLength.map((stroke, i) => (
                    <span key={i} className="px-2 py-1 rounded bg-[var(--surface-muted)] text-ui-micro font-mono">
                      L{i + 1} {STROKE_LABEL[stroke]}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleConfirmImProposal}
                  disabled={imConfirmedForLengthCount === lengthCountForRows}
                  className="px-3 py-1.5 rounded text-ui-caption font-bold uppercase tracking-wide bg-accent-600 hover:bg-accent-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {imConfirmedForLengthCount === lengthCountForRows ? 'Confirmed' : 'Confirm IM Order'}
                </button>
              </>
            ) : (
              <p className="text-ui-caption text-red-500 dark:text-red-400">
                {lengthCountForRows} lengths is not divisible by four — enter each length's stroke manually below.
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="label-caps">Per-length stroke</label>
          <div className="grid grid-cols-2 gap-2">
            {config.strokePerLength.map((stroke, i) => (
              <div key={i} className="flex items-center gap-2 text-ui-caption">
                <span className="text-theme-muted font-mono w-6">L{i + 1}</span>
                <select value={stroke} onChange={(e) => handleLengthStrokeChange(i, e.target.value as Stroke)} className={`${SELECT_CLASS} py-1`}>
                  {STROKES.map((s) => (
                    <option key={s} value={s}>
                      {STROKE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="label-caps flex items-center gap-1.5">
            <Waves className="w-3 h-3" /> Cycle Definition
          </label>
          <select
            value={config.cycleDefinition}
            onChange={(e) => handleCycleDefinitionChange(e.target.value as CycleDefinition)}
            className={SELECT_CLASS}
          >
            <option value="same-hand">Same-hand (free / back default)</option>
            <option value="single-pull">Single-pull (fly / breast default)</option>
          </select>
          <p className="text-ui-micro text-theme-muted">Applies to every stroke-rate figure computed for this race.</p>
        </div>

        <div className="border border-theme-soft rounded-lg p-3 space-y-2">
          <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted">Breakout Distance per Length (optional)</h3>
          <div className="grid grid-cols-2 gap-2">
            {config.strokePerLength.map((_, i) => (
              <div key={i} className="flex items-center gap-2 text-ui-caption">
                <span className="text-theme-muted font-mono w-6">L{i + 1}</span>
                <input
                  type="number"
                  step="0.1"
                  value={breakoutRecord(config)[i + 1] ?? ''}
                  onChange={(e) => handleBreakoutDistanceChange(i + 1, e.target.value)}
                  placeholder="Auto"
                  className={`${INPUT_CLASS} py-1 font-mono`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="border border-theme-soft rounded-lg p-3 space-y-2">
          <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted">Flag Distance</h3>
          <label className="flex items-center gap-2 text-ui-caption text-theme-secondary">
            <input type="checkbox" checked={flagDistanceConfirmed} onChange={(e) => handleFlagDistanceConfirmedChange(e.target.checked)} />
            I have measured the flag distance for the final length
          </label>
          {flagDistanceConfirmed ? (
            <input
              type="number"
              step="0.1"
              value={flagDistanceInput}
              onChange={(e) => handleFlagDistanceInputChange(e.target.value)}
              placeholder="e.g. 5.0"
              className={`${INPUT_CLASS} font-mono`}
            />
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-ui-caption text-theme-secondary">
          <input type="checkbox" checked={config.isRelayLeg} onChange={(e) => handleUpdate({ isRelayLeg: e.target.checked })} />
          This is a relay leg (reaction time and flight time are not applicable)
        </label>

        {config.course === 'SCY' ? (
          <label className="flex items-center gap-2 text-ui-caption text-theme-secondary">
            <input
              type="checkbox"
              checked={config.fifteenMetreReferenceConfirmed}
              onChange={(e) => handleUpdate({ fifteenMetreReferenceConfirmed: e.target.checked })}
            />
            My pool has a visible 15 m reference mark (required to tag the 15 m mark in yards)
          </label>
        ) : null}
      </div>

      <div className="mt-auto pt-6 border-t border-theme-soft shrink-0">
        <button
          onClick={onConfirm}
          disabled={!canConfirm}
          className={`w-full py-3 rounded-lg text-ui-body font-bold uppercase tracking-wider transition-colors shadow-sm flex items-center justify-center gap-2
            ${canConfirm ? 'bg-accent-600 hover:bg-accent-500 text-white shadow-[0_0_15px_var(--accent-500)] shadow-accent-500/20' : 'bg-[var(--surface-muted)] text-theme-muted cursor-not-allowed'}`}
        >
          Start Tagging
        </button>
        {!canConfirm ? (
          <p className="text-ui-micro text-center text-theme-muted mt-2">
            {!lengthCountValid ? 'Fix the distance/course mismatch above.' : 'Confirm the IM stroke order above.'}
          </p>
        ) : null}
      </div>
    </div>
  );
}
