/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view helpers for an optimizer run that happens off the main thread:
 * the progress wording, and the check that the lineup did not move while the
 * run was in flight. None of this touches React.
 */

import type { Workspace } from '@omniswim/core/types';
import type { OptimizeJobKind, OptimizerProgress } from '@omniswim/core/lib/optimizeJob';

/** What the status line needs to describe the run in flight. */
export type OptimizeRunState = {
  kind: OptimizeJobKind;
  /** The team a single-team run is for. Empty for an all-teams run. */
  team: string;
  /** The last progress report. `null` until one arrives, and always `null` for a single-team run. */
  progress: OptimizerProgress | null;
};

export const OPTIMIZE_CANCELLED_MESSAGE = 'Optimization cancelled. Nothing was changed.';

export const CHANGED_WHILE_OPTIMIZING_MESSAGE =
  'The workspace or the optimizer settings changed while the optimizer ran, so its result was not applied. Run it again.';

export function optimizeFailedMessage(err: unknown): string {
  return `Optimization failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** One plain-word line for the status region, such as "Optimizing 3 of 12 teams". */
export function describeOptimizeRun(run: OptimizeRunState): string {
  if (run.kind === 'allTeams') {
    const p = run.progress;
    if (p && p.total > 0) {
      return `Optimizing ${p.current} of ${p.total} ${p.total === 1 ? 'team' : 'teams'}`;
    }
    return 'Optimizing all teams…';
  }
  if (run.kind === 'scan') return run.team ? `Scanning ${run.team}…` : 'Scanning…';
  return run.team ? `Optimizing ${run.team}…` : 'Optimizing…';
}

/**
 * Every workspace field an optimizer job reads, derived from the job code (the import graph of
 * `optimizeJob.ts`: rosterOptimizer, rosterArbitrage, whatIfProjection, scoringEngine,
 * prelimsProjection, psychProjection, athleteAliases, athleteHistory, relayLeg*, arbitrage/*).
 *
 * Compared field by field, by identity. Whole-workspace identity is not used: autosave replaces
 * the workspace object without changing any of these, and that would drop every long run.
 *
 * Fields the job graph does not read, and so are left out: `createdAt`, `loadedPsych`,
 * `raceAnalyses`, `historySources`, `relayLegCredits`. A test pins both lists: changing a field
 * on this list drops a result, and changing one off it must not change the result.
 */
export const OPTIMIZER_INPUT_FIELDS = [
  'id',
  'name',
  'menResults',
  'womenResults',
  'sourceMenResults',
  'sourceWomenResults',
  'psychMenResults',
  'psychWomenResults',
  'recruits',
  'scoringSettings',
  'conference',
  'scoringView',
  'entryPlanMode',
  'officialTeamScores',
  'loadedMeet',
  'deletedSwimmers',
  'scorerRosterOverrides',
  'relayLegOverrides',
  'meetEntryPlans',
  'activeEntryIds',
  'athleteHistory',
  'athleteAliases',
] as const satisfies ReadonlyArray<keyof Workspace>;

export type OptimizerInputField = (typeof OPTIMIZER_INPUT_FIELDS)[number];

/** The fields above, by reference, as they stood when a run started. */
export type OptimizerInputRefs = Readonly<Record<OptimizerInputField, unknown>>;

export function optimizerInputRefsOf(workspace: Workspace): OptimizerInputRefs {
  const refs = {} as Record<OptimizerInputField, unknown>;
  for (const field of OPTIMIZER_INPUT_FIELDS) refs[field] = workspace[field];
  return refs;
}

/** Which of the job's input fields were replaced since the run started. Empty when none. */
export function changedOptimizerInputs(started: OptimizerInputRefs, now: Workspace): OptimizerInputField[] {
  return OPTIMIZER_INPUT_FIELDS.filter(field => started[field] !== now[field]);
}

/**
 * True when an edit replaced any field the job read since the run started.
 *
 * A result holds the FULL post-run arrays, and it was computed from the inputs as they were. Applying
 * it after the coach edited the lineup, the roster, the aliases or the history would discard that
 * edit or describe a field that no longer exists. The synchronous path never needed this check
 * because nothing could run between the click and the apply.
 */
export function optimizerInputsMoved(started: OptimizerInputRefs, now: Workspace): boolean {
  return changedOptimizerInputs(started, now).length > 0;
}

/** What a team run was started for. A result for anything else is not applied. A null mode means the run ignores the Strategy setting. */
export type TeamRunContext = { workspaceId: string; team: string; mode: string | null };

export function teamRunContextChanged(started: TeamRunContext, now: TeamRunContext): boolean {
  return (
    started.workspaceId !== now.workspaceId ||
    started.team !== now.team ||
    (started.mode !== null && started.mode !== now.mode)
  );
}
