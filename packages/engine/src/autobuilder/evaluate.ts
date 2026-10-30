/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The reference column evaluator (D5 5.1). One column is one set of own entries in one event. Its value is the own team's
 * points that `scoreMeet` gives the event when exactly those own entries stand beside the fixed entries of every other
 * side. Nothing here scores by itself: `scoreMeet` is the only scorer.
 */
import { scoreMeet } from '../model/results';
import type { ResultRow } from '../model/results';
import { entryKey } from '../model/lineup';
import type { IndividualEntry, Lineup, LineupEntry, RelayEntry, ScorerTag } from '../model/lineup';
import type { MeetEvent, MeetModel, MeetSwim, RelaySplit } from '../model/meet';
import type { Gender, SwimmerId, TeamId } from '../model/primitives';
import type { CompleteRulePreset } from '../rules/rulePreset';
import type { ConversionSettings } from '../sourcing/convert';
import { freshRelays, squadKeyOfEntry } from './squads';
import type { Squad } from './squads';

export const eventId = (eventKey: string, gender: Gender): string => `${gender}\u0000${eventKey}`;
const memberKey = (members: readonly SwimmerId[]): string => members.join('\u0001');
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ColumnEval {
  /** The own team's points in the event, as `scoreMeet` gives them (not scaled). */
  readonly own: number;
  /** Sizes (2 or more) of the groups of rows that share a place: the denominators of the points the rows hold. */
  readonly tieSizes: readonly number[];
  readonly rows: readonly ResultRow[];
}

export interface EvalBase {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly tags: readonly ScorerTag[];
  readonly rules: CompleteRulePreset;
  readonly sourcing: ConversionSettings;
  readonly own: TeamId;
  /** Every decision swimmer (pinned or free) of a built gender. Their entries are solver-owned. */
  readonly decision: ReadonlySet<SwimmerId>;
  /** The decision swimmers the coach did not tag: a column member among them is tagged a scorer in the evaluation. */
  readonly free: ReadonlySet<SwimmerId>;
}

/** The sizes of the tie groups in a result: rows with one place. Only a place held by 2 or more rows gives a size. */
export function tieSizesOf(rows: readonly ResultRow[]): number[] {
  const byPlace = new Map<number, number>();
  for (const r of rows) if (r.place !== null) byPlace.set(r.place, (byPlace.get(r.place) ?? 0) + 1);
  return [...byPlace.values()].filter((n) => n >= 2).sort((a, b) => a - b);
}

export class Evaluator {
  /** How many `scoreMeet` calls ran. A cache hit does not count. */
  calls = 0;
  private readonly cache = new Map<string, ColumnEval>();
  private readonly entriesByEvent = new Map<string, readonly LineupEntry[]>();
  private readonly swimsByKey = new Map<string, readonly MeetSwim[]>();
  private readonly eventOf = new Map<string, MeetEvent>();
  private readonly swimById = new Map<string, MeetSwim>();
  private readonly splitById = new Map<string, RelaySplit>();

  constructor(private readonly base: EvalBase) {
    const entries = new Map<string, LineupEntry[]>();
    for (const e of base.lineup.entries) {
      const id = eventId(e.eventKey, e.gender);
      const bucket = entries.get(id);
      if (bucket) bucket.push(e);
      else entries.set(id, [e]);
    }
    for (const [id, list] of entries) this.entriesByEvent.set(id, list);
    const swims = new Map<string, MeetSwim[]>();
    for (const s of base.model.swims) {
      const k = `${s.swimmerId}\u0000${s.eventKey}`;
      const bucket = swims.get(k);
      if (bucket) bucket.push(s);
      else swims.set(k, [s]);
    }
    for (const [k, list] of swims) this.swimsByKey.set(k, list);
    for (const e of base.model.events) this.eventOf.set(eventId(e.eventKey, e.gender), e);
    for (const s of base.model.swims) this.swimById.set(s.swimId, s);
    for (const s of base.model.relaySplits) this.splitById.set(s.splitId, s);
  }

  /**
   * The sub-lineup of a relay event for the squads of a column (D5 5.1): every entry of the event in lineup order, except the
   * own relays that are not in the column, then the new squads as relays that take the lowest letters unused by a surviving own
   * relay, in squad-time order. A current squad reuses its entry, so its letter and its bases stay.
   */
  subLineupRelay(event: MeetEvent, squads: readonly Squad[]): Lineup {
    const { own } = this.base;
    const wanted = new Set(squads.map((s) => s.key));
    const kept: LineupEntry[] = [];
    const surviving: RelayEntry[] = [];
    for (const e of this.entriesByEvent.get(eventId(event.eventKey, event.gender)) ?? []) {
      if (e.kind === 'relay' && e.teamId === own) {
        if (!wanted.has(squadKeyOfEntry(e))) continue;
        surviving.push(e);
      }
      kept.push(e);
    }
    const have = new Set(surviving.map(squadKeyOfEntry));
    const fresh = squads.filter((s) => !have.has(s.key));
    return { payloadVersion: 1, meetKey: this.base.lineup.meetKey, entries: [...kept, ...freshRelays(own, event, fresh, surviving)] };
  }

