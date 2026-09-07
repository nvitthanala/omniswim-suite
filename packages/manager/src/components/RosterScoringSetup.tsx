/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Save, Settings } from 'lucide-react';
import { ScoringPresetMeta, ScoringSettings, Workspace } from '@omniswim/core/types';
import { fetchScoringPresetList, fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { usesScorerRoster } from '@omniswim/core/lib/scorerRoster';
import {
  NUMERIC_SETTING_FIELDS,
  NumericSettingField,
  ScorerModeSelect,
  ScoringPresetSelect,
} from './RosterScoringSetupParts';

type Props = {
  workspace: Workspace;
  settings: ScoringSettings;
  onSave: (patch: Partial<Workspace>) => void;
};

export default function RosterScoringSetup({ workspace, settings, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<ScoringSettings>(() => mergeScoringSettings(settings));
  const [presets, setPresets] = useState<ScoringPresetMeta[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');

  useEffect(() => {
    setLocal(mergeScoringSettings(settings));
  }, [settings]);

  useEffect(() => {
    fetchScoringPresetList().then(setPresets).catch(() => setPresets([]));
  }, []);

  const applyPreset = async (id: string) => {
    const next = await fetchScoringPresetSettings(id);
    setLocal(mergeScoringSettings(next));
    setSelectedPreset(id);
  };

  const save = () => {
    onSave({ scoringSettings: local });
  };

  const rosterMode = usesScorerRoster(local);

  return (
    <div className="surface-overlay border border-theme-soft rounded-xl mb-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3.5 py-3 text-left gap-2"
      >
        <span className="text-ui-label font-semibold text-[var(--text-primary)] flex items-center gap-2 min-w-0">
          <Settings size={14} className="shrink-0 text-[var(--text-accent)]" />
          <span className="truncate">Scoring setup</span>
          {workspace.conference ? (
            <span className="text-theme-muted font-normal truncate">({workspace.conference})</span>
          ) : null}
        </span>
        {open ? <ChevronUp size={16} className="shrink-0" /> : <ChevronDown size={16} className="shrink-0" />}
      </button>
      {open ? (
        <div className="px-3.5 pb-3.5 space-y-3 border-t border-theme-soft pt-3">
          {!rosterMode ? (
            <p className="text-ui-caption text-amber-400/90 leading-relaxed">
              Roster tools work best with the NSISC preset (roster eligibility mode).
            </p>
          ) : null}
          <div className="grid sm:grid-cols-2 gap-3">
            <ScoringPresetSelect
              presets={presets}
              selectedPreset={selectedPreset}
              onSelect={id => {
                setSelectedPreset(id);
                if (id) applyPreset(id);
              }}
            />
            <ScorerModeSelect
              value={local.scorerEligibilityMode ?? 'points_pool'}
              onChange={mode => setLocal({ ...local, scorerEligibilityMode: mode })}
            />
            {NUMERIC_SETTING_FIELDS.map(field => (
              <NumericSettingField
                key={field.key}
                label={field.label}
                value={local[field.key]}
                onChange={next => setLocal({ ...local, [field.key]: next })}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={save}
            className="text-ui-label px-3 py-2 rounded-lg border border-[var(--text-accent)]/40 text-[var(--text-accent)] flex items-center gap-2 font-medium"
          >
            <Save size={14} /> Save scoring settings
          </button>
        </div>
      ) : null}
    </div>
  );
}
