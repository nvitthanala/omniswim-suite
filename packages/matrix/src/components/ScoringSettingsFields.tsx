/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The scoring-settings form fields shared by `ScoringSettingsPanel.tsx`
 * (inline, collapsible, reached from Matrix's own Score step) and
 * `ScoringSettingsModal.tsx` (a full-screen dialog, reached from the shell's
 * "Suite Settings" menu). Both used to hand-maintain their own independent
 * copy of every field — not cosmetic duplication, an active risk: a field
 * added to one editor and not the other silently stopped being editable from
 * whichever entry point a coach happened to use. Confirmed real, not
 * hypothetical, by this merge itself: `usePdfPlacePoints` existed in the
 * Panel only — a coach opening Suite Settings could never toggle it.
 *
 * This component owns every field and the state behind it. Each host keeps
 * its own chrome (collapsible section vs. full-screen dialog), its own
 * save/cancel affordance, and decides when to actually persist — this
 * component only reports the live-edited draft via `onChange`, exactly like
 * a controlled form input reports its own value.
 *
 * ## Points-editing: one design, adopted from the Modal
 *
 * The Panel previously edited `scoringPoints` as a single free-typed
 * comma-separated string, parsed on save. The Modal edited it as a
 * places-count select plus one number input per place, with two one-click
 * presets (Generic Top 16, Top 24 points only). The array-based UI is
 * adopted here for both hosts: it cannot produce an unparseable value, shows
 * every place's number instead of asking a coach to hand-count a string, and
 * the quick-preset buttons carry over intact. This is a real, visible change
 * for the Panel's own users, not a silent one — recorded here rather than
 * left implicit.
 */
import { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { SegmentedControl } from '@omniswim/ui';
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import { fetchScoringPresetList, fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import { GENERIC_TOP16_SETTINGS, mergeScoringSettings, scoringSettingsLock } from '@omniswim/core/lib/scoringDefaults';

const PLACE_COUNT_OPTIONS = [8, 12, 16, 20, 24];
const TOP_24_POINTS = [32, 28, 27, 26, 25, 24, 23, 22, 20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

/**
 * A places count change must recompute `aFinalBracketSize` (half the
 * scoring places, per the field's own convention) in the same update — the
 * old Modal deferred this to a save-time `Math.floor(points.length / 2)`
 * build step that ran no matter which button changed the count, so every
 * points-length-changing action here goes through this helper instead of
 * setting `scoringPoints` on its own, to keep that same guarantee.
 */
function withScoringPoints(points: number[]): Pick<ScoringSettings, 'scoringPoints' | 'aFinalBracketSize'> {
  return { scoringPoints: points, aFinalBracketSize: Math.floor(points.length / 2) };
}

export interface ScoringSettingsFieldsProps {
  settings: ScoringSettings;
  /** Fires on every field edit with the full, current draft. Does not imply a save — each host decides when to persist. */
  onChange: (next: ScoringSettings) => void;
  /** Decides which fields the engine will overwrite regardless of what's edited here — without it every field reads as freely editable when some are not. */
  conference?: string;
  /** Workspace-level scoring view (absent = 'merged'); omit the callback to hide the toggle entirely. */
  scoringView?: 'merged' | 'pdf_only';
  onScoringViewChange?: (view: 'merged' | 'pdf_only') => void;
  /** Shown as a dismissible banner above the fields when set — the meet-import flow's own suggestion, not something Suite Settings ever has. */
  suggestedPresetId?: string | null;
  /** "Load & save": applies the suggested preset AND asks the host to persist immediately, in one action — the one place this component's edits bypass the normal "wait for the host's own Save" flow, matching the Panel's original one-click convenience. */
  onApplyAndSaveSuggestedPreset?: (next: ScoringSettings) => void;
}

export function ScoringSettingsFields({
  settings,
  onChange,
  conference,
  scoringView,
  onScoringViewChange,
  suggestedPresetId,
  onApplyAndSaveSuggestedPreset,
}: ScoringSettingsFieldsProps) {
  const [local, setLocal] = useState<ScoringSettings>(() => mergeScoringSettings(settings));
  const [presets, setPresets] = useState<ScoringPresetMeta[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');

  useEffect(() => {
    setLocal(mergeScoringSettings(settings));
  }, [settings]);

  useEffect(() => {
    fetchScoringPresetList().then(setPresets).catch(() => setPresets([]));
  }, []);

  // Which controls the engine will overwrite regardless of what's edited here.
  const lock = useMemo(() => scoringSettingsLock(local, { conference }), [local, conference]);
  const lockedKeys = useMemo(() => new Set<string>(lock.keys as readonly string[]), [lock]);
  const isLocked = (key: keyof ScoringSettings) => lockedKeys.has(key as string);
  const lockProps = (key: keyof ScoringSettings) =>
    isLocked(key)
      ? {
          disabled: true,
          title: lock.message ?? 'Fixed by competition rule',
          className: 'glass-input w-full text-xs opacity-60 cursor-not-allowed',
        }
      : { className: 'glass-input w-full text-xs' };

  const update = (patch: Partial<ScoringSettings>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  };

  const applySettings = (s: ScoringSettings) => {
    const next = mergeScoringSettings(s, { conference });
    setLocal(next);
    onChange(next);
    return next;
  };

  const applyPreset = async (presetId: string) => {
    const s = await fetchScoringPresetSettings(presetId);
    applySettings(s);
    setSelectedPreset(presetId);
  };

  const applyGenericTop16 = () => {
    applySettings(GENERIC_TOP16_SETTINGS);
    setSelectedPreset('');
  };

  const applyTop24 = () => {
    update({
      ...withScoringPoints(TOP_24_POINTS),
      relayMultiplier: 2,
      halfRateRelaySwimmer: true,
    });
    setSelectedPreset('');
  };

  const handlePlacesChange = (count: number) => {
    const nextPoints = [...local.scoringPoints];
    while (nextPoints.length < count) nextPoints.push(0);
    update(withScoringPoints(nextPoints.slice(0, count)));
  };

  const handlePointChange = (index: number, value: number) => {
    const nextPoints = [...local.scoringPoints];
    nextPoints[index] = value;
    update({ scoringPoints: nextPoints });
  };

  const resolvedScoringView = scoringView ?? 'merged';

  return (
    <>
      {onScoringViewChange ? (
        <div className="mb-4 p-3 rounded-lg border border-theme-soft surface-overlay">
          <label className="block text-[10px] text-theme-secondary uppercase tracking-widest font-medium mb-2">
            Scoring view
          </label>
          <SegmentedControl
            layout="inline"
            ariaLabel="Scoring view"
            value={resolvedScoringView}
            onChange={onScoringViewChange}
            options={[
              {
                value: 'merged',
                label: 'Merged',
                ariaLabel: 'Use merged scoring view',
                title: "Imported/planned/recruit entries remap onto the loaded meet's events and compete for points",
              },
              {
                value: 'pdf_only',
                label: 'PDF only',
                ariaLabel: 'Use PDF-only scoring view',
                title: 'Plans and recruits are excluded from scoring — original PDF-base scoring only',
              },
            ]}
          />
          <p className="text-[9px] text-theme-muted mt-2 normal-case tracking-normal">
            {resolvedScoringView === 'merged'
              ? 'Plans, imports, and recruits remap onto the loaded meet and compete for points.'
              : 'Plans and recruits are excluded from scoring — only the original meet results score.'}
          </p>
        </div>
      ) : null}

      {lock.message ? (
        <div className="mb-4 p-3 rounded-lg border border-theme-soft surface-overlay flex items-start gap-2">
          <Lock size={12} className="text-theme-muted mt-0.5 shrink-0" aria-hidden />
          <p className="text-[10px] text-theme-secondary leading-relaxed normal-case tracking-normal">
            {lock.message}
            <span className="text-theme-muted">
              {' '}
              Editing them here would have no effect, so they are shown fixed rather than accepting a
              change that is discarded before scoring.
            </span>
          </p>
        </div>
      ) : null}

      {suggestedPresetId ? (
        <div className="mb-4 p-3 rounded badge-warning text-[10px]">
          <span className="uppercase tracking-widest font-medium">Suggested preset: </span>
          {suggestedPresetId}
          <button
            type="button"
            className="ml-2 underline hover:text-[var(--text-primary)]"
            onClick={() => {
              void fetchScoringPresetSettings(suggestedPresetId).then(s => {
                const next = applySettings(s);
                setSelectedPreset(suggestedPresetId);
                onApplyAndSaveSuggestedPreset?.(next);
              });
            }}
            aria-label={`Load and save suggested ${suggestedPresetId} scoring preset`}
          >
            Load & save
          </button>
        </div>
      ) : null}

      <div className="space-y-4">
        <div>
          <label className="block text-[10px] text-theme-secondary uppercase mb-1">PDF place points</label>
          <select
            className="glass-input w-full text-xs uppercase"
            aria-label="PDF place points setting"
            value={local.usePdfPlacePoints === true ? 'on' : local.usePdfPlacePoints === false ? 'off' : 'auto'}
            onChange={e => {
              const v = e.target.value;
              update({ usePdfPlacePoints: v === 'on' ? true : v === 'off' ? false : 'auto' });
            }}
          >
            <option value="auto">Auto (detect from PDF)</option>
            <option value="on">On (use HyTek Points column)</option>
            <option value="off">Off (engine scoring only)</option>
          </select>
        </div>

        <div>
          <label className="block text-[10px] text-theme-secondary uppercase mb-1">Scoring preset</label>
          <div className="flex flex-wrap gap-2 items-start">
            <select
              className="glass-input flex-1 min-w-[10rem] text-xs uppercase"
              aria-label="Scoring preset"
              value={selectedPreset}
              onChange={e => {
                const id = e.target.value;
                setSelectedPreset(id);
                if (id) void applyPreset(id);
              }}
            >
              <option value="">Custom (current fields)</option>
              {presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={applyGenericTop16}
              className="px-3 py-1.5 bg-[var(--surface-muted)] hover:bg-[var(--surface-strong)] text-[var(--text-primary)] rounded-lg text-xs transition-colors border border-theme-soft shrink-0"
            >
              Generic Top 16
            </button>
            <button
              type="button"
              onClick={applyTop24}
              className="px-3 py-1.5 bg-[var(--surface-muted)] hover:bg-[var(--surface-strong)] text-[var(--text-primary)] rounded-lg text-xs transition-colors border border-theme-soft shrink-0"
            >
              Top 24 points only
            </button>
          </div>
          {selectedPreset && presets.find(p => p.id === selectedPreset)?.description ? (
            <p className="text-[9px] text-theme-secondary mt-1 italic">
              {presets.find(p => p.id === selectedPreset)?.description}
            </p>
          ) : null}
        </div>

        <div>
          <div className="flex items-center gap-3 mb-1">
            <label className="text-[10px] text-theme-secondary uppercase">Scoring places</label>
            <select
              value={local.scoringPoints.length}
              onChange={e => handlePlacesChange(parseInt(e.target.value, 10))}
              className="glass-input font-mono text-xs"
              aria-label="Number of scoring places"
            >
              {PLACE_COUNT_OPTIONS.map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-4 md:grid-cols-6 gap-3 pt-1">
            {local.scoringPoints.map((pt, i) => (
              <div key={i} className="flex flex-col gap-1">
                <span className="text-[9px] text-theme-secondary font-mono">Place {i + 1}</span>
                <input
                  type="number"
                  aria-label={`Points for place ${i + 1}`}
                  value={pt || ''}
                  onChange={e => handlePointChange(i, parseFloat(e.target.value) || 0)}
                  className="glass-input w-full font-mono text-xs"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Scorer cap scope</label>
            <select
              className={`glass-input w-full text-xs uppercase${isLocked('scorerCapScope') ? ' opacity-60 cursor-not-allowed' : ''}`}
              aria-label="Scorer cap scope"
              disabled={isLocked('scorerCapScope')}
              title={isLocked('scorerCapScope') ? lock.message ?? undefined : undefined}
              value={local.scorerCapScope ?? 'event'}
              onChange={e => update({ scorerCapScope: e.target.value as 'meet' | 'event' })}
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
              value={local.diverScorerWeight ?? 1}
              onChange={e => update({ diverScorerWeight: parseFloat(e.target.value) || 1 })}
              {...lockProps('diverScorerWeight')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max individual scorers / team</label>
            <input
              type="number"
              aria-label="Maximum individual scorers per team"
              value={local.maxIndividualScorersPerTeam}
              onChange={e => update({ maxIndividualScorersPerTeam: parseInt(e.target.value, 10) || 999 })}
              {...lockProps('maxIndividualScorersPerTeam')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max scoring relays / team / relay event</label>
            <input
              type="number"
              aria-label="Maximum scoring relays per team per event"
              value={local.maxRelaysScoringPerTeam}
              onChange={e => update({ maxRelaysScoringPerTeam: parseInt(e.target.value, 10) || 999 })}
              {...lockProps('maxRelaysScoringPerTeam')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max ind entries / swimmer</label>
            <input
              type="number"
              aria-label="Maximum individual entries per swimmer"
              value={local.maxIndividualEntriesPerSwimmer ?? 999}
              onChange={e => update({ maxIndividualEntriesPerSwimmer: parseInt(e.target.value, 10) || 999 })}
              {...lockProps('maxIndividualEntriesPerSwimmer')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max relay entries / swimmer</label>
            <input
              type="number"
              aria-label="Maximum relay entries per swimmer"
              value={local.maxRelayEntriesPerSwimmer ?? 999}
              onChange={e => update({ maxRelayEntriesPerSwimmer: parseInt(e.target.value, 10) || 999 })}
              {...lockProps('maxRelayEntriesPerSwimmer')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Max total entries / swimmer</label>
            <input
              type="number"
              aria-label="Maximum total entries per swimmer"
              value={local.maxTotalEntriesPerSwimmer ?? 999}
              onChange={e => update({ maxTotalEntriesPerSwimmer: parseInt(e.target.value, 10) || 999 })}
              {...lockProps('maxTotalEntriesPerSwimmer')}
            />
          </div>
          <div>
            <label className="block text-[10px] text-theme-secondary uppercase mb-1">Relay multiplier</label>
            <input
              type="number"
              aria-label="Relay multiplier"
              value={local.relayMultiplier}
              onChange={e => update({ relayMultiplier: parseFloat(e.target.value) || 1 })}
              className="glass-input w-full text-xs"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-[10px] text-theme-secondary cursor-pointer">
              <input
                type="checkbox"
                aria-label="Half-rate relay swimmers"
                checked={local.halfRateRelaySwimmer}
                onChange={e => update({ halfRateRelaySwimmer: e.target.checked })}
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
                checked={local.relayEligibleFromScorerPool === true}
                onChange={e => update({ relayEligibleFromScorerPool: e.target.checked })}
                className="accent-[var(--text-accent)]"
              />
              Relays only if all legs are in individual scorer pool
            </label>
          </div>
        </div>
      </div>
    </>
  );
}
