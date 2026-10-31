/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild` (plans/2026-10-25/D5-AUTOBUILDER.md), slice A1: the `max-own` objective over individual and diving events,
 * with per-swimmer entry caps and the scoring-team size under the strict diver rule. Own relays stay as entered. Coach tags
 * are pins. The solver is injected: the engine takes no `highs` dependency.
 *
 * The MIP only proposes. The built lineup is re-scored as a whole meet through `scoreMeet` (the gate), and it is returned
 * only when it strictly beats the current lineup on own points (the guard).
 */
import { scoreMeet } from '../model/results';
import type { Results } from '../model/results';
import type { Lineup, ScorerTag } from '../model/lineup';
import type { Gender } from '../model/primitives';
import { explain } from './explain';
import { evaluationOfScored, gate, repairable, scoreLineup } from './gate';
import { scorerIds } from './load';
import { makeScale } from './lp';
import { reachesTarget } from './mode';
import { scaleFor, solveAutoBuild, tieGroupSizes } from './solve';
import type { Squad } from './squads';
import type { SolveOutcome, SolveRecord } from './solve';
import type { Evaluator } from './evaluate';
import { eventId } from './evaluate';
import { buildProblem, classify, Space } from './space';
import type { EventSpace, Problem } from './space';
import type { Support } from './support';
import { checkLimits, checkLoadSettings, checkObjective, checkOwnTags, checkRoster, checkRules, checkSchedule, checkTeams, loadRuleOf } from './support';
import { autoBuildFail } from './types';
import type { AutoBuildEvaluation, AutoBuildProof, AutoBuildProposal, AutoBuildRequest, AutoBuildResult, AutoBuildRestriction, AutoBuildScore, MipSolve } from './types';

export { AUTOBUILD_DEFAULT_LIMITS, AUTOBUILD_DEFAULT_ROBUST, AutoBuildError } from './types';
export type {
  AutoBuildErrorCode,
  AutoBuildEvaluation,
  AutoBuildExplanation,
  AutoBuildLimits,
  AutoBuildObjective,
  AutoBuildProof,
  AutoBuildProposal,
  AutoBuildRequest,
  AutoBuildRestriction,
  AutoBuildResult,
  AutoBuildScore,
  EntryChange,
  MipSolution,
  MipSolve,
  RivalRef,
} from './types';

/** The spots one pinned swimmer takes under the strict diver rule: a diver only when every current entry is a dive. */
function strictFits(problem: Problem): boolean {
  const { size, weight } = problem.support;
  if (size === 'unlimited') return true;
  const dives = new Map<string, boolean>();
  for (const e of problem.req.lineup.entries) {
    const only = e.kind === 'individual' && problem.req.model.events.some((m) => m.eventKey === e.eventKey && m.gender === e.gender && m.kind === 'diving');
    const swimmers = e.kind === 'individual' ? [e.swimmerId] : e.legs.map((l) => l.swimmerId);
    for (const id of swimmers) dives.set(id, (dives.get(id) ?? true) && only);
  }
  return problem.genders.every((g: Gender) => {
    const spots = (problem.pinned.get(g) ?? []).reduce((sum, id) => sum + (dives.get(id) === true ? weight.numerator : weight.denominator), 0);
    return spots <= size * weight.denominator;
  });
}

function evaluationOf(results: Results, problem: Problem): AutoBuildEvaluation {
  const { req } = problem;
  // D5 5.4: the current lineup of a robust request is scored again with the robust swims pinned on the entries of the pinned swimmers.
  return evaluationOfScored(problem, scoreLineup(problem, req.lineup, req.tags, (id) => problem.roles.get(id) === 'scorer', { results, load: problem.currentLoad }));
}

function restrictionsOf(problem: Problem, space: Space): AutoBuildRestriction[] {
  const out: AutoBuildRestriction[] = ['scorers_only_entries'];
  if (problem.built.some((e) => e.kind === 'relay')) out.push('relays_within_scoring_cap', 'disjoint_relays', 'relay_leg_bases');
  if (problem.fixedRelayEvents.size > 0) out.push('fixed_relay_events');
  if ([...problem.held].some((k) => !problem.frozenHeld.has(k))) out.push('held_split_entries');
  if (problem.support.size !== 'unlimited') out.push('strict_diver_weight');
  if (space.frozenPairs.length > 0) out.push('robust_frozen_pairs');
  return out;
}

/** D5 amendment 1, 6.5 b: the strict diver weight binds when the current lineup passes the gate but breaks it. */
const bindingOf = (restriction: AutoBuildRestriction, strictBinds: boolean): boolean => restriction === 'strict_diver_weight' && strictBinds;

/** The parts of a proof that do not depend on the outcome. */
function proofBase(problem: Problem, space: Space, records: readonly SolveRecord[], gateMs: number | null, strictBinds: boolean): Pick<AutoBuildProof, 'searchSpace' | 'solves' | 'timings'> {
  const solveMs = records.some((r) => r.ms === null) ? null : records.reduce((s, r) => s + (r.ms as number), 0);
  return {
    searchSpace: {
      restrictions: restrictionsOf(problem, space),
      restrictionStatus: restrictionsOf(problem, space).map((restriction) => ({ restriction, binding: bindingOf(restriction, strictBinds) })),
      fixedRelayEvents: problem.req.model.events
        .filter((e) => problem.fixedRelayEvents.has(`${e.gender}\u0000${e.eventKey}`))
        .map((e) => ({ eventKey: e.eventKey, gender: e.gender })),
      frozenPairs: space.frozenPairs.map((f) => ({ ...f })),
      events: space.events.map((es) => ({
        eventKey: es.event.eventKey,
        gender: es.event.gender,
        candidates: es.relay === null ? es.candidates.length : es.relay.squads.length,
        outside: es.relay === null ? es.outside().length : es.relay.tauOut === null ? 0 : 1,
        columns: es.columns.length,
      })),
    },
    solves: records.map((r) => ({ stage: r.stage, status: r.status, ms: r.ms, rows: r.rows, cols: r.cols })),
    timings: { evaluateMs: space.evaluateMs, solveMs, gateMs, explainMs: null },
  };
}

function proofOf(
  problem: Problem,
  space: Space,
  outcome: SolveOutcome,
  current: AutoBuildEvaluation,
  records: readonly SolveRecord[],
  gateMs: number | null,
  strictBinds: boolean
): AutoBuildProof {
  const base = proofBase(problem, space, records, gateMs, strictBinds);
  // Goal seek ranks the negative change count: the changes are `-best`, and a bound on the ranked value bounds the changes from below.
  const goal = problem.mode.target !== null;
  const sign = goal ? -1 : 1;
  if (outcome.kind === 'found') {
    const { D, best, upper } = outcome.bound;
    const bestFound = (sign * best) / D;
    if (upper === null) return { status: 'unknown', bestFound, upperBound: null, gap: null, ...base };
    // The local search never claims a proof (D5 10), even when its points meet the bound: that stays a gap of 0.
    return { status: upper === best && outcome.method !== 'local-search' ? 'proven_optimal' : 'gap', bestFound, upperBound: (sign * upper) / D, gap: (upper - best) / D, ...base };
  }
  if (goal) {
    // No lineup reaches the target as far as the search knows. `proven`: the relaxed MIP is infeasible, so none exists.
    const upper = outcome.kind === 'non_result' ? outcome.upperScaled : null;
    const proven = outcome.kind === 'infeasible' && outcome.proven;
    return { status: proven ? 'proven_optimal' : 'unknown', bestFound: 0, upperBound: upper === null ? null : -upper, gap: null, ...base };
  }
  // No lineup was found: the best known is the current one, and a dual bound (when the solver gave one) is the only bound.
  const upper = outcome.kind === 'non_result' ? outcome.upperScaled : null;
  const upperBound = upper === null ? null : upper / outcome.scale.D;
  return {
    status: upperBound === null ? 'unknown' : 'gap',
    bestFound: current.objective,
    upperBound,
    gap: upperBound === null ? null : Math.max(0, upperBound - current.objective),
    ...base,
  };
}

/**
 * Slice A9. The gate may put back a removed scorer (`restoreIdleRemovals`), and the lineup it gives can score above the solver's incumbent. The proof then
 * reads the proposal's own score as the best found, so `bestFound` and `gap` are those of the lineup the coach sees, and `proven_optimal` is claimed
 * only when that score equals the solver's bound. A score above the bound means the model and `scoreMeet` disagree: `model_mismatch`.
 */
function withProposalBest(problem: Problem, outcome: Extract<SolveOutcome, { kind: 'found' }>, proposal: AutoBuildProposal): Extract<SolveOutcome, { kind: 'found' }> {
  if (problem.mode.target !== null) return outcome;
  const { D, best, upper } = outcome.bound;
  const x = proposal.evaluation.objective * D;
  const scaled = Math.round(x);
  if (Math.abs(x - scaled) >= 1e-6) autoBuildFail('model_mismatch', `the proposal's objective ${proposal.evaluation.objective} is not whole at scale ${D}`);
  if (scaled <= best) return outcome;
  if (upper !== null && scaled > upper) autoBuildFail('model_mismatch', `the proposal's objective ${scaled} is above the solver's bound ${upper} at scale ${D}`);
  return { ...outcome, bound: { ...outcome.bound, best: scaled } };
}

