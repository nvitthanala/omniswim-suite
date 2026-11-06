/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The meet-wide scorer pool and tie-group admission.
// Split out of `utils.ts`, which still re-exports every name from here.

import { Gender, SwimmerResult, ScoringSettings } from '../types';
import { isAbFinalRelayLeg } from './scorerRoster';
import { convertTimeToSeconds } from './timeFormat';
import { normalizeSwimmerName } from './swimmerNames';
import { isDivingForSettings } from './scoringRules';

export type TeamMeetState = {
  poolWeights: Map<string, number>;
};

function teamMeetStateKey(team: string, gender: Gender | string | undefined): string {
  return `${String(team).trim()}|||${gender ?? ''}`;
}

function totalPoolWeight(pool: Map<string, number>): number {
  let sum = 0;
  pool.forEach(w => {
    sum += w;
  });
  return sum;
}

function scorerWeightForEvent(event: string, settings: ScoringSettings): number {
  if (!isDivingForSettings(event, settings)) return 1;
  return settings.diverScorerWeight ?? 1;
}

export function swimmerInPool(pool: Map<string, number>, name: string): boolean {
  return pool.has(normalizeSwimmerName(name));
}

function canAddSwimmerToPool(
  pool: Map<string, number>,
  name: string,
  event: string,
  settings: ScoringSettings
): boolean {
  const cap = settings.maxIndividualScorersPerTeam ?? 18;
  if (cap >= 999) return true;
  const key = normalizeSwimmerName(name);
  if (pool.has(key)) return true;
  const add = scorerWeightForEvent(event, settings);
  return totalPoolWeight(pool) + add <= cap + 1e-9;
}

function addSwimmerToPool(pool: Map<string, number>, name: string, event: string, settings: ScoringSettings): void {
  const key = normalizeSwimmerName(name);
  if (pool.has(key)) return;
  pool.set(key, scorerWeightForEvent(event, settings));
}

/**
 * Distinct athlete names in one tie group, ordered fastest first.
 *
 * A tie group has no internal ranking — that is what makes it a tie — so when
 * the scorer cap cannot admit everyone in it, SOMETHING has to break the tie or
 * the result depends on row order (i.e. on import order, which is not a
 * competition rule). Fastest-first is the tiebreak: it is deterministic, and it
 * is the answer a coach expects — the last scorer slot goes to the faster
 * athlete. Equal times fall back to name order.
 *
 * A tie group now only ever holds equal times: `prepareRecruitsForScoring` used
 * to collapse a whole roster-only event into one rank-1 group, and no longer
 * does. The tiebreak still matters for a real dead heat that straddles the cap.
 */
function tieGroupNamesFastestFirst(members: SwimmerResult[]): string[] {
  const best = new Map<string, number>();
  for (const m of members) {
    const raw = convertTimeToSeconds(m.time);
    const t = Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
    const prev = best.get(m.name);
    if (prev === undefined || t < prev) best.set(m.name, t);
  }
  return [...best.keys()].sort((a, b) => (best.get(a)! - best.get(b)!) || a.localeCompare(b));
}

/**
 * Admit one team's slice of one tie group into the meet-wide scorer pool, and
 * return the names that may score. Newly admitted names are added to the pool.
 *
 * Replaces `uniqueNames.every(n => canAddSwimmerToPool(...))`, which got two
 * things wrong. Both were invisible in PDF-shaped data — a team almost never
 * holds two swimmers on one placement, so the group was a single athlete and
 * `every` reduced to this — and both detonate when ranks collapse:
 *
 *  1. ADMISSION IS PER ATHLETE. An athlete already in the pool is already
 *     consuming one of the team's scorer slots, so a groupmate who cannot fit
 *     must not be able to un-score them. `every` zeroed the whole group, so on
 *     a roster-only workspace ONE un-poolable athlete cost the team every point
 *     in the event — measured: 5 of 14 events on the HSU 2026-27 roster, 10 of
 *     14 on OBU. This is the same defect, in the pool gate, that was fixed in
 *     the roster gate below; see plans/2026-08-14/12.
 *
 *  2. ADMISSION ACCUMULATES WITHIN THE GROUP. `canAddSwimmerToPool` weighs one
 *     name against the pool AS IT STANDS, so N new names in a single group each
 *     saw the same pre-group weight and all N passed. The 18-scorer pool
 *     therefore admitted 31 athletes in HSU's first event — the cap was not
 *     enforced at all, which is why the optimizer (which does enforce 18) and
 *     the engine disagreed about who scores. Adding each admission immediately
 *     makes the next test see it.
 *
 * Points are NOT redistributed: the tie share is fixed by the placement, so an
 * athlete the pool cannot take forfeits their share rather than handing it to a
 * teammate, and a rival's points never move.
 */
export function admitTieGroupToMeetPool(
  pool: Map<string, number>,
  members: SwimmerResult[],
  event: string,
  settings: ScoringSettings
): Set<string> {
  const admitted = new Set<string>();
  for (const name of tieGroupNamesFastestFirst(members)) {
    if (!canAddSwimmerToPool(pool, name, event, settings)) continue;
    addSwimmerToPool(pool, name, event, settings);
    admitted.add(name);
  }
  return admitted;
}

/**
 * Same admission rule for the per-EVENT scorer cap (`scorerCapScope: 'event'`).
 * `used` is the team's scorer count so far in this event; the returned names are
 * the ones that still fit. Previously this branch zeroed the entire group once
 * the team was at its cap, and overshot the cap when the group crossed it.
 */
export function admitTieGroupToEventCap(
  members: SwimmerResult[],
  used: number,
  cap: number
): Set<string> {
  const room = Math.max(0, cap - used);
  return new Set(tieGroupNamesFastestFirst(members).slice(0, room));
}

/** Add A/B relay legs to the meet scorer pool so relay-only athletes can score relays (pool rule). */
export function seedAbRelayLegsIntoPool(
  relayRows: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>
): void {
  for (const r of relayRows) {
    if (!isAbFinalRelayLeg(r, merged)) continue;
    const team = String(r.team ?? '').trim() || 'Unknown';
    const meetState = getOrCreateMeetState(meetStates, team, r.gender);
    if (canAddSwimmerToPool(meetState.poolWeights, r.name, r.event, merged)) {
      addSwimmerToPool(meetState.poolWeights, r.name, r.event, merged);
    }
  }
}

export function getOrCreateMeetState(states: Map<string, TeamMeetState>, team: string, gender: Gender | string | undefined): TeamMeetState {
  const key = teamMeetStateKey(team, gender);
  let s = states.get(key);
  if (!s) {
    s = { poolWeights: new Map() };
    states.set(key, s);
  }
  return s;
}
