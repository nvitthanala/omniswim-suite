/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { FileWarning } from 'lucide-react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import {
  diffOptimizerChanges,
  optimizeRosterForTeam,
  type GuardedOptimizerResult,
  type OptimizerChangeSummary,
} from '@omniswim/core/lib/rosterOptimizer';
import {
  buildArbitrageCardsResult,
  type ArbitrageCardsResult,
  optimizeWithArbitrage,
  type ArbitrageCard,
  type ArbitrageMode,
} from '@omniswim/core/lib/rosterArbitrage';
import { Button, EmptyState, useToast } from '@omniswim/ui';
import TeamPickerEmptyState from './TeamPickerEmptyState';
import { ArbitragePreviewSection, OptimizerControls } from './RosterOptimizeStepParts';
import OptimizerChangeSummaryPanel, { type OptimizerRunSummary } from './OptimizerChangeSummaryPanel';
import BatchOptimizerPanel from './BatchOptimizerPanel';
import {
  BATCH_UNCHANGED_MESSAGE,
  buildBatchApplyPatch,
  type BatchOptimizationResult,
} from './batchOptimizerView';
import {
  APPLY_NOT_SAVED_MESSAGE,
  buildOptimizerUndo,
  optimizerArraysOf,
  optimizerUndoIsClean,
  optimizerUndoState,
  optimizerUndoTargetReached,
  UNDO_CHANGED_MESSAGE,
  UNDO_NOT_SAVED_MESSAGE,
  type OptimizerUndo,
} from './optimizerUndo';

/**
 * The summary record the panel shows. The Undo lives inside it. `gender` is the view the run was
 * made in: the panel text describes that view, so the panel hides while the step shows the other.
 */
type RunSummaryRecord = OptimizerRunSummary & { undo: OptimizerUndo | null; gender: Gender };

/**
 * An Undo whose write was issued. The provider's save is debounced and gives no result to await
 * (`updateWorkspace` resolves before the PUT runs), so the step watches the workspace instead.
 * - pending: the write was issued. Nothing is claimed until the arrays read as the pre-run arrays.
 * - settled: they did, the toast was shown and the summary dropped. The step keeps watching: if the
 *   optimized arrays come back, the save failed and the provider reloaded the server copy.
 */
type UndoFlow = { phase: 'pending' | 'settled'; undo: OptimizerUndo; summary: RunSummaryRecord };

/** Snapshot shape from `captureBeforeState`, shared by `applyOptimizerResult`. */
type OptimizerBeforeState = {
  overrides: NonNullable<Workspace['scorerRosterOverrides']>;
  plans: NonNullable<Workspace['meetEntryPlans']>;
  activeIds: NonNullable<Workspace['activeEntryIds']>;
  /** Read for the Undo fingerprint only. A run does not write it. */
  relayOverrides?: NonNullable<Workspace['relayLegOverrides']>;
};

/**
 * Shared "run guarded optimizer, branch on outcome" logic for the per-team
 * arbitrage (`applyTeam`) and legacy (`applyLegacy`) optimize buttons —
 * jscpd's flagged 24-line clone between them (2026-09-25 code-health pass).
 * `applyAllTeamsResult` below applies the "All teams" dialog's result to the
 * whole field instead of one team and keeps its own copy: its toast wording and
 * label differ enough that sharing would blur both messages.
 */
function applyOptimizerResult({
  team,
  workspaceId,
  result,
  before,
  buildSuccessMessage,
  recordRunSummary,
  onUpdate,
  setLastOptimizeUndo,
  toast,
}: {
  team: string;
  workspaceId: string;
  result: GuardedOptimizerResult;
  before: OptimizerBeforeState;
  buildSuccessMessage: (result: GuardedOptimizerResult, gain: number) => string;
  recordRunSummary: (label: string, result: GuardedOptimizerResult, before: OptimizerBeforeState, allTeams?: boolean) => void;
  onUpdate: (patch: Partial<Workspace>) => void;
  setLastOptimizeUndo: (value: OptimizerUndo | null) => void;
  toast: ReturnType<typeof useToast>;
}) {
  recordRunSummary(team, result, before);
  // "Found nothing better" is not success. The optimiser now refuses to apply a
  // result that would lower the team total — on a recruit-driven workspace the
  // unguarded run took 1277 points to 0 — so the toast must distinguish the two
  // rather than reporting a win for a no-op.
  if (result.outcome === 'unchanged') {
    // The most recent run superseded whatever the prior one applied — a
    // dangling Undo here would revert a change this summary no longer
    // describes.
    setLastOptimizeUndo(null);
    toast.push(
      'info',
      `${team}: already the best lineup found — nothing changed (${result.previousTotal.toFixed(1)} pts).`
    );
    return;
  }
  const applied = {
    scorerRosterOverrides: result.overrides,
    meetEntryPlans: result.meetEntryPlans,
    activeEntryIds: result.activeEntryIds,
  };
  onUpdate(applied);
  setLastOptimizeUndo(buildOptimizerUndo({ label: team, workspaceId, before, applied }));
  const gain = result.projectedTotal - result.previousTotal;
  toast.push('success', buildSuccessMessage(result, gain));
}

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringSettings: ScoringSettings;
  whatIfMode: boolean;
  removeSeniors: boolean;
  selectedTeam: string;
  teams: string[];
  onUpdate: (patch: Partial<Workspace>) => void;
};

