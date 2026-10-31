/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Build and gate (D5 8). The proposal is built from the chosen columns, re-scored as a whole meet through `scoreMeet`, and
 * accepted only when the re-scored points equal the MIP's points and no new hard violation shows. A difference throws
 * `model_mismatch` and no lineup leaves this module.
 */
import { scoreMeet } from '../model/results';
import { sessionLoad } from '../planner/sessionLoad';
import type { Results, Violation } from '../model/results';
import { entryKey } from '../model/lineup';
import type { IndividualEntry, LineupEntry, RelayEntry, ScorerTag } from '../model/lineup';
import type { Gender, SwimmerId, TeamId } from '../model/primitives';
import type { Selection, Scale } from './lp';
import { ownPenalty, scorerIds, violationsOf } from './load';
import type { SessionLoadResult } from './load';
import { freshRelays, squadKeyOfEntry } from './squads';
import { metricOf, reachesTarget } from './mode';
import { pinLineup } from './robust';
import { rosterSpots } from './roster';
import { pairKey } from './space';
import type { Problem, Space } from './space';
import { autoBuildFail } from './types';
import type { AutoBuildEvaluation, AutoBuildProposal, EntryChange } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const ownPointsOf = (results: Results, own: TeamId): number => (results.teams.find((t) => t.teamId === own) as { points: number }).points;

/**
 * A violation the gate refuses to add. The others are warnings or settings the engine only reports. A `session_load` violation
 * is hard in `respect` mode only: in `prefer` mode it is the cost the penalty prices. The limit binds own decision swimmers only
 * (D5 amendment 2): with `decision` given, a `session_load` violation of any other swimmer, an opponent, is never hard.
 */
export function isHard(v: Violation, respect: boolean, decision?: ReadonlySet<SwimmerId>): boolean {
  switch (v.kind) {
    case 'session_load':
      return respect && (decision === undefined || decision.has(v.swimmerId));
    case 'entry_cap':
    case 'scoring_team_size':
    case 'relay_swimmer_repeated':
    case 'relay_entries_over_limit':
    case 'unscheduled_event':
      return true;
    case 'relay_leg':
      return v.reason !== 'off_scoring_roster';
    default:
      return false;
  }
}

const isWarning = (v: Violation, problem: Problem): boolean =>
  v.kind === 'scorer_without_entry' ||
  v.kind === 'seed_time_missing' ||
  (v.kind === 'relay_leg' && v.reason === 'off_scoring_roster') ||
  // A swimmer outside the decision set, an opponent, is not bound by the own load limit: a new violation of theirs is reported, not refused.
  (v.kind === 'session_load' && !problem.decision.has(v.swimmerId));

/** Hard violations of a lineup that name a decision swimmer or an own built side: what the solver can repair. */
export function repairable(problem: Problem): Violation[] {
  const respect = problem.support.load !== null && !problem.support.load.prefer;
  return problem.currentViolations.filter((v) => {
    if (v.kind === 'entry_cap') return problem.decision.has(v.swimmerId);
    if (v.kind === 'session_load') return respect && problem.decision.has(v.swimmerId);
    if (v.kind === 'scoring_team_size') return v.teamId === problem.req.ownTeamId && problem.genders.includes(v.gender);
    // Own relays of a built event are solver-owned: an over-limit count there is repaired by choosing fewer relays (D5 amendment 2, 3.3).
    if (v.kind === 'relay_entries_over_limit') return v.teamId === problem.req.ownTeamId && problem.built.some((e) => e.eventKey === v.eventKey && e.gender === v.gender);
    return false;
  });
}

const isPinned = (problem: Problem, id: SwimmerId): boolean => problem.roles.get(id) === 'scorer';
/** A decision swimmer on the proposal's roster: a pinned scorer the build keeps (slice A9: not a removed one), or a free swimmer who joins. */
const onRoster = (problem: Problem, who: { readonly joined: ReadonlySet<SwimmerId>; readonly removed: ReadonlySet<SwimmerId> }, id: SwimmerId): boolean =>
  (isPinned(problem, id) && !who.removed.has(id)) || who.joined.has(id);
const genderOf = (problem: Problem, id: SwimmerId): Gender => (problem.req.model.swimmers.find((s) => s.swimmerId === id) as { gender: Gender }).gender;

