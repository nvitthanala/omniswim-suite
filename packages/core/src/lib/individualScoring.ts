/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Individual event scoring: timed finals, place caps and tie groups.
// Split out of `utils.ts`, which still re-exports every name from here.

import { SwimmerResult, ScoringSettings } from '../types';
import { ScorerRosterLookup, usesScorerRoster } from './scorerRoster';
import { itemAt } from './indexedAccess';
import { convertTimeToSeconds } from './timeFormat';
import { normalizeSwimmerName } from './swimmerNames';
import {
  classifyRoundTier,
  isChampionshipGenderEvent,
  isScoringSwimResult,
  canScoreAthlete,
  athleteHasFinalsDiveInEvent,
  parseRankInt,
  individualPlaceTable,
  scoringRowIndex,
  tiedPlaceShare,
  roundTierSort,
  isDivingForSettings,
} from './scoringRules';
import {
  type TeamMeetState,
  admitTieGroupToMeetPool,
  admitTieGroupToEventCap,
  getOrCreateMeetState,
} from './meetPool';

/** Distance timed finals (1000/1650 etc.) — one heat, not A/B prelims. */
export function isTimedFinalDistanceHeat(
  event: string | undefined,
  roundSwam: string | undefined
): boolean {
  if (!event) return false;
  const u = event.toUpperCase();
  const isDistance = /\b(1000|1650|1500|800|10000)\b/.test(u) || u.includes('TIMED');
  if (!isDistance) return false;
  return classifyRoundTier(roundSwam) === 'FIN';
}

function isTimedFinalDistanceSession(individuals: SwimmerResult[]): boolean {
  return individuals.length > 0 && individuals.every(r => isTimedFinalDistanceHeat(r.event, r.roundSwam));
}

/** One event's rows, grouped by finish rank (ties by exact time+name), in scoring order. */
function buildTimedFinalRankGroups(
  individuals: SwimmerResult[]
): { byRank: Map<string, SwimmerResult[]>; sortedKeys: string[] } {
  const byRank = new Map<string, SwimmerResult[]>();
  for (const r of individuals) {
    const rk = parseRankInt(r.rank);
    const key =
      rk != null && rk > 0 ? String(rk) : `T|${convertTimeToSeconds(r.time)}|${r.name}`;
    if (!byRank.has(key)) byRank.set(key, []);
    byRank.get(key)!.push(r);
  }

  const sortedKeys = Array.from(byRank.keys()).sort((a, b) => {
    // Each key was created with a row pushed straight after, so a group is never empty.
    const first = itemAt(byRank.get(a)!, 0);
    const second = itemAt(byRank.get(b)!, 0);
    const ra = parseRankInt(first.rank) ?? 9999;
    const rb = parseRankInt(second.rank) ?? 9999;
    if (ra !== rb) return ra - rb;
    return convertTimeToSeconds(first.time) - convertTimeToSeconds(second.time);
  });

  return { byRank, sortedKeys };
}

/**
 * Timed-finals distance: split one rank/tie group into the rows that may still
 * earn ladder points, pushing every zero-point row (a non-finish result, an
 * exhibition swim, a time trial, or an unscored round/event) straight into
 * `indivOut`. Place ladder follows meet finish order among the legal swims that
 * remain; roster caps apply via the meet-wide pool in
 * {@link awardTimedFinalPointEligibleGroup}, not by skipping ladder slots here.
 */
function splitTimedFinalGroupEligibility(
  group: SwimmerResult[],
  merged: ScoringSettings,
  indivOut: SwimmerResult[]
): SwimmerResult[] {
  const ineligible = group.filter(r => !isScoringSwimResult(r));
  ineligible.forEach(r => indivOut.push({ ...r, points: 0 }));

  const eligible = group.filter(r => isScoringSwimResult(r));
  const pointEligible: SwimmerResult[] = [];
  for (const r of eligible) {
    const ex = r.isExhibition;
    const tt = r.isTimeTrial && !isChampionshipGenderEvent(r.event);
    if (ex || tt || !canScoreAthlete(r.roundSwam, r.event, merged)) {
      indivOut.push({ ...r, points: 0 });
      continue;
    }
    pointEligible.push(r);
  }
  return pointEligible;
}

