/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The search space (D5 3): who decides, which (swimmer, event) pairs are candidates, and the columns of each event.
 * Slice A1 covers individual and diving events. Own relays stay as entered.
 */
import { buildIndex, resolveLineup } from '../model/results';
import type { Results } from '../model/results';
import { entryKey } from '../model/lineup';
import type { IndividualEntry, Lineup, LineupEntry, ScorerRole } from '../model/lineup';
import type { MeetEvent } from '../model/meet';
import type { Gender, SwimmerId } from '../model/primitives';
import { Evaluator, eventId } from './evaluate';
import type { ColumnEval } from './evaluate';
import { eventCap } from './support';
import type { Support } from './support';
import type { AutoBuildRequest } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Who the solver decides about, and the fixed facts around them. Built once per call. */
export interface Problem {
  readonly req: AutoBuildRequest;
  readonly support: Support;
  readonly genders: readonly Gender[];
  /** Coach role per swimmer (every team). */
  readonly roles: ReadonlyMap<SwimmerId, ScorerRole>;
  /** Own scorer-tagged swimmers of a built gender, by gender, sorted. They stay on the roster. */
  readonly pinned: ReadonlyMap<Gender, readonly SwimmerId[]>;
  /** Own untagged members of a built gender who are on no own relay, by gender, sorted. They may join the roster. */
  readonly free: ReadonlyMap<Gender, readonly SwimmerId[]>;
  readonly decision: ReadonlySet<SwimmerId>;
  readonly freeSet: ReadonlySet<SwimmerId>;
  /** Own relay entries (fixed in A1) per swimmer: the constant `k_R` of the entry-cap rows. */
  readonly relayEntries: ReadonlyMap<SwimmerId, number>;
  /** Current own individual entries of decision swimmers, key `swimmerId NUL eventKey`. */
  readonly currentEntry: ReadonlyMap<string, IndividualEntry>;
  /** The built events: non-relay events of a built gender, sorted by gender then event key. */
  readonly built: readonly MeetEvent[];
  readonly currentResults: Results;
}

export const pairKey = (swimmerId: SwimmerId, eventKey: string): string => `${swimmerId}\u0000${eventKey}`;