/** The guard (D5 8.4) for a solve with a result. */
function decide(problem: Problem, space: Space, outcome: Extract<SolveOutcome, { kind: 'found' }>, current: AutoBuildEvaluation, currentInSpace: boolean, records: readonly SolveRecord[], clock: (() => number) | undefined): AutoBuildResult {
  const t0 = clock?.();
  const proposal = gate(problem, space, outcome.selection, outcome.scale, outcome.bestScaled, outcome.method, outcome.valueScaled);
  const gateMs = clock !== undefined && t0 !== undefined ? clock() - t0 : null;
  const broken = repairable(problem);
  const proof = proofOf(problem, space, withProposalBest(problem, outcome, proposal), current, records, gateMs, broken.length === 0 && !strictFits(problem));
  // D5 9: the explanations are read from the finished proposal, after the proof. They change neither, except `timings.explainMs`.
  const explained = (): { readonly proposal: AutoBuildProposal; readonly proof: AutoBuildProof } => {
    const t1 = clock?.();
    const explanations = explain(problem, proposal, {
      status: proof.status,
      candidate: (event, swimmerId) => space.events.find((es) => es.id === eventId(event.eventKey, event.gender))?.candidates.includes(swimmerId) === true,
    });
    const explainMs = clock !== undefined && t1 !== undefined ? clock() - t1 : null;
    return { proposal: { ...proposal, explanations }, proof: { ...proof, timings: { ...proof.timings, explainMs } } };
  };
  if (broken.length > 0) {
    const done = explained();
    return { kind: 'current_infeasible', currentViolations: broken, alternative: done.proposal, current, proof: done.proof };
  }
  // Goal seek (D5 8.4): the current lineup missed the target, or `autoBuild` would have returned `current_meets_target`. The gate has
  // checked that the proposal reaches it, so it is better by the mode's own objective, the change count. No witness check applies:
  // the current lineup is not in the space of lineups that reach the target.
  if (problem.mode.target !== null) {
    const done = explained();
    return { kind: 'improved', proposal: done.proposal, current, proof: done.proof };
  }
  const { D } = outcome.scale;
  const now = Math.round(current.objective * D);
  if (Math.abs(current.objective * D - now) >= 1e-6) autoBuildFail('model_mismatch', `the current lineup's objective ${current.objective} is not whole at scale ${D}`);
  // An incumbent from a time-limited solve may sit below the current lineup, so only an Optimal result is a witness check.
  if (currentInSpace && outcome.method === 'mip' && outcome.bestScaled < now) {
    autoBuildFail('model_mismatch', `the solver's optimum ${outcome.bestScaled} is below the current lineup's ${now}, and the current lineup is in the search space`);
  }
  if (Math.round(proposal.evaluation.objective * D) > now) {
    const done = explained();
    return { kind: 'improved', proposal: done.proposal, current, proof: done.proof };
  }
  // D5 amendment 1, 6.5 b: a current lineup outside the strict space is not proven optimal, only the strict space is.
  const provenNoBetter = proof.status === 'proven_optimal' && strictFits(problem);
  return { kind: 'unchanged', reason: provenNoBetter ? 'proven_no_better' : 'none_found_within_limits', current, proof };
}

