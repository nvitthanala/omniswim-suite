import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Lock, Settings, Save } from 'lucide-react';
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import { fetchScoringPresetList, fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import { mergeScoringSettings, scoringSettingsLock } from '@omniswim/core/lib/scoringDefaults';

type Props = {
  settings: ScoringSettings;
  onSave: (s: ScoringSettings) => void;
  suggestedPresetId?: string | null;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Workspace-level scoring view (absent = 'merged'); omit to hide the toggle. */
  scoringView?: 'merged' | 'pdf_only';
  onScoringViewChange?: (view: 'merged' | 'pdf_only') => void;
  /**
   * Workspace conference. Decides which controls the engine will overwrite —
   * without it this panel offers edits that `mergeScoringSettings` discards.
   */
  conference?: string;
};

export default function ScoringSettingsPanel({
  settings,
  onSave,
  suggestedPresetId,
  collapsible = false,
  defaultOpen = false,
  scoringView,
  onScoringViewChange,
  conference,
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

  // Which controls the engine will overwrite whatever this panel sends. Rendering
  // them editable meant a coach could change a number, save, and watch the total
  // not move — `mergeScoringSettings` discards the value before scoring sees it.
  const lock = useMemo(
    () => scoringSettingsLock(localSettings, { conference }),
    [localSettings, conference]
  );
  const lockedKeys = useMemo(() => new Set<string>(lock.keys as readonly string[]), [lock]);
  const isLocked = (key: keyof ScoringSettings) => lockedKeys.has(key as string);
  /** Applied to a locked control so it reads as fixed rather than broken. */
  const lockProps = (key: keyof ScoringSettings) =>
    isLocked(key)
      ? {
          disabled: true,
          title: lock.message ?? 'Fixed by competition rule',
          className: 'glass-input w-full text-xs opacity-60 cursor-not-allowed',
        }
      : { className: 'glass-input w-full text-xs' };

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
      aria-label="Save scoring settings"
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

  const resolvedScoringView = scoringView ?? 'merged';

  const scoringViewControl = onScoringViewChange ? (
    <div className="mb-4 p-3 rounded-lg border border-theme-soft surface-overlay">
      <label className="block text-[10px] text-theme-secondary uppercase tracking-widest font-medium mb-2">
        Scoring view
      </label>
      <div className="inline-flex items-center rounded-md border border-theme-soft surface-overlay p-1">
        <button
          type="button"
          onClick={() => onScoringViewChange('merged')}
          aria-label="Use merged scoring view"
          aria-pressed={resolvedScoringView === 'merged'}
          className={`px-3 py-1.5 rounded text-[10px] uppercase font-medium transition-colors ${
            resolvedScoringView === 'merged'
              ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
              : 'text-theme-secondary hover:text-[var(--text-primary)]'
          }`}
          title="Imported/planned/recruit entries remap onto the loaded meet's events and compete for points"
        >
          Merged
        </button>
        <button
          type="button"
          onClick={() => onScoringViewChange('pdf_only')}
          aria-label="Use PDF-only scoring view"
          aria-pressed={resolvedScoringView === 'pdf_only'}
          className={`px-3 py-1.5 rounded text-[10px] uppercase font-medium transition-colors ${
            resolvedScoringView === 'pdf_only'
              ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
              : 'text-theme-secondary hover:text-[var(--text-primary)]'
          }`}
          title="Plans and recruits are excluded from scoring — original PDF-base scoring only"
        >
          PDF only
        </button>
      </div>
      <p className="text-[9px] text-theme-muted mt-2 normal-case tracking-normal">
        {resolvedScoringView === 'merged'
          ? 'Plans, imports, and recruits remap onto the loaded meet and compete for points.'
          : 'Plans and recruits are excluded from scoring — only the original meet results score.'}
      </p>
    </div>
  ) : null;

  const body = (
    <>
      {scoringViewControl}
      {lock.message ? (
        <div className="mb-4 p-3 rounded-lg border border-theme-soft surface-overlay flex items-start gap-2">
          <Lock size={12} className="text-theme-muted mt-0.5 shrink-0" aria-hidden />
          <p className="text-[10px] text-theme-secondary leading-relaxed normal-case tracking-normal">
            {lock.message}
            <span className="text-theme-muted">
              {' '}
              Editing them here would have no effect, so they are shown fixed rather than
              accepting a change that is discarded before scoring.
            </span>
          </p>
        </div>
      ) : null}
      {suggestedPresetId && (
        <div className="mb-4 p-3 rounded badge-warning text-[10px]">
          <span className="uppercase tracking-widest font-medium">Suggested preset: </span>
          {suggestedPresetId}
          <button
            type="button"
            className="ml-2 underline hover:text-[var(--text-primary)]"
            onClick={() => applyPreset(suggestedPresetId).then(saveCurrent)}
            aria-label={`Load and save suggested ${suggestedPresetId} scoring preset`}
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
            aria-label="PDF place points setting"
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
            aria-label="Scoring preset"
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
            aria-label="Points distribution"
            onChange={e => setPointsStr(e.target.value)}
            className="glass-input w-full font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Scorer cap scope</label>
            <select
              className={`glass-input w-full text-xs uppercase${isLocked('scorerCapScope') ? ' opacity-60 cursor-not-allowed' : ''}`}
              aria-label="Scorer cap scope"
              disabled={isLocked('scorerCapScope')}
              title={isLocked('scorerCapScope') ? lock.message ?? undefined : undefined}
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
              aria-label="Diver scorer weight"
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
              {...lockProps('diverScorerWeight')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max individual scorers / team</label>
            <input
              type="number"
              aria-label="Maximum individual scorers per team"
              value={localSettings.maxIndividualScorersPerTeam}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxIndividualScorersPerTeam: parseInt(e.target.value, 10) || 999,
                })
              }
              {...lockProps('maxIndividualScorersPerTeam')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max scoring relays / team / relay event</label>
            <input
              type="number"
              aria-label="Maximum scoring relays per team per event"
              value={localSettings.maxRelaysScoringPerTeam}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxRelaysScoringPerTeam: parseInt(e.target.value, 10) || 999,
                })
              }
              {...lockProps('maxRelaysScoringPerTeam')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max ind entries / swimmer</label>
            <input
              type="number"
              aria-label="Maximum individual entries per swimmer"
              value={localSettings.maxIndividualEntriesPerSwimmer ?? 999}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxIndividualEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                })
              }
              {...lockProps('maxIndividualEntriesPerSwimmer')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max relay entries / swimmer</label>
            <input
              type="number"
              aria-label="Maximum relay entries per swimmer"
              value={localSettings.maxRelayEntriesPerSwimmer ?? 999}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxRelayEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                })
              }
              {...lockProps('maxRelayEntriesPerSwimmer')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max total entries / swimmer</label>
            <input
              type="number"
              aria-label="Maximum total entries per swimmer"
              value={localSettings.maxTotalEntriesPerSwimmer ?? 999}
              onChange={e =>
                setLocalSettings({
                  ...localSettings,
                  maxTotalEntriesPerSwimmer: parseInt(e.target.value, 10) || 999,
                })
              }
              {...lockProps('maxTotalEntriesPerSwimmer')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Relay multiplier</label>
            <input
              type="number"
              aria-label="Relay multiplier"
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
                aria-label="Half-rate relay swimmers"
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
            <label
              className={`flex items-center gap-2 text-[10px] text-theme-secondary ${
                isLocked('relayEligibleFromScorerPool') ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
              }`}
              title={isLocked('relayEligibleFromScorerPool') ? lock.message ?? undefined : undefined}
            >
              <input
                type="checkbox"
                aria-label="Require relay legs to be in individual scorer pool"
                disabled={isLocked('relayEligibleFromScorerPool')}
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
      <div className="surface-card rounded-xl overflow-hidden shrink-0">
        <div className="flex items-center gap-2 p-4">
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-label={`${open ? 'Collapse' : 'Expand'} custom scoring logic`}
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
    <div className="surface-card rounded-xl p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        {headerTitle}
        {saveButton}
      </div>
      {body}
    </div>
  );
}
