/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 2: roster optimizer stages A/B/C.
 *
 * Tests:
 *   npx tsx scripts/test_roster_optimizer.mjs
 *   npx tsx scripts/test_optimizer_never_loses.mjs
 *
 * THE GUARD. `optimizeRosterForTeam` used to run its stages, score the outcome,
 * and return it unconditionally — it computed `previousTotal` and
 * `projectedTotal` and never compared them. On the HSU 2026-27 roster workspace
 * that took a coach's team total from 1277.00 to 0.00 behind a button labelled
 * "Optimize team", with no warning and no undo. See the mechanism note on
 * `optimizeScorersForTeam`.
 *
 * Every entry point now enumerates COMPLETE candidate states, scores each one,
 * and returns the highest-scoring — accepting a candidate only when it strictly
 * beats the workspace's current total. When nothing beats it, the caller gets
 * its own state back untouched and `outcome: 'unchanged'`. A caller must be able
 * to tell "gained N" from "found nothing better", because a silent no-op behind
 * a success toast is its own trust problem.
 */

import {
  Gender,
  PlannedSwimEntry,
  ScorerRosterOverride,
  ScoringSettings,
  Workspace,
} from '../types';
import {
  aggregateSwimmerMeetPoints,
  buildScorerRosterLookup,
  scorerRosterKey,
} from './scorerRoster';
import { buildAliasResolver } from './athleteAliases';
import { mergeScoringSettings } from './scoringDefaults';
import {
  buildEventProfileFromCatalog,
  getAthleteProfile,
  meetProgramEvents,
} from './athleteHistory';
import { buildWhatIfResults, createPlannedEntry } from './whatIfProjection';
import { buildCategorizedScoringInputs, calculatePoints } from './utils';
import type { CatalogTeamRoster } from './rosterCatalog';

export type OptimizerStage = 'scorers' | 'events' | 'hypothetical' | 'all';

/**
 * Did the optimizer actually change anything?
 *
 * - `improved`  — the returned state scores strictly higher than the workspace's
 *                 current state. `projectedTotal > previousTotal`.
 * - `unchanged` — nothing beat the current state, so the returned
 *                 `overrides` / `meetEntryPlans` / `activeEntryIds` are the
 *                 caller's own, untouched, and `projectedTotal === previousTotal`.
 *
 * A caller must branch on this rather than showing an unconditional success
 * toast: "found nothing better" is a legitimate outcome and must read as one.
 */
export type OptimizerOutcome = 'improved' | 'unchanged';

/** Which stages the returned state actually came from (`none` when the guard held). */
export type OptimizerAppliedStages = 'none' | 'scorers' | 'events' | 'scorers+events';

export type OptimizerResult = {
  overrides: ScorerRosterOverride[];
  meetEntryPlans: PlannedSwimEntry[];
  activeEntryIds: string[];
  projectedTotal: number;
  previousTotal: number;
  /** See {@link OptimizerOutcome}. Optional on the base type so pre-existing
   *  result shapes (e.g. `ArbitrageOptimizeResult`) stay assignable; the guarded
   *  entry points always set it — see {@link GuardedOptimizerResult}. */
  outcome?: OptimizerOutcome;
  /** See {@link OptimizerAppliedStages}. */
  appliedStages?: OptimizerAppliedStages;
  /**
   * What the pre-guard code would have returned: the total of the fully chained
   * stage result, accepted or not. Diagnostic only — never apply it. When
   * `outcome === 'unchanged'` and this is far below `previousTotal`, the stages
   * disagree with the scoring engine and the guard is the only thing standing
   * between the coach and a destroyed projection.
   */
  unguardedTotal?: number;
};

/** An `OptimizerResult` from a guarded entry point: the guard fields are always present. */
export type GuardedOptimizerResult = OptimizerResult & {
  outcome: OptimizerOutcome;
  appliedStages: OptimizerAppliedStages;
  unguardedTotal: number;
};

/** Team totals are sums of floats; require a real gain, not float dust. */
const IMPROVEMENT_EPSILON = 1e-6;

