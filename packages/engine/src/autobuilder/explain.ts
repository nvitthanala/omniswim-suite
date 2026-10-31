/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Explanations (D5 9, slice A8). Two kinds: an `unusual_event` for an individual entry outside the swimmer's best events, and a
 * `roster_add` for a swimmer the proposal puts on the scoring roster. Every number is read from a `scoreMeet` result or a model swim:
 * the proposal's own results, a fresh `scoreMeet` of the proposal with one entry added or removed, the column evaluator for "the swimmer
 * alone against the other teams", or the seed of an entry (`resolveLineup`). No number is estimated.
 *
 * Choices the spec leaves open (the A8 report to the lead lists them):
 * - Every fact uses NORMAL seeds, in every mode. A robust proposal carries no pins, so the lineup the coach applies is scored with normal
 *   seeds, and these facts describe that lineup (`evaluation.results`, `evaluation.ownPoints`).
 * - `marginalPoints` is own points in every mode. A margin or goal-seek mode ranks lineups by a different metric, but "what this entry
 *   adds" stays the team's own points, so the text never has to name a rival.
 * - An entry is explained when the swimmer is owned (tagged a scorer, or added to the roster by this proposal) and the entry scored a
 *   place. An entry that was removed from the places has no place to explain.
 * - `explain` reads the proposal. It never changes it, and it never reads or changes the proof.
 */
import { buildIndex, isRankable, resolveLineup, scoreMeet, scyValue } from '../model/results';
import type { ResultRow, Results, Violation } from '../model/results';
import { entryKey } from '../model/lineup';
import type { IndividualEntry, Lineup, LineupEntry } from '../model/lineup';
import type { MeetEvent, MeetSwim } from '../model/meet';
import type { EventKey, Gender, Hundredths, SwimmerId } from '../model/primitives';
import { sessionLoad } from '../planner/sessionLoad';
import { Evaluator } from './evaluate';
import { ownPenalty, scorerIds, violationsOf } from './load';
import { ownPointsOf } from './gate';
import { rosterSpots } from './roster';
import { pairKey } from './space';
import type { Problem } from './space';
import { autoBuildFail } from './types';
import type { AutoBuildExplanation, AutoBuildProof, AutoBuildProposal } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export { rosterSpots };

/** Points are sums of table values, so a difference this small is zero. */
const PENALTY_EPSILON = 1e-9;

type Unusual = Extract<AutoBuildExplanation, { kind: 'unusual_event' }>;
type Skipped = Unusual['skipped'][number];

/** One event of a swimmer's ranking: the swimmer alone against the other teams (D5 9, invariant 17 rule 1). */
export interface RankedEvent {
  readonly event: MeetEvent;
  readonly place: number;
  readonly points: number;
}

/**
 * D5 9: the order of a swimmer's events. The singleton place first, then the singleton points (more is better), then the event key.
 * One function, so a later ruling changes one place.
 */
export function rankOrder(a: RankedEvent, b: RankedEvent): number {
  return a.place - b.place || b.points - a.points || cmp(a.event.eventKey, b.event.eventKey);
}

/**
 * The seed swim is `estimated` only when it is a converted swim (R58). An entry that names its seed swim reads that swim. Otherwise the
 * engine seeds the best rankable value, and the seed is estimated only when every swim at that value is converted: a recorded swim at the
 * same value proves the value.
 */
export function seedIsEstimated(swims: readonly MeetSwim[], entry: IndividualEntry, value: Hundredths): boolean {
  if (entry.seedSwimId !== null) {
    const named = swims.find((s) => s.swimId === entry.seedSwimId);
    if (named === undefined) autoBuildFail('model_mismatch', `the seed swim "${entry.seedSwimId}" of ${entryKey(entry)} is not in the model`);
    return (named as MeetSwim).scy.kind === 'converted';
  }
  const atValue = swims.filter((s) => isRankable(s) && scyValue(s) === value);
  if (atValue.length === 0) autoBuildFail('model_mismatch', `no swim of ${entry.swimmerId} in ${entry.eventKey} has the seed value ${value}`);
  return atValue.every((s) => s.scy.kind === 'converted');
}