  /** Own points of a relay column: one-event `scoreMeet` over the swims and splits the sub-lineup's legs name. */
  evaluateRelay(event: MeetEvent, squads: readonly Squad[]): ColumnEval {
    const key = `${eventId(event.eventKey, event.gender)}\u0003${squads.map((q) => q.key).join('\u0002')}`;
    const known = this.cache.get(key);
    if (known) return known;
    const { base } = this;
    const lineup = this.subLineupRelay(event, squads);
    const swimIds = new Set<string>();
    const splitIds = new Set<string>();
    for (const e of lineup.entries) {
      if (e.kind !== 'relay') continue;
      for (const leg of e.legs) {
        if (leg.basis.kind === 'split') splitIds.add(leg.basis.splitId);
        else if (leg.basis.kind === 'flat-start-swim' || leg.basis.kind === 'flyover-estimate') swimIds.add(leg.basis.swimId);
      }
    }
    const swims = [...swimIds].sort(cmp).flatMap((id) => this.swimById.get(id) ?? []);
    const splits = [...splitIds].sort(cmp).flatMap((id) => this.splitById.get(id) ?? []);
    const model: MeetModel = { ...base.model, events: [event], swims, relaySplits: splits };
    const joining = new Set(squads.flatMap((q) => q.swimmers).filter((id) => base.free.has(id)));
    const extra: ScorerTag[] = [...joining].sort(cmp).map((swimmerId) => ({ teamId: base.own, swimmerId, role: 'scorer' as const }));
    this.calls += 1;
    const results = scoreMeet(model, lineup, [...base.tags, ...extra], base.rules, base.sourcing);
    const rows = results.events.find((e) => e.eventKey === event.eventKey && e.gender === event.gender)?.rows ?? [];
    const evaluated: ColumnEval = {
      own: rows.reduce((sum, r) => (r.teamId === base.own ? sum + r.points : sum), 0),
      tieSizes: tieSizesOf(rows),
      rows,
    };
    this.cache.set(key, evaluated);
    return evaluated;
  }

  /**
   * The sub-lineup of column `members` (D5 5.1): the current entries of the event in lineup order, keeping each fixed entry
   * and each current entry of a member in place, then the members without a current entry, sorted by entry key, with the
   * engine's own seed pick.
   */
  subLineup(event: MeetEvent, members: readonly SwimmerId[]): Lineup {
    const memberSet = new Set(members);
    const kept: LineupEntry[] = [];
    const have = new Set<SwimmerId>();
    for (const e of this.entriesByEvent.get(eventId(event.eventKey, event.gender)) ?? []) {
      if (e.kind === 'individual' && this.base.decision.has(e.swimmerId)) {
        if (!memberSet.has(e.swimmerId)) continue;
        have.add(e.swimmerId);
      }
      kept.push(e);
    }
    const added: IndividualEntry[] = members
      .filter((id) => !have.has(id))
      .map((swimmerId) => ({ kind: 'individual' as const, teamId: this.base.own, swimmerId, eventKey: event.eventKey, gender: event.gender, seedSwimId: null }));
    added.sort((a, b) => cmp(entryKey(a), entryKey(b)));
    return { payloadVersion: 1, meetKey: this.base.lineup.meetKey, entries: [...kept, ...added] };
  }

  evaluate(event: MeetEvent, members: readonly SwimmerId[]): ColumnEval {
    const key = `${eventId(event.eventKey, event.gender)}\u0002${memberKey(members)}`;
    const known = this.cache.get(key);
    if (known) return known;
    const { base } = this;
    const lineup = this.subLineup(event, members);
    const present = new Set<SwimmerId>();
    for (const e of lineup.entries) {
      if (e.kind === 'individual') present.add(e.swimmerId);
    }
    const swims: MeetSwim[] = [];
    for (const id of [...present].sort(cmp)) swims.push(...(this.swimsByKey.get(`${id}\u0000${event.eventKey}`) ?? []));
    const model: MeetModel = { ...base.model, events: [event], swims, relaySplits: [] };
    const extra: ScorerTag[] = members.filter((id) => base.free.has(id)).map((swimmerId) => ({ teamId: base.own, swimmerId, role: 'scorer' as const }));
    this.calls += 1;
    const results = scoreMeet(model, lineup, [...base.tags, ...extra], base.rules, base.sourcing);
    const rows = results.events.find((e) => e.eventKey === event.eventKey && e.gender === event.gender)?.rows ?? [];
    const evaluated: ColumnEval = {
      own: rows.reduce((sum, r) => (r.teamId === base.own ? sum + r.points : sum), 0),
      tieSizes: tieSizesOf(rows),
      rows,
    };
    this.cache.set(key, evaluated);
    return evaluated;
  }
}