export interface Built {
  readonly lineup: AutoBuildProposal['lineup'];
  readonly rosterAdds: AutoBuildProposal['rosterAdds'];
  readonly tagsForScoring: readonly ScorerTag[];
  readonly entryChanges: readonly EntryChange[];
  /** Free swimmers with z = 1. */
  readonly joined: ReadonlySet<SwimmerId>;
  /** Swappable scorers with z = 0 (slice A9). */
  readonly removed: ReadonlySet<SwimmerId>;
  readonly rosterRemoves: AutoBuildProposal['rosterRemoves'];
}

const eventIdOf = (e: { readonly gender: Gender; readonly eventKey: string }): string => `${e.gender}\u0000${e.eventKey}`;

/** D5 8.1: copy the lineup, drop the solver-owned entries that are not chosen, keep the rest in place, append the new entries. */
export function buildLineup(problem: Problem, space: Space, selection: Selection): Built {
  const { req } = problem;
  // A scorer the gate restored keeps his entries as built under the removal, so for the entries he still counts as removed.
  const owned = (id: SwimmerId): boolean => onRoster(problem, { joined: selection.joined, removed: new Set([...selection.removed, ...(selection.restored ?? [])]) }, id);
  const members = new Map<string, ReadonlySet<SwimmerId>>();
  for (const es of space.events) members.set(es.id, new Set(selection.chosen.get(es.id)?.members ?? []));
  const builtIds = new Set(space.events.map((es) => es.id));
  const relayIds = new Set(space.events.filter((es) => es.relay !== null).map((es) => es.id));

  /** An own relay of a built relay event is solver-owned: it stays only when its squad is in the chosen column. */
  const relayVerdict = (e: LineupEntry): 'keep' | 'drop' | null => {
    if (e.kind !== 'relay' || e.teamId !== req.ownTeamId || !relayIds.has(eventIdOf(e))) return null;
    const wanted = (selection.chosen.get(eventIdOf(e))?.squads ?? []).some((q) => q.key === squadKeyOfEntry(e));
    return wanted ? 'keep' : 'drop';
  };
  /** An own individual entry of a decision swimmer who is pinned or joins: it stays only when the swimmer is in the chosen column. */
  const individualDropped = (e: LineupEntry): boolean =>
    e.kind === 'individual' &&
    e.teamId === req.ownTeamId &&
    problem.decision.has(e.swimmerId) &&
    builtIds.has(eventIdOf(e)) &&
    owned(e.swimmerId) &&
    !(members.get(eventIdOf(e)) as ReadonlySet<SwimmerId>).has(e.swimmerId);

  const entries: LineupEntry[] = [];
  const changes: EntryChange[] = [];
  const have = new Set<string>();
  const surviving = new Map<string, RelayEntry[]>();
  for (const e of req.lineup.entries) {
    const verdict = relayVerdict(e);
    if (verdict === 'drop' || individualDropped(e)) {
      changes.push({ kind: 'removed', entryKey: entryKey(e), why: 'replaced' });
      continue;
    }
    if (verdict === 'keep') surviving.set(eventIdOf(e), [...(surviving.get(eventIdOf(e)) ?? []), e as RelayEntry]);
    if (e.kind === 'individual' && e.teamId === req.ownTeamId && problem.decision.has(e.swimmerId) && builtIds.has(eventIdOf(e)) && owned(e.swimmerId)) {
      have.add(pairKey(e.swimmerId, e.eventKey) + e.gender);
    }
    entries.push(e);
  }
  const order = new Map<string, number>(req.model.events.map((e, i) => [eventIdOf(e), i]));
  const byModelOrder = [...space.events].sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
  const added: EntryChange[] = [];
  const append = (fresh: readonly LineupEntry[]): void => {
    for (const f of fresh) {
      entries.push(f);
      added.push({ kind: 'added', entryKey: entryKey(f) });
    }
  };
  for (const es of byModelOrder) {
    if (es.relay !== null) {
      const kept = surviving.get(es.id) ?? [];
      const present = new Set(kept.map(squadKeyOfEntry));
      const squads = (selection.chosen.get(es.id)?.squads ?? []).filter((q) => !present.has(q.key));
      append(freshRelays(req.ownTeamId, es.event, squads, kept));
      continue;
    }
    const fresh: IndividualEntry[] = [];
    for (const swimmerId of members.get(es.id) as ReadonlySet<SwimmerId>) {
      if (have.has(pairKey(swimmerId, es.event.eventKey) + es.event.gender)) continue;
      fresh.push({ kind: 'individual', teamId: req.ownTeamId, swimmerId, eventKey: es.event.eventKey, gender: es.event.gender, seedSwimId: null });
    }
    append(fresh.sort((a, b) => cmp(entryKey(a), entryKey(b))));
  }

  const joined = [...selection.joined].sort(cmp);
  const rosterAdds = joined.map((swimmerId) => ({ teamId: req.ownTeamId, gender: genderOf(problem, swimmerId), swimmerId }));
  const removed = [...selection.removed].sort(cmp);
  const rosterRemoves = removed.map((swimmerId) => ({ teamId: req.ownTeamId, gender: genderOf(problem, swimmerId), swimmerId }));
  // A removed scorer loses his tag (his entries stay in the lineup as non-scorer entries).
  const kept = req.tags.filter((t) => !(t.teamId === req.ownTeamId && t.role === 'scorer' && selection.removed.has(t.swimmerId)));
  const tags: ScorerTag[] = [...kept, ...joined.map((swimmerId) => ({ teamId: req.ownTeamId, swimmerId, role: 'scorer' as const }))];
  tags.sort((a, b) => cmp(a.teamId, b.teamId) || cmp(a.swimmerId, b.swimmerId) || cmp(a.role, b.role));
  return {
    lineup: { payloadVersion: 1, meetKey: req.lineup.meetKey, entries },
    rosterAdds,
    rosterRemoves,
    tagsForScoring: tags,
    entryChanges: [...changes, ...added],
    joined: new Set(joined),
    removed: new Set(removed),
  };
}

