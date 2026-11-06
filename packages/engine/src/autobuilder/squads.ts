/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay squads (D5 3.2, slice A2). A squad is four distinct decision swimmers with a leg basis at each position. Leg options
 * follow invariant 13 (the exact leg event) and invariant 19 (leg 1 flat, legs 2 to 4 a split with a flying or unknown start),
 * so a built relay never raises a `relay_leg` violation. A split is valued by `splitScyValue` (a non-SCY split converts, README R62). When the
 * flyover is set (README R14), a swimmer with no split option at leg 2 to 4 gets a flyover-estimate option from the fastest rankable swim of
 * the leg event (D7 section 5). `Q_e` is the top T squads by time, the best squad that shares no
 * swimmer with each of them, and the current own squads. Nothing here scores: `scoreMeet` is the only scorer.
 */
import { expectedLegEvents, isRankable, scyValue } from '../model/results';
import { estimateFlyingLeg, splitScyValue } from '../sourcing/flyover';
import type { SourcingSettings } from '../sourcing/flyover';
import { entryKey } from '../model/lineup';
import type { LegBasis, RelayEntry, RelayLeg } from '../model/lineup';
import type { DivisionRef, MeetEvent, MeetModel, MeetSwim, RelaySplit } from '../model/meet';
import type { Gender, SwimmerId, TeamId } from '../model/primitives';
import { autoBuildFail } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SEP = '\u0001';

/** One swimmer's best basis for one leg position. */
export interface LegOption {
  readonly swimmerId: SwimmerId;
  /** Hundredths. */
  readonly value: number;
  readonly basis: LegBasis;
  /** The swim or split id: breaks a tie between equal values. */
  readonly id: string;
}

/** The option lists per leg position (0 to 3), each sorted by value, then swimmer id. */
export type Positions = readonly [readonly LegOption[], readonly LegOption[], readonly LegOption[], readonly LegOption[]];

export interface Squad {
  /** The ordered leg swimmer ids: the squad's identity. */
  readonly key: string;
  readonly swimmers: readonly SwimmerId[];
  readonly legs: readonly [RelayLeg, RelayLeg, RelayLeg, RelayLeg];
  /** Sum of the leg values in hundredths; `Infinity` when a leg of a current relay has no time. */
  readonly time: number;
  /** The current entry when this squad is a current own relay: it keeps its letter and its bases. */
  readonly current: RelayEntry | null;
}

export const squadKeyOf = (swimmers: readonly SwimmerId[]): string => swimmers.join(SEP);
export const squadKeyOfEntry = (entry: RelayEntry): string => squadKeyOf(entry.legs.map((l) => l.swimmerId));

/** Swims and splits indexed for the leg options. */
export interface LegSources {
  readonly swimById: ReadonlyMap<string, MeetSwim>;
  readonly splitById: ReadonlyMap<string, RelaySplit>;
  readonly swimsBy: ReadonlyMap<SwimmerId, readonly MeetSwim[]>;
  readonly splitsBy: ReadonlyMap<SwimmerId, readonly RelaySplit[]>;
  /** The conversion settings and the flyover the options and the current squads are valued under. */
  readonly sourcing: SourcingSettings;
  /** The division of each swimmer's team: a split converts by it. */
  readonly divisionBy: ReadonlyMap<SwimmerId, DivisionRef>;
  /** The meet events by `gender\u0000eventKey`: a current relay's expected leg events come from its event. */
  readonly eventBy: ReadonlyMap<string, MeetEvent>;
}

export function buildLegSources(model: MeetModel, sourcing: SourcingSettings): LegSources {
  const swimsBy = new Map<SwimmerId, MeetSwim[]>();
  for (const s of model.swims) swimsBy.set(s.swimmerId, [...(swimsBy.get(s.swimmerId) ?? []), s]);
  const splitsBy = new Map<SwimmerId, RelaySplit[]>();
  for (const s of model.relaySplits) splitsBy.set(s.swimmerId, [...(splitsBy.get(s.swimmerId) ?? []), s]);
  const teamDivision = new Map(model.teams.map((t) => [t.teamId, t.division]));
  const divisionBy = new Map<SwimmerId, DivisionRef>();
  for (const swimmer of model.swimmers) {
    const division = teamDivision.get(swimmer.teamId);
    if (division !== undefined) divisionBy.set(swimmer.swimmerId, division);
  }
  return {
    swimById: new Map(model.swims.map((s) => [s.swimId, s])),
    splitById: new Map(model.relaySplits.map((s) => [s.splitId, s])),
    swimsBy,
    splitsBy,
    sourcing,
    divisionBy,
    eventBy: new Map(model.events.map((e) => [`${e.gender}\u0000${e.eventKey}`, e])),
  };
}

const UNKNOWN_DIVISION: DivisionRef = { state: 'unknown', reason: 'unmapped_team' };