function undecided(problem: Problem, space: Space, outcome: Exclude<SolveOutcome, { kind: 'found' }>, current: AutoBuildEvaluation, currentInSpace: boolean, records: readonly SolveRecord[]): AutoBuildResult {
  const proof = proofOf(problem, space, outcome, current, records, null, repairable(problem).length === 0 && !strictFits(problem));
  if (outcome.kind === 'non_result') return { kind: 'unchanged', reason: 'none_found_within_limits', current, proof };
  // Goal seek: an infeasible MIP says that no lineup reaches the target, whatever the current lineup is (D5 8.4).
  if (problem.mode.target !== null) return { kind: 'target_unreachable', reason: outcome.proven ? 'proven' : 'within_limits', current, proof };
  // Infeasible. A current lineup inside the search space is a witness, so an infeasible MIP is a model error.
  if (currentInSpace) autoBuildFail('model_mismatch', 'the MIP is infeasible, but the current lineup satisfies every row of it');
  const broken = repairable(problem);
  if (broken.length > 0) return { kind: 'current_infeasible', currentViolations: broken, alternative: null, current, proof };
  // The gate accepts the current lineup, but the strict diver rule (D5 4.4) puts it outside the search space.
  return { kind: 'unchanged', reason: 'none_found_within_limits', current, proof };
}