/** One complete, internally coherent state the optimizer may return. */
export type OptimizerCandidate = {
  appliedStages: Exclude<OptimizerAppliedStages, 'none'>;
  overrides: ScorerRosterOverride[];
  plans: PlannedSwimEntry[];
  activeIds: string[];
  total: number;
};

/** The caller's own state and what it scores — what a refusal hands back untouched. */
export type OptimizerBaseState = {
  overrides: ScorerRosterOverride[];
  plans: PlannedSwimEntry[];
  activeIds: string[];
  total: number;
};

/**
 * THE GUARD, on its own, so every optimizer entry point shares one copy.
 *
 * Takes the caller's current state and a list of COMPLETE candidate states, and
 * returns the highest-scoring candidate that strictly beats the current total by
 * more than {@link IMPROVEMENT_EPSILON}. When none does, it returns the caller's
 * own `overrides` / `plans` / `activeIds` untouched with `outcome: 'unchanged'`
 * and `appliedStages: 'none'` — not a half-applied hybrid, and never a state
 * that scores less than the one it was handed.
 *
 * Ties go to the state already on screen: an equal-scoring reshuffle is churn,
 * and changing a coach's lineup has a cost even when the number does not move.
 *
 * `unguardedTotal` is what the pre-guard code would have returned — the fully
 * chained candidate, accepted or not. Diagnostic only; never apply it. It is
 * what lets a test prove the guard is still load-bearing rather than decorative.
 *
 * Every candidate's `total` MUST come from the same scoring function that
 * produced `base.total`. Comparing two differently-measured totals is the bug
 * this guard exists to prevent, wearing a disguise.
 */
export function selectGuardedResult(
  base: OptimizerBaseState,
  candidates: readonly OptimizerCandidate[],
  unguardedTotal: number
): GuardedOptimizerResult {
  let best: OptimizerCandidate | null = null;
  for (const candidate of candidates) {
    const bar = best ? best.total : base.total;
    if (candidate.total > bar + IMPROVEMENT_EPSILON) best = candidate;
  }

  if (!best) {
    return {
      overrides: base.overrides,
      meetEntryPlans: base.plans,
      activeEntryIds: base.activeIds,
      projectedTotal: base.total,
      previousTotal: base.total,
      outcome: 'unchanged',
      appliedStages: 'none',
      unguardedTotal,
    };
  }

  return {
    overrides: best.overrides,
    meetEntryPlans: best.plans,
    activeEntryIds: best.activeIds,
    projectedTotal: best.total,
    previousTotal: base.total,
    outcome: 'improved',
    appliedStages: best.appliedStages,
    unguardedTotal,
  };
}

/** Score one state once and bucket the points by team — every team's total from a single pass. */
function teamTotalsForState(
  workspace: Workspace,
  gender: Gender,
  removeSeniors: boolean,
  settings: ScoringSettings,
  overrides: ScorerRosterOverride[],
  plans?: PlannedSwimEntry[],
  activeIds?: string[],
  rosterCatalog?: CatalogTeamRoster
): Map<string, number> {
  const ws: Workspace = {
    ...workspace,
    scorerRosterOverrides: overrides,
    meetEntryPlans: plans ?? workspace.meetEntryPlans,
    activeEntryIds: activeIds ?? workspace.activeEntryIds,
  };
  const base = buildWhatIfResults({ workspace: ws, gender, removeSeniors });
  const results = rosterCatalog
    ? buildCategorizedScoringInputs({
        workspace: { ...ws, menResults: base, womenResults: gender === Gender.WOMEN ? base : [] },
        gender,
        rosterCatalog,
      })
    : base;
  const scored = calculatePoints(results, settings, {
    scorerRosterOverrides: overrides,
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])],
  });
  const totals = new Map<string, number>();
  for (const r of scored) {
    if (r.gender != null && r.gender !== gender) continue;
    const t = String(r.team ?? '').trim();
    if (!t) continue;
    totals.set(t, (totals.get(t) ?? 0) + (typeof r.points === 'number' ? r.points : 0));
  }
  return totals;
}

/**
 * Score ONE state and return one team's total from it.
 *
 * Exported so a second optimizer entry point cannot quietly grow its own copy.
 * `optimizeWithArbitrage` in rosterArbitrage.ts used to have one, and it ignored
 * `removeSeniors` — it scored a senior-full field while handing `removeSeniors`
 * to the scorers stage, so the stage optimized one projection and the caller was
 * shown another.
 */