/** The lineup without the swimmer: his individual entries, and every relay he swims (a swimmer belongs to one team, so no team test is needed). */
const withoutSwimmer = (lineup: Lineup, swimmerId: SwimmerId): Lineup => ({
  ...lineup,
  entries: lineup.entries.filter((e) => (e.kind === 'individual' ? e.swimmerId !== swimmerId : e.legs.every((l) => l.swimmerId !== swimmerId))),
});

const sameViolation = (a: Violation, b: Violation): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The next other-team entry behind a place: the best place past it. A tie of places is neither ahead nor behind. Entries that share a place
 * share a seed, so the order within a place (team, then entry key) never picks a different time.
 */
function nextBehind(
  field: readonly (ResultRow & { readonly place: number })[],
  place: number,
  values: ReadonlyMap<string, Hundredths | null>
): { readonly teamId: string; readonly seed: Hundredths } | null {
  const behind = field
    .filter((r) => r.place > place)
    .flatMap((r) => {
      const theirs = values.get(r.entryKey);
      return theirs === null || theirs === undefined ? [] : [{ teamId: r.teamId, place: r.place, seed: theirs, key: r.entryKey }];
    })
    .sort((a, b) => a.place - b.place || cmp(a.teamId, b.teamId) || cmp(a.key, b.key));
  const next = behind[0];
  return next === undefined ? null : { teamId: next.teamId, seed: next.seed };
}

/**
 * The roster_remove explanations (slice A9), sorted by swimmer id. `spotsAfter` is the proposal's roster after the removal. `marginalPoints` is the
 * own points of the proposal with the swimmer a scorer again (his entries stay in the lineup), less the proposal's own points: what keeping him adds.
 */
function rosterRemoveFacts(problem: Problem, proposal: AutoBuildProposal): AutoBuildExplanation[] {
  const { req, support } = problem;
  const own = req.ownTeamId;
  const swimmerOf = new Map(req.model.swimmers.map((s) => [s.swimmerId, s]));
  const out: AutoBuildExplanation[] = [];
  for (const gone of [...proposal.rosterRemoves].sort((a, b) => cmp(a.swimmerId, b.swimmerId))) {
    const scorers = proposal.tagsForScoring.filter((t) => t.teamId === own && t.role === 'scorer' && swimmerOf.get(t.swimmerId)?.gender === gone.gender).map((t) => t.swimmerId);
    const kept = scoreMeet(req.model, proposal.lineup, [...proposal.tagsForScoring, { teamId: own, swimmerId: gone.swimmerId, role: 'scorer' as const }], req.rules, req.sourcing);
    out.push({
      kind: 'roster_remove',
      swimmerId: gone.swimmerId,
      spotsAfter: rosterSpots(proposal.lineup, scorers, support.weight, req.model.events),
      marginalPoints: ownPointsOf(kept, own) - proposal.evaluation.ownPoints,
    });
  }
  return out;
}

/** The roster_add explanations, sorted by swimmer id. */
function rosterAddFacts(problem: Problem, proposal: AutoBuildProposal): AutoBuildExplanation[] {
  const { req, support } = problem;
  const own = req.ownTeamId;
  const swimmerOf = new Map(req.model.swimmers.map((s) => [s.swimmerId, s]));
  const out: AutoBuildExplanation[] = [];
  for (const add of [...proposal.rosterAdds].sort((a, b) => cmp(a.swimmerId, b.swimmerId))) {
    const scorers = proposal.tagsForScoring
      .filter((t) => t.teamId === own && t.role === 'scorer' && swimmerOf.get(t.swimmerId)?.gender === add.gender)
      .map((t) => t.swimmerId);
    const without = scoreMeet(req.model, withoutSwimmer(proposal.lineup, add.swimmerId), proposal.tagsForScoring, req.rules, req.sourcing);
    out.push({
      kind: 'roster_add',
      swimmerId: add.swimmerId,
      spotsAfter: rosterSpots(proposal.lineup, scorers, support.weight, req.model.events),
      marginalPoints: proposal.evaluation.ownPoints - ownPointsOf(without, own),
    });
  }
  return out;
}

