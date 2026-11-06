/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Relay entry grouping and relay event scoring.
// Split out of `utils.ts`, which still re-exports every name from here.

import { SwimmerResult, ScoringSettings } from '../types';
import { relayEntryRosterEligible, ScorerRosterLookup, usesScorerRoster } from './scorerRoster';
import { itemAt } from './indexedAccess';
import { convertTimeToSeconds } from './timeFormat';
import { normalizeSwimmerName } from './swimmerNames';
import {
  isScoringSwimResult,
  canScoreAthlete,
  parseRankInt,
  tiedPlaceShare,
  scoringRowIndexForRelay,
  relayPlaceValues,
  roundTierSort,
} from './scoringRules';
import { type TeamMeetState, swimmerInPool, getOrCreateMeetState } from './meetPool';

/** Team relay clock for grouping legs — never use leg split in `time`. */
export function relayTeamClock(r: SwimmerResult): string {
  return String(r.relayTeamTime ?? r.finalsTime ?? r.prelimsTime ?? '').trim();
}

/**
 * The swimmers a relay entry names, sorted, or `''` when the row records none.
 *
 * A team's A and B relays carry the same team name (a relay letter is stored
 * nowhere on a row) and, on a dead heat, the same event, round, place and clock.
 * The four swimmers are what tells the two entries apart. Every leg row of one
 * entry lists the same four names, so the signature is the same on all of them.
 */
export function relayEntryLegSignature(r: SwimmerResult): string {
  const named = r.relayNames ?? [];
  if (named.length === 0) return '';
  return named
    .map(n => normalizeSwimmerName(String(n.name ?? '')))
    .sort()
    .join(';');
}

/**
 * One key per team relay entry (all legs share this). Used for scoring caps and grouping.
 * Event + team + round + place + team time + the named swimmers — not per-leg
 * split times.
 *
 * The swimmers are in the key so one team's A and B relays on a dead heat stay two
 * entries: without them they merged into one eight-leg group, which paid the
 * pair's points to eight legs and counted one entry against the per-team relay
 * cap instead of two. A row that names no swimmers keeps the previous key.
 */
export function relayEntryGroupKey(r: SwimmerResult): string {
  const team = String(r.team ?? '').trim();
  const event = String(r.event ?? '').trim();
  const round = String(r.roundSwam ?? '').trim();
  const rk = parseRankInt(r.rank) ?? '';
  const clock = relayTeamClock(r);
  const legs = relayEntryLegSignature(r);
  const base = `${event}|${team}|${round}|${rk}|${clock}`;
  return legs ? `${base}|${legs}` : base;
}

/** @deprecated Use relayEntryGroupKey */
function relayScoringGroupKey(r: SwimmerResult): string {
  return relayEntryGroupKey(r);
}

/**
 * The 0-based place-table row one relay entry (all its legs) scores from, or
 * `null` when the entry takes no place: an exhibition or time-trial entry, a
 * round or event that does not score, a non-finish result, no rank, or a rank
 * the table has no row for.
 *
 * One gate, read by both the tie count and the scoring loop, so the two cannot
 * disagree about which entries hold a place.
 */
function relayEntryPlaceIndex(group: SwimmerResult[], merged: ScoringSettings): number | null {
  // Both callers pass a `relayMap` bucket: created with a row pushed straight after.
  const sample = itemAt(group, 0);
  const ex = group.some(r => r.isExhibition);
  const tt = group.some(r => r.isTimeTrial);
  if (ex || tt || !canScoreAthlete(sample.roundSwam, sample.event, merged) || !isScoringSwimResult(sample)) {
    return null;
  }
  const rk = parseRankInt(sample.rank);
  return rk != null ? scoringRowIndexForRelay(sample.roundSwam, rk, sample.event, merged) : null;
}

/**
 * Entries that tie share one event, round and finish rank — the key the
 * individual scorer uses (`buildIndividualEventGroups`). Not the team and not
 * the clock: two teams tied for 1st are two entries on one tie key.
 *
 * Gender is NOT in the key, deliberately. `SwimmerResult.gender` is optional, so
 * a key that read it would un-split a tie between a relay that names its gender
 * and one that does not. Every caller of `calculatePoints` passes the rows of ONE
 * gender, so one event label never holds two genders here.
 */
function relayTieKey(sample: SwimmerResult): string {
  const rk = parseRankInt(sample.rank) ?? 0;
  return `${String(sample.event ?? '').trim()}|${(sample.roundSwam || '').trim()}|${rk}`;
}