export function teamTotalForTeam(
  workspace: Workspace,
  gender: Gender,
  removeSeniors: boolean,
  settings: ScoringSettings,
  team: string,
  overrides: ScorerRosterOverride[],
  plans?: PlannedSwimEntry[],
  activeIds?: string[],
  rosterCatalog?: CatalogTeamRoster
): number {
  const totals = teamTotalsForState(
    workspace,
    gender,
    removeSeniors,
    settings,
    overrides,
    plans,
    activeIds,
    rosterCatalog
  );
  return totals.get(team) ?? 0;
}

/**
 * Stage A: maximize scorer roster for one team.
 *
 * WHO ENFORCES THE CAP (resolved 2026-08-30 — the disagreement this comment
 * used to record is gone; see the note on what is still open, below).
 *
 * `cap` below selects the best `maxIndividualScorersPerTeam` (18 under NSISC)
 * by projected points. It is NOT the only thing enforcing that number, and it
 * must not be: the engine enforces it too, in the meet-wide scorer pool
 * (`admitTieGroupToMeetPool` in utils.ts), which is where diver weighting and
 * meet scope live. The two used to disagree — the pool tested each athlete
 * against the pool AS IT STOOD, so a whole tie group of new names all passed
 * the same check and the pool admitted 31 athletes against a cap of 18, while
 * this function trimmed to exactly 18. Every override written here was then a
 * forced OFF against a set the engine had never capped, and a single un-poolable
 * athlete zeroed every teammate in the event.
 *
 * The pool now admits per athlete and accumulates, so it holds exactly 18.
 * `buildScorerRosterLookup` still defaults a recruit row to `isScorer: true`,
 * and that is correct: it answers "is this athlete on the scoring roster at
 * all", not "is this athlete one of the 18". One question, one enforcer. The
 * overrides written here therefore steer WHICH 18 the pool takes — a ranked
 * choice among a capped set — instead of fighting a second, uncapped one.
 *
 * CLOSED 2026-09-02. `prepareRecruitsForScoring` used to rank each recruit
 * against the PDF rows in its event ALONE, so with no PDF loaded there were no
 * comparators and EVERY recruit came back rank 1 in EVERY event — one event
 * scored as a single N-way tie, paying every entrant the same fractional share.
 * Recruit rows are now placed against each other too, and a row that already
 * carries a projected placement keeps it. See plans/2026-08-14/12 §2 and
 * scripts/test_recruit_placement_grid.mjs.
 */