/**
 * Timed-finals distance: award one point-eligible tie group its ladder slice,
 * split per team by whichever cap rule is active, pushing every row (awarded
 * or zero) into `indivOut`. Mutates `teamIndivScorers` (the per-event cap's
 * running count) and `meetStates` (the meet-wide pool) exactly as the caller's
 * loop did inline. Returns how many ladder places this group consumed — 0
 * when nothing was awarded, so the ladder does not advance.
 */
function awardTimedFinalPointEligibleGroup(
  pointEligible: SwimmerResult[],
  sampleEvent: string,
  pts: number[],
  scoringPlace: number,
  cap: number,
  useMeetWidePool: boolean,
  teamIndivScorers: Record<string, number>,
  meetStates: Map<string, TeamMeetState>,
  merged: ScoringSettings,
  indivOut: SwimmerResult[]
): number {
  const avail = pts.length - scoringPlace;
  const take = Math.min(pointEligible.length, avail);
  // The one tie rule: places the group spans, added, over the group's size.
  const each = tiedPlaceShare(pts, scoringPlace, pointEligible.length);
  if (each == null) {
    pointEligible.forEach(r => indivOut.push({ ...r, points: 0 }));
    return 0;
  }

  const byTeam = new Map<string, SwimmerResult[]>();
  for (const r of pointEligible) {
    const t = String(r.team ?? 'Unknown').trim() || 'Unknown';
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t)!.push(r);
  }

  let anyAwarded = false;
  for (const [team, members] of byTeam) {
    // `members` was created with a row pushed straight after, so it is never empty.
    const meetState = getOrCreateMeetState(meetStates, team, itemAt(members, 0).gender);

    // Cap admission is per athlete and accumulates — see admitTieGroupToMeetPool.
    if (useMeetWidePool) {
      const admitted = admitTieGroupToMeetPool(
        meetState.poolWeights,
        members,
        sampleEvent,
        merged
      );
      for (const r of members) {
        const award = admitted.has(r.name) ? each : 0;
        indivOut.push({ ...r, points: award });
        if (award > 0) anyAwarded = true;
      }
    } else if (cap < 999) {
      const used = teamIndivScorers[team] || 0;
      const allowed = admitTieGroupToEventCap(members, used, cap);
      for (const r of members) {
        const award = allowed.has(r.name) ? each : 0;
        indivOut.push({ ...r, points: award });
        if (award > 0) anyAwarded = true;
      }
      teamIndivScorers[team] = used + allowed.size;
    } else {
      for (const r of members) {
        indivOut.push({ ...r, points: each });
      }
      anyAwarded = true;
    }
  }

  return anyAwarded ? take : 0;
}

/**
 * Timed-finals distance: place points follow scoring order among finishers who actually earn
 * points (exhibition, non-roster, and pool-blocked swimmers do not consume ladder slots).
 */
function scoreTimedFinalIndividualsInEvent(
  individuals: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  useMeetWidePool: boolean,
  _rosterLookup?: ScorerRosterLookup
): SwimmerResult[] {
  // One event per call, so one table: `individuals[0].event` names it. Diving
  // scores from `divingPoints` when the preset carries one (Rule 7-1-4).
  const pts = individualPlaceTable(individuals[0]?.event, merged);
  const cap = merged.maxIndividualScorersPerTeam ?? 999;
  const teamIndivScorers: Record<string, number> = {};
  const indivOut: SwimmerResult[] = [];

  const { byRank, sortedKeys } = buildTimedFinalRankGroups(individuals);

  let scoringPlace = 0;

  for (const key of sortedKeys) {
    const group = byRank.get(key)!;
    const pointEligible = splitTimedFinalGroupEligibility(group, merged, indivOut);
    if (pointEligible.length === 0) continue;

    // Single-event call (see above): every row in the group shares one event,
    // so the first point-eligible row names it exactly as the first eligible
    // row did before this split.
    scoringPlace += awardTimedFinalPointEligibleGroup(
      pointEligible,
      // `pointEligible.length === 0` continued above, so index 0 exists.
      itemAt(pointEligible, 0).event,
      pts,
      scoringPlace,
      cap,
      useMeetWidePool,
      teamIndivScorers,
      meetStates,
      merged,
      indivOut
    );
  }

  return indivOut;
}

