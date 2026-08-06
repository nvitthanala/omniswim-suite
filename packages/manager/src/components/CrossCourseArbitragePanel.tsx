/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-course arbitrage side panel for the roster Lineup step. Read-only. Primary
 * section: exact points-positive 1-for-1 swap suggestions — is each swimmer's current
 * lineup optimal, or can they score more in another event? Supporting sections:
 * converted-time upgrades (LCM/SCM swims whose SCY conversion beats the actual SCY
 * best — these feed the swap candidate pool) and thin event coverage gaps. Computed
 * off the main thread via requestCrossCourseArbitrage (see
 * @omniswim/core/lib/crossCourseArbitrageClient), debounced and stale-response
 * guarded so rapid what-if edits don't stampede the worker.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Gauge,
  Plus,
  Repeat,
  Repeat2,
  Undo2,
  Users,
} from 'lucide-react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { requestCrossCourseArbitrage } from '@omniswim/core/lib/crossCourseArbitrageClient';
import {
  AthleteButton,
  Section,
  ShowAllToggle,
  StalePill,
  VerifyPill,
} from './crossCourseArbitrageParts';
import {
  courseEdges,
  formatMargin,
  formatPoints,
  groupRelaySwaps,
  groupSwaps,
} from './crossCourseArbitrageView';
import {
  applyEntryAdd,
  applyEntryDrop,
  applyExactSwap,
  applyRelayLegSwap,
  rankRelayLegSwaps,
  type AddOnlyRow,
  type CoverageGap,
  type CrossCourseArbitrageResult,
  type DropOnlyRow,
  type ExactSwap,
  type RelayLegSwap,
  type RelayLegSwapRanking,
} from '@omniswim/core/lib/crossCourseArbitrage';
import {
  suggestRelayAlternatePromotions,
  type RelayAlternateReason,
  type RelayAlternatePromotion,
} from '@omniswim/core/lib/scoringTheory';
import { relayStrokeForIndex } from '@omniswim/core/lib/relayLegMatching';
import { LoadingSpinner, useToast } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  settings: ScoringSettings;
  onJumpAthlete?: (name: string) => void;
  /** When provided together with `canApply`, swap rows get a one-click Apply button. */
  onUpdate?: (patch: Partial<Workspace>) => void;
  /** Gate for the Apply affordance — typically the step's what-if mode flag. */
  canApply?: boolean;
};


const DEBOUNCE_MS = 300;
const EDGES_DEFAULT_LIMIT = 8;
const SWAPS_DEFAULT_LIMIT = 10;
const GAPS_DEFAULT_LIMIT = 8;
const RELAY_SWAPS_DEFAULT_LIMIT = 10;
const DROPS_DEFAULT_LIMIT = 8;
const ADDS_DEFAULT_LIMIT = 8;

const DROP_SOURCE_LABEL: Record<ExactSwap['dropSource'], string> = {
  plan: 'planned',
  result: 'meet entry',
  recruit: 'recruit',
};

const RELAY_ALTERNATE_REASON_LABEL: Record<RelayAlternateReason, string> = {
  soft_removed: 'soft-removed',
  over_entry_cap: 'over entry cap',
  missing_from_roster: 'off roster',
};