export function optimizeScorersForTeam(
  workspace: Workspace,
  gender: Gender,
  team: string,
  removeSeniors: boolean,
  settings: ScoringSettings,
  rosterCatalog?: CatalogTeamRoster
): ScorerRosterOverride[] {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });
  const base = buildWhatIfResults({ workspace, gender, removeSeniors });
  const results = rosterCatalog
    ? buildCategorizedScoringInputs({ workspace, gender, rosterCatalog })
    : base;
  const scored = calculatePoints(results, merged, {
    scorerRosterOverrides: workspace.scorerRosterOverrides ?? [],
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])],
  });
  // Built once per call. Two spellings of one athlete are two ranked rows, and
  // `cap` selects the top N of them — so a duplicate both eats a scorer slot and
  // splits that athlete's points across two keys, ranking them lower than they
  // are. Points must be aggregated through the SAME resolver as the rows, or the
  // merged row would be ranked on only its canonical half's points.
  const resolver = buildAliasResolver(workspace);
  const lookup = buildScorerRosterLookup(
    results,
    merged,
    workspace.scorerRosterOverrides ?? [],
    gender,
    resolver
  );
  const teamRows = lookup.rows.filter(r => r.team === team);
  const points = aggregateSwimmerMeetPoints(scored, gender, resolver);

  const ranked = [...teamRows].sort((a, b) => {
    const pa = points.get(a.key) ?? 0;
    const pb = points.get(b.key) ?? 0;
    return pb - pa || a.name.localeCompare(b.name);
  });

  const cap = Math.min(merged.maxIndividualScorersPerTeam ?? 18, ranked.length);
  const selected = new Set(ranked.slice(0, cap).map(r => r.key));

  const overrides: ScorerRosterOverride[] = [...(workspace.scorerRosterOverrides ?? [])].filter(
    o => !(o.team === team && o.gender === gender)
  );

  for (const row of teamRows) {
    const want = selected.has(row.key);
    const auto = lookup.isScorer(row.name, row.team, row.gender);
    if (want !== auto) {
      overrides.push({
        name: row.name,
        team: row.team,
        gender: row.gender,
        isScorer: want,
      });
    }
  }

  // Local improvement: try flipping borderline athletes
  let best = teamTotalForTeam(workspace, gender, removeSeniors, merged, team, overrides, undefined, undefined, rosterCatalog);
  const borderline = ranked.slice(Math.max(0, cap - 3), cap + 3);
  for (const row of borderline) {
    const key = scorerRosterKey(row.team, row.gender, row.name);
    const cur = overrides.find(
      o => scorerRosterKey(o.team, o.gender, o.name) === key
    );
    const isOn = cur ? cur.isScorer : lookup.isScorer(row.name, row.team, row.gender);
    const trial = overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key);
    trial.push({ name: row.name, team: row.team, gender: row.gender, isScorer: !isOn });
    const t = teamTotalForTeam(workspace, gender, removeSeniors, merged, team, trial, undefined, undefined, rosterCatalog);
    if (t > best) {
      best = t;
      const rest = overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key);
      if (!isOn) {
        rest.push({ name: row.name, team: row.team, gender: row.gender, isScorer: true });
      }
      overrides.length = 0;
      overrides.push(...rest);
    }
  }

  return overrides;
}

/** Stage B: pick active primary events per athlete from history + PDF,
 *  optionally enriched with catalog-stored additional events. */
export function optimizeEventLineupForTeam(
  workspace: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings,
  rosterCatalog?: CatalogTeamRoster
): { plans: PlannedSwimEntry[]; activeEntryIds: string[] } {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });
  // One resolver for the call. Without it a linked athlete appears twice here and
  // gets TWO sets of planned entries — one human entered in their primary events
  // twice over, straight past the entry cap.
  const lookup = buildScorerRosterLookup(
    buildWhatIfResults({ workspace, gender, removeSeniors: false }),
    merged,
    workspace.scorerRosterOverrides ?? [],
    gender,
    buildAliasResolver(workspace)
  );
  const teamAthletes = lookup.rows.filter(r => r.team === team);
  const existing = [...(workspace.meetEntryPlans ?? [])];
  const rest = existing.filter(p => !(p.team === team && p.gender === gender));
  const plans: PlannedSwimEntry[] = [...rest];
  const activeEntryIds: string[] = [];

  // The loaded meet's program bounds what the optimizer may enter anyone in.
  // Read from the frozen source copy so the plans it writes cannot widen it.
  const sourceResults =
    gender === Gender.MEN
      ? workspace.sourceMenResults ?? workspace.menResults
      : workspace.sourceWomenResults ?? workspace.womenResults;
  const program = meetProgramEvents(sourceResults);
  const allowedEvents = program.size > 0 ? program : null;

  for (const athlete of teamAthletes) {
    const profile =
      buildEventProfileFromCatalog(rosterCatalog, team, gender, athlete.name, merged, allowedEvents) ??
      getAthleteProfile(workspace, team, gender, athlete.name, merged);
    if (!profile) continue;
    for (const event of profile.primaryEvents) {
      const best = profile.bestByEvent[event];
      const entry = createPlannedEntry({
        name: athlete.name,
        team,
        gender,
        classYear: athlete.classYear,
        event,
        time: best?.time ?? 'NT',
        source: 'optimizer',
        active: true,
      });
      plans.push(entry);
      activeEntryIds.push(entry.id);
    }
  }

  return { plans, activeEntryIds };
}

