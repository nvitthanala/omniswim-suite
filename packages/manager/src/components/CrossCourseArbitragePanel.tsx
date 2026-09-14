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
import { ArrowLeftRight } from 'lucide-react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { requestCrossCourseArbitrage } from '@omniswim/core/lib/crossCourseArbitrageClient';
import { buildArbitrageViewModel } from './crossCourseArbitrageView';
import { ArbitrageErrorNotice, UpdatingBadge } from './crossCourseArbitrageParts';
import { ArbitrageResultBody } from './crossCourseArbitrageBody';
import {
  applyEntryAdd,
  applyEntryDrop,
  applyExactSwap,
  applyRelayLegSwap,
  rankRelayLegSwaps,
  type AddOnlyRow,
  type CrossCourseArbitrageResult,
  type DropOnlyRow,
  type ExactSwap,
  type RelayLegSwap,
  type RelayLegSwapRanking,
} from '@omniswim/core/lib/crossCourseArbitrage';
import {
  suggestRelayAlternatePromotions,
  type RelayAlternatePromotion,
} from '@omniswim/core/lib/scoringTheory';
import { useToast } from '@omniswim/ui';

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

  const viewModel = buildArbitrageViewModel(
    result,
    relayRanking,
    loading,
    {
      edges: edgesExpanded,
      swaps: swapsExpanded,
      drops: dropsExpanded,
      adds: addsExpanded,
      relaySwaps: relaySwapsExpanded,
    },
    {
      edges: EDGES_DEFAULT_LIMIT,
      swaps: SWAPS_DEFAULT_LIMIT,
      gaps: GAPS_DEFAULT_LIMIT,
      drops: DROPS_DEFAULT_LIMIT,
      adds: ADDS_DEFAULT_LIMIT,
      relaySwaps: RELAY_SWAPS_DEFAULT_LIMIT,
    }
  );

  return (
    <div className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-3.5">
        <ArrowLeftRight size={16} className="text-[var(--text-accent)] shrink-0" />
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
          Cross-course arbitrage
        </h4>
        <UpdatingBadge show={loading && !!result} />
      </div>

      <ArbitrageErrorNotice error={error} />

      <ArbitrageResultBody
        result={result}
        viewModel={viewModel}
        expanded={{
          edges: edgesExpanded,
          swaps: swapsExpanded,
          drops: dropsExpanded,
          adds: addsExpanded,
          relaySwaps: relaySwapsExpanded,
        }}
        limits={{
          edges: EDGES_DEFAULT_LIMIT,
          swaps: SWAPS_DEFAULT_LIMIT,
          drops: DROPS_DEFAULT_LIMIT,
          adds: ADDS_DEFAULT_LIMIT,
          relaySwaps: RELAY_SWAPS_DEFAULT_LIMIT,
        }}
        setters={{
          setEdgesExpanded,
          setSwapsExpanded,
          setDropsExpanded,
          setAddsExpanded,
          setRelaySwapsExpanded,
        }}
        handlers={{
          onApplySwap: handleApplySwap,
          onApplyDrop: handleApplyDrop,
          onApplyAdd: handleApplyAdd,
          onApplyRelaySwap: handleApplyRelaySwap,
          onApplyRelayPromotion: handleApplyRelayPromotion,
          onUndo: handleUndoLastSwap,
        }}
        lastApplied={lastApplied}
        canApplySwaps={canApplySwaps}
        relayPromotions={relayPromotions}
        onJumpAthlete={onJumpAthlete}
      />
    </div>
  );
}