// ---------------------------------------------------------------------------
// Per-team place cap — NCAA Rules 7-1-1, 7-1-2, 7-1-4, 7-2
// ---------------------------------------------------------------------------

export type OverCapPlaceBehavior = NonNullable<ScoringSettings['overCapPlaceBehavior']>;

type TeamPlaceCapRule = { max: number; behavior: OverCapPlaceBehavior };

/**
 * The per-team place cap in force for this meet, or `null` when the setting is
 * absent — which is every preset written before 2026-09-20, and the path that
 * must stay byte-identical.
 *
 * Throws rather than coercing. A preset whose competition rule cannot be read is
 * a defect in the preset; scoring around it produces a plausible, wrong total,
 * which is the failure mode this repo cares about most.
 */
function resolveTeamPlaceCap(
  settings: ScoringSettings,
  event: string | undefined
): TeamPlaceCapRule | null {
  // Diving caps separately from swimming in the same dual meet (Rule 7-1-4 vs
  // 7-1-1), so the event decides which number applies.
  const diving = settings.divingMaxScorersPerTeamPerEvent;
  const field =
    diving != null && isDivingForSettings(event, settings)
      ? 'divingMaxScorersPerTeamPerEvent'
      : 'maxIndividualScorersPerTeamPerEvent';
  const raw = settings[field];
  if (raw == null) return null;
  if (!Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `ScoringSettings.${field} must be a positive integer — ` +
        `NCAA Rule 7-1-1 reads "with only the best three contestants from each team ` +
        `scoring". Got ${String(raw)}. Omit the field for no cap.`
    );
  }
  const meetWidePool =
    settings.scorerCapScope === 'meet' && (settings.maxIndividualScorersPerTeam ?? 999) < 999;
  if (meetWidePool) {
    // Under 'holds-place' an over-cap contestant still occupies a place, so it must
    // stay in its tie group for the split — which means it has already been admitted
    // to the meet-wide scorer pool by the time its points are struck. It would then
    // burn one of the team's pool slots while scoring nothing. Rather than pick a
    // silent answer, refuse the combination: no built-in preset produces it, and a
    // meet that really needs both should be modelled once, deliberately, with a
    // published rule to cite.
    throw new Error(
      `ScoringSettings combines maxIndividualScorersPerTeamPerEvent ` +
        `(${raw}) with a meet-wide scorer pool (maxIndividualScorersPerTeam=` +
        `${settings.maxIndividualScorersPerTeam}, scorerCapScope='meet'). Those two rules ` +
        `disagree about whether a contestant who takes a place but scores nothing spends a ` +
        `pool slot, and the NCAA rulebook settles neither. Use one or the other.`
    );
  }
  return { max: raw, behavior: settings.overCapPlaceBehavior ?? 'holds-place' };
}

/**
 * True when this row occupies a scoring place in its event, and therefore spends
 * one of its team's cap slots.
 *
 * Mirrors `computeNcaaEventScoring`'s step 1: an exhibition swim, a DQ, a time
 * trial and a round that earns no points are all "removed from consideration"
 * and never held a place to begin with. A place past the end of the point table
 * still counts — Rule 7-1-1 caps the team's best three *contestants*, not its
 * best three scorers.
 */