/** A built lineup, scored whole the way the gate scores it (D5 8.2): the results, the load, the own-only penalty, the robust copy and the metric. */
interface Candidate {
  readonly built: Built;
  readonly results: Results;
  readonly load: SessionLoadResult | null;
  readonly penaltyPoints: number;
  readonly robustResults: Results | null;
  readonly value: number;
  readonly rival: ReturnType<typeof metricOf>['rival'];
  readonly violations: readonly Violation[];
}

/** A lineup scored in the terms of the request's objective (D5 4.7, 5.4, 8.2). */
export interface Scored {
  readonly results: Results;
  readonly load: SessionLoadResult | null;
  readonly penaltyPoints: number;
  readonly robustResults: Results | null;
  readonly value: number;
  readonly rival: ReturnType<typeof metricOf>['rival'];
}

/**
 * The one place that scores a lineup for the objective: the gate, the current lineup (`evaluationOf`) and `autoBuildObjective` all call it.
 * `owned` says which own swimmers the robust pins apply to (the swimmers on the scoring roster that the solver decides). `known` passes a score or a
 * load the caller already has for the same lineup and tags.
 */
export function scoreLineup(
  problem: Problem,
  lineup: AutoBuildProposal['lineup'],
  tagsForScoring: readonly ScorerTag[],
  owned: (id: SwimmerId) => boolean,
  known: { readonly results?: Results; readonly load?: SessionLoadResult | null } = {}
): Scored {
  const { req } = problem;
  const results = known.results ?? scoreMeet(req.model, lineup, tagsForScoring, req.rules, req.sourcing);
  // D5 8.2: the load of the lineup, and a penalty over the own swimmers on the roster only (never `sessionLoad`'s own total).
  const rule = problem.support.load;
  const load: SessionLoadResult | null = known.load !== undefined ? known.load : rule === null ? null : sessionLoad(req.model, lineup, results, rule.schedule, rule.preference, req.rules);
  const penaltyPoints = ownPenalty(rule, load, scorerIds(tagsForScoring, req.ownTeamId));
  // D5 5.4 and 8.2: robust mode ranks the lineup with the robust swims pinned on the entries of the swimmers the solver owns. The pinned copy is
  // scored by `scoreMeet` for the objective only. Everything else (`results`, the load, the violations) is the lineup as given.
  const robustResults = problem.robust === null ? null : scoreMeet(req.model, pinLineup(lineup, req.ownTeamId, problem.robust.pins, owned), tagsForScoring, req.rules, req.sourcing);
  const { value, rival } = metricOf(problem.mode, robustResults ?? results, req.ownTeamId);
  return { results, load, penaltyPoints, robustResults, value, rival };
}

/** The evaluation of a scored lineup: the objective is the metric less the own-only penalty, but in goal seek the metric alone (D5 4.7). */
export function evaluationOfScored(problem: Problem, s: Scored): AutoBuildEvaluation {
  return {
    objective: problem.mode.target === null ? s.value - s.penaltyPoints : s.value,
    ownPoints: ownPointsOf(s.results, problem.req.ownTeamId),
    rival: s.rival,
    robustOwnPoints: s.robustResults === null ? null : ownPointsOf(s.robustResults, problem.req.ownTeamId),
    penaltyPoints: s.penaltyPoints,
    results: s.results,
    load: s.load,
  };
}

