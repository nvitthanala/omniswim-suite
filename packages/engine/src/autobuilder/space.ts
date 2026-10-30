/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The search space (D5 3): who decides, which (swimmer, event) pairs are candidates, and the columns of each event.
 * Slice A1 covers individual and diving events. Slice A2 adds relay events: own relays are solver-owned, and the columns of a
 * relay event are the sets of at most R disjoint squads (`squads.ts`).
 */
import { buildIndex, resolveLineup } from '../model/results';
import type { Results, Violation } from '../model/results';
import { sessionLoad } from '../planner/sessionLoad';
import { entryKey } from '../model/lineup';
import type { IndividualEntry, Lineup, LineupEntry, RelayEntry, ScorerRole } from '../model/lineup';
import type { MeetEvent } from '../model/meet';
import type { Gender, SwimmerId } from '../model/primitives';
import { Evaluator, eventId } from './evaluate';
import type { ColumnEval } from './evaluate';
import { fixedRaces, scheduledOf, violationsOf } from './load';
import type { Races, SessionLoadResult } from './load';
import { buildLegSources, currentSquad, generateSquads, legOptions } from './squads';
import type { LegSources, Positions, Squad } from './squads';
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
  /** Own untagged members of a built gender who are on no fixed own relay, by gender, sorted. They may join the roster. */
  readonly free: ReadonlyMap<Gender, readonly SwimmerId[]>;
  readonly decision: ReadonlySet<SwimmerId>;
  readonly freeSet: ReadonlySet<SwimmerId>;
  /** Own relay entries that stay fixed (an event with a leg off the decision set) per swimmer: the constant `k_R` of the entry-cap rows. */
  readonly relayEntries: ReadonlyMap<SwimmerId, number>;
  /** Current own individual entries of decision swimmers, key `swimmerId NUL eventKey`. */
  readonly currentEntry: ReadonlyMap<string, IndividualEntry>;
  /** The built events: the events of a built gender, except relay events that hold a fixed own relay. Sorted by gender then event key. */
  readonly built: readonly MeetEvent[];
  /** Relay events of a built gender that hold an own relay with a leg off the decision set: they stay as entered. */
  readonly fixedRelayEvents: ReadonlySet<string>;
  readonly currentResults: Results;
  /**
   * Held split entries (D5 4.6), `swimmerId NUL eventKey`: a free swimmer's current entry in a `timed-final-split` event, when load
   * rows exist. The entry stays whatever `z` is (`x = z`), and every column evaluation keeps it, because `sessionLoad` ranks a split
   * heat over every entry.
   */
  readonly held: ReadonlySet<string>;
  /** The races of the own swimmers in the events the search does not build: constants of the load rows. Empty without load rows. */
  readonly fixedRaces: Races;
  /** `sessionLoad` on the current lineup when the request has a `load` (any mode), else `null`. */
  readonly currentLoad: SessionLoadResult | null;
  /** The violations of the current lineup that can name a built lineup: `scoreMeet`'s and the load's (see `violationsOf`). */
  readonly currentViolations: readonly Violation[];
}

export const pairKey = (swimmerId: SwimmerId, eventKey: string): string => `${swimmerId}\u0000${eventKey}`;