export default function CrossCourseArbitragePanel({
  workspace,
  gender,
  team,
  settings,
  onJumpAthlete,
  onUpdate,
  canApply,
}: Props) {
  const toast = useToast();
  const [result, setResult] = useState<CrossCourseArbitrageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edgesExpanded, setEdgesExpanded] = useState(false);
  const [swapsExpanded, setSwapsExpanded] = useState(false);
  const [relaySwapsExpanded, setRelaySwapsExpanded] = useState(false);
  const [dropsExpanded, setDropsExpanded] = useState(false);
  const [addsExpanded, setAddsExpanded] = useState(false);
  const [relayRanking, setRelayRanking] = useState<RelayLegSwapRanking | null>(null);
  const [relayPromotions, setRelayPromotions] = useState<RelayAlternatePromotion[]>([]);
  const [lastApplied, setLastApplied] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  const requestSeq = useRef(0);

  const canApplySwaps = !!(canApply && onUpdate);

  const handleApplySwap = (swap: ExactSwap) => {
    if (!onUpdate) return;
    const { patch, inverse, description } = applyExactSwap(workspace, swap, {
      team: team.trim(),
      gender,
    });
    onUpdate(patch);
    setLastApplied({ inverse, description });
    toast.push('success', description);
  };

  const handleApplyDrop = (drop: DropOnlyRow) => {
    if (!onUpdate) return;
    const { patch, inverse, description } = applyEntryDrop(workspace, drop, {
      team: team.trim(),
      gender,
    });
    onUpdate(patch);
    setLastApplied({ inverse, description });
    toast.push('success', description);
  };

  const handleApplyAdd = (add: AddOnlyRow) => {
    if (!onUpdate) return;
    const { patch, inverse, description } = applyEntryAdd(workspace, add, {
      team: team.trim(),
      gender,
    });
    onUpdate(patch);
    setLastApplied({ inverse, description });
    toast.push('success', description);
  };

  const handleApplyRelaySwap = (swap: RelayLegSwap) => {
    if (!onUpdate) return;
    const { patch, inverse, description } = applyRelayLegSwap(workspace, swap, {
      team: team.trim(),
      gender,
    });
    onUpdate(patch);
    setLastApplied({ inverse, description });
    toast.push('success', description);
  };

  const handleApplyRelayPromotion = (promotion: RelayAlternatePromotion) => {
    if (!onUpdate) return;
    onUpdate(promotion.patch);
    setLastApplied({ inverse: promotion.inverse, description: promotion.description });
    toast.push('success', promotion.description);
  };

  const handleUndoLastSwap = () => {
    if (!lastApplied || !onUpdate) return;
    onUpdate(lastApplied.inverse);
    toast.push('success', `Undid: ${lastApplied.description}`);
    setLastApplied(null);
  };

  // Latest props for the debounced request below. The effect deliberately keys on
  // workspace CONTENT fields (same list useWorkspaceScoring uses) rather than the
  // workspace object: the provider can hand out a fresh workspace object on every
  // notification, and an object-keyed effect would reset the debounce forever so the
  // request never fires.
  const latestPropsRef = useRef({ workspace, gender, team, settings });
  latestPropsRef.current = { workspace, gender, team, settings };

  useEffect(() => {
    const trimmedTeam = team.trim();
    if (!trimmedTeam) {
      requestSeq.current += 1;
      setResult(null);
      setLoading(false);
      setError(null);
      setRelayRanking(null);
      setRelayPromotions([]);
      return;
    }

    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const latest = latestPropsRef.current;
      const latestTeam = latest.team.trim() || trimmedTeam;

      // rankRelayLegSwaps + suggestRelayAlternatePromotions are cheap pure/sync
      // computations (~17ms) — no need to route them through the worker. Compute
      // them alongside the debounced worker request so both stay in lockstep with
      // the same churn-hardened trigger, rather than re-running on every render.
      try {
        const relayResult = rankRelayLegSwaps(latest.workspace, {
          team: latestTeam,
          gender: latest.gender,
          settings: latest.settings,
        });
        const promotions = suggestRelayAlternatePromotions(latest.workspace, {
          team: latestTeam,
          gender: latest.gender,
        });
        if (requestSeq.current === seq) {
          setRelayRanking(relayResult);
          setRelayPromotions(promotions);
        }
      } catch (err) {
        if (requestSeq.current === seq) {
          setRelayRanking({
            pointsMeaningful: false,
            reason: err instanceof Error ? err.message : String(err),
            swaps: [],
            candidatesEvaluated: 0,
          });
          setRelayPromotions([]);
        }
      }

      requestCrossCourseArbitrage(latest.workspace, {
        team: latestTeam,
        gender: latest.gender,
        settings: latest.settings,
      })
        .then(res => {
          if (requestSeq.current !== seq) return; // superseded by a newer request
          setResult(res);
          setError(null);
        })
        .catch(err => {
          if (requestSeq.current !== seq) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (requestSeq.current === seq) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspace.menResults,
    workspace.womenResults,
    workspace.recruits,
    workspace.deletedSwimmers,
    workspace.relayLegOverrides,
    workspace.meetEntryPlans,
    workspace.entryPlanMode,
    workspace.activeEntryIds,
    workspace.athleteHistory,
    workspace.scoringSettings,
    workspace.scorerRosterOverrides,
    workspace.conference,
    gender,
    team,
    settings,
  ]);

  // Reset "show all" toggles (and any pending undo) when the team changes so a
  // new team starts collapsed and never inherits another team's applied swap.
  useEffect(() => {
    setEdgesExpanded(false);
    setSwapsExpanded(false);
    setRelaySwapsExpanded(false);
    setDropsExpanded(false);
    setAddsExpanded(false);
    setLastApplied(null);
  }, [team]);

  if (!team.trim()) {
    return (
      <div className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
        <div className="flex items-center gap-2 text-ui-label font-semibold text-[var(--text-primary)]">
          <ArrowLeftRight size={16} className="text-[var(--text-accent)] shrink-0" />
          Cross-course arbitrage
        </div>
        <p className="text-ui-caption text-theme-secondary mt-2">Select a team…</p>
      </div>
    );
  }

  const edges = result ? courseEdges(result.table.rows) : [];
  const swaps = result ? groupSwaps(result.swapRanking.swaps) : [];
  const gaps = result?.gaps.slice(0, GAPS_DEFAULT_LIMIT) ?? [];
  const shownEdges = edgesExpanded ? edges : edges.slice(0, EDGES_DEFAULT_LIMIT);
  const shownSwaps = swapsExpanded ? swaps : swaps.slice(0, SWAPS_DEFAULT_LIMIT);
  const dropRanking = result?.dropRanking;
  const drops = dropRanking?.drops ?? [];
  const shownDrops = dropsExpanded ? drops : drops.slice(0, DROPS_DEFAULT_LIMIT);
  const addRanking = result?.addRanking;
  const adds = addRanking?.adds ?? [];
  const shownAdds = addsExpanded ? adds : adds.slice(0, ADDS_DEFAULT_LIMIT);
  const showingInitialLoad = loading && !result;

  const effectiveRelayRanking: RelayLegSwapRanking =
    relayRanking ?? { pointsMeaningful: false, swaps: [], candidatesEvaluated: 0 };
  const relaySwaps = groupRelaySwaps(effectiveRelayRanking.swaps);
  const shownRelaySwaps = relaySwapsExpanded
    ? relaySwaps
    : relaySwaps.slice(0, RELAY_SWAPS_DEFAULT_LIMIT);

  return (
    <div className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-3.5">
        <ArrowLeftRight size={16} className="text-[var(--text-accent)] shrink-0" />
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
          Cross-course arbitrage
        </h4>
        {loading && result ? (
          <span
            className="ml-auto flex items-center gap-1.5 text-ui-micro text-theme-muted"
            aria-live="polite"
          >
            <ArrowLeftRight size={11} className="animate-spin" />
            Updating…
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-ui-caption text-amber-400/90 leading-relaxed mb-3">
          Couldn&apos;t compute cross-course data — {error}
        </p>
      ) : null}

      {showingInitialLoad ? (
        <div className="min-h-[140px]">
          <LoadingSpinner label="Computing arbitrage…" />
        </div>
      ) : !result ? null : (
        <div>
          {/* Lineup optimization — the primary section: exact re-scored swaps. */}
          <Section
            title="Lineup optimization"
            icon={<Repeat2 size={14} className="text-[var(--text-accent)] shrink-0" />}
            countLabel={result.swapRanking.pointsMeaningful ? `(${swaps.length})` : undefined}
          >
            {lastApplied ? (
              <button
                type="button"
                onClick={handleUndoLastSwap}
                title={lastApplied.description}
                className="mb-3 flex w-full items-center gap-1.5 truncate rounded-lg border border-theme-soft surface-muted-bg px-3 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
              >
                <Undo2 size={12} className="shrink-0" />
                <span className="truncate">Undo: {lastApplied.description}</span>
              </button>
            ) : null}
            {!result.swapRanking.pointsMeaningful ? (
              <div>
                <p className="text-ui-caption text-theme-secondary leading-relaxed">
                  {result.swapRanking.reason ?? 'Point deltas are not available for this team.'}
                </p>
                <p className="text-ui-micro text-theme-muted mt-1.5 leading-relaxed">
                  Rankings activate once a meet PDF with a scoring field is loaded.
                </p>
              </div>
            ) : swaps.length === 0 ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                Lineup looks optimal — no event swap scores more points than the current
                entries.
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {shownSwaps.map(({ best: swap, otherDrops }) => (
                    <li
                      key={`${swap.athlete}|${swap.addEvent}`}
                      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <AthleteButton
                          name={swap.athlete}
                          onJumpAthlete={onJumpAthlete}
                          className="text-ui-caption max-w-[8rem]"
                        />
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
                            {formatPoints(swap.deltaPoints)}
                          </span>
                          {canApplySwaps ? (
                            <button
                              type="button"
                              onClick={() => handleApplySwap(swap)}
                              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
                            >
                              Apply
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
                        +{swap.addEvent} ({swap.addTime}
                        {swap.addTimeConverted ? 'c' : ''})
                        {swap.addTimeStale ? (
                          <>
                            {' '}
                            <StalePill />
                          </>
                        ) : null}
                        {swap.confidence === 'verify' ? (
                          <>
                            {' '}
                            <VerifyPill />
                          </>
                        ) : null}{' '}
                        · −{swap.dropEvent}
                        {swap.dropTime ? ` (${swap.dropTime})` : ''}
                      </p>
                      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
                        drops a {DROP_SOURCE_LABEL[swap.dropSource]} entry
                        {otherDrops > 0
                          ? ` · ${otherDrops} other drop option${otherDrops === 1 ? '' : 's'}`
                          : ''}
                      </p>
                    </li>
                  ))}
                </ul>
                <ShowAllToggle
                  shown={SWAPS_DEFAULT_LIMIT}
                  total={swaps.length}
                  expanded={swapsExpanded}
                  onToggle={() => setSwapsExpanded(v => !v)}
                />
                <p className="text-ui-micro text-theme-muted mt-2.5">
                  {result.swapRanking.candidatesEvaluated} candidate swap
                  {result.swapRanking.candidatesEvaluated === 1 ? '' : 's'} evaluated.
                </p>
              </>
            )}
          </Section>

          {/* Drop flags — positive drop-only deltas. Under place scoring a lone drop
              is never positive inside its own event, so every row here flags a
              structural problem: an over-entered swimmer whose points the entry caps
              void (capRelief), or a meet-wide scorer-pool slot burned on a low-value
              entry. Empty = healthy. */}
          <Section
            title="Drop flags"
            icon={<AlertTriangle size={14} className="text-[var(--text-accent)] shrink-0" />}
            countLabel={dropRanking?.pointsMeaningful ? `(${drops.length})` : undefined}
          >
            {lastApplied ? (
              <button
                type="button"
                onClick={handleUndoLastSwap}
                title={lastApplied.description}
                className="mb-3 flex w-full items-center gap-1.5 truncate rounded-lg border border-theme-soft surface-muted-bg px-3 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
              >
                <Undo2 size={12} className="shrink-0" />
                <span className="truncate">Undo: {lastApplied.description}</span>
              </button>
            ) : null}
            {!dropRanking || !dropRanking.pointsMeaningful ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                {dropRanking?.reason ?? 'Drop deltas are not available for this team.'}
              </p>
            ) : drops.length === 0 ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                No entry would score more by being dropped — no over-entered swimmers or
                cap-blocked points detected for this team.
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {shownDrops.map(drop => (
                    <li
                      key={`${drop.dropSource}|${drop.dropEntryId}`}
                      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <AthleteButton
                          name={drop.athlete}
                          onJumpAthlete={onJumpAthlete}
                          className="text-ui-caption max-w-[8rem]"
                        />
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
                            {formatPoints(drop.deltaPoints)}
                          </span>
                          {canApplySwaps ? (
                            <button
                              type="button"
                              onClick={() => handleApplyDrop(drop)}
                              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
                            >
                              Apply
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
                        −{drop.dropEvent}
                        {drop.dropTime ? ` (${drop.dropTime})` : ''} ·{' '}
                        {DROP_SOURCE_LABEL[drop.dropSource]} entry
                      </p>
                      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
                        {drop.capRelief
                          ? `over entry cap — dropping restores ${(
                              drop.voidedPointsRestored ?? 0
                            ).toFixed(1)} voided pts`
                          : 'frees a team scoring slot for higher-value entries'}
                      </p>
                    </li>
                  ))}
                </ul>
                <ShowAllToggle
                  shown={DROPS_DEFAULT_LIMIT}
                  total={drops.length}
                  expanded={dropsExpanded}
                  onToggle={() => setDropsExpanded(v => !v)}
                />
                <p className="text-ui-micro text-theme-muted mt-2.5">
                  {dropRanking.candidatesEvaluated} droppable entr
                  {dropRanking.candidatesEvaluated === 1 ? 'y' : 'ies'} evaluated.
                </p>
              </>
            )}
          </Section>

          {/* Open-slot adds — positive add-only deltas for swimmers still under their
              individual/total entry caps: gains available without dropping anything. */}
          <Section
            title="Open-slot adds"
            icon={<Plus size={14} className="text-[var(--text-accent)] shrink-0" />}
            countLabel={addRanking?.pointsMeaningful ? `(${adds.length})` : undefined}
          >
            {lastApplied ? (
              <button
                type="button"
                onClick={handleUndoLastSwap}
                title={lastApplied.description}
                className="mb-3 flex w-full items-center gap-1.5 truncate rounded-lg border border-theme-soft surface-muted-bg px-3 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
              >
                <Undo2 size={12} className="shrink-0" />
                <span className="truncate">Undo: {lastApplied.description}</span>
              </button>
            ) : null}
            {!addRanking || !addRanking.pointsMeaningful ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                {addRanking?.reason ?? 'Add deltas are not available for this team.'}
              </p>
            ) : adds.length === 0 ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                No open-slot addition scores points — every swimmer with entry room is
                already placed where they can score.
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {shownAdds.map(add => (
                    <li
                      key={`${add.athlete}|${add.addEvent}`}
                      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <AthleteButton
                          name={add.athlete}
                          onJumpAthlete={onJumpAthlete}
                          className="text-ui-caption max-w-[8rem]"
                        />
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
                            {formatPoints(add.deltaPoints)}
                          </span>
                          {canApplySwaps ? (
                            <button
                              type="button"
                              onClick={() => handleApplyAdd(add)}
                              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
                            >
                              Apply
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
                        +{add.addEvent} ({add.addTime}
                        {add.addTimeConverted ? 'c' : ''})
                        {add.addTimeStale ? (
                          <>
                            {' '}
                            <StalePill />
                          </>
                        ) : null}
                        {add.confidence === 'verify' ? (
                          <>
                            {' '}
                            <VerifyPill />
                          </>
                        ) : null}
                      </p>
                      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
                        adds without dropping anything — swimmer has entry room under the
                        caps
                      </p>
                    </li>
                  ))}
                </ul>
                <ShowAllToggle
                  shown={ADDS_DEFAULT_LIMIT}
                  total={adds.length}
                  expanded={addsExpanded}
                  onToggle={() => setAddsExpanded(v => !v)}
                />
                <p className="text-ui-micro text-theme-muted mt-2.5">
                  {addRanking.candidatesEvaluated} open-slot add
                  {addRanking.candidatesEvaluated === 1 ? '' : 's'} evaluated.
                </p>
              </>
            )}
          </Section>

          {/* Relay optimization — leg substitutions where the eligibility gate flips
              (a vacated non-scorer leg or soft-removed swimmer), plus scoring-theory
              alternate promotions for legs whose recorded primary has become
              unavailable. Under default NSISC rules A/B-final relays are already
              scorer-eligible and placed by stored rank, so most leg substitutions are
              zero-delta — only genuinely beneficial swaps are surfaced here. */}
          <Section
            title="Relay optimization"
            icon={<Repeat size={14} className="text-[var(--text-accent)] shrink-0" />}
            countLabel={
              effectiveRelayRanking.pointsMeaningful ? `(${relaySwaps.length})` : undefined
            }
          >
            {lastApplied ? (
              <button
                type="button"
                onClick={handleUndoLastSwap}
                title={lastApplied.description}
                className="mb-3 flex w-full items-center gap-1.5 truncate rounded-lg border border-theme-soft surface-muted-bg px-3 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
              >
                <Undo2 size={12} className="shrink-0" />
                <span className="truncate">Undo: {lastApplied.description}</span>
              </button>
            ) : null}
            {!effectiveRelayRanking.pointsMeaningful ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                {effectiveRelayRanking.reason ?? 'Relay point deltas are not available for this team.'}
              </p>
            ) : relaySwaps.length === 0 && relayPromotions.length === 0 ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                No beneficial relay substitutions — all relay legs are already
                scoring-eligible under current rules.
              </p>
            ) : (
              <>
                {relaySwaps.length > 0 ? (
                  <>
                    <ul className="space-y-2">
                      {shownRelaySwaps.map(({ best: swap, otherCandidates }) => {
                        const hasOutAthlete = !!swap.outAthlete && swap.outAthlete !== '—';
                        return (
                          <li
                            key={`${swap.relayEntryKey}|${swap.legIndex}`}
                            className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 flex items-baseline gap-1.5">
                                <span
                                  className="text-ui-caption font-semibold text-[var(--text-primary)] truncate"
                                  title={swap.relayEvent}
                                >
                                  {swap.relayEvent}
                                </span>
                                <span className="text-ui-micro text-theme-muted shrink-0 whitespace-nowrap">
                                  leg {swap.legIndex + 1} · {swap.stroke} {swap.legDistanceYards}y
                                </span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-ui-caption font-mono tabular-nums text-points-positive">
                                  {formatPoints(swap.deltaPoints)}
                                </span>
                                {canApplySwaps ? (
                                  <button
                                    type="button"
                                    onClick={() => handleApplyRelaySwap(swap)}
                                    className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
                                  >
                                    Apply
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 flex flex-wrap items-center gap-1">
                              {hasOutAthlete ? (
                                <AthleteButton
                                  name={swap.outAthlete}
                                  onJumpAthlete={onJumpAthlete}
                                  className="text-ui-micro max-w-[6rem]"
                                />
                              ) : (
                                <span className="text-theme-muted">vacant</span>
                              )}
                              {swap.outTime ? <span>({swap.outTime})</span> : null}
                              <span aria-hidden="true" className="text-theme-muted">
                                →
                              </span>
                              <AthleteButton
                                name={swap.inAthlete}
                                onJumpAthlete={onJumpAthlete}
                                className="text-ui-micro max-w-[6rem]"
                              />
                              <span>
                                ({swap.inTime}
                                {swap.inTimeConverted ? 'c' : ''})
                              </span>
                              {swap.inTimeStale ? <StalePill /> : null}
                            </p>
                            {otherCandidates > 0 ? (
                              <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
                                {otherCandidates} other candidate
                                {otherCandidates === 1 ? '' : 's'} evaluated for this leg
                              </p>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    <ShowAllToggle
                      shown={RELAY_SWAPS_DEFAULT_LIMIT}
                      total={relaySwaps.length}
                      expanded={relaySwapsExpanded}
                      onToggle={() => setRelaySwapsExpanded(v => !v)}
                    />
                    <p className="text-ui-micro text-theme-muted mt-2.5">
                      {effectiveRelayRanking.candidatesEvaluated} candidate relay swap
                      {effectiveRelayRanking.candidatesEvaluated === 1 ? '' : 's'} evaluated.
                    </p>
                  </>
                ) : null}

                {relayPromotions.length > 0 ? (
                  <div className={relaySwaps.length > 0 ? 'mt-3' : ''}>
                    <p className="text-ui-micro font-semibold uppercase tracking-wide text-theme-muted mb-1.5">
                      Alternate promotions
                    </p>
                    <ul className="space-y-1.5">
                      {relayPromotions.map(promotion => {
                        const stroke = relayStrokeForIndex(
                          promotion.relayEvent.toLowerCase(),
                          promotion.legIndex
                        );
                        return (
                          <li
                            key={`${promotion.relayEntryKey}|${promotion.legIndex}`}
                            className="flex items-center justify-between gap-2 rounded-lg border border-theme-soft surface-muted-bg px-3 py-2"
                          >
                            <span
                              className="text-ui-caption text-theme-secondary truncate"
                              title={promotion.description}
                            >
                              Leg {promotion.legIndex + 1} ({stroke}): promote{' '}
                              <span className="text-[var(--text-primary)] font-semibold">
                                {promotion.alternate}
                              </span>{' '}
                              for {promotion.primary} —{' '}
                              {RELAY_ALTERNATE_REASON_LABEL[promotion.reason]}
                            </span>
                            {canApplySwaps ? (
                              <button
                                type="button"
                                onClick={() => handleApplyRelayPromotion(promotion)}
                                className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold shrink-0"
                              >
                                Apply
                              </button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </Section>

          {/* Converted-time upgrades — LCM/SCM swims whose SCY conversion beats the
              actual SCY best; these times are already in the swap candidate pool. */}
          <Section
            title="Converted-time upgrades"
            icon={<Gauge size={14} className="text-[var(--text-accent)] shrink-0" />}
            countLabel={`(${edges.length})`}
          >
            {edges.length === 0 ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                No LCM/SCM swim converts faster than an actual SCY best — conversion adds no
                new candidates for this team.
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {shownEdges.map(row => (
                    <li
                      key={`${row.athlete}|${row.event}`}
                      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex items-baseline gap-1.5">
                          <AthleteButton
                            name={row.athlete}
                            onJumpAthlete={onJumpAthlete}
                            className="text-ui-caption max-w-[8rem]"
                          />
                          <span className="text-ui-caption text-theme-muted truncate">
                            {row.event}
                          </span>
                          {row.scyBest?.stale || row.convertedBest?.stale ? <StalePill /> : null}
                        </div>
                        <span className="text-ui-caption font-mono tabular-nums text-[var(--text-accent)] shrink-0">
                          {formatMargin(row.convertedWinsBy ?? 0)}
                        </span>
                      </div>
                      {row.scyBest && row.convertedBest ? (
                        <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
                          {row.scyBest.time} vs {row.convertedBest.time}c ·{' '}
                          {row.convertedBest.sourceCourse} {row.convertedBest.sourceTime}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <ShowAllToggle
                  shown={EDGES_DEFAULT_LIMIT}
                  total={edges.length}
                  expanded={edgesExpanded}
                  onToggle={() => setEdgesExpanded(v => !v)}
                />
                <p className="text-ui-micro text-theme-muted mt-2.5 leading-relaxed">
                  Converted times are estimates from standard factors and already feed the
                  swap candidates above.
                </p>
              </>
            )}
          </Section>

          {/* Coverage gaps */}
          <Section
            title="Coverage gaps"
            icon={<Users size={14} className="text-[var(--text-accent)] shrink-0" />}
            countLabel={`(${gaps.length})`}
          >
            {gaps.length === 0 ? (
              <p className="text-ui-caption text-theme-secondary leading-relaxed">
                No coverage gaps for this team.
              </p>
            ) : (
              <ul className="space-y-2">
                {gaps.map((gap: CoverageGap) => (
                  <li
                    key={gap.event}
                    className={`rounded-lg border px-3 py-2 flex items-center justify-between gap-2 transition-colors ${
                      gap.countTeamEntries === 0
                        ? 'border-[var(--text-accent)]/30 bg-[var(--text-accent)]/5'
                        : 'border-theme-soft surface-muted-bg'
                    }`}
                  >
                    <span
                      className={`text-ui-caption truncate ${
                        gap.countTeamEntries === 0
                          ? 'text-[var(--text-primary)] font-medium'
                          : 'text-theme-secondary'
                      }`}
                    >
                      {gap.event}
                    </span>
                    <span
                      className={`text-ui-caption font-mono tabular-nums shrink-0 ${
                        gap.countTeamEntries === 0 ? 'text-[var(--text-accent)]' : 'text-theme-muted'
                      }`}
                    >
                      {gap.countTeamEntries} entered · {gap.openSlots} open
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