function takesAScoringPlace(
  r: SwimmerResult,
  eventRows: SwimmerResult[],
  settings: ScoringSettings
): boolean {
  if (!isScoringSwimResult(r)) return false;
  if (r.isExhibition) return false;
  if (r.isTimeTrial && !isChampionshipGenderEvent(r.event)) return false;
  if (!canScoreAthlete(r.roundSwam, r.event, settings)) return false;
  if ((parseRankInt(r.rank) ?? 0) < 1) return false;
  // A prelim dive by a diver who also dove in the final scores nothing there, so
  // it holds no place here either — same exclusion `scoreIndividualsInEvent` makes.
  if (classifyRoundTier(r.roundSwam) === 'PRE' && isDivingForSettings(r.event, settings)) {
    const team = String(r.team ?? 'Unknown').trim() || 'Unknown';
    if (athleteHasFinalsDiveInEvent(eventRows, r.name, team, settings)) return false;
  }
  return true;
}

/** Finish order within one event: round tier first (A before B before prelims), then place. */
function placeOrderCompare(a: SwimmerResult, b: SwimmerResult): number {
  const tw = roundTierSort(a.roundSwam) - roundTierSort(b.roundSwam);
  if (tw !== 0) return tw;
  const ra = parseRankInt(a.rank) ?? 9999;
  const rb = parseRankInt(b.rank) ?? 9999;
  if (ra !== rb) return ra - rb;
  const ta = convertTimeToSeconds(a.time);
  const tb = convertTimeToSeconds(b.time);
  if (ta !== tb) return ta - tb;
  return String(a.name).localeCompare(String(b.name));
}

/**
 * Row ids beyond their team's cap in this event, chosen in finish order.
 *
 * Counts distinct athletes, not rows: a diver with both a prelim and a final row
 * in one event is one contestant and spends one slot. Applied per event, which
 * is the only scope Rule 7 states — the caller passes one event's rows.
 */
function overCapRowIds(
  individuals: SwimmerResult[],
  settings: ScoringSettings,
  cap: number
): Set<string> {
  const contenders = individuals
    .filter(r => takesAScoringPlace(r, individuals, settings))
    .sort(placeOrderCompare);
  const admittedByTeam = new Map<string, Set<string>>();
  const over = new Set<string>();
  for (const r of contenders) {
    const team = String(r.team ?? 'Unknown').trim() || 'Unknown';
    let admitted = admittedByTeam.get(team);
    if (!admitted) {
      admitted = new Set<string>();
      admittedByTeam.set(team, admitted);
    }
    const key = normalizeSwimmerName(r.name);
    if (admitted.has(key)) continue;
    if (admitted.size < cap) {
      admitted.add(key);
      continue;
    }
    over.add(r.id);
  }
  return over;
}

/**
 * Advance every contestant behind a removed one, by rewriting the rank the
 * scorer reads places from.
 *
 * The shift never crosses a round: a consolation finisher must not be promoted
 * into a place the championship final contested (Rule 7-6-8). Within a round the
 * new place is the old one less the number of removed contestants who finished
 * strictly ahead — the standard competition-ranking compaction, so a removed
 * contestant's surviving tie-mate keeps the place and takes its full value
 * rather than splitting it with nobody.
 *
 * The rewritten rank is internal. `runIndividualScoringForEvent` restores each
 * row's source rank before returning, so nothing downstream sees a finish
 * position the meet did not record.
 */
function shiftRanksAfterRemoval(
  survivors: SwimmerResult[],
  removed: SwimmerResult[]
): SwimmerResult[] {
  const removedRanksByTier = new Map<string, number[]>();
  for (const r of removed) {
    const rank = parseRankInt(r.rank);
    if (rank == null) continue;
    const tier = classifyRoundTier(r.roundSwam);
    const list = removedRanksByTier.get(tier);
    if (list) list.push(rank);
    else removedRanksByTier.set(tier, [rank]);
  }
  if (removedRanksByTier.size === 0) return survivors;
  return survivors.map(r => {
    const rank = parseRankInt(r.rank);
    if (rank == null) return r;
    const removedRanks = removedRanksByTier.get(classifyRoundTier(r.roundSwam));
    if (!removedRanks?.length) return r;
    const ahead = removedRanks.reduce((n, x) => (x < rank ? n + 1 : n), 0);
    return ahead > 0 ? { ...r, rank: rank - ahead } : r;
  });
}

