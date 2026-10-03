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
import { ScoringPresetMeta, ScoringSettings } from '@omniswim/core/types';
import { fetchScoringPresetList, fetchScoringPresetSettings } from '@omniswim/core/lib/scoringPresets';
import {
  GENERIC_TOP16_SETTINGS,
  HostPublishedTableRequiredError,
  mergeScoringSettings,
  scoringSettingsLock,
} from '@omniswim/core/lib/scoringDefaults';
import { ScoringViewBanner, ScoringLockBanner, SuggestedPresetBanner } from './ScoringSettingsBanners';
import { ScoringPresetPicker } from './ScoringPresetPicker';
import { ScoringCapsFields } from './ScoringCapsFields';
import { RelayScoringFields, DivingPointsFields, PerEventCapsFields } from './ScoringOptionalTablesFields';

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
  /**
   * The SAVED settings already resolve to PDF place points (an explicit On, or Auto with PDF
   * points in the results). Kept for hosts that cannot say more. When
   * `resultsCarryPdfPlacePoints` is given it decides the Auto case instead, because this flag
   * also reads true for a saved explicit On that the draft has since switched to Auto.
   */
  pdfPlacePointsLocked?: boolean;
  /**
   * The results themselves carry HyTek place points, independent of any saved setting. Lets the
   * dialog resolve a draft Auto the moment it is picked, before anything is saved.
   */
  resultsCarryPdfPlacePoints?: boolean;
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
  pdfPlacePointsLocked = false,
  resultsCarryPdfPlacePoints,
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

  // Reset the edited copy only when the incoming settings change in content.
  // A parent that rebuilds an equal object each render (a toast, a toggle)
  // must not wipe unsaved edits, so key on the serialised value, not identity.
  const settingsKey = JSON.stringify(settings);
  useEffect(() => {
    setLocal(mergeScoringSettings(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settingsKey is the content identity of `settings`
  }, [settingsKey]);

  useEffect(() => {
    fetchScoringPresetList().then(setPresets).catch(() => setPresets([]));
  }, [presetListRefreshToken]);

  // Read the dialog's live choice, not the saved one: an explicit On locks, an
  // explicit Off unlocks in the same session, and Auto falls back to whether the
  // results carry PDF place points (the saved lock only when the host cannot say).
  const autoResolvesToPdf = resultsCarryPdfPlacePoints ?? pdfPlacePointsLocked;
  const pdfPointsLock =
    local.usePdfPlacePoints === true ||
    ((local.usePdfPlacePoints == null || local.usePdfPlacePoints === 'auto') && autoResolvesToPdf);

  // Which controls the engine will overwrite regardless of what's edited here. When the PDF
  // regime is in force the engine ignores the scorer-pool fields (caps, scope, diver weight,
  // relay eligibility) even under Auto, so ask the lock for that regime explicitly.
  const lock = useMemo(
    () => scoringSettingsLock(pdfPointsLock ? { ...local, usePdfPlacePoints: true } : local, { conference }),
    [local, conference, pdfPointsLock]
  );
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
        <ScoringViewBanner scoringView={resolvedScoringView} onScoringViewChange={onScoringViewChange} />
      ) : null}

      {lock.message ? <ScoringLockBanner message={lock.message} /> : null}

      {suggestedPresetId ? (
        <SuggestedPresetBanner
          suggestedPresetId={suggestedPresetId}
          onLoadAndSave={() => {
            // A rejected fetch must not surface as an unhandled rejection. The banner
            // stays so the user can try again; nothing is applied or saved.
            fetchScoringPresetSettings(suggestedPresetId)
              .then(s => {
                const next = applySettings(s);
                setSelectedPreset(suggestedPresetId);
                onApplyAndSaveSuggestedPreset?.(next);
              })
              .catch(err => {
                console.warn(`Could not load the suggested scoring preset "${suggestedPresetId}".`, err);
              });
          }}
        />
      ) : null}

      <div className="space-y-4">
        <div>
          <label className="block text-ui-caption text-theme-secondary mb-1">Scorer eligibility</label>
          <select
            aria-label="Scorer eligibility"
            className="glass-input w-full text-xs"
            value={pdfPointsLock ? 'points_pool' : local.scorerEligibilityMode ?? 'points_pool'}
            disabled={pdfPointsLock}
            title={pdfPointsLock ? 'PDF place points require Points pool eligibility.' : undefined}
            onChange={e => update({ scorerEligibilityMode: e.target.value as ScoringSettings['scorerEligibilityMode'] })}
          >
            <option value="roster">Team scorer list</option>
            <option value="points_pool">Points pool</option>
          </select>
          {pdfPointsLock ? <p className="mt-1 text-ui-caption text-theme-muted">PDF place points require Points pool eligibility.</p> : null}
        </div>
        <div>
          <label className="block text-ui-caption text-theme-secondary mb-1">PDF place points</label>
          <select
            className="glass-input w-full text-xs"
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
          <ScoringPresetPicker
            presets={presets}
            selectedPreset={selectedPreset}
            onSelectPreset={id => {
              setSelectedPreset(id);
              if (id) void applyPreset(id);
              else setHostTableRequired(null);
            }}
            onApplyGenericTop16={applyGenericTop16}
            onApplyTop24={applyTop24}
            presetPickerExtra={presetPickerExtra}
            hostTableRequired={hostTableRequired}
          />
        ) : null}

        <div>
          <div className="flex items-center gap-3 mb-1">
            <label className="text-ui-caption text-theme-secondary">Scoring places</label>
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

        <ScoringCapsFields local={local} update={update} lock={{ message: lock.message, isLocked, lockProps }} />

        <RelayScoringFields relayTable={relayTable} />

        <DivingPointsFields
          divingTable={divingTable}
          divingMaxScorersPerTeamPerEvent={local.divingMaxScorersPerTeamPerEvent}
          onChangeMaxScorers={value => update({ divingMaxScorersPerTeamPerEvent: value })}
        />

        <PerEventCapsFields
          maxIndividualScorersPerTeamPerEvent={local.maxIndividualScorersPerTeamPerEvent}
          onChangeMaxIndividualScorersPerTeamPerEvent={value => update({ maxIndividualScorersPerTeamPerEvent: value })}
          overCapPlaceBehavior={local.overCapPlaceBehavior}
          onChangeOverCapPlaceBehavior={value => update({ overCapPlaceBehavior: value })}
          showConflictWarning={
            local.maxIndividualScorersPerTeamPerEvent != null &&
            local.scorerCapScope === 'meet' &&
            local.maxIndividualScorersPerTeam < 999
          }
        />
      </div>
    </>
  );
}