function ownRelayCounts(req: AutoBuildRequest, results: Results, exhibitionCounts: boolean, builtIds: ReadonlySet<string>): Map<SwimmerId, number> {
  const skipped = new Set<string>();
  if (!exhibitionCounts) {
    for (const e of results.events) for (const r of e.rows) if (r.swimmerId === null && r.notScoredReason === 'exhibition') skipped.add(r.entryKey);
  }
  const counts = new Map<SwimmerId, number>();
  for (const e of req.lineup.entries) {
    if (e.kind !== 'relay' || e.teamId !== req.ownTeamId || skipped.has(entryKey(e)) || builtIds.has(eventId(e.eventKey, e.gender))) continue;
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
  readonly fixedRelayEvents: ReadonlySet<string>;
}

export function classify(req: AutoBuildRequest): Deciders {
  const genders = [...new Set(req.genders)].sort(cmp);
  const roles = new Map<SwimmerId, ScorerRole>(req.tags.map((t) => [t.swimmerId, t.role]));
  const pinned = new Map<Gender, SwimmerId[]>(genders.map((g) => [g, []]));
  const free = new Map<Gender, SwimmerId[]>(genders.map((g) => [g, []]));
  const swimmers = [...req.model.swimmers].filter((s) => s.teamId === req.ownTeamId).sort((a, b) => cmp(a.swimmerId, b.swimmerId));
  for (const s of swimmers) {
    const list = free.get(s.gender);
    if (list === undefined) continue; // a gender the request does not build
    const role = roles.get(s.swimmerId);
    if (role === 'scorer') (pinned.get(s.gender) as SwimmerId[]).push(s.swimmerId);
    else if (role === undefined && s.roster === 'member') list.push(s.swimmerId);
  }
  const decision = new Set<SwimmerId>();
  const freeSet = new Set<SwimmerId>();
  for (const list of pinned.values()) for (const id of list) decision.add(id);
  for (const list of free.values()) for (const id of list) {
    decision.add(id);
    freeSet.add(id);
  }
  // A relay event is solver-owned only when every own relay in it has four decision swimmers. An event with any other own relay
  // stays as entered, and the free swimmers on its relays stay off the roster. Removing them can fix another event: repeat.
  const relays = req.lineup.entries.filter((e): e is RelayEntry => e.kind === 'relay' && e.teamId === req.ownTeamId && genders.includes(e.gender));
  const fixedRelayEvents = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    fixedRelayEvents.clear();
    for (const e of relays) if (e.legs.some((l) => !decision.has(l.swimmerId))) fixedRelayEvents.add(eventId(e.eventKey, e.gender));
    for (const e of relays) {
      if (!fixedRelayEvents.has(eventId(e.eventKey, e.gender))) continue;
      for (const l of e.legs) {
        if (!freeSet.has(l.swimmerId)) continue;
        freeSet.delete(l.swimmerId);
        decision.delete(l.swimmerId);
        changed = true;
      }
    }
  }
  const keep = (m: Map<Gender, SwimmerId[]>): Map<Gender, SwimmerId[]> => new Map([...m].map(([g, list]) => [g, list.filter((id) => decision.has(id))]));
  return { genders, roles, pinned, free: keep(free), decision, freeSet, fixedRelayEvents };
}