/**
 * Score one event's individual rows, applying the per-team place cap when the
 * preset declares one.
 *
 * With no cap this is exactly the previous dispatch between the two scorers, and
 * the cap branches are unreachable.
 */
export function runIndividualScoringForEvent(
  individuals: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  useMeetWidePool: boolean,
  rosterLookup?: ScorerRosterLookup
): SwimmerResult[] {
  const scoreFn = isTimedFinalDistanceSession(individuals)
    ? scoreTimedFinalIndividualsInEvent
    : scoreIndividualsInEvent;

  const capRule = resolveTeamPlaceCap(merged, individuals[0]?.event);
  if (!capRule) return scoreFn(individuals, merged, meetStates, useMeetWidePool, rosterLookup);

  const overCap = overCapRowIds(individuals, merged, capRule.max);
  if (overCap.size === 0) {
    return scoreFn(individuals, merged, meetStates, useMeetWidePool, rosterLookup);
  }

  if (capRule.behavior === 'holds-place') {
    // The over-cap contestant keeps the place they achieved, so they stay in the
    // field, stay in their tie group's denominator, and stay in the place ladder.
    // Only their points are struck; that place's value is lost from the meet, the
    // way Rule 7-7 loses a trailing place nobody was left to fill.
    return scoreFn(individuals, merged, meetStates, useMeetWidePool, rosterLookup).map(r =>
      overCap.has(r.id) ? { ...r, points: 0 } : r
    );
  }

  const removed = individuals.filter(r => overCap.has(r.id));
  const survivors = shiftRanksAfterRemoval(
    individuals.filter(r => !overCap.has(r.id)),
    removed
  );
  const sourceRankById = new Map(individuals.map(r => [r.id, r.rank] as const));
  const scored = scoreFn(survivors, merged, meetStates, useMeetWidePool, rosterLookup).map(r => {
    const sourceRank = sourceRankById.get(r.id);
    return sourceRank === undefined || sourceRank === r.rank ? r : { ...r, rank: sourceRank };
  });
  return [...scored, ...removed.map(r => ({ ...r, points: 0 }))];
}

/** One event's rows, grouped by round + finish rank (ties by exact time+name),
 *  in scoring order (round tier, then rank, then time). */
function buildIndividualEventGroups(
  individuals: SwimmerResult[]
): { indivGroups: Map<string, SwimmerResult[]>; indivSortedKeys: string[] } {
  const indivGroups = new Map<string, SwimmerResult[]>();
  for (const r of individuals) {
    const rk = parseRankInt(r.rank) ?? 0;
    const ev = String(r.event ?? '').trim();
    const key =
      rk > 0
        ? `${ev}|${(r.roundSwam || '').trim()}|${rk}`
        : `${ev}|${(r.roundSwam || '').trim()}|T|${convertTimeToSeconds(r.time)}|${r.name}`;
    if (!indivGroups.has(key)) indivGroups.set(key, []);
    indivGroups.get(key)!.push(r);
  }

  const indivSortedKeys = Array.from(indivGroups.keys()).sort((a, b) => {
    // Each key was created with a row pushed straight after, so a group is never empty.
    const ga = itemAt(indivGroups.get(a)!, 0);
    const gb = itemAt(indivGroups.get(b)!, 0);
    const tw = roundTierSort(ga.roundSwam) - roundTierSort(gb.roundSwam);
    if (tw !== 0) return tw;
    const ra = parseRankInt(ga.rank) ?? 9999;
    const rb = parseRankInt(gb.rank) ?? 9999;
    if (ra !== rb) return ra - rb;
    return convertTimeToSeconds(ga.time) - convertTimeToSeconds(gb.time);
  });

  return { indivGroups, indivSortedKeys };
}

