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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Badge, Button, SegmentedControl } from '@omniswim/ui';
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import { fetchScoringPresetList, fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import {
  GENERIC_TOP16_SETTINGS,
  HostPublishedTableRequiredError,
  mergeScoringSettings,
  scoringSettingsLock,
} from '@omniswim/core/lib/scoringDefaults';

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
  /** Hides the "Scoring preset" picker and its quick-preset buttons — set when this form is embedded inside the preset-authoring editor itself, where a nested picker would be confusing (editing preset B by picking preset A makes no sense). */
  hidePresetPicker?: boolean;
  /** Rendered next to the preset picker's label, e.g. a "Manage rule sets…" link into full CRUD. Ignored when `hidePresetPicker` is set. */
  presetPickerExtra?: ReactNode;
  /** Bump to refetch the preset list — e.g. after `ScoringPresetManagerModal` saves or deletes one. Ignored on initial mount (that fetch always runs). */
  presetListRefreshToken?: number;
}

export function ScoringSettingsFields({
  settings,
  onChange,
  conference,
  scoringView,
  onScoringViewChange,
  suggestedPresetId,
  onApplyAndSaveSuggestedPreset,
  hidePresetPicker = false,
  presetPickerExtra,
  presetListRefreshToken,
}: ScoringSettingsFieldsProps) {
  const [local, setLocal] = useState<ScoringSettings>(() => mergeScoringSettings(settings));
  const [presets, setPresets] = useState<ScoringPresetMeta[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  /**
   * Set when the chosen preset is an NCAA invitational format (Rule 7-4): the
   * NCAA publishes no table for it, so there is nothing to apply. `local`
   * stays exactly as it was — the coach edits the points fields below by hand
   * from the host's own published sheet, never from an invented default.
   */
  const [hostTableRequired, setHostTableRequired] = useState<{ citation: string; message: string } | null>(
    null
  );

  useEffect(() => {
    setLocal(mergeScoringSettings(settings));
  }, [settings]);

  useEffect(() => {
    fetchScoringPresetList().then(setPresets).catch(() => setPresets([]));
  }, [presetListRefreshToken]);

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
    try {
      const s = await fetchScoringPresetSettings(presetId);
      setHostTableRequired(null);
      applySettings(s);
      setSelectedPreset(presetId);
    } catch (err) {
      if (err instanceof HostPublishedTableRequiredError) {
        // Nothing to apply — leave `local` untouched and say why instead.
        setSelectedPreset(presetId);
        setHostTableRequired({ citation: err.citation, message: err.message });
        return;
      }
      throw err;
    }
  };

  const applyGenericTop16 = () => {
    applySettings(GENERIC_TOP16_SETTINGS);
    setSelectedPreset('');
    setHostTableRequired(null);
  };

  const applyTop24 = () => {
    update({
      ...withScoringPoints(TOP_24_POINTS),
      relayMultiplier: 2,
      halfRateRelaySwimmer: true,
    });
    setSelectedPreset('');
    setHostTableRequired(null);
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

  /** Reader/writer pair for an optional points table field (`relayPoints`, `divingPoints`). */
  function optionalPointsField(key: 'relayPoints' | 'divingPoints') {
    const points = local[key] ?? [];
    const setPoints = (next: number[] | undefined) => update({ [key]: next } as Partial<ScoringSettings>);
    return {
      points,
      enabled: (local[key]?.length ?? 0) > 0,
      enable: () => setPoints(points.length ? points : [0]),
      disable: () => setPoints(undefined),
      setCount: (count: number) => {
        const next = [...points];
        while (next.length < count) next.push(0);
        setPoints(next.slice(0, Math.max(1, count)));
      },
      setPoint: (index: number, value: number) => {
        const next = [...points];
        next[index] = value;
        setPoints(next);
      },
    };
  }

  const relayTable = optionalPointsField('relayPoints');
  const divingTable = optionalPointsField('divingPoints');

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

        {!hidePresetPicker ? (
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className="block text-[10px] text-theme-secondary uppercase">Scoring preset</label>
              {presetPickerExtra}
            </div>
            <div className="flex flex-wrap gap-2 items-start">
              <select
                className="glass-input flex-1 min-w-[10rem] text-xs uppercase"
                aria-label="Scoring preset"
                value={selectedPreset}
                onChange={e => {
                  const id = e.target.value;
                  setSelectedPreset(id);
                  if (id) void applyPreset(id);
                  else setHostTableRequired(null);
                }}
              >
                <option value="">Custom (current fields)</option>
                {presets.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.builtIn ? '' : ' (saved)'}
                  </option>
                ))}
              </select>
              <Button variant="outline" size="sm" onClick={applyGenericTop16} className="shrink-0">
                Generic Top 16
              </Button>
              <Button variant="outline" size="sm" onClick={applyTop24} className="shrink-0">
                Top 24 points only
              </Button>
            </div>
            {(() => {
              const selected = presets.find(p => p.id === selectedPreset);
              if (!selectedPreset || !selected) return null;
              return (
                <div className="mt-1.5 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {selected.builtIn ? <Badge tone="neutral">Built-in</Badge> : <Badge tone="accent">Saved</Badge>}
                    {selected.citation ? <Badge tone="info">{selected.citation}</Badge> : null}
                    {selected.requiresHostPublishedTable ? (
                      <Badge tone="warning">Host publishes this table</Badge>
                    ) : null}
                  </div>
                  {selected.description ? (
                    <p className="text-[9px] text-theme-secondary italic">{selected.description}</p>
                  ) : null}
                  {hostTableRequired ? (
                    <div className="p-2 rounded-lg badge-warning text-[10px] normal-case tracking-normal leading-relaxed">
                      <span className="font-medium">No points table applied.</span> {hostTableRequired.citation}{' '}
                      leaves this format&apos;s scoring to the host institution — the NCAA publishes no table for
                      it. Enter the host&apos;s published points below; nothing here is a guess.
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </div>
        ) : null}

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
              {...lockProps('relayMultiplier')}
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

        <div className="p-3 rounded-lg border border-theme-soft surface-overlay">
          <div className="flex items-center justify-between gap-2 mb-1">
            <label className="text-[10px] text-theme-secondary uppercase font-medium">Relay scoring</label>
            <SegmentedControl
              layout="inline"
              ariaLabel="Relay scoring mode"
              value={relayTable.enabled ? 'table' : 'multiplier'}
              onChange={v => (v === 'table' ? relayTable.enable() : relayTable.disable())}
              options={[
                { value: 'multiplier', label: 'Multiplier', ariaLabel: 'Score relays from the relay multiplier' },
                { value: 'table', label: 'Explicit table', ariaLabel: 'Score relays from an explicit relay place table' },
              ]}
            />
          </div>
          {relayTable.enabled ? (
            <>
              <p className="text-[9px] text-theme-muted mb-2 normal-case tracking-normal">
                This rule set carries its own relay place table — relays score from these values directly, and the
                relay multiplier above is ignored (shown disabled). Right for a dual meet: NCAA Rule 7-1-1 scores
                relays 11-4-2, not individual 9-4-3-2-1 doubled.
              </p>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[9px] text-theme-secondary font-mono">Relay places</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  aria-label="Number of relay scoring places"
                  value={relayTable.points.length}
                  onChange={e => relayTable.setCount(parseInt(e.target.value, 10) || 1)}
                  className="glass-input w-20 font-mono text-xs"
                />
              </div>
              <div className="grid grid-cols-4 md:grid-cols-6 gap-3">
                {relayTable.points.map((pt, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <span className="text-[9px] text-theme-secondary font-mono">Place {i + 1}</span>
                    <input
                      type="number"
                      aria-label={`Relay points for place ${i + 1}`}
                      value={pt || ''}
                      onChange={e => relayTable.setPoint(i, parseFloat(e.target.value) || 0)}
                      className="glass-input w-full font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-[9px] text-theme-muted normal-case tracking-normal">
              Relays score as {`scoringPoints[place] × relayMultiplier`} (correct for championship formats, where
              the relay table is exactly double the individual one). Switch to an explicit table for a dual meet or
              any format whose relay values are not simply doubled.
            </p>
          )}
        </div>

        <div className="p-3 rounded-lg border border-theme-soft surface-overlay">
          <div className="flex items-center justify-between gap-2 mb-1">
            <label className="text-[10px] text-theme-secondary uppercase font-medium">Diving points table</label>
            <SegmentedControl
              layout="inline"
              ariaLabel="Diving points table"
              value={divingTable.enabled ? 'table' : 'none'}
              onChange={v => (v === 'table' ? divingTable.enable() : divingTable.disable())}
              options={[
                { value: 'none', label: 'None', ariaLabel: 'No separate diving points table' },
                { value: 'table', label: 'Explicit table', ariaLabel: 'Score diving from its own place table' },
              ]}
            />
          </div>
          {divingTable.enabled ? (
            <>
              <p className="text-[9px] text-theme-muted mb-2 normal-case tracking-normal">
                Diving scores from this table by place instead of the diver scorer weight below (e.g. NCAA Rule
                7-1-4 dual diving: 7-1 for three or fewer divers, 12-1 for six or more).
              </p>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[9px] text-theme-secondary font-mono">Diving places</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  aria-label="Number of diving scoring places"
                  value={divingTable.points.length}
                  onChange={e => divingTable.setCount(parseInt(e.target.value, 10) || 1)}
                  className="glass-input w-20 font-mono text-xs"
                />
              </div>
              <div className="grid grid-cols-4 md:grid-cols-6 gap-3">
                {divingTable.points.map((pt, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <span className="text-[9px] text-theme-secondary font-mono">Place {i + 1}</span>
                    <input
                      type="number"
                      aria-label={`Diving points for place ${i + 1}`}
                      value={pt || ''}
                      onChange={e => divingTable.setPoint(i, parseFloat(e.target.value) || 0)}
                      className="glass-input w-full font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <label className="block text-[10px] text-theme-secondary uppercase mb-1">
                  Max scoring divers / team / event
                </label>
                <input
                  type="number"
                  aria-label="Maximum scoring divers per team per diving event"
                  value={local.divingMaxScorersPerTeamPerEvent ?? ''}
                  placeholder="No separate cap"
                  onChange={e => {
                    const raw = e.target.value;
                    update({ divingMaxScorersPerTeamPerEvent: raw === '' ? undefined : parseInt(raw, 10) || undefined });
                  }}
                  className="glass-input w-full font-mono text-xs"
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="p-3 rounded-lg border border-theme-soft surface-overlay">
          <label className="block text-[10px] text-theme-secondary uppercase font-medium mb-2">
            Per-team, per-event scoring caps
          </label>
          <p className="text-[9px] text-theme-muted mb-2 normal-case tracking-normal">
            Independent of the meet/event scorer pool above — this caps how many of one team&apos;s swimmers can
            score places in a single event, per NCAA Rule 7-2 (e.g. best 2 per team in a dual). Cannot be combined
            with a full-meet scorer pool scope; the server rejects that combination.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-theme-secondary uppercase mb-1">
                Max individual scorers / team / event
              </label>
              <input
                type="number"
                aria-label="Maximum individual scorers per team per event"
                value={local.maxIndividualScorersPerTeamPerEvent ?? ''}
                placeholder="No per-event cap"
                onChange={e => {
                  const raw = e.target.value;
                  update({
                    maxIndividualScorersPerTeamPerEvent: raw === '' ? undefined : parseInt(raw, 10) || undefined,
                  });
                }}
                className="glass-input w-full font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] text-theme-secondary uppercase mb-1">
                Over-cap swimmer behavior
              </label>
              <select
                className="glass-input w-full text-xs uppercase"
                aria-label="Behavior for a swimmer over the per-team place cap"
                value={local.overCapPlaceBehavior ?? 'holds-place'}
                onChange={e =>
                  update({ overCapPlaceBehavior: e.target.value as 'holds-place' | 'removed-from-consideration' })
                }
              >
                <option value="holds-place">Holds place (later teammates still move up)</option>
                <option value="removed-from-consideration">Removed from consideration</option>
              </select>
            </div>
          </div>
          {local.maxIndividualScorersPerTeamPerEvent != null &&
          local.scorerCapScope === 'meet' &&
          local.maxIndividualScorersPerTeam < 999 ? (
            <p className="mt-2 p-2 rounded-lg badge-warning text-[9px] normal-case tracking-normal">
              A per-event place cap cannot be combined with a full-meet scorer pool (&quot;Scorer cap scope&quot; =
              Full meet, with the max individual scorers below 999). Saving this will be rejected — switch scorer
              cap scope to &quot;Per event&quot; or clear the meet-wide cap.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
