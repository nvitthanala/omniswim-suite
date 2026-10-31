/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The robust objective (D5 5.4, slice A7). A pair (swimmer, event) is valued at a swim that is a little slower than the best, taken from
 * real dated swims only. `spreadOf` holds the whole rule (D5 14.1, open question 1: the user has not answered it). A later answer changes
 * that one function. Everything else here only applies its result: the pins, the frozen pairs and the pinned copy of a lineup.
 *
 * No time is ever made up. The robust swim is one of the swims in the model, so `scoreMeet` scores it unchanged through `seedSwimId`.
 */
import { isRankable, scyValue } from '../model/results';
import type { DateWindow, MeetEvent, MeetModel, MeetSwim } from '../model/meet';
import type { Lineup, LineupEntry } from '../model/lineup';
import type { SwimmerId, TeamId } from '../model/primitives';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The key of a (swimmer, event) pair: `swimmerId NUL eventKey`. */
export const pairKey = (swimmerId: SwimmerId, eventKey: string): string => `${swimmerId}\u0000${eventKey}`;

export interface RobustSettings {
  /** How many of the most recent swims the spread reads. */
  readonly recentSwims: number;
  /** The fewest swims a pair needs. A pair with fewer has no spread. */
  readonly minSwims: number;
}

/** The robust swim of a pair, or no spread (`swims`: how many swims the rule found for it). */
export type Spread = { readonly present: true; readonly swim: MeetSwim; readonly swims: number } | { readonly present: false; readonly swims: number };

const inRange = (swim: MeetSwim, range: DateWindow): boolean =>
  range.kind === 'dates' ? (swim.date as string) >= range.from && (swim.date as string) <= range.to : swim.seasonId !== null && range.seasonIds.includes(swim.seasonId);

/**
 * THE RULE (D5 5.4 and 14.1). From the swims of one swimmer in one event:
 * 1. Keep a swim that is rankable, recorded in SCY (no converted estimate), dated, inside the record range, and has a time.
 * 2. Take the `recentSwims` most recent (date descending, a tie by `swimId`).
 * 3. Fewer than `minSwims`: no spread.
 * 4. Sort them fastest first (a dive: highest first, a tie by `swimId`). The robust swim is at index `ceil((n - 1) / 2)`: the slower middle.
 */
export function spreadOf(swims: readonly MeetSwim[], range: DateWindow, diving: boolean, settings: RobustSettings): Spread {
  const eligible = swims.filter((s) => isRankable(s) && s.scy.kind === 'recorded-scy' && s.date !== null && inRange(s, range) && scyValue(s) !== null);
  eligible.sort((a, b) => cmp(b.date as string, a.date as string) || cmp(a.swimId, b.swimId));
  const recent = eligible.slice(0, settings.recentSwims);
  if (recent.length < settings.minSwims) return { present: false, swims: recent.length };
  const value = (s: MeetSwim): number => scyValue(s) as number;
  recent.sort((a, b) => (diving ? value(b) - value(a) : value(a) - value(b)) || cmp(a.swimId, b.swimId));
  return { present: true, swim: recent[Math.ceil((recent.length - 1) / 2)] as MeetSwim, swims: recent.length };
}

/** What robust mode decided for every (decision swimmer, built individual event) pair. */
export interface RobustPlan {
  readonly settings: RobustSettings;
  /** `pairKey` to the `swimId` the pair's own entries are pinned to. Only a pair with a spread is here. */
  readonly pins: ReadonlyMap<string, string>;
  /** `pairKey` to the swim count of a pair with no spread: the frozen pairs (never added, never dropped). */
  readonly absent: ReadonlyMap<string, number>;
}

export function robustPlan(model: MeetModel, pairs: readonly { readonly swimmerId: SwimmerId; readonly event: MeetEvent }[], settings: RobustSettings): RobustPlan {
  const byPair = new Map<string, MeetSwim[]>();
  for (const s of model.swims) {
    const k = pairKey(s.swimmerId, s.eventKey);
    const bucket = byPair.get(k);
    if (bucket) bucket.push(s);
    else byPair.set(k, [s]);
  }
  const pins = new Map<string, string>();
  const absent = new Map<string, number>();
  for (const { swimmerId, event } of pairs) {
    const k = pairKey(swimmerId, event.eventKey);
    const spread = spreadOf(byPair.get(k) ?? [], model.recordRange, event.kind === 'diving', settings);
    if (spread.present) pins.set(k, spread.swim.swimId);
    else absent.set(k, spread.swims);
  }
  return { settings, pins, absent };
}

/**
 * A copy of `lineup` with the robust swim pinned on each own individual entry whose pair has a pin and whose swimmer `owned` accepts.
 * This is the one place that decides which entries a robust score pins: the column evaluator, the current lineup and the gate all call it.
 */
export function pinLineup(lineup: Lineup, own: TeamId, pins: ReadonlyMap<string, string>, owned: (swimmerId: SwimmerId) => boolean): Lineup {
  const entries = lineup.entries.map((e): LineupEntry => {
    if (e.kind !== 'individual' || e.teamId !== own || !owned(e.swimmerId)) return e;
    const swimId = pins.get(pairKey(e.swimmerId, e.eventKey));
    return swimId === undefined ? e : { ...e, seedSwimId: swimId };
  });
  return { ...lineup, entries };
}