/**
 * Individual event group: rows that never earn place points are zeroed and
 * pushed into `indivOut`. Ineligible rows (a non-finish result) are zeroed
 * per-row. An exhibition row is zeroed per-row too: it takes no place, so it
 * leaves the tie count (user decision E2). The scoring rows earn what they
 * would with every exhibition entry absent: their tie share counts only the
 * scoring entries here, and the places behind an exhibition entry are moved up
 * first (`rankAsIfExhibitionAbsent`), the way the timed-final scorer's ladder
 * and `relayEntryPlaceIndex` already do. If any remaining row is a
 * non-championship time trial, or the round/event is unscored, the whole
 * remaining group is zeroed together.
 *
 * Returns `null` once the group is fully accounted for; otherwise the rows
 * still in play.
 */
function eligibleIndividualGroupOrNull(
  group: SwimmerResult[],
  merged: ScoringSettings,
  indivOut: SwimmerResult[]
): SwimmerResult[] | null {
  const ineligible = group.filter(r => !isScoringSwimResult(r));
  const scoringSwims = group.filter(r => isScoringSwimResult(r));
  ineligible.forEach(r => indivOut.push({ ...r, points: 0 }));
  // An exhibition swim holds no place, so it neither scores nor counts in the tie.
  const exhibition = scoringSwims.filter(r => r.isExhibition);
  exhibition.forEach(r => indivOut.push({ ...r, points: 0 }));
  const eligible = scoringSwims.filter(r => !r.isExhibition);
  if (eligible.length === 0) return null;

  const sample = itemAt(eligible, 0);
  const tt = eligible.some(r => r.isTimeTrial) && !isChampionshipGenderEvent(sample.event);

  if (tt || !canScoreAthlete(sample.roundSwam, sample.event, merged)) {
    eligible.forEach(r => indivOut.push({ ...r, points: 0 }));
    return null;
  }
  return eligible;
}

/**
 * Individual event group: the ladder share each eligible row earns, and
 * whether the group is a prelims diving round (for the finals-dive block in
 * {@link awardIndividualEventTeamGroup}). `null` when the rank/table lookup
 * fails — the rows are already zeroed into `indivOut` by then.
 */
function resolveIndividualGroupLadderShare(
  eligible: SwimmerResult[],
  merged: ScoringSettings,
  indivOut: SwimmerResult[]
): { each: number; isPrelimDiving: boolean } | null {
  // The only caller passes the non-empty result of `eligibleIndividualGroupOrNull`.
  const sample = itemAt(eligible, 0);
  const rk = parseRankInt(sample.rank);
  const isPrelimDiving =
    classifyRoundTier(sample.roundSwam) === 'PRE' && isDivingForSettings(sample.event, merged);
  const baseIdx = rk != null ? scoringRowIndex(sample.roundSwam, rk, sample.event, merged) : null;
  if (baseIdx == null) {
    eligible.forEach(r => indivOut.push({ ...r, points: 0 }));
    return null;
  }

  // The one tie rule, shared with the timed-final scorer and with relays.
  const each = tiedPlaceShare(individualPlaceTable(sample.event, merged), baseIdx, eligible.length);
  if (each == null) {
    eligible.forEach(r => indivOut.push({ ...r, points: 0 }));
    return null;
  }
  return { each, isPrelimDiving };
}

/**
 * Individual event group, one team: roster eligibility, the prelim-dive
 * block, and whichever cap rule is active, pushing every row into `indivOut`.
 * Mutates `teamIndivScorers` (the per-event cap's running count) exactly as
 * the caller's loop did inline.
 */
