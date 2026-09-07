import { useEffect, useState } from 'react';
import { proposeStandardImStrokeOrder, raceLengthCount } from '@omniswim/core/lib/raceAnalysis';
import { Settings2 } from 'lucide-react';
import type { CycleDefinition, ImProposal, RaceConfig, RaceCourse, Stroke } from '../types';
import { STROKE_LABEL } from './raceSetupShared';
import {
  BreakoutDistanceSection,
  ConfirmFooter,
  CourseDistanceFields,
  CycleDefinitionField,
  EventTypeSection,
  FlagDistanceSection,
  PerLengthStrokeGrid,
  RelayAndReferenceCheckboxes,
  SwimmerNameField,
} from './RaceSetupFormFields';

export { STROKE_LABEL };

interface Props {
  config: RaceConfig;
  swimmerName: string;
  rosterNames?: string[];
  onSwimmerNameChange: (name: string) => void;
  onChange: (config: RaceConfig) => void;
  onConfirm: () => void;
}

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
        <SwimmerNameField swimmerName={swimmerName} rosterNames={rosterNames} onChange={onSwimmerNameChange} />

        <CourseDistanceFields
          config={config}
          lengthCountForRows={lengthCountForRows}
          lengthCountValid={lengthCountValid}
          onCourseChange={handleCourseChange}
          onDistanceChange={handleDistanceChange}
        />

        <EventTypeSection
          eventType={eventType}
          onEventTypeChange={handleEventTypeChange}
          singleStroke={singleStroke}
          onSingleStrokeChange={handleSingleStrokeChange}
          imProposal={imProposal}
          imConfirmedForLengthCount={imConfirmedForLengthCount}
          lengthCountForRows={lengthCountForRows}
          onConfirmImProposal={handleConfirmImProposal}
        />

        <PerLengthStrokeGrid strokePerLength={config.strokePerLength} onChange={handleLengthStrokeChange} />

        <CycleDefinitionField value={config.cycleDefinition} onChange={handleCycleDefinitionChange} />

        <BreakoutDistanceSection
          strokePerLength={config.strokePerLength}
          breakoutRecord={breakoutRecord(config)}
          onChange={handleBreakoutDistanceChange}
        />

        <FlagDistanceSection
          flagDistanceConfirmed={flagDistanceConfirmed}
          flagDistanceInput={flagDistanceInput}
          onConfirmedChange={handleFlagDistanceConfirmedChange}
          onInputChange={handleFlagDistanceInputChange}
        />

        <RelayAndReferenceCheckboxes
          isRelayLeg={config.isRelayLeg}
          onRelayLegChange={(checked) => handleUpdate({ isRelayLeg: checked })}
          course={config.course}
          fifteenMetreReferenceConfirmed={config.fifteenMetreReferenceConfirmed}
          onFifteenMetreReferenceChange={(checked) => handleUpdate({ fifteenMetreReferenceConfirmed: checked })}
        />
      </div>

      <ConfirmFooter canConfirm={canConfirm} lengthCountValid={lengthCountValid} onConfirm={onConfirm} />
    </div>
  );
}