function candidateOf(problem: Problem, built: Built): Candidate {
  const scored = scoreLineup(problem, built.lineup, built.tagsForScoring, (id) => onRoster(problem, built, id));
  const rule = problem.support.load;
  return { built, ...scored, violations: violationsOf(scored.results, scored.load, rule === null ? null : rule.schedule) };
}

/** The objective of a candidate in the gate's terms: the metric of the mode (robust seeds in robust mode) less the own-only penalty. */
const objectiveOfCandidate = (c: Candidate): number => c.value - c.penaltyPoints;

/**
 * Slice A9. Without Z2 a swappable scorer's `z` is free while the team-size row has slack, so a result that skipped the tie-break (a time limit, an
 * incumbent) can list a removal that buys nothing, or one that the solver could have undone for more points. The gate undoes a removal, in swimmer-id
 * order, when (1) the strict team-size count (D5 4.4) still holds with him back, (2) the lineup with him a scorer again adds no blocking violation to the
 * lineup without him (see `blockersOf`: a swimmer over a limit is a blocker on the roster and none off it), and (3) the objective that `scoreMeet` gives
 * it is not lower. His entries stay as built under the removal (`Selection.restored`), so only his tag comes back. The caller has checked the solver's
 * own assignment against the MIP first. A restore is post-processing: the lineup it gives may score above the solver's value (an incumbent of a
 * time-limited solve). A goal seek is exempt: it minimizes changes, so the solver itself never removes without a reason, and the change count must
 * match the MIP's.
 */
export function restoreIdleRemovals(problem: Problem, space: Space, selection: Selection): Selection {
  if (selection.removed.size === 0 || problem.mode.target !== null) return selection;
  const { req, support } = problem;
  const own = req.ownTeamId;
  let state = selection;
  const first = candidateOf(problem, buildLineup(problem, space, state));
  const lineup = first.built.lineup;
  let baseline = objectiveOfCandidate(first);
  let blocked = new Set(blockersOf(problem, first.built, first.violations).map((b) => b.key));
  for (const g of problem.genders) {
    const onTeam = (id: SwimmerId): boolean => genderOf(problem, id) === g;
    const roster = new Set<SwimmerId>(req.tags.filter((t) => t.teamId === own && t.role === 'scorer' && onTeam(t.swimmerId) && !selection.removed.has(t.swimmerId)).map((t) => t.swimmerId));
    for (const id of selection.joined) if (onTeam(id)) roster.add(id);
    for (const id of [...selection.removed].filter(onTeam).sort(cmp)) {
      const spots = rosterSpots(lineup, [...roster, id], support.weight, req.model.events, true);
      if (support.size !== 'unlimited' && spots.numerator > support.size * support.weight.denominator) continue;
      const back: Selection = { ...state, removed: new Set([...state.removed].filter((x) => x !== id)), restored: new Set([...(state.restored ?? []), id]) };
      const next = candidateOf(problem, buildLineup(problem, space, back));
      const blockers = blockersOf(problem, next.built, next.violations);
      if (blockers.some((b) => !blocked.has(b.key))) continue;
      const objective = objectiveOfCandidate(next);
      if (objective < baseline - 1e-9) continue;
      state = back;
      baseline = objective;
      blocked = new Set(blockers.map((b) => b.key));
      roster.add(id);
    }
  }
  return state;
}

/**
 * The objective of a built lineup (the metric of the mode, less the own-only penalty in `prefer` mode) must equal the MIP's, scaled
 * (D5 8.3.2). `what` names the quantity in the failure.
 */
function checkPoints(points: number, scale: Scale, mip: number, what = 'the own points less the penalty'): void {
  const x = points * scale.D;
  if (Math.abs(x - Math.round(x)) >= 1e-6 || Math.round(x) !== mip) {
    autoBuildFail('model_mismatch', `scoreMeet gives ${points} for ${what} (${x} at scale ${scale.D}); the solver proved ${mip}`);
  }
}

/** A hard violation the gate refuses (D5 8.3.3 and 8.3.4), with the failure it raises. `key` names the violation. */
interface Blocker {
  readonly key: string;
  readonly message: string;
  readonly subject: string | null;
}

/**
 * The hard violations of a built lineup that the gate refuses, in order. The checks that name a swimmer are roster-aware: an entry-cap or session-load
 * violation binds a decision swimmer on the roster of this built lineup (`onRoster`), not one who left it, though `sessionLoad` lists both.
 */