/**
 * D5 9, why a swimmer is not entered in a higher-ranked event: `entry_cap` when he is at a cap, then `session_load` (a real limit, so
 * `respect` mode only), then `strict_diver_rule` (the AutoBuilder counts a swimmer who dives and swims as a full scoring spot, D5 14.4; real scoring may count
 * him at the diver weight, so this is the AutoBuilder's conservative rule, not a meet rule and not a `scoreMeet` violation), then
 * `load_penalty` (the prefer-mode penalty of the extra race is as large as the points the entry adds), then, when the entry adds own points and no limit blocks it, `search_limit` (max-own, a proof that is not `proven_optimal`, or a pair outside the candidate columns or frozen in robust mode: the search left it out) or `objective` (a proven optimum of another mode prefers the entered event), and last `teammates` (it adds no own points). `entry_cap`,
 * `session_load` and `load_penalty` read a `scoreMeet` or `sessionLoad` result of the proposal with the entry added. `strict_diver_rule` counts the
 * roster with `rosterSpots(..., strict = true)`.
 */
function bindingOf(
  problem: Problem,
  proposal: AutoBuildProposal,
  swimmerId: SwimmerId,
  gender: Gender,
  entry: IndividualEntry,
  added: { readonly points: number; readonly results: Results },
  event: MeetEvent,
  context: ExplainContext
): Skipped['binding'] {
  const { req } = problem;
  const rule = problem.support.load;
  const { results: after } = added;
  const before = proposal.evaluation.results.violations;
  const isNew = (v: Violation, base: readonly Violation[]): boolean => !base.some((b) => sameViolation(b, v));
  // The solver's own size test (D5 4.4): a diver who swims a non-dive event takes a full spot. `scoreMeet` does not see that, so it is not a violation.
  const { size, weight } = problem.support;
  const scorers = proposal.tagsForScoring
    .filter((t) => t.teamId === req.ownTeamId && t.role === 'scorer' && req.model.swimmers.find((s) => s.swimmerId === t.swimmerId)?.gender === gender)
    .map((t) => t.swimmerId);
  const overSize = (entries: readonly LineupEntry[]): boolean =>
    size !== 'unlimited' && rosterSpots({ ...proposal.lineup, entries }, scorers, weight, req.model.events, true).numerator > size * weight.denominator;
  if (after.violations.some((v) => v.kind === 'entry_cap' && v.swimmerId === swimmerId && isNew(v, before))) return 'entry_cap';
  const load = rule === null ? null : sessionLoad(req.model, { ...proposal.lineup, entries: [...proposal.lineup.entries, entry] }, after, rule.schedule, rule.preference, req.rules);
  if (rule !== null && !rule.prefer) {
    const base = violationsOf(proposal.evaluation.results, proposal.evaluation.load, rule.schedule);
    if (violationsOf(after, load, rule.schedule).some((v) => v.kind === 'session_load' && v.swimmerId === swimmerId && isNew(v, base))) return 'session_load';
  }
  if (overSize([...proposal.lineup.entries, entry]) && !overSize(proposal.lineup.entries)) return 'strict_diver_rule';
  if (rule !== null && rule.prefer && added.points > 0) {
    const extra = ownPenalty(rule, load, scorerIds(proposal.tagsForScoring, req.ownTeamId)) - proposal.evaluation.penaltyPoints;
    if (extra > 0 && added.points - extra <= PENALTY_EPSILON) return 'load_penalty';
  }
  if (added.points <= 0) return 'teammates';
  // The entry would add own points and no limit blocks it. Why did the search leave it out? A proven optimum in the space of a mode other than max-own
  // leaves it out only because the mode's objective prefers the entered event. Otherwise the search itself stopped short: in max-own a proven
  // optimum has no such entry, so it is always the search; a proof that is not `proven_optimal` is not a proof; and a pair outside the candidate
  // columns (or frozen in robust mode, which is never a candidate) was never tried.
  const maxOwn = problem.mode.metric === 'own' && problem.mode.target === null && problem.robust === null;
  if (maxOwn || context.status !== 'proven_optimal' || !context.candidate(event, swimmerId)) return 'search_limit';
  return 'objective';
}