/**
 * Optimize one team, and never hand back a state that scores less than the one
 * you passed in.
 *
 * Each stage is evaluated as a COMPLETE candidate state rather than as a link in
 * a chain that is scored only at the end. That matters because the stages can
 * disagree with each other, and on live data they do:
 *
 * | Workspace (HSU men)     | current | scorers | events  | scorers+events |
 * | ----------------------- | ------- | ------- | ------- | -------------- |
 * | meet loaded             | 1383.83 | 1214.33 | 1242.00 | **1691.00**    |
 * | recruits only, no meet  | 1277.00 |  213.00 | **1395.00** |     0.00   |
 *
 * On the first row the scorers stage alone LOSES 170 points and only pays off
 * once the events stage runs after it; on the second the chained result is a
 * total wipeout while the events stage on its own is the best answer available.
 * Neither "always chain" nor "reject the scorers stage" finds both. Enumerating
 * and taking the max does, and the strict-improvement bar keeps the wipeout out.
 *
 * A candidate must beat the current total by more than {@link IMPROVEMENT_EPSILON}
 * to be accepted, so an equal-scoring reshuffle is rejected as churn: changing a
 * coach's lineup has a cost even when the number does not move.
 */
export function optimizeRosterForTeam(
  workspace: Workspace,
  gender: Gender,
  team: string,
  removeSeniors: boolean,
  settings: ScoringSettings,
  stages: OptimizerStage = 'all',
  rosterCatalog?: CatalogTeamRoster
): GuardedOptimizerResult {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });

  // The caller's own state, which is what gets handed back untouched if nothing wins.
  const baseOverrides = [...(workspace.scorerRosterOverrides ?? [])];
  const basePlans = [...(workspace.meetEntryPlans ?? [])];
  const baseActiveIds = [...(workspace.activeEntryIds ?? [])];

  const score = (
    overrides: ScorerRosterOverride[],
    plans: PlannedSwimEntry[],
    activeIds: string[]
  ): number =>
    teamTotalForTeam(
      workspace,
      gender,
      removeSeniors,
      merged,
      team,
      overrides,
      plans,
      activeIds,
      rosterCatalog
    );

  const previousTotal = score(baseOverrides, basePlans, baseActiveIds);

  const wantScorers = stages === 'scorers' || stages === 'all';
  const wantEvents = stages === 'events' || stages === 'all';
  /* stages === 'hypothetical': rank projection already runs inside
   * buildWhatIfResults when plans are present, so there is no candidate to
   * build and the current state is by definition the best one. */

  const candidates: OptimizerCandidate[] = [];
  let scorerOverrides: ScorerRosterOverride[] | null = null;

  if (wantScorers) {
    scorerOverrides = optimizeScorersForTeam(
      workspace,
      gender,
      team,
      removeSeniors,
      merged,
      rosterCatalog
    );
    candidates.push({
      appliedStages: 'scorers',
      overrides: scorerOverrides,
      plans: basePlans,
      activeIds: baseActiveIds,
      total: score(scorerOverrides, basePlans, baseActiveIds),
    });
  }

  if (wantEvents) {
    // Events against the scorer set the workspace already has, NOT the one stage
    // A just proposed — this is the candidate that saves a recruit-only roster
    // when stage A is the thing destroying it.
    const ev = optimizeEventLineupForTeam(workspace, gender, team, merged, rosterCatalog);
    candidates.push({
      appliedStages: 'events',
      overrides: baseOverrides,
      plans: ev.plans,
      activeIds: ev.activeEntryIds,
      total: score(baseOverrides, ev.plans, ev.activeEntryIds),
    });
  }

  if (wantScorers && wantEvents && scorerOverrides) {
    const ev = optimizeEventLineupForTeam(
      { ...workspace, scorerRosterOverrides: scorerOverrides },
      gender,
      team,
      merged,
      rosterCatalog
    );
    candidates.push({
      appliedStages: 'scorers+events',
      overrides: scorerOverrides,
      plans: ev.plans,
      activeIds: ev.activeEntryIds,
      total: score(scorerOverrides, ev.plans, ev.activeEntryIds),
    });
  }

  // What the pre-guard code would have returned: the fully chained stage result.
  const chained =
    wantScorers && wantEvents
      ? candidates.find(c => c.appliedStages === 'scorers+events')
      : wantScorers
        ? candidates.find(c => c.appliedStages === 'scorers')
        : wantEvents
          ? candidates.find(c => c.appliedStages === 'events')
          : undefined;
  const unguardedTotal = chained ? chained.total : previousTotal;

  return selectGuardedResult(
    {
      overrides: baseOverrides,
      plans: basePlans,
      activeIds: baseActiveIds,
      total: previousTotal,
    },
    candidates,
    unguardedTotal
  );
}