function blockersOf(problem: Problem, built: Built, violations: readonly Violation[]): Blocker[] {
  const before = new Set(problem.currentViolations.map((v) => JSON.stringify(v)));
  const respect = problem.support.load !== null && !problem.support.load.prefer;
  const out: Blocker[] = [];
  for (const v of violations) {
    if (!isHard(v, respect, problem.decision)) continue;
    const key = JSON.stringify(v);
    if (v.kind === 'entry_cap' && problem.decision.has(v.swimmerId) && onRoster(problem, built, v.swimmerId)) {
      out.push({ key, message: `swimmer "${v.swimmerId}" is over the ${v.which} entry cap in the built lineup (${v.count} of ${v.limit})`, subject: v.swimmerId });
    } else if (v.kind === 'session_load' && problem.decision.has(v.swimmerId) && onRoster(problem, built, v.swimmerId)) {
      out.push({ key, message: `swimmer "${v.swimmerId}" swims ${v.races} races in one session in the built lineup (limit ${v.limit})`, subject: v.swimmerId });
    } else if (v.kind === 'scoring_team_size' && v.teamId === problem.req.ownTeamId && problem.genders.includes(v.gender)) {
      out.push({ key, message: `the built ${v.gender} roster is over the scoring-team size`, subject: v.gender });
    } else if (!before.has(key)) {
      out.push({ key, message: `the built lineup adds a ${v.kind} violation that the current lineup lacks`, subject: v.kind });
    }
  }
  return out;
}

/** D5 8.3.3 and 8.3.4. */
function checkViolations(problem: Problem, built: Built, violations: readonly Violation[]): Violation[] {
  const before = new Set(problem.currentViolations.map((v) => JSON.stringify(v)));
  const first = blockersOf(problem, built, violations)[0];
  if (first !== undefined) autoBuildFail('model_mismatch', first.message, first.subject);
  return violations.filter((v) => isWarning(v, problem) && !before.has(JSON.stringify(v)));
}

/**
 * Build, re-score and check. Throws `model_mismatch` on any difference. `mipPoints` is what the mode ranks (`LpBuild.pointsOf`):
 * the metric less the penalty, or in goal seek the negative change count. `valueScaled` is the metric (`LpBuild.valueOf`), which goal
 * seek checks as well, because its ranked quantity says nothing about the metric.
 *
 * Two phases. First the solver's own assignment is built and checked against `mipPoints` and the hard rules. Then (not in goal seek) the gate
 * undoes the removals that `restoreIdleRemovals` accepts and scores the lineup it gives again. That candidate is the proposal: its score, not the
 * solver's, is the evaluation. It is never below `mipPoints`.
 */
export function gate(
  problem: Problem,
  space: Space,
  selection: Selection,
  scale: Scale,
  mipPoints: number,
  method: AutoBuildProposal['method'] = 'mip',
  valueScaled: number = mipPoints
): AutoBuildProposal {
  const raw = candidateOf(problem, buildLineup(problem, space, selection));
  const target = problem.mode.target;
  if (target === null) {
    checkPoints(raw.value - raw.penaltyPoints, scale, mipPoints, 'the metric less the penalty');
  } else {
    // Goal seek (D5 4.7): the metric equals the MIP's, it reaches the target, and the changes counted from the lineup are the ones
    // the MIP minimized (4.9). The metric carries no penalty.
    checkPoints(raw.value, scale, valueScaled, 'the metric');
    if (!reachesTarget(raw.value, target, scale.D)) autoBuildFail('model_mismatch', `the built lineup's metric ${raw.value} is below the target ${target}`);
    const rawChanges = raw.built.rosterAdds.length + raw.built.rosterRemoves.length + raw.built.entryChanges.length;
    if (rawChanges !== -mipPoints) autoBuildFail('model_mismatch', `the built lineup has ${rawChanges} changes; the solver counted ${-mipPoints}`);
  }
  checkViolations(problem, raw.built, raw.violations);
  const restored = restoreIdleRemovals(problem, space, selection);
  const final = restored === selection ? raw : candidateOf(problem, buildLineup(problem, space, restored));
  const { built } = final;
  const changeCount = built.rosterAdds.length + built.rosterRemoves.length + built.entryChanges.length;
  const newWarnings = checkViolations(problem, built, final.violations);
  const evaluation = evaluationOfScored(problem, final);
  return {
    lineup: built.lineup,
    rosterAdds: built.rosterAdds,
    rosterRemoves: built.rosterRemoves,
    tagsForScoring: built.tagsForScoring,
    entryChanges: built.entryChanges,
    changeCount,
    evaluation,
    explanations: [],
    newWarnings,
    method,
    scaleD: scale.D,
  };
}
