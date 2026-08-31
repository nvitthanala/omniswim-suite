import { Activity, Ruler, Target, User, Waves } from 'lucide-react';
import type { CycleDefinition, ImProposal, RaceConfig, RaceCourse, Stroke } from '../types';
import { INPUT_CLASS, SELECT_CLASS, STROKE_LABEL, STROKES } from './raceSetupShared';

interface SwimmerNameFieldProps {
  swimmerName: string;
  rosterNames: string[];
  onChange: (name: string) => void;
}

/** Swimmer name input with a roster-backed datalist for autocomplete. */
export function SwimmerNameField({ swimmerName, rosterNames, onChange }: SwimmerNameFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="label-caps flex items-center gap-1.5">
        <User className="w-3 h-3" /> Swimmer Name
      </label>
      <input
        type="text"
        list="metrics-roster-names"
        value={swimmerName}
        onChange={(e) => onChange(e.target.value)}
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
  );
}

interface CourseDistanceFieldsProps {
  config: RaceConfig;
  lengthCountForRows: number;
  lengthCountValid: boolean;
  onCourseChange: (course: RaceCourse) => void;
  onDistanceChange: (distance: number) => void;
}

/** Course + distance selectors, plus the derived length count / mismatch warning. */
export function CourseDistanceFields({
  config,
  lengthCountForRows,
  lengthCountValid,
  onCourseChange,
  onDistanceChange,
}: CourseDistanceFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="label-caps flex items-center gap-1.5">
            <Ruler className="w-3 h-3" /> Course
          </label>
          <select value={config.course} onChange={(e) => onCourseChange(e.target.value as RaceCourse)} className={SELECT_CLASS}>
            <option value="LCM">Long Course (50m)</option>
            <option value="SCM">Short Course (25m)</option>
            <option value="SCY">Short Course (25y)</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="label-caps flex items-center gap-1.5">
            <Target className="w-3 h-3" /> Distance
          </label>
          <select value={config.raceDistance} onChange={(e) => onDistanceChange(Number(e.target.value))} className={SELECT_CLASS}>
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
    </>
  );
}

interface EventTypeSectionProps {
  eventType: 'single' | 'im';
  onEventTypeChange: (next: 'single' | 'im') => void;
  singleStroke: Stroke;
  onSingleStrokeChange: (stroke: Stroke) => void;
  imProposal: ImProposal | null;
  imConfirmedForLengthCount: number | null;
  lengthCountForRows: number;
  onConfirmImProposal: () => void;
}

/** Event-type toggle (single stroke vs IM) and the stroke/IM-order picker below it. */
export function EventTypeSection({
  eventType,
  onEventTypeChange,
  singleStroke,
  onSingleStrokeChange,
  imProposal,
  imConfirmedForLengthCount,
  lengthCountForRows,
  onConfirmImProposal,
}: EventTypeSectionProps) {
  return (
    <>
      <div className="space-y-1.5">
        <label className="label-caps flex items-center gap-1.5">
          <Activity className="w-3 h-3" /> Event
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onEventTypeChange('single')}
            className={`px-3 py-2 rounded text-ui-caption font-bold uppercase tracking-wide border ${eventType === 'single' ? 'border-[var(--text-accent)] text-[var(--text-accent)]' : 'border-theme-soft text-theme-muted'}`}
          >
            Single Stroke
          </button>
          <button
            type="button"
            onClick={() => onEventTypeChange('im')}
            className={`px-3 py-2 rounded text-ui-caption font-bold uppercase tracking-wide border ${eventType === 'im' ? 'border-[var(--text-accent)] text-[var(--text-accent)]' : 'border-theme-soft text-theme-muted'}`}
          >
            IM
          </button>
        </div>
      </div>

      {eventType === 'single' ? (
        <SingleStrokePicker singleStroke={singleStroke} onChange={onSingleStrokeChange} />
      ) : (
        <ImOrderPanel
          imProposal={imProposal}
          imConfirmedForLengthCount={imConfirmedForLengthCount}
          lengthCountForRows={lengthCountForRows}
          onConfirmImProposal={onConfirmImProposal}
        />
      )}
    </>
  );
}

function SingleStrokePicker({ singleStroke, onChange }: { singleStroke: Stroke; onChange: (stroke: Stroke) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="label-caps">Stroke</label>
      <select value={singleStroke} onChange={(e) => onChange(e.target.value as Stroke)} className={SELECT_CLASS}>
        {STROKES.map((s) => (
          <option key={s} value={s}>
            {STROKE_LABEL[s]}
          </option>
        ))}
      </select>
    </div>
  );
}

