/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The fast column scorer (D5 12.4, 5.1). It gives the rows `scoreMeet` gives one event, by arithmetic over the entries of that event:
 * the roster plan, one stable sort for the ranks, the per-team caps, one more sort when entries leave, and the table points with
 * the tie shares. It reads no sub-model and builds no index per call.
 *
 * `scoreMeet` stays the reference. This scorer covers the rules that `supported` accepts, and it returns `null` for anything
 * it does not model: the caller then runs the reference. It never guesses a value. A row it cannot derive makes the whole
 * event fall back.
 *
 * What it models, in the order `scoreMeet` runs it (results.ts):
 * 1. Roster plan (`planRoster`): an entry with an exhibition leg leaves the places, and so does an entry that is not on the
 *    scoring roster (`nonScorerPlacement: 'removed-from-consideration'`; a relay needs every leg a scorer).
 * 2. Ranks (`rankFields`): a stable sort by value (a dive: higher first). `split` ties share a rank, `ordered` ties do not.
 * 3. Caps (`overCapKeys`): per team, in rank order (a tie by the legacy name), the first `cap` swimmers are admitted. An
 *    individual over the cap leaves the places or holds its place by `overCap`. A relay does the same by `relayOverCap`.
 * 4. A second ranking without the entries that left. Their rows keep `place: null`.
 * 5. Points (the legacy scorer under `pointsOnlyRules`): a rank group of n entries shares the points of the n places it spans
 *    (`tiedPlaceShare`), and a place past the table scores nothing. A held entry stays in the group and scores 0.
 * 6. `resultRow`: the reason a row has no points.
 */
import { entryKey } from '../model/lineup';
import type { LineupEntry, RelayEntry, ScorerRole } from '../model/lineup';
import type { MeetEvent, MeetModel, MeetSwim, MeetSwimmer, RelaySplit } from '../model/meet';
import type { SwimmerId, TeamId } from '../model/primitives';
import { isRankable, pointTables, scyValue, settled } from '../model/results';
import type { NotScoredReason, ResultRow } from '../model/results';
import type { CompleteRulePreset, TieRule } from '../rules/rulePreset';
import { eventCap } from './support';

const legacyName = (id: SwimmerId): string => `sw:${id}`;
const seedKey = (swimmerId: SwimmerId, eventKey: string): string => `${swimmerId}\u0000${eventKey}`;

/** One entry of the event: what the scorer needs of it. */
interface Item {
  readonly key: string;
  readonly teamId: TeamId;
  readonly swimmerIds: readonly SwimmerId[];
  readonly relay: boolean;
  readonly value: number | null;
}

/** An entry value that the scorer cannot derive: the reference has to read it (and to throw what it throws). */
const UNREADABLE = Symbol('unreadable');

/**
 * Whether the fast scorer models the rules. A rule it does not model returns `false`, and the reference scores everything.
 * `checkRules` already refuses the rules that D5 2.1 item 4 names, so only the over-cap rules and the tie rule remain.
 */
