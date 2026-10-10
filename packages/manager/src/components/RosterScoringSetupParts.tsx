/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Sub-components and field metadata for RosterScoringSetup. The settings form
 * is six near-identical numeric fields (label, value, an integer setter with
 * the same `|| 999` fallback) plus two selects — pulled out as a lookup table
 * and small named components instead of six copies of the same JSX block.
 */

import React from 'react';
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import { entryCapPolicy } from '@omniswim/core/lib/scoringDefaults';
import { NumberField } from '@omniswim/ui';

/** One numeric scoring-limit field: label, the settings key it reads/writes,
 * and the display fallback used when the value is unset. */
type NumericFieldSpec = {
  key: Extract<
    keyof ScoringSettings,
    | 'maxIndividualScorersPerTeam'
    | 'maxRelaysScoringPerTeam'
    | 'maxIndividualEntriesPerSwimmer'
    | 'maxRelayEntriesPerSwimmer'
    | 'maxTotalEntriesPerSwimmer'
  >;
  label: string;
  min?: number;
};

export const NUMERIC_SETTING_FIELDS: NumericFieldSpec[] = [
  { key: 'maxIndividualScorersPerTeam', label: 'Max scorers / team' },
  { key: 'maxRelaysScoringPerTeam', label: 'Max relays / event' },
  { key: 'maxIndividualEntriesPerSwimmer', label: 'Max ind entries / swimmer', min: 1 },
  { key: 'maxRelayEntriesPerSwimmer', label: 'Max relay entries / swimmer', min: 1 },
  { key: 'maxTotalEntriesPerSwimmer', label: 'Max total entries / swimmer', min: 1 },
];

export function NumericSettingField({
  label,
  min,
  value,
  onChange,
}: {
  label: string;
  min?: number;
  value: number | undefined;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-ui-caption text-theme-muted">{label}</span>
      <NumberField
        className="glass-input rounded-lg px-3 py-2 text-ui-body font-mono"
        value={value ?? 999}
        min={min}
        onValueChange={onChange}
      />
    </label>
  );
}

/**
 * Optional entry-cap policy flags. Absent settings resolve through
 * `entryCapPolicy`, so the checkboxes show the effective default (time trials
 * off, exhibition on) until the user sets an explicit boolean.
 */
export function EntryCapPolicyFields({
  settings,
  onChange,
}: {
  settings: Pick<ScoringSettings, 'entryCapCountsTimeTrials' | 'entryCapCountsExhibition'>;
  onChange: (patch: Partial<ScoringSettings>) => void;
}) {
  const policy = entryCapPolicy(settings);
  return (
    <div className="sm:col-span-2 flex flex-col gap-2">
      <label className="flex items-center gap-2 text-ui-caption text-theme-muted cursor-pointer">
        <input
          type="checkbox"
          aria-label="Time trials count toward the entry cap"
          checked={policy.countsTimeTrials}
          onChange={e => onChange({ entryCapCountsTimeTrials: e.target.checked })}
          className="accent-[var(--text-accent)]"
        />
        Time trials count toward the entry cap
      </label>
      <label className="flex items-center gap-2 text-ui-caption text-theme-muted cursor-pointer">
        <input
          type="checkbox"
          aria-label="Exhibition swims count toward the entry cap"
          checked={policy.countsExhibition}
          onChange={e => onChange({ entryCapCountsExhibition: e.target.checked })}
          className="accent-[var(--text-accent)]"
        />
        Exhibition swims count toward the entry cap
      </label>
    </div>
  );
}

export function ScoringPresetSelect({
  presets,
  selectedPreset,
  onSelect,
}: {
  presets: ScoringPresetMeta[];
  selectedPreset: string;
  onSelect: (id: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-ui-caption text-theme-muted">Preset</span>
      <select
        className="glass-input rounded-lg px-3 py-2 text-ui-body"
        value={selectedPreset}
        onChange={e => onSelect(e.target.value)}
      >
        <option value="">Custom</option>
        {presets.map(p => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ScorerModeSelect({
  value,
  onChange,
}: {
  value: 'points_pool' | 'roster';
  onChange: (mode: 'points_pool' | 'roster') => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-ui-caption text-theme-muted">Scorer mode</span>
      <select
        className="glass-input rounded-lg px-3 py-2 text-ui-body"
        value={value}
        onChange={e => onChange(e.target.value as 'points_pool' | 'roster')}
      >
        <option value="roster">Team scorer list</option>
        <option value="points_pool">Points pool</option>
      </select>
    </label>
  );
}