/** D5 2.1 items 5 and 6: the load refusals that need the candidates of every event. */
function checkLoad(load: NonNullable<AutoBuildRequest['load']>, events: readonly EventSpace[], evaluator: Evaluator): void {
  // D5 2.1 item 5: a pending setting of a relay event refuses first. One probe column per relay event reads its `sessionLoad`; the
  // individual events were read when their candidate pairs were scored.
  for (const es of events) if (es.relay !== null && es.relay.squads.length > 0) evaluator.evaluateRelay(es.event, [es.relay.squads[0] as Squad]);
  // Item 6: an event with a candidate pair or a squad must be on the schedule, or `sessionLoad` would count no races for it.
  checkSchedule(load, events.filter((es) => (es.relay === null ? es.scorable.length > 0 || es.frozenIn.length > 0 : es.relay.squads.length > 0)).map((es) => es.event));
}

/** D5 2.1, in order, up to the problem: the refusals that need no candidate. Shared by `autoBuild` and `autoBuildObjective`. */
function prepare(req: AutoBuildRequest): { readonly problem: Problem; readonly support: Support; readonly currentResults: Results } {
  // 1: the preflight. Its ScoreMeetError reaches the caller unchanged.
  const currentResults = scoreMeet(req.model, req.lineup, req.tags, req.rules, req.sourcing);
  checkTeams(req.model, req.ownTeamId);
  if (classify(req).decision.size === 0) autoBuildFail('nothing_to_build', 'no own swimmer can be decided: every one is untagged off the roster, on an own relay, or tagged off the scoring roster');
  checkOwnTags(req.tags, req.ownTeamId);
  const rules = checkRules(req.rules);
  if (req.load !== null) checkLoadSettings(req.load);
  const support: Support = { ...rules, load: loadRuleOf(req.load) };
  checkObjective(req.model, req.ownTeamId, req.objective);
  checkLimits(req.limits);
  checkRoster(req.roster);
  // D5 4.7 subtracts the load penalty in every mode "but goal seek", and the evaluation doc says goal seek is in mode units: the spec does
  // not say whether a goal-seek target counts the penalty. Refuse the combination until the lead decides.
  if (req.objective.kind === 'goal-seek' && req.load !== null && req.load.preference.mode === 'prefer') {
    autoBuildFail('mode_not_built', 'goal seek with the "prefer" load mode is not built: D5 4.7 does not say whether the target counts the penalty', 'goal-seek-prefer');
  }

  return { problem: buildProblem(req, support, currentResults), support, currentResults };
}