/**
 * Optimize every team in the field, one after another.
 *
 * Each team is individually guarded, but that is not sufficient on its own: team
 * B's baseline is measured AFTER team A's changes were applied, so a per-team
 * gain can sit on top of a loss the chain already caused elsewhere. The reported
 * totals are therefore measured against the ORIGINAL workspace and the FINAL
 * state — one scoring pass each, bucketed by team — and if the aggregate still
 * comes out lower, the whole batch is discarded and the caller's state is
 * returned untouched.
 */
export function optimizeRosterAllTeams(
  workspace: Workspace,
  gender: Gender,
  removeSeniors: boolean,
  settings: ScoringSettings,
  stages: OptimizerStage = 'all',
  rosterCatalog?: CatalogTeamRoster
): GuardedOptimizerResult {
  const baselineResults = buildWhatIfResults({ workspace, gender, removeSeniors });
  const baseTeams = new Set(
    baselineResults
      .filter(r => !r.isRelay || r.name !== r.team)
      .map(r => String(r.team ?? '').trim())
      .filter(Boolean)
  );
  if (rosterCatalog) baseTeams.add(rosterCatalog.team.name);
  const teams = [...baseTeams].sort();
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });

  const baseOverrides = [...(workspace.scorerRosterOverrides ?? [])];
  const basePlans = [...(workspace.meetEntryPlans ?? [])];
  const baseActiveIds = [...(workspace.activeEntryIds ?? [])];

  const sumForState = (
    overrides: ScorerRosterOverride[],
    plans: PlannedSwimEntry[],
    activeIds: string[]
  ): number => {
    const totals = teamTotalsForState(
      workspace,
      gender,
      removeSeniors,
      merged,
      overrides,
      plans,
      activeIds,
      rosterCatalog
    );
    return teams.reduce((sum, team) => sum + (totals.get(team) ?? 0), 0);
  };

  const previousTotal = sumForState(baseOverrides, basePlans, baseActiveIds);

  let overrides = baseOverrides;
  let plans = basePlans;
  let activeIds = baseActiveIds;
  let usedScorers = false;
  let usedEvents = false;

  for (const team of teams) {
    const sub = optimizeRosterForTeam(
      { ...workspace, scorerRosterOverrides: overrides, meetEntryPlans: plans, activeEntryIds: activeIds },
      gender,
      team,
      removeSeniors,
      merged,
      stages,
      rosterCatalog
    );
    overrides = sub.overrides;
    plans = sub.meetEntryPlans;
    activeIds = sub.activeEntryIds;
    if (sub.appliedStages === 'scorers' || sub.appliedStages === 'scorers+events') usedScorers = true;
    if (sub.appliedStages === 'events' || sub.appliedStages === 'scorers+events') usedEvents = true;
  }

  // What applying the accumulated batch would actually score, measured whole
  // rather than as a sum of per-team deltas taken against moving baselines.
  const appliedTotal = sumForState(overrides, plans, activeIds);
  const changed = usedScorers || usedEvents;

  if (!changed || appliedTotal <= previousTotal + IMPROVEMENT_EPSILON) {
    return {
      overrides: baseOverrides,
      meetEntryPlans: basePlans,
      activeEntryIds: baseActiveIds,
      projectedTotal: previousTotal,
      previousTotal,
      outcome: 'unchanged',
      appliedStages: 'none',
      unguardedTotal: appliedTotal,
    };
  }

  return {
    overrides,
    meetEntryPlans: plans,
    activeEntryIds: activeIds,
    projectedTotal: appliedTotal,
    previousTotal,
    outcome: 'improved',
    appliedStages: usedScorers && usedEvents ? 'scorers+events' : usedScorers ? 'scorers' : 'events',
    unguardedTotal: appliedTotal,
  };
}