export function fastSupported(rules: CompleteRulePreset): boolean {
  if (settled(rules.scorers.eligibility, 'scorers.eligibility') !== 'roster') return false;
  if (settled(rules.scoring.nonScorerPlacement, 'scoring.nonScorerPlacement') !== 'removed-from-consideration') return false;
  if (settled(rules.scorers.relayLegsMustBeScorers, 'scorers.relayLegsMustBeScorers') !== true) return false;
  const ties = settled(rules.scoring.ties, 'scoring.ties');
  if (ties !== 'split' && ties !== 'ordered') return false;
  const relayCap = settled(rules.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent');
  if (relayCap !== 'unlimited' && (!Number.isInteger(relayCap) || relayCap < 1)) return false;
  const size = settled(rules.scorers.scoringTeamSize, 'scorers.scoringTeamSize');
  // A numeric team size with the per-event scope is refused by `scoreMeet` itself: the reference must say so.
  if (size !== 'unlimited' && settled(rules.scorers.scoringTeamScope, 'scorers.scoringTeamScope') === 'event') return false;
  return true;
}

export class FastScorer {
  private readonly ties: TieRule;
  private readonly tables: ReturnType<typeof pointTables>;
  private readonly relayCap: number | null;
  private readonly relayRemoved: boolean;
  private readonly swims = new Map<string, MeetSwim>();
  private readonly splits = new Map<string, RelaySplit>();
  private readonly swimmers = new Map<string, MeetSwimmer>();
  private readonly teams = new Set<string>();
  private readonly swimsByKey = new Map<string, MeetSwim[]>();
  private readonly values = new Map<string, number | null | typeof UNREADABLE>();
  /** `eventCap` per event key and gender, `undefined` before the first read. */
  private readonly capOf = new Map<string, ReturnType<typeof eventCap>>();

  constructor(model: MeetModel, private readonly rules: CompleteRulePreset) {
    this.ties = settled(rules.scoring.ties, 'scoring.ties');
    this.tables = pointTables(rules);
    const relayCap = settled(rules.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent');
    this.relayCap = relayCap === 'unlimited' ? null : relayCap;
    this.relayRemoved = settled(rules.scorers.relayOverCap, 'scorers.relayOverCap') === 'exhibition';
    for (const s of model.swims) {
      this.swims.set(s.swimId, s);
      const k = seedKey(s.swimmerId, s.eventKey);
      const bucket = this.swimsByKey.get(k);
      if (bucket) bucket.push(s);
      else this.swimsByKey.set(k, [s]);
    }
    for (const sp of model.relaySplits) this.splits.set(sp.splitId, sp);
    for (const w of model.swimmers) this.swimmers.set(w.swimmerId, w);
    for (const t of model.teams) this.teams.add(String(t.teamId));
  }

  /**
   * Whether `scoreMeet` would accept the entry (`resolveLineup`): a team and a swimmer in the model, on that team and on the roster,
   * and an individual entry of the swimmer's own gender. Anything else is an error the reference raises, so the caller falls back.
   */
  private resolvable(e: LineupEntry): boolean {
    if (!this.teams.has(String(e.teamId))) return false;
    const ids = e.kind === 'individual' ? [e.swimmerId] : e.legs.map((l) => l.swimmerId);
    for (const id of ids) {
      const w = this.swimmers.get(id);
      if (w === undefined || w.teamId !== e.teamId || w.roster === 'not_member') return false;
      if (e.kind === 'individual' && w.gender !== e.gender) return false;
    }
    return true;
  }

  /** The seed value of an entry, as `resolveLineup` reads it, or `UNREADABLE` when the reference must read it. */
  private valueOf(entry: LineupEntry, event: MeetEvent): number | null | typeof UNREADABLE {
    if (entry.kind === 'individual') {
      const cacheKey = `i\u0000${entry.swimmerId}\u0000${entry.eventKey}\u0000${entry.gender}\u0000${entry.seedSwimId ?? ''}`;
      const known = this.values.get(cacheKey);
      if (known !== undefined) return known;
      const v = this.individualValue(entry, event);
      this.values.set(cacheKey, v);
      return v;
    }
    const cacheKey = `r\u0000${event.eventKey}\u0000${entry.legs.map((l) => `${l.swimmerId}\u0001${l.basis.kind}\u0001${'swimId' in l.basis ? l.basis.swimId : 'splitId' in l.basis ? l.basis.splitId : ''}`).join('\u0002')}`;
    const known = this.values.get(cacheKey);
    if (known !== undefined) return known;
    const v = this.relayValue(entry);
    this.values.set(cacheKey, v);
    return v;
  }

  private individualValue(entry: Extract<LineupEntry, { kind: 'individual' }>, event: MeetEvent): number | null | typeof UNREADABLE {
    if (entry.seedSwimId !== null) {
      const swim = this.swims.get(entry.seedSwimId);
      if (!swim || swim.swimmerId !== entry.swimmerId || swim.eventKey !== entry.eventKey) return UNREADABLE;
      return scyValue(swim);
    }
    let best: number | null = null;
    for (const swim of (this.swimsByKey.get(seedKey(entry.swimmerId, entry.eventKey)) ?? []).filter(isRankable)) {
      const v = scyValue(swim);
      if (v === null) continue;
      if (best === null || (event.kind === 'diving' ? v > best : v < best)) best = v;
    }
    return best;
  }

  private relayValue(entry: RelayEntry): number | null | typeof UNREADABLE {
    let total = 0;
    let timed = true;
    for (const leg of entry.legs) {
      const basis = leg.basis;
      let v: number | null;
      switch (basis.kind) {
        case 'no-time':
          v = null;
          break;
        case 'flat-start-swim': {
          const swim = this.swims.get(basis.swimId);
          if (!swim || swim.swimmerId !== leg.swimmerId) return UNREADABLE;
          v = scyValue(swim);
          break;
        }
        case 'split': {
          const split = this.splits.get(basis.splitId);
          if (!split || split.swimmerId !== leg.swimmerId || split.course !== 'SCY') return UNREADABLE;
          v = split.split.hundredths;
          break;
        }
        default:
          return UNREADABLE;
      }
      if (v === null) timed = false;
      else total += v;
    }
    return timed ? total : null;
  }

  private cap(event: MeetEvent): ReturnType<typeof eventCap> {
    const k = `${event.gender}\u0000${event.eventKey}`;
    if (this.capOf.has(k)) return this.capOf.get(k) as ReturnType<typeof eventCap>;
    const cap = eventCap(this.rules, event);
    this.capOf.set(k, cap);
    return cap;
  }

  /** Stable ranks of the timed items: `split` ties share a rank, `ordered` ties do not. */
  private rank(items: readonly Item[], diving: boolean): Map<string, number> {
    const timed = items.filter((r) => r.value !== null);
    timed.sort((a, b) => (diving ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)));
    const out = new Map<string, number>();
    let previous = -1;
    let previousRank = 0;
    timed.forEach((r, i) => {
      const rank = this.ties === 'split' && i > 0 && r.value === previous ? previousRank : i + 1;
      out.set(r.key, rank);
      previous = r.value as number;
      previousRank = rank;
    });
    return out;
  }

  /**
   * The rows of one event for `entries` (in lineup order), or `null` when the reference must score it. `roleOf` is the tag of a swimmer
   * on the scoring-roster plan: a swimmer with no tag is a non-scorer.
   */
  score(event: MeetEvent, entries: readonly LineupEntry[], roleOf: (id: SwimmerId) => ScorerRole | undefined): ResultRow[] | null {
    const relayEvent = event.kind === 'relay';
    const diving = event.kind === 'diving';
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if ((e.kind === 'relay') !== relayEvent || !this.resolvable(e)) return null;
      if (seen.has(entryKey(e))) return null;
      seen.add(entryKey(e));
      const value = this.valueOf(e, event);
      if (value === UNREADABLE) return null;
      items.push({
        key: entryKey(e),
        teamId: e.teamId,
        swimmerIds: e.kind === 'individual' ? [e.swimmerId] : e.legs.map((l) => l.swimmerId),
        relay: e.kind === 'relay',
        value,
      });
    }

    // 1. The roster plan: who leaves the places, and why.
    const leaving = this.plan(items, roleOf);
    const kept = leaving.size === 0 ? items : items.filter((r) => !leaving.has(r.key));

    // 2 and 3. Ranks of the full field of the scoring roster, and the entries over a per-team cap.
    const fullRank = this.rank(kept, diving);
    const { held, removed } = relayEvent ? this.relayCaps(kept, fullRank) : this.individualCaps(event, kept, fullRank);

    // 4. Rank again without the entries the caps removed.
    const survivors = removed.size === 0 ? kept : kept.filter((r) => !removed.has(r.key));
    const rank = removed.size === 0 ? fullRank : this.rank(survivors, diving);

    // 5. Points, and 6. the rows.
    const table = relayEvent ? this.tables.relay : diving ? this.tables.diving : this.tables.individual;
    const share = this.shares(survivors, rank, table);
    return this.rows(items, { leaving, held, removed, rank, share, table });
  }

  /** The entries that leave the places before ranking: an exhibition leg, or a swimmer off the scoring roster (a relay needs all legs). */
  private plan(items: readonly Item[], roleOf: (id: SwimmerId) => ScorerRole | undefined): Map<string, 'non_scorer' | 'exhibition'> {
    const leaving = new Map<string, 'non_scorer' | 'exhibition'>();
    for (const r of items) {
      const roles = r.swimmerIds.map(roleOf);
      if (roles.includes('exhibition')) leaving.set(r.key, 'exhibition');
      else if (!(r.relay ? roles.every((x) => x === 'scorer') : roles[0] === 'scorer')) leaving.set(r.key, 'non_scorer');
    }
    return leaving;
  }

  /** Relays over `scoringRelaysPerTeamPerEvent`, in rank order: held, or removed under the exhibition rule. */
  private relayCaps(kept: readonly Item[], fullRank: ReadonlyMap<string, number>): { held: Set<string>; removed: Set<string> } {
    const held = new Set<string>();
    const removed = new Set<string>();
    if (this.relayCap === null) return { held, removed };
    const counts = new Map<TeamId, number>();
    for (const r of kept.filter((x) => fullRank.has(x.key)).sort(this.byRank(fullRank))) {
      // Under 'holds-place' a relay past the table takes no cap slot. Under 'exhibition' every relay after the first leaves.
      if (!this.relayRemoved && (fullRank.get(r.key) as number) > this.tables.relay.length) continue;
      const used = counts.get(r.teamId) ?? 0;
      if (used >= this.relayCap) (this.relayRemoved ? removed : held).add(r.key);
      else counts.set(r.teamId, used + 1);
    }
    return { held, removed };
  }

  /** Swimmers over the per-event scorer cap, per team in rank order (a tie by the legacy name): held, or removed by `overCap`. */
  private individualCaps(event: MeetEvent, kept: readonly Item[], fullRank: ReadonlyMap<string, number>): { held: Set<string>; removed: Set<string> } {
    const held = new Set<string>();
    const removed = new Set<string>();
    const rule = this.cap(event);
    if (rule === null) return { held, removed };
    const over = rule.overCap === 'removed-from-consideration' ? removed : held;
    const admitted = new Map<TeamId, Set<SwimmerId>>();
    for (const r of kept.filter((x) => fullRank.has(x.key)).sort(this.byRank(fullRank))) {
      const set = admitted.get(r.teamId) ?? new Set<SwimmerId>();
      admitted.set(r.teamId, set);
      const id = r.swimmerIds[0] as SwimmerId;
      if (set.has(id)) continue;
      if (set.size < rule.cap) set.add(id);
      else over.add(r.key);
    }
    return { held, removed };
  }

  /** The points each rank group's entry gets: a group of n entries shares the points of the n places it spans, and a place past the table scores nothing. */
  private shares(survivors: readonly Item[], rank: ReadonlyMap<string, number>, table: readonly number[]): Map<number, number> {
    const groupSize = new Map<number, number>();
    for (const r of survivors) {
      const k = rank.get(r.key);
      if (k !== undefined) groupSize.set(k, (groupSize.get(k) ?? 0) + 1);
    }
    const share = new Map<number, number>();
    for (const [k, n] of groupSize) {
      if (k > table.length) continue;
      let sum = 0;
      let spanned = 0;
      for (let idx = k - 1; idx < k - 1 + n; idx++) {
        const v = table[idx];
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v;
          spanned += 1;
        }
      }
      if (spanned > 0) share.set(k, sum / n);
    }
    return share;
  }

  /** `resultRow`: one row per entry, with the reason it has no points. Sorted by place, then entry key. */
  private rows(
    items: readonly Item[],
    plan: {
      readonly leaving: ReadonlyMap<string, 'non_scorer' | 'exhibition'>;
      readonly held: ReadonlySet<string>;
      readonly removed: ReadonlySet<string>;
      readonly rank: ReadonlyMap<string, number>;
      readonly share: ReadonlyMap<number, number>;
      readonly table: readonly number[];
    }
  ): ResultRow[] {
    const { leaving, held, removed, rank, share, table } = plan;
    const rows: ResultRow[] = items.map((r) => {
      const place = rank.get(r.key) ?? null;
      const base = { entryKey: r.key, teamId: r.teamId, swimmerId: r.relay ? null : (r.swimmerIds[0] as SwimmerId), place };
      const zeroed = held.has(r.key);
      const points = zeroed || place === null ? 0 : (share.get(place) ?? 0);
      const row = { ...base, points, scored: points > 0 };
      const left = leaving.get(r.key);
      if (left !== undefined) return { ...row, notScoredReason: left };
      if (removed.has(r.key)) return { ...row, notScoredReason: (r.relay ? 'exhibition' : 'removed_over_event_cap') as NotScoredReason };
      if (points > 0) return row;
      if (place === null) return { ...row, notScoredReason: 'no_time' as const };
      if (place > table.length) return { ...row, notScoredReason: 'outside_point_table' as const };
      if (held.has(r.key)) return { ...row, notScoredReason: (r.relay ? 'relay_scorer_cap' : 'event_scorer_cap') as NotScoredReason };
      return row;
    });
    return rows.sort(
      (a, b) => (a.place ?? Infinity) - (b.place ?? Infinity) || (a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0)
    );
  }

  /** The legacy order inside a rank: finish order, then the synthetic name of the first swimmer (`placeOrderCompare`). */
  private byRank(rankOf: ReadonlyMap<string, number>): (a: Item, b: Item) => number {
    return (a, b) => {
      const ra = rankOf.get(a.key) as number;
      const rb = rankOf.get(b.key) as number;
      if (ra !== rb) return ra - rb;
      return legacyName(a.swimmerIds[0] as SwimmerId).localeCompare(legacyName(b.swimmerIds[0] as SwimmerId));
    };
  }
}