/**
 * Scores a lineup (with the tags it is scored under) in the terms of the request's objective: the number `autoBuild` ranks. It is `proposal.evaluation`
 * for a proposal's own lineup and tags, and `current` for the request's. The refusals are `autoBuild`'s up to the problem, and `robust_no_spread`.
 * One refusal is not repeated: an unscheduled event with a candidate (D5 2.1 item 6), which `autoBuild` checks from the columns of every candidate. So a
 * direct call can score a request that `autoBuild` would refuse. Accepting a proposal is safe: it came from a successful `autoBuild` run on this request.
 *
 * `meetsTarget` is `null` unless the objective is a goal seek. Then it is the gate's own test (`reachesTarget`: whole numbers at a scale `D`). Pass
 * `proposal.scaleD` as `scaleD` to get the gate's answer; the scale is then the lcm of `scaleD` and the tie groups below, so a tie that an opponent
 * re-suggest adds is still whole. Without it the scale is the finest the request and this lineup need (the lcm of the decimal and
 * penalty scales and of the tie groups of the current and the scored results). The gate's scale can be finer, because it also counts the tie groups of every
 * candidate column, which only a run knows. So without `scaleD` a target within 1e-9 / D of the metric can read differently from the gate.
 */
export function autoBuildObjective(req: Omit<AutoBuildRequest, 'clock'>, lineup: Lineup, tags: readonly ScorerTag[], scaleD?: number): AutoBuildScore {
  const { problem } = prepare(req);
  if (problem.robust !== null && problem.robust.pins.size === 0) {
    autoBuildFail('robust_no_spread', 'robust mode found no (swimmer, event) pair with enough dated SCY swims inside the record range, so no pair has a spread', 'robust');
  }
  const roster = scorerIds(tags, req.ownTeamId);
  const scored = scoreLineup(problem, lineup, tags, (id) => roster.has(id));
  const target = problem.mode.target;
  if (target === null) return { ...evaluationOfScored(problem, scored), meetsTarget: null };
  // `makeScale` takes the lcm of every size it is given, so `scaleD` joins the tie groups of the scored lineup: a re-suggest can give it a tie the run never saw.
  const D = makeScale(problem.support, new Set([...(scaleD === undefined ? [] : [scaleD]), ...tieGroupSizes(problem.currentResults), ...tieGroupSizes(scored.results)])).D;
  return { ...evaluationOfScored(problem, scored), meetsTarget: reachesTarget(scored.value, target, D) };
}

export async function autoBuild(req: AutoBuildRequest, solve: MipSolve): Promise<AutoBuildResult> {
  // The wall-time budget runs from here (D5 amendment 1, 6.3). Without a clock, only solver-reported seconds count.
  const started = req.clock?.();
  const { problem, currentResults } = prepare(req);
  const load = req.load;
  const space = new Space(problem, req.limits.candidatesPerEvent, req.clock, (events, evaluator) => {
    if (load !== null && load.preference.mode !== 'off') checkLoad(load, events, evaluator);
    // D5 2.1 item 8, after the schedule refusals of item 6: robust mode needs one pair with a spread. A simulator-only model has none.
    if (problem.robust !== null && problem.robust.pins.size === 0) {
      autoBuildFail('robust_no_spread', 'robust mode found no (swimmer, event) pair with enough dated SCY swims inside the record range, so no pair has a spread', 'robust');
    }
  });

  const current = evaluationOf(currentResults, problem);
  const currentInSpace = repairable(problem).length === 0 && strictFits(problem);
  const records: SolveRecord[] = [];
  // Goal seek (D5 8.4): a feasible current lineup that reaches the target needs no change. The schedule refusals above have run first.
  const target = problem.mode.target;
  if (target !== null && repairable(problem).length === 0) {
    const D = scaleFor(space).D;
    if (reachesTarget(current.objective, target, D)) {
      const proof: AutoBuildProof = { status: 'proven_optimal', bestFound: 0, upperBound: 0, gap: 0, ...proofBase(problem, space, records, null, !strictFits(problem)) };
      return { kind: 'unchanged', reason: 'current_meets_target', current, proof };
    }
  }
  const outcome = await solveAutoBuild(space, req.limits, solve, req.clock, started, records);
  return outcome.kind === 'found'
    ? decide(problem, space, outcome, current, currentInSpace, records, req.clock)
    : undecided(problem, space, outcome, current, currentInSpace, records);
}