export function buildProblem(req: AutoBuildRequest, support: Support, currentResults: Results): Problem {
  const who = classify(req);
  const currentEntry = new Map<string, IndividualEntry>();
  for (const e of req.lineup.entries) {
    if (e.kind === 'individual' && e.teamId === req.ownTeamId && who.decision.has(e.swimmerId)) currentEntry.set(pairKey(e.swimmerId, e.eventKey), e);
  }
  const built = req.model.events
    .filter((e) => who.genders.includes(e.gender) && !who.fixedRelayEvents.has(eventId(e.eventKey, e.gender)))
    .sort((a, b) => cmp(a.gender, b.gender) || cmp(a.eventKey, b.eventKey));
  const builtIds = new Set(built.map((e) => eventId(e.eventKey, e.gender)));
  const rule = support.load;
  const held = new Set<string>();
  let races: Races = new Map();
  if (rule !== null) {
    for (const event of built) {
      if (event.kind === 'relay' || scheduledOf(rule.schedule, event.eventKey, event.gender)?.format.kind !== 'timed-final-split') continue;
      for (const id of who.freeSet) {
        if (currentEntry.has(pairKey(id, event.eventKey)) && req.model.swimmers.some((m) => m.swimmerId === id && m.gender === event.gender)) held.add(pairKey(id, event.eventKey));
      }
    }
    const own = new Set(req.model.swimmers.filter((m) => m.teamId === req.ownTeamId).map((m) => m.swimmerId));
    races = fixedRaces(rule, req.model, req.lineup, currentResults, (e) => builtIds.has(eventId(e.eventKey, e.gender)), own, req.rules);
  }
  const currentLoad = rule === null ? null : sessionLoad(req.model, req.lineup, currentResults, rule.schedule, rule.preference, req.rules);
  return {
    req,
    support,
    ...who,
    relayEntries: ownRelayCounts(req, currentResults, support.exhibitionCounts, builtIds),
    currentEntry,
    built,
    currentResults,
    held,
    fixedRaces: races,
    currentLoad,
    currentViolations: violationsOf(currentResults, currentLoad, rule === null ? null : rule.schedule),
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
  /** Sorted by swimmer id. A relay column lists every swimmer of its squads. */
  readonly members: readonly SwimmerId[];
  /** A relay column: its squads, sorted by key. */
  readonly squads?: readonly Squad[];
  readonly eval: ColumnEval;
  readonly isCurrent: boolean;
}

/** What a relay event holds besides its columns (D5 3.2, 3.3, 6.2). */
export interface RelayData {
  readonly positions: Positions;
  readonly freestyle: boolean;
  /** The decision swimmers with a leg option at some position: the swimmers an outside squad can use. */
  readonly eligible: readonly SwimmerId[];
  /** R: the own relays one event scores. */
  readonly slots: number;
  /** The current own squads (the current column). */
  readonly current: readonly Squad[];
  /** The times of the fixed entries that hold a place in the empty column (hundredths). */
  readonly standing: readonly number[];
  /** T: how many top squads `Q_e` holds. */
  T: number;
  squads: readonly Squad[];
  tauOut: number | null;
  /** Points one outside slot can earn at most (the relay table at the best place behind the standing relays), or 0. */
  ubRel: number;
}

export class EventSpace {
  /** Set for a relay event. */
  relay: RelayData | null = null;
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
    k: number,
    /** Held entries (D5 4.6): candidates whether or not they rank in the top K. */
    readonly forced: readonly SwimmerId[] = []
  ) {
    const diving = event.kind === 'diving';
    this.scorable = [...pairs.values()]
      .filter((p) => p.scorable)
      .sort((a, b) => (diving ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)) || cmp(a.swimmerId, b.swimmerId))
      .map((p) => p.swimmerId);
    const top = this.scorable.slice(0, k);
    this.candidates = [...top, ...forced.filter((id) => !top.includes(id))];
  }

  /** Scorable pairs outside `C_e`. A relay event has none: its outside squads are the slot `oR`. */
  outside(): SwimmerId[] {
    if (this.relay !== null) return [];
    const inside = new Set(this.candidates);
    return this.scorable.filter((id) => !inside.has(id));
  }
}

const tableLength = (support: Support, event: MeetEvent): number => (event.kind === 'diving' ? support.tables.diving.length : support.tables.individual.length);

export class Space {
  readonly evaluator: Evaluator;
  private readonly sources: LegSources;
  private readonly index: ReturnType<typeof buildIndex>;
  readonly events: EventSpace[] = [];
  /** Milliseconds spent evaluating columns (construction and refinement), or `null` when the request holds no clock. */
  evaluateMs: number | null;