function ownRelayCounts(req: AutoBuildRequest, results: Results, exhibitionCounts: boolean): Map<SwimmerId, number> {
  const skipped = new Set<string>();
  if (!exhibitionCounts) {
    for (const e of results.events) for (const r of e.rows) if (r.swimmerId === null && r.notScoredReason === 'exhibition') skipped.add(r.entryKey);
  }
  const counts = new Map<SwimmerId, number>();
  for (const e of req.lineup.entries) {
    if (e.kind !== 'relay' || e.teamId !== req.ownTeamId || skipped.has(entryKey(e))) continue;
    for (const id of new Set(e.legs.map((l) => l.swimmerId))) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Who decides: the own swimmers of the built genders, by their tags (D5 1). */
export interface Deciders {
  readonly genders: readonly Gender[];
  readonly roles: ReadonlyMap<SwimmerId, ScorerRole>;
  readonly pinned: ReadonlyMap<Gender, readonly SwimmerId[]>;
  readonly free: ReadonlyMap<Gender, readonly SwimmerId[]>;
  readonly decision: ReadonlySet<SwimmerId>;
  readonly freeSet: ReadonlySet<SwimmerId>;
}

export function classify(req: AutoBuildRequest): Deciders {
  const genders = [...new Set(req.genders)].sort(cmp);
  const roles = new Map<SwimmerId, ScorerRole>(req.tags.map((t) => [t.swimmerId, t.role]));
  const relayLegs = new Set<SwimmerId>();
  for (const e of req.lineup.entries) {
    if (e.kind === 'relay' && e.teamId === req.ownTeamId) for (const l of e.legs) relayLegs.add(l.swimmerId);
  }
  const pinned = new Map<Gender, SwimmerId[]>(genders.map((g) => [g, []]));
  const free = new Map<Gender, SwimmerId[]>(genders.map((g) => [g, []]));
  const swimmers = [...req.model.swimmers].filter((s) => s.teamId === req.ownTeamId).sort((a, b) => cmp(a.swimmerId, b.swimmerId));
  for (const s of swimmers) {
    const list = free.get(s.gender);
    if (list === undefined) continue; // a gender the request does not build
    const role = roles.get(s.swimmerId);
    if (role === 'scorer') (pinned.get(s.gender) as SwimmerId[]).push(s.swimmerId);
    else if (role === undefined && s.roster === 'member' && !relayLegs.has(s.swimmerId)) list.push(s.swimmerId);
  }
  const decision = new Set<SwimmerId>();
  for (const list of [...pinned.values(), ...free.values()]) for (const id of list) decision.add(id);
  return { genders, roles, pinned, free, decision, freeSet: new Set([...free.values()].flat()) };
}

export function buildProblem(req: AutoBuildRequest, support: Support, currentResults: Results): Problem {
  const who = classify(req);
  const currentEntry = new Map<string, IndividualEntry>();
  for (const e of req.lineup.entries) {
    if (e.kind === 'individual' && e.teamId === req.ownTeamId && who.decision.has(e.swimmerId)) currentEntry.set(pairKey(e.swimmerId, e.eventKey), e);
  }
  const built = req.model.events
    .filter((e) => e.kind !== 'relay' && who.genders.includes(e.gender))
    .sort((a, b) => cmp(a.gender, b.gender) || cmp(a.eventKey, b.eventKey));
  return {
    req,
    support,
    ...who,
    relayEntries: ownRelayCounts(req, currentResults, support.exhibitionCounts),
    currentEntry,
    built,
    currentResults,
  };
}

/** One (swimmer, event) pair of the search. */
export interface Pair {
  readonly swimmerId: SwimmerId;
  /** The seed the entry would have: hundredths (a dive: points). `null`: no usable time. */
  readonly value: number | null;
  readonly scorable: boolean;
  /** The singleton column `{swimmer}`: the upper-bound value of an outside pair (D5 6.2). `null` when `value` is `null`. */
  readonly singleton: ColumnEval | null;
}

export interface Column {
  /** Sorted by swimmer id. */
  readonly members: readonly SwimmerId[];
  readonly eval: ColumnEval;
  readonly isCurrent: boolean;
}

export class EventSpace {
  /** Scorable swimmers, fastest first (dives highest first), ties by swimmer id. */
  readonly scorable: readonly SwimmerId[];
  candidates: SwimmerId[];
  columns: Column[] = [];

  constructor(
    readonly event: MeetEvent,
    readonly id: string,
    readonly pairs: ReadonlyMap<SwimmerId, Pair>,
    /** The current own entries' swimmers among the pinned: the current column (D5 3.3). */
    readonly currentColumn: readonly SwimmerId[],
    k: number
  ) {
    const diving = event.kind === 'diving';
    this.scorable = [...pairs.values()]
      .filter((p) => p.scorable)
      .sort((a, b) => (diving ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)) || cmp(a.swimmerId, b.swimmerId))
      .map((p) => p.swimmerId);
    this.candidates = this.scorable.slice(0, k);
  }

  /** Scorable pairs outside `C_e`. */
  outside(): SwimmerId[] {
    const inside = new Set(this.candidates);
    return this.scorable.filter((id) => !inside.has(id));
  }
}

const tableLength = (support: Support, event: MeetEvent): number => (event.kind === 'diving' ? support.tables.diving.length : support.tables.individual.length);

export class Space {
  readonly evaluator: Evaluator;
  readonly events: EventSpace[] = [];
  /** Milliseconds spent evaluating columns (construction and refinement), or `null` when the request holds no clock. */
  evaluateMs: number | null;

  constructor(readonly problem: Problem, k: number, private readonly clock?: () => number) {
    const started = clock?.();
    this.evaluateMs = clock === undefined ? null : 0;
    const { req, support } = problem;
    this.evaluator = new Evaluator({
      model: req.model,
      lineup: req.lineup,
      tags: req.tags,
      rules: req.rules,
      sourcing: req.sourcing,
      own: req.ownTeamId,
      decision: problem.decision,
      free: problem.freeSet,
    });
    const values = this.seedValues();
    const pinned = new Set([...problem.pinned.values()].flat());
    for (const event of problem.built) {
      const pairs = new Map<SwimmerId, Pair>();
      const swimmers = [...(problem.pinned.get(event.gender) ?? []), ...(problem.free.get(event.gender) ?? [])].sort(cmp);
      for (const swimmerId of swimmers) {
        const value = values.get(pairKey(swimmerId, event.eventKey) + event.gender) ?? null;
        if (value === null) {
          pairs.set(swimmerId, { swimmerId, value, scorable: false, singleton: null });
          continue;
        }
        const singleton = this.evaluator.evaluate(event, [swimmerId]);
        const key = entryKey(this.entryFor(swimmerId, event));
        const row = singleton.rows.find((r) => r.entryKey === key);
        const scorable = row !== undefined && row.place !== null && row.place <= tableLength(support, event);
        pairs.set(swimmerId, { swimmerId, value, scorable, singleton });
      }
      const currentColumn = swimmers.filter((id) => pinned.has(id) && problem.currentEntry.has(pairKey(id, event.eventKey)));
      const space = new EventSpace(event, eventId(event.eventKey, event.gender), pairs, currentColumn, k);
      this.events.push(space);
      this.refresh(space);
    }
    this.charge(started);
  }

  private charge(started: number | undefined): void {
    if (this.clock !== undefined && started !== undefined && this.evaluateMs !== null) this.evaluateMs += this.clock() - started;
  }

  private entryFor(swimmerId: SwimmerId, event: MeetEvent): IndividualEntry {
    return (
      this.problem.currentEntry.get(pairKey(swimmerId, event.eventKey)) ?? {
        kind: 'individual',
        teamId: this.problem.req.ownTeamId,
        swimmerId,
        eventKey: event.eventKey,
        gender: event.gender,
        seedSwimId: null,
      }
    );
  }

  /** The seed value of every (decision swimmer, built event) entry, from one `resolveLineup` call. */
  private seedValues(): Map<string, number | null> {
    const { problem } = this;
    const entries: LineupEntry[] = [];
    for (const event of problem.built) {
      for (const swimmerId of [...(problem.pinned.get(event.gender) ?? []), ...(problem.free.get(event.gender) ?? [])]) {
        entries.push(this.entryFor(swimmerId, event));
      }
    }
    const lineup: Lineup = { payloadVersion: 1, meetKey: problem.req.lineup.meetKey, entries };
    const out = new Map<string, number | null>();
    for (const r of resolveLineup(problem.req.model, lineup, buildIndex(problem.req.model)).resolved) {
      out.set(pairKey(r.entry.kind === 'individual' ? r.entry.swimmerId : '', r.entry.eventKey) + r.gender, r.value);
    }
    return out;
  }

  /** Rebuild the columns of an event from its candidates: every subset, plus the current column (D5 3.3). */
  refresh(es: EventSpace): void {
    const cap = eventCap(this.problem.req.rules, es.event);
    const pruneAt = cap !== null && cap.overCap === 'removed-from-consideration' ? cap.cap : Infinity;
    const keyOf = (members: readonly SwimmerId[]): string => members.join('\u0001');
    const seen = new Set<string>();
    const columns: Column[] = [];
    const currentKey = keyOf(es.currentColumn);
    const add = (members: readonly SwimmerId[]): void => {
      const k = keyOf(members);
      if (seen.has(k)) return;
      seen.add(k);
      columns.push({ members, eval: this.evaluator.evaluate(es.event, members), isCurrent: k === currentKey });
    };
    const cands = es.candidates;
    for (let mask = 0; mask < 1 << cands.length; mask++) {
      const members = cands.filter((_, i) => (mask >> i) & 1).sort(cmp);
      if (members.length <= pruneAt) add(members);
    }
    add(es.currentColumn);
    columns.sort((a, b) => cmp(keyOf(a.members), keyOf(b.members)));
    es.columns = columns;
  }

  /** Evaluator milliseconds per `scoreMeet` call so far, or `null` when there is no clock or no call yet. */
  msPerColumn(): number | null {
    return this.evaluateMs === null || this.evaluator.calls === 0 ? null : this.evaluateMs / this.evaluator.calls;
  }

  /**
   * Refinement (D5 amendment 1, 6.3 item 3): the swimmers to add per event. `additions` lists the active outside swimmers
   * per event id. Each event gains at most `perEvent` of them, fastest first, up to `kMax` candidates. `newColumns` is the
   * count of columns the growth adds (before pruning), for the time estimate.
   */
  planGrowth(additions: ReadonlyMap<string, readonly SwimmerId[]>, kMax: number, perEvent: number): { readonly next: ReadonlyMap<string, SwimmerId[]>; readonly newColumns: number } {
    const next = new Map<string, SwimmerId[]>();
    let newColumns = 0;
    for (const es of this.events) {
      const wanted = new Set(additions.get(es.id) ?? []);
      if (wanted.size === 0) continue;
      const grown = [...es.candidates];
      let added = 0;
      for (const id of es.scorable) {
        if (grown.length >= kMax || added >= perEvent) break;
        if (wanted.has(id) && !grown.includes(id)) {
          grown.push(id);
          added += 1;
        }
      }
      if (added === 0) continue;
      next.set(es.id, grown);
      newColumns += 2 ** grown.length - 2 ** es.candidates.length;
    }
    return { next, newColumns };
  }

  /** Apply a plan from `planGrowth`: rebuild the columns of the events that grew. */
  applyGrowth(next: ReadonlyMap<string, readonly SwimmerId[]>): void {
    const started = this.clock?.();
    for (const es of this.events) {
      const grown = next.get(es.id);
      if (grown === undefined) continue;
      es.candidates = [...grown];
      this.refresh(es);
    }
    this.charge(started);
  }
}