export function ArbitrageCardList({
  cards,
  pointsMeaningful = true,
  reason,
}: {
  cards: ArbitrageCard[];
  pointsMeaningful?: boolean;
  reason?: string;
}) {
  // "We cannot compute a point value here" and "we computed one and found no
  // gains" are different answers. Showing the same empty state for both reads as
  // the second, which is the more reassuring and the wrong one.
  if (!pointsMeaningful) {
    return (
      <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
        <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
          Point values need a scored field to place against.
          {reason ? ` ${reason}` : ' Load a meet with at least two scoring teams.'}
        </p>
        <p className="text-ui-caption text-theme-muted mt-2 max-w-md mx-auto">
          Event swaps can still be made by hand on the Lineup step — only the points
          they would be worth cannot be stated yet.
        </p>
      </div>
    );
  }
  if (cards.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
        <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
          No swap gains points for this team — every athlete is already in the events
          that score most for them.
        </p>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {cards.map(c => (
        <li
          key={`${c.athleteName}|${c.preferredEvent}|${c.alternateEvent}`}
          className="rounded-xl border border-theme-soft surface-muted-bg p-4 min-w-0"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-ui-label font-semibold text-[var(--text-primary)] truncate min-w-0">
              {c.athleteName}
            </p>
            <span className="text-ui-label font-mono text-[var(--text-accent)] shrink-0">
              +{c.arbitragePts}
            </span>
          </div>
          <p className="text-ui-body text-theme-secondary mt-2 leading-relaxed break-words">
            Swim <span className="text-[var(--text-primary)]">{c.preferredEvent}</span>
            {c.addTime ? ` (${c.addTime})` : ''} instead of{' '}
            <span className="text-[var(--text-primary)]">{c.alternateEvent}</span>.
          </p>
          {c.addTimeConverted || c.needsVerify ? (
            <p className="text-ui-caption text-theme-muted mt-1.5 break-words">
              {c.addTimeConverted ? 'Entry time is converted from a metric swim' : null}
              {c.addTimeConverted && c.needsVerify ? ' — ' : null}
              {c.needsVerify
                ? 'placing sits inside conversion-factor noise, so verify before acting'
                : null}
              .
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function RosterOptimizeStep({
  workspace,
  gender,
  scoringSettings,
  whatIfMode,
  removeSeniors,
  selectedTeam,
  teams,
  onUpdate,
}: Props) {
  const toast = useToast();
  const [mode, setMode] = useState<ArbitrageMode>('individual_first');
  const [cards, setCards] = useState<ArbitrageCard[]>([]);
  const team = selectedTeam && teams.includes(selectedTeam) ? selectedTeam : '';
  // "Nothing to work with" is no scoreable TEAM, not no meet PDF. A workspace
  // can be recruit-driven -- SwimCloud imports and planned entries with no meet
  // loaded -- and still have a full roster to build, which is the HSU planning
  // workflow. Keying this off menResults blocked that path entirely.
  const hasRoster = teams.length > 0;

  // Computed on request, never during render.
  //
  // `buildArbitrageCardsResult` re-scores the field once per candidate swap — 849
  // candidates at ~7 ms each on the largest measured meet. Running that in a `useMemo` froze
  // the main thread for 8.3 s in a single task (measured), so opening this step
  // locked the UI. Correct numbers are not worth a frozen tab; the button makes
  // the cost explicit and keeps the step instant to open.
  const [preview, setPreview] = useState<ArbitrageCardsResult | null>(null);
  const [scanning, setScanning] = useState(false);
  // The Undo lives INSIDE the summary record, because the summary panel is the only place its
  // button renders. Dropping the summary (Dismiss, team change, workspace change) therefore drops
  // the Undo with it, and an Undo that is armed but out of reach cannot be represented.
  const [lastRunSummary, setLastRunSummary] = useState<RunSummaryRecord | null>(null);
  const [undoFlow, setUndoFlow] = useState<UndoFlow | null>(null);
  // Focus anchors. The summary (and the Undo button inside it) unmounts when a run is dropped, and a
  // focused element that unmounts leaves focus on <body>. The step root and its primary button are
  // stable, so focus moves there first.
  const rootRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const visibleSummary = lastRunSummary && lastRunSummary.gender === gender ? lastRunSummary : null;
  const lastOptimizeUndo = lastRunSummary?.undo ?? null;
  const lastRunIsAllTeams = useRef(false);
  const setLastOptimizeUndo = (undo: OptimizerUndo | null) =>
    setLastRunSummary(prev => (prev ? { ...prev, undo } : prev));
  // The "All teams" dialog. It is the one entry point for a whole-field run.
  const [showAllTeams, setShowAllTeams] = useState(false);
  // One-shot undo for the single most recent APPLIED optimizer run, following
  // RosterImportWizard.tsx's lastAliasLink/handleUndoAliasLink shape: a
  // component-local snapshot of the pre-run state plus one dedicated Undo
  // action, not a full history stack. Lost on refresh, same scope as that
  // pattern's own today.
  // Set when Undo was pressed but the lineup moved since the run. Undo then waits for an
  // explicit "Undo anyway" instead of discarding the later edits.
  // 'changed': the coach edited after the run. 'apply_not_saved': the arrays are exactly the pre-run
  // arrays, so the apply's save failed and the provider reloaded the server copy.
  const [undoBlocked, setUndoBlocked] = useState<'changed' | 'apply_not_saved' | null>(null);
  useEffect(() => {
    setUndoBlocked(null);
  }, [lastOptimizeUndo]);

  const dropRun = () => {
    setLastRunSummary(null);
    setUndoFlow(null);
  };

  // An Undo snapshot belongs to one workspace. Switching workspace drops the summary and the Undo,
  // so a snapshot can never be written onto another workspace.
  useEffect(() => {
    dropRun();
  }, [workspace.id]);

  // A summary describes one gender's view, so it is only SHOWN in that view (`visibleSummary`).
  // - A single-team run is about one team's roster in that view: clear it on a gender switch.
  // - An All-teams run wrote both genders' arrays and its fingerprint guards the Undo, so keep the
  //   record. The panel hides while the other gender is shown and returns when the coach flips back.
  // - `undoFlow` is never touched here. An Undo that still waits for its save must keep waiting, or
  //   a later save failure would get no "not saved" message.
  useEffect(() => {
    if (lastRunIsAllTeams.current) return;
    setLastRunSummary(null);
  }, [gender]);

  /** Move focus off the summary before it unmounts. Primary button when it can take focus, else the step root. */
  const releaseFocusFromSummary = () => {
    const summary = summaryRef.current;
    if (!summary || !summary.contains(document.activeElement)) return;
    const primary = rootRef.current?.querySelector<HTMLElement>('[data-optimizer-focus]');
    if (primary && !(primary as HTMLButtonElement).disabled) primary.focus();
    else rootRef.current?.focus();
  };

  // Observe the Undo. See UndoFlow.
  useEffect(() => {
    if (!undoFlow) return;
    // The Undo belongs to one workspace. Another workspace's lineup can equal the optimized arrays;
    // reading that as a failed save would re-arm this Undo's summary in the wrong workspace.
    if (undoFlow.undo.workspaceId !== workspace.id) {
      setUndoFlow(null);
      return;
    }
    const current = optimizerArraysOf(workspace);
    if (undoFlow.phase === 'pending') {
      if (!optimizerUndoTargetReached(undoFlow.undo, current)) return;
      releaseFocusFromSummary();
      toast.push('success', `Undid: ${undoFlow.undo.label} optimize`);
      setLastRunSummary(null);
      setUndoFlow({ ...undoFlow, phase: 'settled' });
      return;
    }
    if (optimizerUndoIsClean(undoFlow.undo, current)) {
      // The optimized arrays are back: the Undo's save failed. Put the Undo back within reach.
      toast.push('error', UNDO_NOT_SAVED_MESSAGE);
      setLastRunSummary({ ...undoFlow.summary, undo: undoFlow.undo });
      setUndoFlow({ ...undoFlow, phase: 'pending' });
    } else if (!optimizerUndoTargetReached(undoFlow.undo, current)) {
      setUndoFlow(null); // something else wrote the lineup; there is nothing left to watch
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, undoFlow]);

  // A stale scan is worse than none — it would describe a roster that no longer exists.
  useEffect(() => {
    setPreview(null);
  }, [workspace, gender, team, scoringSettings]);

  // A summary (and its undo) from a previous team's run stays visible under
  // the old team's controls otherwise — dismissible on its own is not enough
  // once the coach has moved on to a different team, and undoing a stale
  // snapshot against the WRONG team's current state would be actively wrong.
  // An All-teams run is not about one team, so its summary and Undo survive a
  // team change (and are shown with or without a team picked).
  useEffect(() => {
    if (lastRunIsAllTeams.current) return;
    dropRun();
  }, [team]);

  /** The three optimizer-owned fields, as they read right now — the only
   *  state `diffOptimizerChanges` can honestly compare against, and exactly
   *  what one-shot undo needs to snapshot before an apply call overwrites it. */
  const captureBeforeState = (): OptimizerBeforeState => ({
    overrides: workspace.scorerRosterOverrides ?? [],
    plans: workspace.meetEntryPlans ?? [],
    activeIds: workspace.activeEntryIds ?? [],
    relayOverrides: workspace.relayLegOverrides ?? [],
  });

  const recordRunSummary = (
    label: string,
    result: GuardedOptimizerResult,
    before: OptimizerBeforeState,
    allTeams = false
  ) => {
    lastRunIsAllTeams.current = allTeams;
    setUndoFlow(null); // a new run supersedes any Undo still being watched
    const changes: OptimizerChangeSummary = diffOptimizerChanges(before, {
      overrides: result.overrides,
      plans: result.meetEntryPlans,
    });
    setLastRunSummary({ label, result, changes, undo: null, gender });
  };

  const handleUndoOptimize = (force = false) => {
    if (!lastOptimizeUndo) return;
    if (lastOptimizeUndo.workspaceId !== workspace.id) {
      dropRun();
      return;
    }
    // The run left the arrays in a known state. If they differ now, either the coach edited after
    // the run (writing the pre-run arrays back would discard those edits) or the apply's save
    // failed and the server copy came back (the arrays are exactly the pre-run arrays).
    if (!force) {
      const state = optimizerUndoState(lastOptimizeUndo, optimizerArraysOf(workspace));
      if (state !== 'clean') {
        setUndoBlocked(state);
        return;
      }
    }
    // Write, then wait to see the arrays change before claiming success (see UndoFlow).
    onUpdate(lastOptimizeUndo.patch);
    if (lastRunSummary) setUndoFlow({ phase: 'pending', undo: lastOptimizeUndo, summary: lastRunSummary });
  };

  const runScan = () => {
    if (!team) return;
    setScanning(true);
    // Yield a frame so the "Scanning…" state paints before the blocking work starts.
    window.setTimeout(() => {
      try {
        setPreview(buildArbitrageCardsResult(workspace, gender, team, scoringSettings));
      } finally {
        setScanning(false);
      }
    }, 0);
  };

  const displayCards = cards.length > 0 ? cards : preview?.cards ?? [];

  const applyTeam = () => {
    if (!whatIfMode || !team) return;
    const before = captureBeforeState();
    const result = optimizeWithArbitrage(
      workspace,
      gender,
      team,
      removeSeniors,
      scoringSettings,
      mode
    );
    // The cards describe the lineup that came back, so they are worth showing
    // whether or not that lineup was applied.
    setCards(result.cards);
    // Same guard as applyLegacy — see applyOptimizerResult above. This path is
    // guarded too now: it refuses a candidate that would lower the team total,
    // and on a recruit-driven workspace it does refuse. A "+0.0 pts" success
    // toast over an untouched lineup would report a win for a no-op.
    applyOptimizerResult({
      team,
      workspaceId: workspace.id,
      result,
      before,
      buildSuccessMessage: (_result, gain) => `${team}: +${gain.toFixed(1)} pts (${mode.replace('_', ' ')})`,
      recordRunSummary,
      onUpdate,
      setLastOptimizeUndo,
      toast,
    });
  };

  const applyLegacy = () => {
    if (!whatIfMode || !team) return;
    const before = captureBeforeState();
    const result = optimizeRosterForTeam(workspace, gender, team, removeSeniors, scoringSettings);
    applyOptimizerResult({
      team,
      workspaceId: workspace.id,
      result,
      before,
      buildSuccessMessage: (result, gain) =>
        `${team}: +${gain.toFixed(1)} pts → ${result.projectedTotal.toFixed(1)} (${result.appliedStages?.replace('+', ' + ') ?? 'optimised'})`,
      recordRunSummary,
      onUpdate,
      setLastOptimizeUndo,
      toast,
    });
  };

  /**
   * Applies what the "All teams" dialog produced. The dialog never offers an
   * `unchanged` result for applying; this guards again so a result that changed
   * nothing can never write state or arm an Undo, whichever way it arrives.
   * Per-team gains can cancel once chained (measured +307 and +18 individually
   * netting to +16 across the meet), which is why the engine guards on the
   * aggregate and reports it as `outcome`.
   */
  const applyAllTeamsResult = (result: BatchOptimizationResult) => {
    const before = captureBeforeState();
    recordRunSummary('All teams', result.optimizer, before, true);
    const patch = buildBatchApplyPatch(result);
    if (!patch) {
      setLastOptimizeUndo(null);
      toast.push('info', BATCH_UNCHANGED_MESSAGE);
      return;
    }
    onUpdate(patch);
    setLastOptimizeUndo(buildOptimizerUndo({ label: 'All teams', workspaceId: workspace.id, before, applied: patch }));
    const gain = result.optimizer.projectedTotal - result.optimizer.previousTotal;
    toast.push('success', `All teams: +${gain.toFixed(1)} pts across the field`);
  };

  const allTeamsDialog = showAllTeams ? (
    <BatchOptimizerPanel
      workspace={workspace}
      gender={gender}
      scoringSettings={scoringSettings}
      removeSeniors={removeSeniors}
      onApply={applyAllTeamsResult}
      onClose={() => setShowAllTeams(false)}
    />
  ) : null;

  // Shown in both the no-team and the team view, so an All-teams apply always
  // has its Undo in reach.
  const runSummaryPanel = visibleSummary ? (
    <div ref={summaryRef}>
      <OptimizerChangeSummaryPanel
        summary={visibleSummary}
        onDismiss={() => {
          releaseFocusFromSummary();
          dropRun();
        }}
        onUndo={lastOptimizeUndo ? () => handleUndoOptimize() : undefined}
        undoBlockedKind={lastOptimizeUndo ? undoBlocked ?? undefined : undefined}
        undoBlockedMessage={
          lastOptimizeUndo && undoBlocked
            ? undoBlocked === 'apply_not_saved'
              ? APPLY_NOT_SAVED_MESSAGE
              : UNDO_CHANGED_MESSAGE
            : undefined
        }
        onUndoAnyway={() => handleUndoOptimize(true)}
        onKeepEdits={() => setUndoBlocked(null)}
      />
    </div>
  ) : null;

  if (!hasRoster) {
    return (
      <EmptyState
        icon={<FileWarning size={28} />}
        eyebrow="Optimize"
        title="Bring in swimmers first"
        description="Load a meet or import swimmers on the Athletes step to build this optimization."
      />
    );
  }

  if (!selectedTeam) {
    return (
      <div ref={rootRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        <TeamPickerEmptyState
          eyebrow="Optimize"
          title="Choose a team to optimize"
          description="Use the team bar above to pick the team whose point opportunities you want to review and optimize."
        />
        <div className="surface-card rounded-xl p-4 sm:p-5 flex flex-wrap items-center gap-3">
          <p className="text-ui-body text-theme-secondary min-w-0 flex-1">
            Or optimize every team at once. This does not need a team.
          </p>
          <Button
            variant="outline"
            data-optimizer-focus
            disabled={!whatIfMode}
            onClick={() => setShowAllTeams(true)}
            title={whatIfMode ? 'Optimize every team in the field' : 'Enable What-if to optimize'}
          >
            All teams…
          </Button>
        </div>
        {runSummaryPanel}
        {allTeamsDialog}
      </div>
    );
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="surface-card rounded-xl p-4 sm:p-5 flex flex-col gap-5 outline-none">
      <OptimizerControls
        team={team}
        mode={mode}
        onModeChange={setMode}
        whatIfMode={whatIfMode}
        onApplyTeam={applyTeam}
        onApplyLegacy={applyLegacy}
        onOpenAllTeams={() => setShowAllTeams(true)}
      />

      {!whatIfMode ? (
        <p className="text-ui-caption rounded-lg border border-theme-soft surface-muted-bg px-3 py-2 text-theme-secondary">
          Enable What-if to apply optimizer changes.
        </p>
      ) : null}

      {runSummaryPanel}

      {allTeamsDialog}

      <ArbitragePreviewSection
        team={team}
        scanning={scanning}
        onScan={runScan}
        displayCards={displayCards}
        cards={cards}
        preview={preview}
      />
    </div>
  );
}