/** A split's yards value (`splitScyValue`), by its swimmer's team division. A swimmer outside the model has an unknown division, never a guessed one. */
const splitValue = (split: RelaySplit, gender: Gender, sources: LegSources): number | null =>
  splitScyValue(split, sources.divisionBy.get(split.swimmerId) ?? UNKNOWN_DIVISION, gender, sources.sourcing);

const better = (a: LegOption, b: LegOption | null): boolean => b === null || a.value < b.value || (a.value === b.value && a.id < b.id);

/** The flyover-estimate option from the fastest rankable swim of the leg event, or `null` (flyover unset, no such swim, or no positive estimate). */
function flyoverOption(swimmerId: SwimmerId, expected: string, sources: LegSources): LegOption | null {
  let flat: MeetSwim | null = null;
  let flatValue = 0;
  for (const swim of sources.swimsBy.get(swimmerId) ?? []) {
    if (swim.eventKey !== expected || !isRankable(swim)) continue;
    const value = scyValue(swim);
    if (value === null) continue;
    if (flat === null || value < flatValue || (value === flatValue && swim.swimId < flat.swimId)) {
      flat = swim;
      flatValue = value;
    }
  }
  if (flat === null) return null;
  const estimate = estimateFlyingLeg(flat, expected, sources.sourcing.flyover);
  return estimate === null
    ? null
    : {
        swimmerId,
        value: estimate.hundredths,
        basis: { kind: 'flyover-estimate', swimId: flat.swimId },
        id: flat.swimId,
      };
}

/** One swimmer's option at one position (D5 3.2), or `null`. */
function optionAt(swimmerId: SwimmerId, position: number, expected: string, gender: Gender, sources: LegSources): LegOption | null {
  let best: LegOption | null = null;
  if (position === 0) {
    for (const swim of sources.swimsBy.get(swimmerId) ?? []) {
      if (swim.eventKey !== expected || !isRankable(swim)) continue;
      const value = scyValue(swim);
      if (value === null) continue;
      const option: LegOption = { swimmerId, value, basis: { kind: 'flat-start-swim', swimId: swim.swimId }, id: swim.swimId };
      if (better(option, best)) best = option;
    }
  }
  for (const split of sources.splitsBy.get(swimmerId) ?? []) {
    if (split.legEventKey !== expected) continue;
    if (position === 0 ? split.start !== 'flat' : split.start === 'flat') continue;
    const value = splitValue(split, gender, sources);
    if (value === null) continue;
    const option: LegOption = { swimmerId, value, basis: { kind: 'split', splitId: split.splitId }, id: split.splitId };
    if (better(option, best)) best = option;
  }
  // A flyover option only where the swimmer has no split option: a split already includes the exchange, so the estimate never competes with one.
  if (position > 0 && best === null) best = flyoverOption(swimmerId, expected, sources);
  return best;
}

/** The option lists of the decision swimmers of one relay event, or `null` when the event has no expected leg events. */
export function legOptions(event: MeetEvent, swimmers: readonly SwimmerId[], sources: LegSources): Positions | null {
  const expected = expectedLegEvents(event);
  if (expected === null) return null;
  const lists = [0, 1, 2, 3].map((position) => {
    const list: LegOption[] = [];
    for (const swimmerId of swimmers) {
      const option = optionAt(swimmerId, position, expected[position] as string, event.gender, sources);
      if (option !== null) list.push(option);
    }
    return list.sort((a, b) => a.value - b.value || cmp(a.swimmerId, b.swimmerId));
  });
  return lists as unknown as Positions;
}

const squadOf = (options: readonly LegOption[]): Squad => ({
  key: squadKeyOf(options.map((o) => o.swimmerId)),
  swimmers: options.map((o) => o.swimmerId),
  legs: options.map((o) => ({ swimmerId: o.swimmerId, basis: o.basis })) as unknown as Squad['legs'],
  time: options.reduce((sum, o) => sum + o.value, 0),
  current: null,
});

const byTime = (a: Squad, b: Squad): number => a.time - b.time || cmp(a.key, b.key);

/**
 * Every squad over the first `cap` options per position that avoids `exclude`. A medley relay assigns four distinct swimmers
 * to the four positions. A freestyle relay fixes legs 2 to 4 in swimmer-id order and keeps the leadoff that gives the smallest
 * total, so one set of four swimmers is one squad.
 */
