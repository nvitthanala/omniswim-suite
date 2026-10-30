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
import { metricOf } from './mode';
import { pinLineup } from './robust';
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
const genderOf = (problem: Problem, id: SwimmerId): Gender => (problem.req.model.swimmers.find((s) => s.swimmerId === id) as { gender: Gender }).gender;

export interface Built {
  readonly lineup: AutoBuildProposal['lineup'];
  readonly rosterAdds: AutoBuildProposal['rosterAdds'];
  readonly tagsForScoring: readonly ScorerTag[];
  readonly entryChanges: readonly EntryChange[];
  /** Free swimmers with z = 1. */
  readonly joined: ReadonlySet<SwimmerId>;
}

const eventIdOf = (e: { readonly gender: Gender; readonly eventKey: string }): string => `${e.gender}\u0000${e.eventKey}`;

/** D5 8.1: copy the lineup, drop the solver-owned entries that are not chosen, keep the rest in place, append the new entries. */
export function buildLineup(problem: Problem, space: Space, selection: Selection): Built {
  const { req } = problem;
  const owned = (id: SwimmerId): boolean => isPinned(problem, id) || selection.joined.has(id);
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
  const tags: ScorerTag[] = [...req.tags, ...joined.map((swimmerId) => ({ teamId: req.ownTeamId, swimmerId, role: 'scorer' as const }))];
  tags.sort((a, b) => cmp(a.teamId, b.teamId) || cmp(a.swimmerId, b.swimmerId) || cmp(a.role, b.role));
  return {
    lineup: { payloadVersion: 1, meetKey: req.lineup.meetKey, entries },
    rosterAdds,
    tagsForScoring: tags,
    entryChanges: [...changes, ...added],
    joined: new Set(joined),
  };
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

/** D5 8.3.3 and 8.3.4. */
function checkViolations(problem: Problem, built: Built, violations: readonly Violation[]): Violation[] {
  const before = new Set(problem.currentViolations.map((v) => JSON.stringify(v)));
  const respect = problem.support.load !== null && !problem.support.load.prefer;
  for (const v of violations) {
    if (!isHard(v, respect, problem.decision)) continue;
    if (v.kind === 'entry_cap' && problem.decision.has(v.swimmerId) && (isPinned(problem, v.swimmerId) || built.joined.has(v.swimmerId))) {
      autoBuildFail('model_mismatch', `swimmer "${v.swimmerId}" is over the ${v.which} entry cap in the built lineup (${v.count} of ${v.limit})`, v.swimmerId);
    }
    if (v.kind === 'session_load' && problem.decision.has(v.swimmerId) && (isPinned(problem, v.swimmerId) || built.joined.has(v.swimmerId))) {
      autoBuildFail('model_mismatch', `swimmer "${v.swimmerId}" swims ${v.races} races in one session in the built lineup (limit ${v.limit})`, v.swimmerId);
    }
    if (v.kind === 'scoring_team_size' && v.teamId === problem.req.ownTeamId && problem.genders.includes(v.gender)) {
      autoBuildFail('model_mismatch', `the built ${v.gender} roster is over the scoring-team size`, v.gender);
    }
    if (!before.has(JSON.stringify(v))) autoBuildFail('model_mismatch', `the built lineup adds a ${v.kind} violation that the current lineup lacks`, v.kind);
  }
  return violations.filter((v) => isWarning(v, problem) && !before.has(JSON.stringify(v)));
}

/**
 * Build, re-score and check. Throws `model_mismatch` on any difference. `mipPoints` is what the mode ranks (`LpBuild.pointsOf`):
 * the metric less the penalty, or in goal seek the negative change count. `valueScaled` is the metric (`LpBuild.valueOf`), which goal
 * seek checks as well, because its ranked quantity says nothing about the metric.
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
  const { req } = problem;
  const built = buildLineup(problem, space, selection);
  const results = scoreMeet(req.model, built.lineup, built.tagsForScoring, req.rules, req.sourcing);
  // D5 8.2: the load of the built lineup, and a penalty over the own swimmers on the roster only (never `sessionLoad`'s own total).
  const rule = problem.support.load;
  const load: SessionLoadResult | null = rule === null ? null : sessionLoad(req.model, built.lineup, results, rule.schedule, rule.preference, req.rules);
  const penaltyPoints = ownPenalty(problem.support.load, load, scorerIds(built.tagsForScoring, req.ownTeamId));
  const ownPoints = ownPointsOf(results, req.ownTeamId);
  // D5 5.4 and 8.2: robust mode ranks the lineup with the robust swims pinned on the entries of the swimmers the solver owns. The pinned copy is
  // scored by `scoreMeet` for the objective only. Everything else (`results`, `ownPoints`, the load, the violations) is the lineup as built.
  const robustResults =
    problem.robust === null
      ? null
      : scoreMeet(req.model, pinLineup(built.lineup, req.ownTeamId, problem.robust.pins, (id) => isPinned(problem, id) || built.joined.has(id)), built.tagsForScoring, req.rules, req.sourcing);
  const { value, rival } = metricOf(problem.mode, robustResults ?? results, req.ownTeamId);
  const changeCount = built.rosterAdds.length + built.entryChanges.length;
  const target = problem.mode.target;
  if (target === null) {
    checkPoints(value - penaltyPoints, scale, mipPoints, 'the metric less the penalty');
  } else {
    // Goal seek (D5 4.7): the metric equals the MIP's, it reaches the target, and the changes counted from the lineup are the ones
    // the MIP minimized (4.9). The metric carries no penalty.
    checkPoints(value, scale, valueScaled, 'the metric');
    if (Math.round(value * scale.D) < Math.ceil(target * scale.D - 1e-9)) autoBuildFail('model_mismatch', `the built lineup's metric ${value} is below the target ${target}`);
    if (changeCount !== -mipPoints) autoBuildFail('model_mismatch', `the built lineup has ${changeCount} changes; the solver counted ${-mipPoints}`);
  }
  const newWarnings = checkViolations(problem, built, violationsOf(results, load, rule === null ? null : rule.schedule));
  const evaluation: AutoBuildEvaluation = { objective: target === null ? value - penaltyPoints : value, ownPoints, rival, robustOwnPoints: robustResults === null ? null : ownPointsOf(robustResults, req.ownTeamId), penaltyPoints, results, load };
  return {
    lineup: built.lineup,
    rosterAdds: built.rosterAdds,
    tagsForScoring: built.tagsForScoring,
    entryChanges: built.entryChanges,
    changeCount,
    evaluation,
    explanations: [],
    newWarnings,
    method,
  };
}