  constructor(readonly problem: Problem, k: number, private readonly clock?: () => number) {
    const started = clock?.();
    this.evaluateMs = clock === undefined ? null : 0;
    const { req, support } = problem;
    this.sources = buildLegSources(req.model);
    this.index = buildIndex(req.model);
    this.evaluator = new Evaluator({
      model: req.model,
      lineup: req.lineup,
      tags: req.tags,
      rules: req.rules,
      sourcing: req.sourcing,
      own: req.ownTeamId,
      decision: problem.decision,
      free: problem.freeSet,
      load: support.load,
      held: problem.held,
    });
    const values = this.seedValues();
    const pinned = new Set([...problem.pinned.values()].flat());
    for (const event of problem.built) {
      if (event.kind === 'relay') {
        this.addRelayEvent(event);
        continue;
      }
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
      const forced = swimmers.filter((id) => problem.held.has(pairKey(id, event.eventKey)));
      const space = new EventSpace(event, eventId(event.eventKey, event.gender), pairs, currentColumn, k, forced);
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
      if (event.kind === 'relay') continue;
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
    if (es.relay !== null) {
      this.refreshRelay(es, es.relay);
      return;
    }
    const cap = eventCap(this.problem.req.rules, es.event);
    // A removed over-cap entry still races, and in a split heat it moves other entries between heats: with load rows no column is
    // dominated by dropping it, so a split event keeps every column.
    const split = this.problem.support.load !== null && scheduledOf(this.problem.support.load.schedule, es.event.eventKey, es.event.gender)?.format.kind === 'timed-final-split';
    const pruneAt = cap !== null && cap.overCap === 'removed-from-consideration' && !split ? cap.cap : Infinity;
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

  /** The relay event: its option lists, the squads `Q_e`, and the columns (D5 3.2, 3.3). */
  private addRelayEvent(event: MeetEvent): void {
    const { problem } = this;
    const id = eventId(event.eventKey, event.gender);
    const swimmers = [...(problem.pinned.get(event.gender) ?? []), ...(problem.free.get(event.gender) ?? [])].sort(cmp);
    // D5 amendment 2, 3.2: a swimmer with no relay or total capacity left after the fixed entries cannot be in a new squad.
    const { entryCaps } = problem.support;
    const roomy = (id: SwimmerId): boolean => {
      const kR = problem.relayEntries.get(id) ?? 0;
      return (entryCaps.relay === 'unlimited' || entryCaps.relay - kR > 0) && (entryCaps.total === 'unlimited' || entryCaps.total - kR > 0);
    };
    const positions = legOptions(event, swimmers.filter(roomy), this.sources) ?? ([[], [], [], []] as unknown as Positions);
    const current = problem.req.lineup.entries
      .filter((e): e is RelayEntry => e.kind === 'relay' && e.teamId === problem.req.ownTeamId && e.eventKey === event.eventKey && e.gender === event.gender)
      .map((e) => currentSquad(e, this.sources));
    const es = new EventSpace(event, id, new Map(), [], 0);
    const empty = this.evaluator.evaluateRelay(event, []);
    const times = new Map(resolveLineup(problem.req.model, this.evaluator.subLineupRelay(event, []), this.index).resolved.map((r) => [r.key, r.value]));
    const standing = empty.rows.flatMap((r) => (r.place === null ? [] : (times.get(r.entryKey) ?? null) === null ? [] : [times.get(r.entryKey) as number]));
    es.relay = {
      positions,
      freestyle: event.relayKind !== 'medley',
      eligible: [...new Set(positions.flat().map((o) => o.swimmerId))].sort(cmp),
      slots: problem.support.relayCap,
      current,
      standing,
      T: problem.req.limits.relaySquadsPerEvent,
      squads: [],
      tauOut: null,
      ubRel: 0,
    };
    this.events.push(es);
    this.refresh(es);
  }

  /** Points an outside squad can earn at most: the relay table at the best place behind the standing relays that beat `tau_out`. */
  private outsidePoints(r: RelayData): number {
    if (r.tauOut === null) return 0;
    const ahead = r.standing.filter((v) => (this.problem.support.ties === 'ordered' ? v <= (r.tauOut as number) : v < (r.tauOut as number))).length;
    return this.problem.support.tables.relay[ahead] ?? 0;
  }

  /** Every set of at most R pairwise swimmer-disjoint squads of `Q_e`, the empty set included, plus the current column. */
  private refreshRelay(es: EventSpace, r: RelayData): void {
    const set = generateSquads(r.positions, r.freestyle, r.T, r.current);
    r.squads = set.squads;
    r.tauOut = set.tauOut;
    r.ubRel = this.outsidePoints(r);
    const keyOf = (squads: readonly Squad[]): string => squads.map((q) => q.key).join('\u0002');
    const currentKey = keyOf([...r.current].sort((a, b) => cmp(a.key, b.key)));
    const seen = new Set<string>();
    const columns: Column[] = [];
    const add = (squads: readonly Squad[]): void => {
      const ordered = [...squads].sort((a, b) => cmp(a.key, b.key));
      const k = keyOf(ordered);
      if (seen.has(k)) return;
      seen.add(k);
      const members = [...new Set(ordered.flatMap((q) => q.swimmers))].sort(cmp);
      columns.push({ members, squads: ordered, eval: this.evaluator.evaluateRelay(es.event, ordered), isCurrent: k === currentKey });
    };
    const walk = (from: number, chosen: readonly Squad[], used: ReadonlySet<SwimmerId>): void => {
      add(chosen);
      if (chosen.length >= r.slots) return;
      for (let i = from; i < r.squads.length; i++) {
        const squad = r.squads[i] as Squad;
        if (squad.swimmers.some((id) => used.has(id))) continue;
        walk(i + 1, [...chosen, squad], new Set([...used, ...squad.swimmers]));
      }
    };
    walk(0, [], new Set());
    // The full current column is a legal choice unless more than R own relays in one event is a hard violation (D5 amendment 2, 3.3).
    if (r.current.length <= r.slots || this.problem.support.nonScoringRelaysAllowed) add(r.current);
    columns.sort((a, b) => cmp(keyOf(a.squads as readonly Squad[]), keyOf(b.squads as readonly Squad[])));
    es.columns = columns;
    es.candidates = [];
  }

  /** Evaluator milliseconds per `scoreMeet` call so far, or `null` when there is no clock or no call yet. */
  msPerColumn(): number | null {
    return this.evaluateMs === null || this.evaluator.calls === 0 ? null : this.evaluateMs / this.evaluator.calls;
  }

  /**
   * Refinement (D5 amendment 1, 6.3 item 3). `outside` lists the active outside swimmers per individual event id, and
   * `relays` the relay events whose outside slot is active. Each individual event gains at most `perEvent` of its outside
   * swimmers, fastest first, up to `kMax` candidates. A relay event doubles T, up to `tMax`. `newColumns` estimates the
   * columns the growth adds (before pruning), for the time estimate.
   */
  planGrowth(
    outside: ReadonlyMap<string, readonly SwimmerId[]>,
    relays: ReadonlySet<string>,
    limits: { readonly kMax: number; readonly tMax: number },
    perEvent: number
  ): GrowthPlan {
    const candidates = new Map<string, SwimmerId[]>();
    const relayT = new Map<string, number>();
    let newColumns = 0;
    for (const es of this.events) {
      if (es.relay !== null) {
        const next = Math.min(es.relay.T * 2, limits.tMax);
        if (relays.has(es.id) && next > es.relay.T) {
          relayT.set(es.id, next);
          const sets = (n: number): number => {
            let total = 0;
            for (let i = 0, c = 1; i <= Math.min(es.relay?.slots ?? 0, n); i++, c = (c * (n - i + 1)) / i) total += c;
            return total;
          };
          newColumns += sets(2 * next) - sets(2 * es.relay.T);
        }
        continue;
      }
      const wanted = new Set(outside.get(es.id) ?? []);
      if (wanted.size === 0) continue;
      const grown = [...es.candidates];
      let added = 0;
      for (const id of es.scorable) {
        if (grown.length >= limits.kMax || added >= perEvent) break;
        if (wanted.has(id) && !grown.includes(id)) {
          grown.push(id);
          added += 1;
        }
      }
      if (added === 0) continue;
      candidates.set(es.id, grown);
      newColumns += 2 ** grown.length - 2 ** es.candidates.length;
    }
    return { candidates, relayT, newColumns, empty: candidates.size === 0 && relayT.size === 0 };
  }

  /** Apply a plan from `planGrowth`: rebuild the columns of the events that grew. */
  applyGrowth(plan: GrowthPlan): void {
    const started = this.clock?.();
    for (const es of this.events) {
      const grown = plan.candidates.get(es.id);
      const t = plan.relayT.get(es.id);
      if (grown === undefined && t === undefined) continue;
      if (grown !== undefined) es.candidates = [...grown];
      if (t !== undefined && es.relay !== null) es.relay.T = t;
      this.refresh(es);
    }
    this.charge(started);
  }
}

/** The events that grow in one refinement round (D5 amendment 1, 6.3 item 3). */
export interface GrowthPlan {
  readonly candidates: ReadonlyMap<string, readonly SwimmerId[]>;
  readonly relayT: ReadonlyMap<string, number>;
  readonly newColumns: number;
  readonly empty: boolean;
}