/** What the search knew when it stopped: the proof status of the result, and whether a pair was in the candidate columns `C_e` of its event. */
export interface ExplainContext {
  readonly status: AutoBuildProof['status'];
  readonly candidate: (event: MeetEvent, swimmerId: SwimmerId) => boolean;
}

export function explain(problem: Problem, proposal: AutoBuildProposal, context: ExplainContext): readonly AutoBuildExplanation[] {
  const { req } = problem;
  const own = req.ownTeamId;
  const { model } = req;
  const results = proposal.evaluation.results;
  const index = buildIndex(model);
  const swimmerOf = new Map(model.swimmers.map((s) => [s.swimmerId, s]));
  const swimsOf = new Map<string, MeetSwim[]>();
  for (const s of model.swims) {
    const k = `${s.swimmerId}\u0000${s.eventKey}`;
    const bucket = swimsOf.get(k);
    if (bucket) bucket.push(s);
    else swimsOf.set(k, [s]);
  }
  const rowsOf = (r: Results, eventKey: EventKey, gender: Gender): readonly ResultRow[] => r.events.find((e) => e.eventKey === eventKey && e.gender === gender)?.rows ?? [];
  const valueOf = (lineup: Lineup): Map<string, Hundredths | null> => new Map(resolveLineup(model, lineup, index).resolved.map((r) => [r.key, r.value]));
  const proposalValues = valueOf(proposal.lineup);

  // The swimmers the solver owns: a decision swimmer (a built gender) on the proposal's roster. A scorer of a gender the request does not
  // build stays as entered, and is not ranked here. A scorer the proposal removes (slice A9) is not on the roster: his entries are non-scorer entries.
  const roster = new Set(proposal.tagsForScoring.filter((t) => t.teamId === own && t.role === 'scorer').map((t) => t.swimmerId));
  const owned = (id: SwimmerId): boolean => problem.decision.has(id) && roster.has(id);
  const out: AutoBuildExplanation[] = [];

  out.push(...rosterAddFacts(problem, proposal));
  out.push(...rosterRemoveFacts(problem, proposal));

  // unusual_event: individual entries only. One column evaluator over the request's lineup, with no load: the swimmer alone against every
  // fixed entry (the other teams and the own entries the build does not own).
  const evaluator = new Evaluator({
    model,
    lineup: req.lineup,
    tags: req.tags,
    rules: req.rules,
    sourcing: req.sourcing,
    own,
    decision: problem.decision,
    free: problem.freeSet,
    load: null,
    held: new Set<string>(),
  });
  const individuals = new Map<SwimmerId, IndividualEntry[]>();
  for (const e of proposal.lineup.entries) {
    if (e.kind !== 'individual' || e.teamId !== own) continue;
    const bucket = individuals.get(e.swimmerId);
    if (bucket) bucket.push(e);
    else individuals.set(e.swimmerId, [e]);
  }
  const marginalCache = new Map<string, { readonly points: number; readonly results: Results }>();

  for (const swimmerId of [...individuals.keys()].sort(cmp)) {
    if (!owned(swimmerId)) continue;
    const entries = individuals.get(swimmerId) as IndividualEntry[];
    const swimmer = swimmerOf.get(swimmerId);
    if (swimmer === undefined) continue;
    const entered = new Map(entries.map((e) => [`${e.gender}\u0000${e.eventKey}`, e]));
    // The ranking: every built individual event of the swimmer's gender where the swimmer has a usable seed and a place alone.
    const candidates = problem.built.filter((e) => e.kind !== 'relay' && e.gender === swimmer.gender);
    // The entry a swimmer has in an event: the proposal's, else the current one (it may name a seed swim, as an adapted lineup's does: the
    // column evaluator keeps it in place, so every number about the event reads the same seed), else a new one with the engine's own pick.
    const fresh = (event: MeetEvent): IndividualEntry =>
      entered.get(`${event.gender}\u0000${event.eventKey}`) ??
      problem.currentEntry.get(pairKey(swimmerId, event.eventKey)) ?? { kind: 'individual', teamId: own, swimmerId, eventKey: event.eventKey, gender: event.gender, seedSwimId: null };
    const seeds = valueOf({ payloadVersion: 1, meetKey: req.lineup.meetKey, entries: candidates.map(fresh) });
    const ranking: RankedEvent[] = [];
    for (const event of candidates) {
      if ((seeds.get(entryKey(fresh(event))) ?? null) === null) continue;
      const alone = evaluator.evaluate(event, [swimmerId]);
      const row = alone.rows.find((r) => r.entryKey === entryKey(fresh(event)));
      if (row === undefined || row.place === null) continue;
      ranking.push({ event, place: row.place, points: row.points });
    }
    ranking.sort(rankOrder);
    const best = new Set(ranking.slice(0, entries.length).map((r) => `${r.event.gender}\u0000${r.event.eventKey}`));

    const marginalOfAdding = (event: MeetEvent): { readonly points: number; readonly results: Results } => {
      const k = `${swimmerId}\u0000${event.gender}\u0000${event.eventKey}`;
      const known = marginalCache.get(k);
      if (known) return known;
      const added = scoreMeet(model, { ...proposal.lineup, entries: [...proposal.lineup.entries, fresh(event)] }, proposal.tagsForScoring, req.rules, req.sourcing);
      const value = { points: ownPointsOf(added, own) - proposal.evaluation.ownPoints, results: added };
      marginalCache.set(k, value);
      return value;
    };
    for (const entry of [...entries].sort((a, b) => cmp(entryKey(a), entryKey(b)))) {
      const rank = ranking.findIndex((r) => r.event.eventKey === entry.eventKey && r.event.gender === entry.gender);
      const row = rowsOf(results, entry.eventKey, entry.gender).find((r) => r.entryKey === entryKey(entry));
      if (row === undefined) autoBuildFail('model_mismatch', `${entryKey(entry)} is in the proposal but has no row in its results`);
      if ((row as ResultRow).place === null) continue; // removed from the places: nothing to explain
      if (rank < 0) autoBuildFail('model_mismatch', `${entryKey(entry)} placed in the proposal but has no place alone against the other teams`);
      if (best.has(`${entry.gender}\u0000${entry.eventKey}`)) continue;
      const mine = row as ResultRow & { readonly place: number };
      const seedOrNull = proposalValues.get(entryKey(entry));
      const seed: Hundredths = seedOrNull === null || seedOrNull === undefined ? autoBuildFail('model_mismatch', `${entryKey(entry)} placed in the proposal but has no seed`) : seedOrNull;
      const field = rowsOf(results, entry.eventKey, entry.gender).filter((r) => r.teamId !== own && r.place !== null) as (ResultRow & { readonly place: number })[];
      const next = nextBehind(field, mine.place, proposalValues);
      const without = scoreMeet(model, { ...proposal.lineup, entries: proposal.lineup.entries.filter((e: LineupEntry) => entryKey(e) !== entryKey(entry)) }, proposal.tagsForScoring, req.rules, req.sourcing);
      const skipped: Skipped[] = ranking
        .slice(0, rank)
        .filter((r) => !entered.has(`${r.event.gender}\u0000${r.event.eventKey}`))
        .map((r) => ({ eventKey: r.event.eventKey, placeAlone: r.place, marginalPoints: marginalOfAdding(r.event).points, binding: bindingOf(problem, proposal, swimmerId, swimmer.gender, fresh(r.event), marginalOfAdding(r.event), r.event, context) }));
      out.push({
        kind: 'unusual_event',
        entryKey: entryKey(entry),
        swimmerId,
        eventKey: entry.eventKey,
        gender: entry.gender,
        place: mine.place,
        points: mine.points,
        seed,
        estimated: seedIsEstimated(swimsOf.get(`${swimmerId}\u0000${entry.eventKey}`) ?? [], entry, seed),
        otherTeamsAhead: field.filter((r) => r.place < mine.place).length,
        nextOtherTeamBehind: next,
        marginalPoints: proposal.evaluation.ownPoints - ownPointsOf(without, own),
        skipped,
      });
    }
  }
  return out;
}