function awardIndividualEventTeamGroup(
  team: string,
  allMembers: SwimmerResult[],
  each: number,
  isPrelimDiving: boolean,
  individuals: SwimmerResult[],
  sampleEvent: string,
  cap: number,
  useMeetWidePool: boolean,
  teamIndivScorers: Record<string, number>,
  meetStates: Map<string, TeamMeetState>,
  merged: ScoringSettings,
  rosterLookup: ScorerRosterLookup | undefined,
  indivOut: SwimmerResult[]
): void {
  // `allMembers` is a `byTeam` bucket: created with a row pushed straight after.
  const firstMember = itemAt(allMembers, 0);
  const meetState = getOrCreateMeetState(meetStates, team, firstMember.gender);
  const gender = firstMember.gender;

  // Roster eligibility is a per-ATHLETE decision, so it is applied per
  // athlete. It used to be `uniqueNames.every(...)`, which zeroed the whole
  // team group the moment one member was off the scoring roster.
  //
  // That is invisible in PDF-shaped data — a team almost never holds two
  // swimmers on one placement, so the group is a single athlete and `every`
  // reduces to the same test. It was catastrophic when ranks collapsed:
  // `prepareRecruitsForScoring` had no comparators on a roster-only
  // workspace, so every recruit row came back rank 1 and an entire event
  // became ONE tie group. Turning 14 of 32 athletes off then zeroed every
  // event any of them entered — 12 of 14 events measured, zero exceptions,
  // and a 1277-point projection went to 0. See plans/2026-08-14/12.
  //
  // That collapse is fixed (2026-09-02): recruit rows are placed against
  // each other, so a group holds equal times only. This per-athlete filter
  // stays — it is correct on its own terms, and a real dead heat can still
  // straddle the scoring roster. See scripts/test_recruit_placement_grid.mjs.
  let members = allMembers;
  if (rosterLookup && usesScorerRoster(merged)) {
    members = [];
    for (const r of allMembers) {
      if (rosterLookup.isScorer(r.name, team, gender)) members.push(r);
      else indivOut.push({ ...r, points: 0 });
    }
    if (members.length === 0) return;
  }

  const prelimDiveBlocked = (r: SwimmerResult) =>
    isPrelimDiving && athleteHasFinalsDiveInEvent(individuals, r.name, team, merged);

  // A prelims dive by someone with a finals dive in the same event scores
  // nothing, so it must not consume a scorer slot either — such rows are
  // held out of admission exactly as the previous `.filter(...)` did.
  // `prelimDiveBlocked` depends only on name/team/event, so it is constant
  // per name within a group and this cannot split one athlete's rows.
  const poolCandidates = members.filter(r => !prelimDiveBlocked(r));

  // Cap admission is per athlete and accumulates — see admitTieGroupToMeetPool.
  if (useMeetWidePool) {
    const admitted = admitTieGroupToMeetPool(meetState.poolWeights, poolCandidates, sampleEvent, merged);
    for (const r of members) {
      indivOut.push({ ...r, points: admitted.has(r.name) && !prelimDiveBlocked(r) ? each : 0 });
    }
  } else if (cap < 999) {
    const used = teamIndivScorers[team] || 0;
    const allowed = admitTieGroupToEventCap(poolCandidates, used, cap);
    for (const r of members) {
      indivOut.push({ ...r, points: allowed.has(r.name) && !prelimDiveBlocked(r) ? each : 0 });
    }
    teamIndivScorers[team] = used + allowed.size;
  } else {
    members.forEach(r => indivOut.push({ ...r, points: prelimDiveBlocked(r) ? 0 : each }));
  }
}

/**
 * The rows with their rank rewritten as if every exhibition entry were absent
 * (user decision E2, 2026-10-18). In each round tier that holds an exhibition
 * entry with a rank, every other ranked row moves up by the exhibition entries
 * ranked strictly ahead of it, the same subtraction `shiftRanksAfterRemoval`
 * makes. The result is floored at 1 plus the number of other ranked rows
 * strictly ahead, so a tie keeps its rank, and the entry after a tie of n
 * still skips n places.
 *
 * A gap in the printed ranks is the meet's data and survives. A row that sits
 * past the gap, such as an unprojected recruit at A-Final rank 12 behind eight
 * finishers, moves up by the exhibition entries only (12 to 11), never down to
 * the dense rank (9).
 *
 * A disqualified or time-trial row holds its printed place and counts as
 * ahead. This differs from the timed-final ladder, which skips such rows.
 * Only the exhibition entries leave.
 *
 * A tier with no ranked exhibition entry is returned as it came. The rewritten
 * rank is internal; `scoreIndividualsInEvent` restores each row's source rank
 * before returning.
 */