/**
 * How many relay entries hold each tied place.
 *
 * Counted BEFORE the per-team relay cap and the roster / scorer-pool gates, so
 * an entry those gates zero still holds its place and still sits in the divisor:
 * it forfeits its share and a rival's points never move. This is the rule the
 * individual scorer follows (see `admitTieGroupToMeetPool`).
 */
function countTiedRelayEntries(
  entries: SwimmerResult[][],
  merged: ScoringSettings
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of entries) {
    if (relayEntryPlaceIndex(group, merged) == null) continue;
    const key = relayTieKey(itemAt(group, 0));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function scoreRelaysInEvent(
  relays: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  useMeetWidePool: boolean,
  rosterLookup?: ScorerRosterLookup
): SwimmerResult[] {
  const relayMap = new Map<string, SwimmerResult[]>();
  for (const r of relays) {
    const k = relayScoringGroupKey(r);
    if (!relayMap.has(k)) relayMap.set(k, []);
    relayMap.get(k)!.push(r);
  }
  const relayKeys = Array.from(relayMap.keys()).sort((a, b) => {
    // Each key was created with a row pushed straight after, so a group is never empty.
    const ra = itemAt(relayMap.get(a)!, 0);
    const rb = itemAt(relayMap.get(b)!, 0);
    const tw = roundTierSort(ra.roundSwam) - roundTierSort(rb.roundSwam);
    if (tw !== 0) return tw;
    const rna = parseRankInt(ra.rank) ?? 9999;
    const rnb = parseRankInt(rb.rank) ?? 9999;
    if (rna !== rnb) return rna - rnb;
    return convertTimeToSeconds(ra.time) - convertTimeToSeconds(rb.time);
  });

  /** Relay cap is per team per relay event (e.g. max 2 scoring entries in 200 Free Relay). */
  const teamRelayCountsByEvent = new Map<string, number>();
  const relayOut: SwimmerResult[] = [];
  const placeValues = relayPlaceValues(merged);
  const tiedEntryCounts = countTiedRelayEntries(
    relayKeys.map(k => relayMap.get(k)!),
    merged
  );

  for (const key of relayKeys) {
    const group = relayMap.get(key)!;
    const sample = itemAt(group, 0);
    const team = String(sample.team ?? 'Unknown').trim() || 'Unknown';
    const eventName = String(sample.event ?? '').trim();
    const meetState = getOrCreateMeetState(meetStates, team, sample.gender);

    const idx = relayEntryPlaceIndex(group, merged);
    if (idx == null) {
      group.forEach(r => relayOut.push({ ...r, points: 0 }));
      continue;
    }

    const maxRel = merged.maxRelaysScoringPerTeam ?? 2;
    const relayCapKey = `${team}|||${eventName}`;
    const relayCount = teamRelayCountsByEvent.get(relayCapKey) ?? 0;
    if (relayCount >= maxRel) {
      group.forEach(r => relayOut.push({ ...r, points: 0 }));
      continue;
    }

    if (rosterLookup && usesScorerRoster(merged)) {
      if (!relayEntryRosterEligible(group, merged, rosterLookup)) {
        group.forEach(r => relayOut.push({ ...r, points: 0 }));
        continue;
      }
    } else if (useMeetWidePool && merged.relayEligibleFromScorerPool === true) {
      const allInPool = group.every(r => swimmerInPool(meetState.poolWeights, r.name));
      if (!allInPool) {
        group.forEach(r => relayOut.push({ ...r, points: 0 }));
        continue;
      }
    }

    // Tied entries split the points of every place the tie spans (decision U1),
    // through the same helper the individual scorers use. `null` means the table
    // holds no row at any spanned place: the entry takes no points, a decision
    // made here and not inside the lookup.
    const tiedEntries = tiedEntryCounts.get(relayTieKey(sample)) ?? 1;
    const teamPts = tiedPlaceShare(placeValues, idx, tiedEntries) ?? 0;
    const n = group.length;
    // halfRateRelaySwimmer: each leg earns 1/n of team relay points (typically n=4 → 1/4 share).
    let swimmerPts = teamPts / (n > 0 ? n : 1);
    if (merged.halfRateRelaySwimmer) {
      swimmerPts = teamPts / (n >= 4 ? 4 : Math.max(n, 1));
    }

    // One relay unit per team entry (4 legs), capped per relay event.
    teamRelayCountsByEvent.set(relayCapKey, relayCount + 1);

    group.forEach(r => relayOut.push({ ...r, points: swimmerPts }));
  }

  return relayOut;
}