function ImOrderPanel({
  imProposal,
  imConfirmedForLengthCount,
  lengthCountForRows,
  onConfirmImProposal,
}: {
  imProposal: ImProposal | null;
  imConfirmedForLengthCount: number | null;
  lengthCountForRows: number;
  onConfirmImProposal: () => void;
}) {
  const hasProposal = imProposal !== null && imProposal.strokePerLength.length > 0;
  return (
    <div className="border border-theme-soft rounded-lg p-3 space-y-2">
      <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted">Standard IM Order (proposed)</h3>
      {hasProposal && imProposal ? (
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
            onClick={onConfirmImProposal}
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
  );
}

interface PerLengthStrokeGridProps {
  strokePerLength: readonly Stroke[];
  onChange: (index: number, stroke: Stroke) => void;
}

/** One stroke selector per race length. */
export function PerLengthStrokeGrid({ strokePerLength, onChange }: PerLengthStrokeGridProps) {
  return (
    <div className="space-y-1.5">
      <label className="label-caps">Per-length stroke</label>
      <div className="grid grid-cols-2 gap-2">
        {strokePerLength.map((stroke, i) => (
          <div key={i} className="flex items-center gap-2 text-ui-caption">
            <span className="text-theme-muted font-mono w-6">L{i + 1}</span>
            <select value={stroke} onChange={(e) => onChange(i, e.target.value as Stroke)} className={`${SELECT_CLASS} py-1`}>
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
  );
}

interface CycleDefinitionFieldProps {
  value: CycleDefinition;
  onChange: (value: CycleDefinition) => void;
}

/** Stroke-cycle definition used for every stroke-rate figure. */
export function CycleDefinitionField({ value, onChange }: CycleDefinitionFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="label-caps flex items-center gap-1.5">
        <Waves className="w-3 h-3" /> Cycle Definition
      </label>
      <select value={value} onChange={(e) => onChange(e.target.value as CycleDefinition)} className={SELECT_CLASS}>
        <option value="same-hand">Same-hand (free / back default)</option>
        <option value="single-pull">Single-pull (fly / breast default)</option>
      </select>
      <p className="text-ui-micro text-theme-muted">Applies to every stroke-rate figure computed for this race.</p>
    </div>
  );
}

interface BreakoutDistanceSectionProps {
  strokePerLength: readonly Stroke[];
  breakoutRecord: Record<number, number>;
  onChange: (lengthIndex: number, value: string) => void;
}

/** Optional per-length breakout distance overrides. */
export function BreakoutDistanceSection({ strokePerLength, breakoutRecord, onChange }: BreakoutDistanceSectionProps) {
  return (
    <div className="border border-theme-soft rounded-lg p-3 space-y-2">
      <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted">Breakout Distance per Length (optional)</h3>
      <div className="grid grid-cols-2 gap-2">
        {strokePerLength.map((_, i) => (
          <div key={i} className="flex items-center gap-2 text-ui-caption">
            <span className="text-theme-muted font-mono w-6">L{i + 1}</span>
            <input
              type="number"
              step="0.1"
              value={breakoutRecord[i + 1] ?? ''}
              onChange={(e) => onChange(i + 1, e.target.value)}
              placeholder="Auto"
              className={`${INPUT_CLASS} py-1 font-mono`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

interface FlagDistanceSectionProps {
  flagDistanceConfirmed: boolean;
  flagDistanceInput: string;
  onConfirmedChange: (confirmed: boolean) => void;
  onInputChange: (value: string) => void;
}

/** Flag-distance measurement confirmation + optional value input. */
export function FlagDistanceSection({
  flagDistanceConfirmed,
  flagDistanceInput,
  onConfirmedChange,
  onInputChange,
}: FlagDistanceSectionProps) {
  return (
    <div className="border border-theme-soft rounded-lg p-3 space-y-2">
      <h3 className="text-ui-caption font-bold uppercase tracking-widest text-theme-muted">Flag Distance</h3>
      <label className="flex items-center gap-2 text-ui-caption text-theme-secondary">
        <input type="checkbox" checked={flagDistanceConfirmed} onChange={(e) => onConfirmedChange(e.target.checked)} />
        I have measured the flag distance for the final length
      </label>
      {flagDistanceConfirmed ? (
        <input
          type="number"
          step="0.1"
          value={flagDistanceInput}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="e.g. 5.0"
          className={`${INPUT_CLASS} font-mono`}
        />
      ) : null}
    </div>
  );
}

interface RelayAndReferenceCheckboxesProps {
  isRelayLeg: boolean;
  onRelayLegChange: (checked: boolean) => void;
  course: RaceCourse;
  fifteenMetreReferenceConfirmed: boolean;
  onFifteenMetreReferenceChange: (checked: boolean) => void;
}

/** Relay-leg flag, plus the SCY-only 15 m reference confirmation. */
export function RelayAndReferenceCheckboxes({
  isRelayLeg,
  onRelayLegChange,
  course,
  fifteenMetreReferenceConfirmed,
  onFifteenMetreReferenceChange,
}: RelayAndReferenceCheckboxesProps) {
  return (
    <>
      <label className="flex items-center gap-2 text-ui-caption text-theme-secondary">
        <input type="checkbox" checked={isRelayLeg} onChange={(e) => onRelayLegChange(e.target.checked)} />
        This is a relay leg (reaction time and flight time are not applicable)
      </label>

      {course === 'SCY' ? (
        <label className="flex items-center gap-2 text-ui-caption text-theme-secondary">
          <input type="checkbox" checked={fifteenMetreReferenceConfirmed} onChange={(e) => onFifteenMetreReferenceChange(e.target.checked)} />
          My pool has a visible 15 m reference mark (required to tag the 15 m mark in yards)
        </label>
      ) : null}
    </>
  );
}

interface ConfirmFooterProps {
  canConfirm: boolean;
  lengthCountValid: boolean;
  onConfirm: () => void;
}

/** The "Start Tagging" confirm button and its blocking-reason hint. */
export function ConfirmFooter({ canConfirm, lengthCountValid, onConfirm }: ConfirmFooterProps) {
  return (
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
  );
}
