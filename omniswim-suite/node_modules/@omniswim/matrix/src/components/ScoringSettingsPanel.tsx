import React, { useEffect, useState } from 'react';
import { ChevronDown, Settings, Save } from 'lucide-react';
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import { fetchScoringPresetList, fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';

type Props = {
  settings: ScoringSettings;
  onSave: (s: ScoringSettings) => void;
  suggestedPresetId?: string | null;
  collapsible?: boolean;
  defaultOpen?: boolean;
};

export default function ScoringSettingsPanel({
  settings,
  onSave,
  suggestedPresetId,
  collapsible = false,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [localSettings, setLocalSettings] = useState<ScoringSettings>(() => mergeScoringSettings(settings));
  const [pointsStr, setPointsStr] = useState(settings.scoringPoints.join(', '));
  const [presets, setPresets] = useState<ScoringPresetMeta[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');

  useEffect(() => {
    setLocalSettings(mergeScoringSettings(settings));
    setPointsStr(settings.scoringPoints.join(', '));
  }, [settings]);

  useEffect(() => {
    fetchScoringPresetList().then(setPresets).catch(() => setPresets([]));
  }, []);

  const applyPreset = async (presetId: string) => {
    const next = await fetchScoringPresetSettings(presetId);
    setLocalSettings(next);
    setPointsStr(next.scoringPoints.join(', '));
    setSelectedPreset(presetId);
  };

  const saveCurrent = () => {
    const arr = pointsStr.split(',').map(s => parseFloat(s.trim())).filter(n => !Number.isNaN(n));
    onSave({ ...localSettings, scoringPoints: arr });
  };

  const headerTitle = (
    <h4 className="text-ui-label font-medium text-theme-secondary uppercase tracking-widest flex items-center gap-2">
      <Settings size={12} />
      Custom Scoring Logic
    </h4>
  );

  const saveButton = (
    <button
      type="button"
      onClick={saveCurrent}
      className="text-ui-micro badge-info px-2 py-1 rounded hover:opacity-90 transition-colors uppercase font-medium flex items-center gap-1 shrink-0"
    >
      <Save size={10} /> Save
    </button>
  );

  const header = (
    <div className="flex items-center justify-between gap-3 w-full">
      {headerTitle}
      <div className="flex items-center gap-2">
        {!collapsible ? saveButton : null}
        {collapsible ? (
          <ChevronDown
            size={14}
            className={`text-theme-secondary transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );

  const body = (
    <>
      {suggestedPresetId && (
        <div className="mb-4 p-3 rounded badge-warning text-[10px]">
          <span className="uppercase tracking-widest font-medium">Suggested preset: </span>
          {suggestedPresetId}
          <button
            type="button"
            className="ml-2 underline hover:text-[var(--text-primary)]"
            onClick={() => applyPreset(suggestedPresetId).then(saveCurrent)}
          >
            Load & save
          </button>
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-[10px] text-theme-secondary uppercase mb-1">PDF place points</label>
          <select
            className="glass-input w-full text-xs uppercase"
            value={
              localSettings.usePdfPlacePoints === true
                ? 'on'
                : localSettings.usePdfPlacePoints === false
                  ? 'off'
                  : 'auto'
            }
            onChange={e => {
              const v = e.target.value;
              setLocalSettings({
                ...localSettings,
                usePdfPlacePoints: v === 'on' ? true : v === 'off' ? false : 'auto',
              });
            }}
          >
            <option value="auto">Auto (detect from PDF)</option>
            <option value="on">On (use HyTek Points column)</option>
            <option value="off">Off (engine scoring only)</option>
          </select>
        </div>

        <div>
          <label className="block text-[10px] text-theme-secondary uppercase mb-1">Scoring preset</label>
          <select
            className="glass-input w-full text-xs uppercase"
            value={selectedPreset}
            onChange={e => {
              const id = e.target.value;
              setSelectedPreset(id);
              if (id) applyPreset(id);
            }}
          >
            <option value="">Custom (current fields)</option>
            {presets.map(p => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {selectedPreset && presets.find(p => p.id === selectedPreset)?.description && (
            <p className="text-[9px] text-theme-secondary mt-1 italic">
              {presets.find(p => p.id === selectedPreset)?.description}
            </p>
          )}
        </div>

        <div>
          <label className="block text-[10px] text-theme-secondary uppercase mb-1">Points distribution (comma separated)</label>
          <input
            value={pointsStr}
            onChange={e => setPointsStr(e.target.value)}
            className="glass-input w-full font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Scorer cap scope</label>
            <select
              className="glass-input w-full text-xs uppercase"
              value={localSettings.scorerCapScope ?? 'event'}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  scorerCapScope: e.target.value as 'meet' | 'event',
                })
              }
            >
              <option value="event">Per event</option>
              <option value="meet">Full meet</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Diver scorer weight</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={localSettings.diverScorerWeight ?? 1}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  diverScorerWeight: parseFloat(e.target.value) || 1,
                })
              }
              className="glass-input w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max individual scorers / team</label>
            <input
              type="number"
              value={localSettings.maxIndividualScorersPerTeam}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxIndividualScorersPerTeam: parseInt(e.target.value, 10) || 999,
                })
              }
              className="glass-input w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max scoring relays / team / relay event</label>
            <input
              type="number"
              value={localSettings.maxRelaysScoringPerTeam}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxRelaysScoringPerTeam: parseInt(e.target.value, 10) || 999,
                })
              }
              className="glass-input w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max ind entries / swimmer</label>
            <input
              type="number"
              value={localSettings.maxIndividualEntriesPerSwimmer ?? 999}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxIndividualEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                })
              }
              className="glass-input w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max relay entries / swimmer</label>
            <input
              type="number"
              value={localSettings.maxRelayEntriesPerSwimmer ?? 999}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxRelayEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                })
              }
              className="glass-input w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Relay multiplier</label>
            <input
              type="number"
              value={localSettings.relayMultiplier}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  relayMultiplier: parseFloat(e.target.value) || 1,
                })
              }
              className="glass-input w-full text-xs"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-[10px] text-theme-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={localSettings.halfRateRelaySwimmer}
                onChange={e =>
                  setLocalSettings({ ...localSettings, halfRateRelaySwimmer: e.target.checked })
                }
                className="accent-[var(--text-accent)]"
              />
              Half-rate relay swimmers
            </label>
          </div>
          <div className="col-span-2">
            <label className="flex items-center gap-2 text-[10px] text-theme-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={localSettings.relayEligibleFromScorerPool === true}
                onChange={e =>
                  setLocalSettings({
                    ...localSettings,
                    relayEligibleFromScorerPool: e.target.checked,
                  })
                }
                className="accent-[var(--text-accent)]"
              />
              Relays only if all legs are in individual scorer pool
            </label>
          </div>
        </div>
      </div>
    </>
  );

  if (collapsible) {
    return (
      <div className="surface-card rounded-lg overflow-hidden shrink-0">
        <div className="flex items-center gap-2 p-4">
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            className="flex-1 min-w-0 text-left hover:opacity-90 transition-opacity"
          >
            {header}
          </button>
          {open ? saveButton : null}
        </div>
        {open ? <div className="px-5 pb-5 border-t border-theme-soft pt-4">{body}</div> : null}
      </div>
    );
  }

  return (
    <div className="surface-card rounded-lg p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        {headerTitle}
        {saveButton}
      </div>
      {body}
    </div>
  );
}
