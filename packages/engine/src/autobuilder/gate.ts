/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Build and gate (D5 8). The proposal is built from the chosen columns, re-scored as a whole meet through `scoreMeet`, and
 * accepted only when the re-scored points equal the MIP's points and no new hard violation shows. A difference throws
 * `model_mismatch` and no lineup leaves this module.
 */
import { scoreMeet } from '../model/results';
import type { Results, Violation } from '../model/results';
import { entryKey } from '../model/lineup';
import type { IndividualEntry, LineupEntry, RelayEntry, ScorerTag } from '../model/lineup';
import type { Gender, SwimmerId, TeamId } from '../model/primitives';
import type { Selection, Scale } from './lp';
import { freshRelays, squadKeyOfEntry } from './squads';
import { pairKey } from './space';
import type { Problem, Space } from './space';
import { autoBuildFail } from './types';
import type { AutoBuildEvaluation, AutoBuildProposal, EntryChange } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const ownPointsOf = (results: Results, own: TeamId): number => (results.teams.find((t) => t.teamId === own) as { points: number }).points;

/** A violation the gate refuses to add. The others are warnings or settings the engine only reports. */
export function isHard(v: Violation): boolean {
  switch (v.kind) {
    case 'entry_cap':
    case 'session_load':
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

const isWarning = (v: Violation): boolean =>
  v.kind === 'scorer_without_entry' || v.kind === 'seed_time_missing' || (v.kind === 'relay_leg' && v.reason === 'off_scoring_roster');

/** Hard violations of a lineup that name a decision swimmer or an own built side: what the solver can repair. */
export function repairable(problem: Problem, results: Results): Violation[] {
  return results.violations.filter((v) => {
    if (v.kind === 'entry_cap' || v.kind === 'session_load') return problem.decision.has(v.swimmerId);
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

/** The own points of a built lineup must equal the MIP's points, scaled (D5 8.3.2). */
function checkPoints(results: Results, own: TeamId, scale: Scale, mip: number): void {
  const points = ownPointsOf(results, own);
  const x = points * scale.D;
  if (Math.abs(x - Math.round(x)) >= 1e-6 || Math.round(x) !== mip) {
    autoBuildFail('model_mismatch', `scoreMeet gives ${points} own points (${x} at scale ${scale.D}); the solver proved ${mip}`);
  }
}

/** D5 8.3.3 and 8.3.4. */
function checkViolations(problem: Problem, built: Built, results: Results, current: Results): Violation[] {
  const before = new Set(current.violations.map((v) => JSON.stringify(v)));
  for (const v of results.violations) {
    if (!isHard(v)) continue;
    if (v.kind === 'entry_cap' && problem.decision.has(v.swimmerId) && (isPinned(problem, v.swimmerId) || built.joined.has(v.swimmerId))) {
      autoBuildFail('model_mismatch', `swimmer "${v.swimmerId}" is over the ${v.which} entry cap in the built lineup (${v.count} of ${v.limit})`, v.swimmerId);
    }
    if (v.kind === 'scoring_team_size' && v.teamId === problem.req.ownTeamId && problem.genders.includes(v.gender)) {
      autoBuildFail('model_mismatch', `the built ${v.gender} roster is over the scoring-team size`, v.gender);
    }
    if (!before.has(JSON.stringify(v))) autoBuildFail('model_mismatch', `the built lineup adds a ${v.kind} violation that the current lineup lacks`, v.kind);
  }
  return results.violations.filter((v) => isWarning(v) && !before.has(JSON.stringify(v)));
}

/** Build, re-score and check. Throws `model_mismatch` on any difference. */
export function gate(problem: Problem, space: Space, selection: Selection, scale: Scale, mipPoints: number, method: 'mip' | 'mip-incumbent' = 'mip'): AutoBuildProposal {
  const { req } = problem;
  const built = buildLineup(problem, space, selection);
  const results = scoreMeet(req.model, built.lineup, built.tagsForScoring, req.rules, req.sourcing);
  checkPoints(results, req.ownTeamId, scale, mipPoints);
  const newWarnings = checkViolations(problem, built, results, problem.currentResults);
  const ownPoints = ownPointsOf(results, req.ownTeamId);
  const evaluation: AutoBuildEvaluation = { objective: ownPoints, ownPoints, rival: null, robustOwnPoints: null, penaltyPoints: 0, results, load: null };
  return {
    lineup: built.lineup,
    rosterAdds: built.rosterAdds,
    tagsForScoring: built.tagsForScoring,
    entryChanges: built.entryChanges,
    changeCount: built.rosterAdds.length + built.entryChanges.length,
    evaluation,
    explanations: [],
    newWarnings,
    method,
  };
}