function rankAsIfExhibitionAbsent(individuals: SwimmerResult[]): SwimmerResult[] {
  const exhibitionTiers = new Set<string>();
  for (const r of individuals) {
    if (isScoringSwimResult(r) && r.isExhibition && (parseRankInt(r.rank) ?? 0) >= 1) {
      exhibitionTiers.add(classifyRoundTier(r.roundSwam));
    }
  }
  if (exhibitionTiers.size === 0) return individuals;

  const isExhibitionEntry = (r: SwimmerResult): boolean =>
    isScoringSwimResult(r) && r.isExhibition === true;
  const inTier = (r: SwimmerResult): boolean =>
    (parseRankInt(r.rank) ?? 0) >= 1 && exhibitionTiers.has(classifyRoundTier(r.roundSwam));
  const exhibition = individuals.filter(r => inTier(r) && isExhibitionEntry(r));
  const present = individuals.filter(r => inTier(r) && !isExhibitionEntry(r));
  return individuals.map(r => {
    if (!inTier(r) || isExhibitionEntry(r)) return r;
    const rank = parseRankInt(r.rank) as number;
    const tier = classifyRoundTier(r.roundSwam);
    const countAhead = (rows: SwimmerResult[]): number =>
      rows.filter(h => classifyRoundTier(h.roundSwam) === tier && (parseRankInt(h.rank) as number) < rank)
        .length;
    const next = Math.max(rank - countAhead(exhibition), 1 + countAhead(present), 1);
    return next === rank ? r : { ...r, rank: next };
  });
}

function scoreIndividualsInEvent(
  individuals: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  useMeetWidePool: boolean,
  rosterLookup?: ScorerRosterLookup
): SwimmerResult[] {
  const field = rankAsIfExhibitionAbsent(individuals);
  const { indivGroups, indivSortedKeys } = buildIndividualEventGroups(field);

  const cap = merged.maxIndividualScorersPerTeam ?? 999;
  const teamIndivScorers: Record<string, number> = {};
  const indivOut: SwimmerResult[] = [];

  for (const key of indivSortedKeys) {
    const group = indivGroups.get(key)!;
    const eligible = eligibleIndividualGroupOrNull(group, merged, indivOut);
    if (!eligible) continue;

    const share = resolveIndividualGroupLadderShare(eligible, merged, indivOut);
    if (!share) continue;

    const byTeam = new Map<string, SwimmerResult[]>();
    for (const r of eligible) {
      const t = String(r.team ?? 'Unknown').trim() || 'Unknown';
      if (!byTeam.has(t)) byTeam.set(t, []);
      byTeam.get(t)!.push(r);
    }

    for (const [team, allMembers] of byTeam) {
      awardIndividualEventTeamGroup(
        team,
        allMembers,
        share.each,
        share.isPrelimDiving,
        field,
        // `eligible` is non-empty: `eligibleIndividualGroupOrNull` returned it.
        itemAt(eligible, 0).event,
        cap,
        useMeetWidePool,
        teamIndivScorers,
        meetStates,
        merged,
        rosterLookup,
        indivOut
      );
    }
  }

  if (field === individuals) return indivOut;
  const sourceRankById = new Map(individuals.map(r => [r.id, r.rank] as const));
  return indivOut.map(r => {
    const sourceRank = sourceRankById.get(r.id);
    return sourceRank === undefined || sourceRank === r.rank ? r : { ...r, rank: sourceRank };
  });
}
