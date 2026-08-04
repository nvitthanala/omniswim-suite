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
            <label className="flex flex-col gap-1.5 min-w-0">
              <span className="text-ui-caption text-theme-muted">Preset</span>
              <select
                className="glass-input rounded-lg px-3 py-2 text-ui-body"
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
            <label className="flex flex-col gap-1.5 min-w-0">
              <span className="text-ui-caption text-theme-muted">Scorer mode</span>
              <select
                className="glass-input rounded-lg px-3 py-2 text-ui-body"
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
            <label className="flex flex-col gap-1.5 min-w-0">
              <span className="text-ui-caption text-theme-muted">Max scorers / team</span>
              <input
                type="number"
                className="glass-input rounded-lg px-3 py-2 text-ui-body font-mono"
                value={local.maxIndividualScorersPerTeam}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxIndividualScorersPerTeam: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1.5 min-w-0">
              <span className="text-ui-caption text-theme-muted">Max relays / event</span>
              <input
                type="number"
                className="glass-input rounded-lg px-3 py-2 text-ui-body font-mono"
                value={local.maxRelaysScoringPerTeam}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxRelaysScoringPerTeam: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1.5 min-w-0">
              <span className="text-ui-caption text-theme-muted">Max ind entries / swimmer</span>
              <input
                type="number"
                className="glass-input rounded-lg px-3 py-2 text-ui-body font-mono"
                value={local.maxIndividualEntriesPerSwimmer ?? 999}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxIndividualEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1.5 min-w-0">
              <span className="text-ui-caption text-theme-muted">Max relay entries / swimmer</span>
              <input
                type="number"
                className="glass-input rounded-lg px-3 py-2 text-ui-body font-mono"
                value={local.maxRelayEntriesPerSwimmer ?? 999}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxRelayEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1.5 min-w-0">
              <span className="text-ui-caption text-theme-muted">Max total entries / swimmer</span>
              <input
                type="number"
                className="glass-input rounded-lg px-3 py-2 text-ui-body font-mono"
                value={local.maxTotalEntriesPerSwimmer ?? 999}
                onChange={e =>
                  setLocal({
                    ...local,
                    maxTotalEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                  })
                }
              />
            </label>
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
