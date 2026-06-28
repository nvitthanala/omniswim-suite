import React, { useEffect, useState } from 'react';
import { X, Save } from 'lucide-react';
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import { fetchScoringPresetList, fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import { GENERIC_TOP16_SETTINGS, mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';

interface Props {
  settings: ScoringSettings;
  onSave: (s: ScoringSettings) => void;
  onClose: () => void;
}

export default function ScoringSettingsModal({ settings, onSave, onClose }: Props) {
  const base = mergeScoringSettings(settings);
  const [places, setPlaces] = useState(base.scoringPoints.length);
  const [points, setPoints] = useState<number[]>([...base.scoringPoints]);
  const [relayMultiplier, setRelayMultiplier] = useState(base.relayMultiplier);
  const [halfRate, setHalfRate] = useState(base.halfRateRelaySwimmer);
  const [maxIndividualScorersPerTeam, setMaxIndividualScorersPerTeam] = useState(
    base.maxIndividualScorersPerTeam
  );
  const [maxRelaysScoringPerTeam, setMaxRelaysScoringPerTeam] = useState(base.maxRelaysScoringPerTeam);
  const [scorerCapScope, setScorerCapScope] = useState<'meet' | 'event'>(base.scorerCapScope ?? 'event');
  const [diverScorerWeight, setDiverScorerWeight] = useState(base.diverScorerWeight ?? 1);
  const [relayPool, setRelayPool] = useState(base.relayEligibleFromScorerPool === true);
  const [maxIndividualEntriesPerSwimmer, setMaxIndividualEntriesPerSwimmer] = useState(
    base.maxIndividualEntriesPerSwimmer ?? 999
  );
  const [maxRelayEntriesPerSwimmer, setMaxRelayEntriesPerSwimmer] = useState(
    base.maxRelayEntriesPerSwimmer ?? 999
  );
  const [presets, setPresets] = useState<ScoringPresetMeta[]>([]);

  useEffect(() => {
    fetchScoringPresetList().then(setPresets).catch(() => setPresets([]));
  }, []);

  const handlePlacesChange = (p: number) => {
    setPlaces(p);
    const newPoints = [...points];
    while (newPoints.length < p) newPoints.push(0);
    setPoints(newPoints.slice(0, p));
  };

  const handlePointChange = (idx: number, val: number) => {
    const newP = [...points];
    newP[idx] = val;
    setPoints(newP);
  };

  const applyPreset = async (presetId: string) => {
    const s = await fetchScoringPresetSettings(presetId);
    handlePlacesChange(s.scoringPoints.length);
    setPoints([...s.scoringPoints]);
    setRelayMultiplier(s.relayMultiplier);
    setHalfRate(s.halfRateRelaySwimmer);
    setMaxIndividualScorersPerTeam(s.maxIndividualScorersPerTeam);
    setMaxRelaysScoringPerTeam(s.maxRelaysScoringPerTeam);
    setScorerCapScope(s.scorerCapScope ?? 'event');
    setDiverScorerWeight(s.diverScorerWeight ?? 1);
    setRelayPool(s.relayEligibleFromScorerPool === true);
    setMaxIndividualEntriesPerSwimmer(s.maxIndividualEntriesPerSwimmer ?? 999);
    setMaxRelayEntriesPerSwimmer(s.maxRelayEntriesPerSwimmer ?? 999);
  };

  const applyGenericTop16 = () => {
    const s = GENERIC_TOP16_SETTINGS;
    handlePlacesChange(s.scoringPoints.length);
    setPoints([...s.scoringPoints]);
    setRelayMultiplier(s.relayMultiplier);
    setHalfRate(s.halfRateRelaySwimmer);
    setMaxIndividualScorersPerTeam(s.maxIndividualScorersPerTeam);
    setMaxRelaysScoringPerTeam(s.maxRelaysScoringPerTeam);
    setScorerCapScope(s.scorerCapScope ?? 'event');
    setDiverScorerWeight(s.diverScorerWeight ?? 1);
    setRelayPool(s.relayEligibleFromScorerPool === true);
    setMaxIndividualEntriesPerSwimmer(s.maxIndividualEntriesPerSwimmer ?? 999);
    setMaxRelayEntriesPerSwimmer(s.maxRelayEntriesPerSwimmer ?? 999);
  };

  const set24Places = () => {
    handlePlacesChange(24);
    setPoints([32, 28, 27, 26, 25, 24, 23, 22, 20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1]);
    setRelayMultiplier(2);
    setHalfRate(true);
  };

  const buildSettings = (): ScoringSettings => ({
    scoringPoints: points,
    relayMultiplier,
    halfRateRelaySwimmer: halfRate,
    maxIndividualScorersPerTeam,
    maxRelaysScoringPerTeam,
    aFinalBracketSize: Math.floor(points.length / 2),
    scorerCapScope,
    diverScorerWeight,
    relayEligibleFromScorerPool: relayPool,
    diverEventPattern: base.diverEventPattern ?? ['DIVING', 'DIVE'],
    maxIndividualEntriesPerSwimmer,
    maxRelayEntriesPerSwimmer,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop backdrop-blur-sm">
      <div className="surface-card rounded-lg p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">Scoring Matrix Configuration</h2>
          <button onClick={onClose} className="text-theme-secondary hover:text-[var(--text-primary)] transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-6 text-sm">
          <div className="flex flex-col gap-3 border-b border-theme-soft pb-6">
            <label className="block text-[10px] text-theme-secondary uppercase tracking-widest font-medium">
              Preset configurations
            </label>
            <select
              className="glass-input text-xs uppercase"
              defaultValue=""
              onChange={e => {
                const id = e.target.value;
                if (id) applyPreset(id);
                e.target.value = '';
              }}
            >
              <option value="">Load preset…</option>
              {presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={applyGenericTop16}
                className="px-3 py-1.5 bg-[var(--surface-muted)] hover:bg-[var(--surface-strong)] text-[var(--text-primary)] rounded text-xs transition-colors border border-theme-soft"
              >
                Generic Top 16
              </button>
              <button
                type="button"
                onClick={set24Places}
                className="px-3 py-1.5 bg-[var(--surface-muted)] hover:bg-[var(--surface-strong)] text-[var(--text-primary)] rounded text-xs transition-colors border border-theme-soft"
              >
                Top 24 points only
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-[10px] text-theme-secondary uppercase tracking-widest font-medium border-b border-theme-soft pb-2">
              Individual points
            </h3>
            <div className="flex items-center gap-4">
              <label className="text-theme-secondary">Scoring places:</label>
              <select
                value={places}
                onChange={e => handlePlacesChange(parseInt(e.target.value, 10))}
                className="glass-input font-mono"
              >
                <option value={8}>8</option>
                <option value={12}>12</option>
                <option value={16}>16</option>
                <option value={20}>20</option>
                <option value={24}>24</option>
              </select>
            </div>
            <div className="grid grid-cols-4 md:grid-cols-6 gap-3 pt-2">
              {points.map((pt, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <span className="text-[10px] text-theme-secondary font-mono">Place {i + 1}</span>
                  <input
                    type="number"
                    value={pt || ''}
                    onChange={e => handlePointChange(i, parseFloat(e.target.value) || 0)}
                    className="glass-input w-full font-mono text-xs"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-theme-soft">
            <h3 className="text-[10px] text-theme-secondary uppercase tracking-widest font-medium pb-2 border-b border-theme-soft">
              Team caps & relays
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-theme-secondary mb-1 text-[10px] uppercase">Scorer cap scope</label>
                <select
                  value={scorerCapScope}
                  onChange={e => setScorerCapScope(e.target.value as 'meet' | 'event')}
                  className="glass-input w-full text-xs"
                >
                  <option value="event">Per event</option>
                  <option value="meet">Full meet</option>
                </select>
              </div>
              <div>
                <label className="block text-theme-secondary mb-1 text-[10px] uppercase">Diver scorer weight</label>
                <input
                  type="number"
                  step="0.01"
                  value={diverScorerWeight}
                  onChange={e => setDiverScorerWeight(parseFloat(e.target.value) || 1)}
                  className="glass-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-theme-secondary mb-1 text-[10px] uppercase">Max individual scorers</label>
                <input
                  type="number"
                  value={maxIndividualScorersPerTeam}
                  onChange={e => setMaxIndividualScorersPerTeam(parseInt(e.target.value, 10) || 999)}
                  className="glass-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-theme-secondary mb-1 text-[10px] uppercase">Max scoring relays / team / relay event</label>
                <input
                  type="number"
                  value={maxRelaysScoringPerTeam}
                  onChange={e => setMaxRelaysScoringPerTeam(parseInt(e.target.value, 10) || 999)}
                  className="glass-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-theme-secondary mb-1 text-[10px] uppercase">Max ind entries / swimmer</label>
                <input
                  type="number"
                  value={maxIndividualEntriesPerSwimmer}
                  onChange={e => setMaxIndividualEntriesPerSwimmer(parseInt(e.target.value, 10) || 999)}
                  className="glass-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-theme-secondary mb-1 text-[10px] uppercase">Max relay entries / swimmer</label>
                <input
                  type="number"
                  value={maxRelayEntriesPerSwimmer}
                  onChange={e => setMaxRelayEntriesPerSwimmer(parseInt(e.target.value, 10) || 999)}
                  className="glass-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-theme-secondary mb-2">Relay multiplier</label>
                <select
                  value={relayMultiplier}
                  onChange={e => setRelayMultiplier(parseFloat(e.target.value))}
                  className="glass-input w-full font-mono"
                >
                  <option value={1}>1x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2x</option>
                  <option value={4}>4x</option>
                </select>
              </div>
              <div className="flex flex-col justify-center gap-2">
                <label className="flex items-center gap-2 text-theme-secondary cursor-pointer text-[10px]">
                  <input type="checkbox" checked={halfRate} onChange={e => setHalfRate(e.target.checked)} className="accent-[var(--text-accent)]" />
                  Half-rate relay swimmers
                </label>
                <label className="flex items-center gap-2 text-theme-secondary cursor-pointer text-[10px]">
                  <input type="checkbox" checked={relayPool} onChange={e => setRelayPool(e.target.checked)} className="accent-[var(--text-accent)]" />
                  Relay legs must be in scorer pool
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="pt-6 mt-2 border-t border-theme-soft flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 theme-hover-row rounded text-theme-secondary transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSave(buildSettings())}
            className="px-6 py-2 bg-[var(--text-accent)] border border-[var(--text-accent)]/25 text-white rounded font-medium flex items-center gap-2"
          >
            <Save size={16} />
            Update scoring model
          </button>
        </div>
      </div>
    </div>
  );
}
