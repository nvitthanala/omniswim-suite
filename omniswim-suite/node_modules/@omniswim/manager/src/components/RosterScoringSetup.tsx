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
    <div className="surface-overlay border border-theme-soft rounded-lg mb-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-primary)] flex items-center gap-2">
          <Settings size={12} />
          Conference scoring setup
          {workspace.conference ? (
            <span className="text-[var(--text-accent)] font-normal normal-case">({workspace.conference})</span>
          ) : null}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-3 border-t border-theme-soft pt-3">
          {!rosterMode ? (
            <p className="text-[9px] text-amber-400/90">
              Roster optimizer works best with NSISC preset (roster eligibility mode).
            </p>
          ) : null}
          <div className="grid sm:grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[9px] text-theme-secondary uppercase">Preset</span>
              <select
                className="surface-muted-bg border border-theme-soft rounded px-2 py-1 text-[10px]"
                value={selectedPreset}
                onChange={e => {
                  const id = e.target.value;
                  setSelectedPreset(id);
                  if (id) applyPreset(id);
                }}
              >
                <option value="">Custom</option>
                {presets.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[9px] text-theme-secondary uppercase">Scorer mode</span>
              <select
                className="surface-muted-bg border border-theme-soft rounded px-2 py-1 text-[10px]"
                value={local.scorerEligibilityMode ?? 'points_pool'}
                onChange={e =>
                  setLocal({
                    ...local,
                    scorerEligibilityMode: e.target.value as 'points_pool' | 'roster',
                  })
                }
              >
                <option value="roster">Roster (NSISC)</option>
                <option value="points_pool">Points pool</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[9px] text-theme-secondary uppercase">Max scorers / team</span>
              <input
                type="number"
                className="surface-muted-bg border border-theme-soft rounded px-2 py-1 text-[10px] font-mono"
                value={local.maxIndividualScorersPerTeam}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxIndividualScorersPerTeam: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[9px] text-theme-secondary uppercase">Max relays / event</span>
              <input
                type="number"
                className="surface-muted-bg border border-theme-soft rounded px-2 py-1 text-[10px] font-mono"
                value={local.maxRelaysScoringPerTeam}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxRelaysScoringPerTeam: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[9px] text-theme-secondary uppercase">Max ind entries / swimmer</span>
              <input
                type="number"
                className="surface-muted-bg border border-theme-soft rounded px-2 py-1 text-[10px] font-mono"
                value={local.maxIndividualEntriesPerSwimmer ?? 999}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxIndividualEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[9px] text-theme-secondary uppercase">Max relay entries / swimmer</span>
              <input
                type="number"
                className="surface-muted-bg border border-theme-soft rounded px-2 py-1 text-[10px] font-mono"
                value={local.maxRelayEntriesPerSwimmer ?? 999}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxRelayEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
          </div>
          <button
            type="button"
            onClick={save}
            className="text-[10px] px-2 py-1 rounded border border-[var(--text-accent)]/40 text-[var(--text-accent)] flex items-center gap-1"
          >
            <Save size={10} /> Save scoring settings
          </button>
        </div>
      ) : null}
    </div>
  );
}