function enumerate(positions: Positions, freestyle: boolean, exclude: ReadonlySet<SwimmerId>, cap: number): Squad[] {
  const list = (p: number, take: number): LegOption[] => (positions[p] as readonly LegOption[]).filter((o) => !exclude.has(o.swimmerId)).slice(0, take);
  const out: Squad[] = [];
  if (!freestyle) {
    for (const a of list(0, cap)) {
      for (const b of list(1, cap)) {
        if (b.swimmerId === a.swimmerId) continue;
        for (const c of list(2, cap)) {
          if (c.swimmerId === a.swimmerId || c.swimmerId === b.swimmerId) continue;
          for (const d of list(3, cap)) {
            if (d.swimmerId !== a.swimmerId && d.swimmerId !== b.swimmerId && d.swimmerId !== c.swimmerId) out.push(squadOf([a, b, c, d]));
          }
        }
      }
    }
    return out;
  }
  const best = new Map<string, Squad>();
  const rest = list(1, cap + 1);
  for (const a of list(0, cap)) {
    const others = rest.filter((o) => o.swimmerId !== a.swimmerId).slice(0, cap).sort((x, y) => cmp(x.swimmerId, y.swimmerId));
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        for (let k = j + 1; k < others.length; k++) {
          const squad = squadOf([a, others[i] as LegOption, others[j] as LegOption, others[k] as LegOption]);
          const set = [...squad.swimmers].sort(cmp).join(SEP);
          const known = best.get(set);
          if (known === undefined || byTime(squad, known) < 0) best.set(set, squad);
        }
      }
    }
  }
  return [...best.values()];
}

export interface SquadSet {
  /** `Q_e`, sorted by time then key. */
  readonly squads: readonly Squad[];
  /** The time of the (T+1)-th squad in time order: any squad not in the top T is at least this slow. `null`: no such squad. */
  readonly tauOut: number | null;
}

/** A current own relay as a squad: it keeps its bases, so its time is read from them. */
export function currentSquad(entry: RelayEntry, sources: LegSources): Squad {
  let time = 0;
  const event = sources.eventBy.get(`${entry.gender}\u0000${entry.eventKey}`);
  const expected = event === undefined ? null : expectedLegEvents(event);
  entry.legs.forEach((leg, position) => {
    const basis = leg.basis;
    let value: number | null = null;
    if (basis.kind === 'split') {
      const split = sources.splitById.get(basis.splitId);
      value = split === undefined ? null : splitValue(split, entry.gender, sources);
    } else if (basis.kind === 'flat-start-swim') {
      const swim = sources.swimById.get(basis.swimId);
      value = swim === undefined ? null : scyValue(swim);
    } else if (basis.kind === 'flyover-estimate') {
      // Leg 1 takes no estimate (`scoreMeet` gives it no time and a `basis_position` violation), and a leg event the meet does not name has none to check.
      const swim = sources.swimById.get(basis.swimId);
      const legEvent = expected === null ? undefined : expected[position];
      value = swim === undefined || position === 0 || legEvent === undefined ? null : (estimateFlyingLeg(swim, legEvent, sources.sourcing.flyover)?.hundredths ?? null);
    }
    time = value === null ? Infinity : time + value;
  });
  return { key: squadKeyOfEntry(entry), swimmers: entry.legs.map((l) => l.swimmerId), legs: entry.legs, time, current: entry };
}

/** `Q_e` (D5 3.2): the top T squads, the best disjoint complement of each, and the current squads. */
export function generateSquads(positions: Positions, freestyle: boolean, T: number, current: readonly Squad[]): SquadSet {
  // A squad of rank r uses, at each position, a swimmer of rank at most r + 3: faster swaps would outrank it otherwise.
  const all = enumerate(positions, freestyle, new Set(), T + 4).sort(byTime);
  const top = all.slice(0, T);
  const tauOut = all.length > T ? (all[T] as Squad).time : null;
  const byKey = new Map<string, Squad>();
  for (const s of top) byKey.set(s.key, s);
  for (const s of top) {
    // The best squad that shares no swimmer with `s`: at most rank 4 per position.
    const complement = enumerate(positions, freestyle, new Set(s.swimmers), 5).sort(byTime)[0];
    if (complement !== undefined) byKey.set(complement.key, complement);
  }
  for (const s of current) byKey.set(s.key, s);
  return { squads: [...byKey.values()].sort(byTime), tauOut };
}

/** The lowest letters unused by the surviving own relays go to the new squads in time order (D5 5.1). */
export function freshRelays(own: TeamId, event: MeetEvent, fresh: readonly Squad[], surviving: readonly RelayEntry[]): RelayEntry[] {
  const used = new Set(surviving.map((e) => e.letter));
  const out: RelayEntry[] = [];
  for (const squad of [...fresh].sort(byTime)) {
    const letter = [...LETTERS].find((l) => !used.has(l));
    if (letter === undefined) return autoBuildFail('model_mismatch', `no relay letter is left for ${event.eventKey}`, event.eventKey);
    used.add(letter);
    out.push({ kind: 'relay', teamId: own, eventKey: event.eventKey, gender: event.gender as Gender, letter, legs: squad.legs });
  }
  return out.sort((a, b) => cmp(entryKey(a), entryKey(b)));
}
