/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Roster simulation for relays: leg resolution, split details and `simulateRoster`.
// Split out of `utils.ts`, which still re-exports every name from here.

import { Gender, SwimmerResult, RelayMissingLeg, RelayLegOverride } from '../types';
// Dependency-free by design — see the module header there. Importing
// `cutlineUtils` here instead would create a cycle (it imports this file).
import { normalizeEventForCutline } from './cutlineEventNames';
import { itemAt } from './indexedAccess';
import { isTheoreticalRelayLegRowId } from './theoreticalMeetLabel';
import {
  buildSyntheticLegSplitDetail,
  normalizeRelayLegSplitDetail,
  rebuildTeamSplitSummary,
  relayLegDistanceYardsOfEvent,
  relayLegEstimateOf,
} from './relaySplits';
import {
  findRelayLegOverride,
  isRelayLegEvent,
  isTimeTrialOnlyForRelayLeg,
  migrateTiedRelayOverrides,
  overrideNamesTimeTrialOnlySwimmer,
  relayEntryGender,
  relayLegRequirements,
  relayStrokeForBoundedIndex,
  resolveOverrideAssignee,
  swimmerMatchesRelayLeg,
  type RelayLegMatchSettings,
} from './relayLegMatching';
import { convertTimeToSeconds, formatSecondsToTime } from './timeFormat';
import { normalizeSwimmerName, canonicalSwimmerName, isGraduatingClassYear } from './swimmerNames';
import { isTimeTrialSwim, parseRankInt } from './scoringRules';
import { relayLegsAllowTimeTrials } from './scoringDefaults';
import { relayTeamClock, relayEntryLegSignature } from './relayScoring';

/**
 * One key per team relay entry for the roster simulation. The named swimmers are
 * in the key for the reason they are in {@link relayEntryGroupKey}: one team's A
 * and B relays on a dead heat share team, event, round, place and clock, and
 * without the swimmers they merge into one eight-leg group, whose legs the
 * simulation then writes back over four. A row that names no swimmers keeps the
 * previous key.
 */
function relayGroupKey(r: SwimmerResult): string {
  const clock = relayTeamClock(r) || r.time;
  const t = convertTimeToSeconds(clock);
  const rk = parseRankInt(r.rank) ?? '';
  const rs = (r.roundSwam || '').trim();
  const base = `${(r.team || '').trim()}|${r.event}|${rs}|${rk}|${t}`;
  const legs = relayEntryLegSignature(r);
  return legs ? `${base}|${legs}` : base;
}

/**
 * The departed leg holder's own individual swim at the leg's distance and
 * stroke, or `undefined` when they have none.
 *
 * `simulateRoster` measures a substitute against this swim's time when it
 * exists, and against the leg's recorded split otherwise. The relay-leg swap's
 * clock hold (`resolveClockHoldTime` in `arbitrage/relayLegSwaps.ts`) must pick
 * the same time, or the held clock moves. Both call this function so the two
 * cannot drift apart again.
 *
 * The event must be the leg event exactly (`isRelayLegEvent`): a departed
 * swimmer's 1000 Free is not their 100 Free. The swim must be the relay team's
 * own (`team`, compared trimmed): a namesake on another team is a different
 * swimmer, and before R1 (plans/2026-09-24) the first one in `results` order
 * won. Names compare by `canonicalSwimmerName`. Rows are searched in `results`
 * order and the first match wins.
 *
 * A time-trial swim (`isTimeTrialSwim`) is not the baseline unless
 * `settings.relayLegsAllowTimeTrials` is on (user decision D9). It is left out
 * before the search, so the swimmer's next matching swim stands in, and a
 * swimmer whose only swim at the leg is a time trial has none: the caller then
 * measures against the leg's recorded split. A leg with neither a swim nor a
 * recorded split has no baseline at all, and the callers leave it unpriced:
 * `simulateRoster` writes the team time `NT`, and the swap ranking skips the
 * leg. `settings.scoredEventNumberMax`
 * is the meet's scored-event boundary, as in `isTimeTrialSwim`. Omitted, the
 * setting is off and no boundary applies. Both callers pass the same settings
 * (`simulateRoster`'s `relayLegSettings`, and `relayLegMatchSettings` of the
 * workspace in the swap ranking), so the held clock and the subtracted time
 * stay one time.
 */
export function findDepartedLegSwim(
  results: SwimmerResult[],
  legName: string,
  relayEvent: string,
  legIndex: number,
  team: string,
  settings?: RelayLegMatchSettings
): SwimmerResult | undefined {
  const { legDistanceYards, stroke } = relayLegRequirements(relayEvent, legIndex);
  // A leg index with no stroke matches no event.
  if (stroke === undefined) return undefined;
  const nameKey = canonicalSwimmerName(legName);
  const teamKey = String(team ?? '').trim();
  const allowTimeTrials = relayLegsAllowTimeTrials(settings);
  return results.find(
    s =>
      !s.isRelay &&
      String(s.team ?? '').trim() === teamKey &&
      canonicalSwimmerName(s.name) === nameKey &&
      isRelayLegEvent(s.event, legDistanceYards, stroke) &&
      (allowTimeTrials || !isTimeTrialSwim(s, settings?.scoredEventNumberMax))
  );
}

/**
 * The time an override holds for a leg when it names no swimmer, or undefined.
 *
 * A clock hold is a time typed with NO swimmer named. An override that names
 * one (`assigneeName` or `recruitId`) is a fill, and a fill whose swimmer
 * stopped resolving is vacant, not held: a relay swap stores the swimmer's name
 * AND a clock-hold time, so reading that time for an unresolved name showed a
 * filled `—` leg that no audit flagged.
 */
function clockHoldTime(override: RelayLegOverride): string | undefined {
  if (override.assigneeName?.trim() || override.recruitId) return undefined;
  return override.manualLegTime?.trim() || undefined;
}

/** One relay leg's canonical name/class-year, as `relayNames` (or a fallback
 *  built from the ordered rows) records it. */
type RelayLegCanonical = { name: string; year: string };

type ResolvedRelayLegs = {
  outLegs: RelayLegCanonical[];
  newTimeSecs: number;
  modified: boolean;
  legReplacements: Map<number, SwimmerResult>;
  legMissingByIndex: Map<number, RelayMissingLeg>;
  legVacantByIndex: Map<number, boolean>;
  /** Legs filled from a time-trial swim (only possible when the setting allows it). */
  legTimeTrialByIndex: Set<number>;
};

/**
 * Why a leg is vacant when its named swim is not the leg's event. A swim that is
 * the leg's event but a time trial (setting off) is not a wrong stroke: say so,
 * so the coach can opt in rather than hunt for a mismatch.
 */
function failedLegCheckReason(
  assignee: SwimmerResult,
  event: string,
  legIndex: number,
  settings?: RelayLegMatchSettings
): RelayMissingLeg['reason'] {
  return isTimeTrialOnlyForRelayLeg(assignee, event, legIndex, settings)
    ? 'time_trial_only'
    : 'stroke_mismatch';
}

/**
 * Why a leg is vacant when its override resolves onto no swim. The named
 * swimmer's only swim at the leg event may be a time trial (setting off): the
 * same reason the recruit-id path reports ({@link failedLegCheckReason}).
 */
function unresolvedOverrideReason(
  override: RelayLegOverride,
  legPool: SwimmerResult[],
  template: SwimmerResult,
  legIndex: number,
  relayGender: Gender | undefined,
  settings?: RelayLegMatchSettings
): RelayMissingLeg['reason'] {
  return overrideNamesTimeTrialOnlySwimmer(
    override,
    legPool,
    template.team,
    template.event,
    legIndex,
    relayGender,
    settings
  )
    ? 'time_trial_only'
    : 'vacant';
}

/**
 * The leg clock a departed leg is taken off at, in seconds: the row's measured split, else (a theoretical
 * meet's leg row, where nobody swam the relay) the leg's estimate, else `null`. A measured split always wins.
 * A theoretical relay's team time is the sum of the estimates, so subtracting the estimate keeps it exact.
 */
function departedLegClockSec(legRow: SwimmerResult | undefined): number | null {
  if (legRow === undefined) return null;
  if (legRow.relayLegSplit && legRow.relayLegSplit !== 'NT') return convertTimeToSeconds(legRow.relayLegSplit);
  return relayLegEstimateOf(legRow)?.time ?? null;
}

/**
 * Resolve every leg of one relay group: a leg whose holder stays untouched
 * keeps their spot; a leg whose holder departs (dropped, excluded, or a
 * non-scorer vacate) is filled by its override's assignee, or by its manual time
 * when the override names no swimmer (a clock hold), or left vacant with a
 * 3-second penalty and a reason the lineup audit can name. An override that
 * names a swimmer who no longer resolves is vacant, never a clock hold.
 *
 * `legPool` is the swims an override may resolve onto — `simulateRoster`'s
 * caller mixes in the history leg-only pool there. `findDepartedLegSwim`'s
 * clock-hold time is shared with the relay-leg swap ranking
 * (`arbitrage/relayLegSwaps.ts`'s `resolveClockHoldTime`) so the two cannot
 * drift apart; see that function's own doc comment.
 */
function resolveRelayLegs(
  legsCanonical: RelayLegCanonical[],
  ordered: SwimmerResult[],
  template: SwimmerResult,
  evLower: string,
  results: SwimmerResult[],
  legPool: SwimmerResult[],
  overrideList: RelayLegOverride[],
  removeSeniors: boolean,
  excluded: Set<string>,
  vacateLegs: Set<string>,
  relayLegSettings?: RelayLegMatchSettings
): ResolvedRelayLegs {
  const outLegs = legsCanonical.map(l => ({ ...l }));
  const legTimeTrialByIndex = new Set<number>();
  let newTimeSecs = convertTimeToSeconds(template.time);
  let modified = false;
  const legReplacements = new Map<number, SwimmerResult>();
  const legMissingByIndex = new Map<number, RelayMissingLeg>();
  const legVacantByIndex = new Map<number, boolean>();
  const relayGender = relayEntryGender(template);
  const assignedInRelay = new Set<string>();

  const applyLegTimeDelta = (
    index: number,
    newLegTimeSec: number,
    oldSplitSec: number | null,
    departedIndiv: SwimmerResult | undefined
  ) => {
    // The time the leg is measured against: the departed swimmer's own swim, else the leg's recorded split.
    // With neither, the leg has no baseline and the replacement cannot be priced. The team time is then
    // unknown: `Infinity`, which `formatSecondsToTime` writes as `NT`. It is never "no change", which
    // priced the replacement as exactly as fast as the swimmer who left.
    const departedSec = departedIndiv ? convertTimeToSeconds(departedIndiv.time) : Number.NaN;
    const baselineSec = Number.isFinite(departedSec)
      ? departedSec
      : oldSplitSec != null && Number.isFinite(oldSplitSec)
        ? oldSplitSec
        : null;
    if (baselineSec === null) {
      newTimeSecs = Number.POSITIVE_INFINITY;
      // The leg is filled, so it is not vacant. Name why the time is NT.
      legMissingByIndex.set(index, {
        legIndex: index,
        stroke: relayStrokeForBoundedIndex(evLower, index),
        reason: 'no_baseline',
      });
      return;
    }
    newTimeSecs += newLegTimeSec - baselineSec;
  };

  const legNeedsReplace = (leg: RelayLegCanonical): boolean =>
    (removeSeniors && isGraduatingClassYear(leg.year)) ||
    excluded.has(canonicalSwimmerName(leg.name)) ||
    vacateLegs.has(normalizeSwimmerName(leg.name));

  // Every leg holder who stays is on the relay before any override is
  // resolved. Collected while walking the legs, a holder of a LATER leg was
  // not yet known when an earlier leg's override named them, so one swimmer
  // could swim two legs (real case: HSU 200 Free Relay A with Gavin Kock
  // removed and Oliver Pozvai, its anchor, named for leg 1).
  for (const leg of outLegs) {
    if (legNeedsReplace(leg)) continue;
    const nm = leg.name?.trim();
    if (nm && nm !== '—' && nm !== 'Unknown') assignedInRelay.add(normalizeSwimmerName(nm));
  }

  for (let index = 0; index < outLegs.length; index++) {
    // `index < outLegs.length` is the loop bound.
    const leg = itemAt(outLegs, index);
    if (!legNeedsReplace(leg)) continue;
    const isNonScorerLeg = vacateLegs.has(normalizeSwimmerName(leg.name));

    const legRowForSplit =
      ordered.find(row => (row.relayLegIndex ?? -1) === index) ?? ordered[index];
    const oldSplitSec = departedLegClockSec(legRowForSplit);

    const departedIndiv = findDepartedLegSwim(
      results,
      leg.name,
      template.event,
      index,
      template.team,
      relayLegSettings
    );

    // `index` is the loop counter, so it always has a stroke.
    const stroke = relayStrokeForBoundedIndex(evLower, index);
    const override = findRelayLegOverride(overrideList, template, index, results);
    const departedNameKey = normalizeSwimmerName(leg.name);

    const markVacant = (reason: RelayMissingLeg['reason']) => {
      modified = true;
      newTimeSecs += 3.0;
      outLegs[index] = { name: '—', year: '' };
      legVacantByIndex.set(index, true);
      legMissingByIndex.set(index, { legIndex: index, stroke, reason });
      legReplacements.set(index, {
        ...template,
        id: `vacant-${index}`,
        name: '—',
        classYear: '',
        time: formatSecondsToTime((oldSplitSec ?? 30) + 3),
        isRelay: false,
      });
    };

    if (!override) {
      markVacant(isNonScorerLeg ? 'no_replacement' : 'vacant');
      continue;
    }

    const assignee = resolveOverrideAssignee(
      override,
      legPool,
      template.team,
      template.event,
      index,
      relayGender,
      relayLegSettings
    );
    const manualTime = override.manualLegTime?.trim();

    if (assignee) {
      if (normalizeSwimmerName(assignee.name) === departedNameKey) {
        markVacant('vacant');
        continue;
      }
      if (!swimmerMatchesRelayLeg(assignee, template.event, index, relayLegSettings)) {
        markVacant(failedLegCheckReason(assignee, template.event, index, relayLegSettings));
        continue;
      }
      const assigneeKey = normalizeSwimmerName(assignee.name);
      if (assignedInRelay.has(assigneeKey)) {
        markVacant('stroke_mismatch');
        continue;
      }

      modified = true;
      legReplacements.set(index, assignee);
      if (assignee.relayLegTimeTrial === true) legTimeTrialByIndex.add(index);
      assignedInRelay.add(assigneeKey);
      const legTimeSec = convertTimeToSeconds(manualTime || assignee.time);
      applyLegTimeDelta(index, legTimeSec, oldSplitSec, departedIndiv);
      outLegs[index] = {
        name: assignee.name,
        year: String(override.classYear ?? assignee.classYear),
      };
      continue;
    }

    const holdTime = clockHoldTime(override);
    if (holdTime) {
      modified = true;
      const legTimeSec = convertTimeToSeconds(holdTime);
      applyLegTimeDelta(index, legTimeSec, oldSplitSec, departedIndiv);
      outLegs[index] = { name: '—', year: '' };
      legReplacements.set(index, {
        ...template,
        id: `manual-${index}`,
        name: '—',
        classYear: '',
        time: holdTime,
        isRelay: false,
      });
      continue;
    }

    markVacant(
      unresolvedOverrideReason(override, legPool, template, index, relayGender, relayLegSettings)
    );
  }

  return {
    outLegs,
    newTimeSecs,
    modified,
    legReplacements,
    legMissingByIndex,
    legVacantByIndex,
    legTimeTrialByIndex,
  };
}

type RelayLegSplitDetails = {
  legTotals: (string | null)[];
  legDetailsByIndex: Map<number, SwimmerResult['relayLegSplitDetail']>;
  /** Replaced legs of a relay with no readable distance: time, no detail. */
  undetailedLegTimes: Map<number, string>;
};

/**
 * Build each leg's split total from the resolved legs: a replaced leg with no
 * readable distance carries its time only; a replaced leg with a readable
 * distance gets a synthesized split detail; an unreplaced leg keeps its
 * recorded split (normalized) exactly.
 */
function buildRelayLegSplitDetails(
  outLegs: RelayLegCanonical[],
  ordered: SwimmerResult[],
  evLower: string,
  legReplacements: Map<number, SwimmerResult>,
  legDistYards: number | null
): RelayLegSplitDetails {
  const legTotals: (string | null)[] = [];
  const legDetailsByIndex = new Map<number, SwimmerResult['relayLegSplitDetail']>();
  const undetailedLegTimes = new Map<number, string>();

  for (let index = 0; index < outLegs.length; index++) {
    const legRowForSplit =
      ordered.find(row => (row.relayLegIndex ?? -1) === index) ?? ordered[index];
    // `index` is the loop counter, so it always has a stroke.
    const stroke = legRowForSplit?.relayLegStroke ?? relayStrokeForBoundedIndex(evLower, index);

    if (legReplacements.has(index) && legDistYards == null) {
      // No leg distance to build a split detail on: carry the leg time only.
      const legTime = legReplacements.get(index)!.time;
      undetailedLegTimes.set(index, legTime);
      legTotals.push(legTime);
    } else if (legReplacements.has(index) && legDistYards != null) {
      const replacement = legReplacements.get(index)!;
      const prior = normalizeRelayLegSplitDetail(legRowForSplit?.relayLegSplitDetail);
      const detail = buildSyntheticLegSplitDetail(
        index,
        stroke,
        legDistYards,
        replacement.time,
        prior?.segments
      );
      legDetailsByIndex.set(index, detail);
      legTotals.push(detail.legTotal ?? replacement.time);
    } else if (legRowForSplit?.relayLegSplitDetail) {
      const normalizedDetail = normalizeRelayLegSplitDetail(legRowForSplit.relayLegSplitDetail);
      if (normalizedDetail) legDetailsByIndex.set(index, normalizedDetail);
      legTotals.push(
        normalizedDetail?.legTotal ?? legRowForSplit.relayLegSplit ?? null
      );
    } else {
      legTotals.push(legRowForSplit?.relayLegSplit ?? null);
    }
  }

  return { legTotals, legDetailsByIndex, undetailedLegTimes };
}

/**
 * Compute the team split summary and push this relay group's final rows —
 * rewritten if any leg changed, unchanged (as `ordered`) otherwise.
 */
function emitRelayGroupRows(
  ordered: SwimmerResult[],
  resolved: ResolvedRelayLegs,
  legTotals: (string | null)[],
  legDetailsByIndex: Map<number, SwimmerResult['relayLegSplitDetail']>,
  undetailedLegTimes: Map<number, string>,
  finalResults: SwimmerResult[]
): void {
  const { outLegs, modified, legMissingByIndex, legVacantByIndex, legTimeTrialByIndex } = resolved;
  const newTeamStr = formatSecondsToTime(resolved.newTimeSecs);

  // A theoretical meet's relay has no splits (nobody swam it), so it has no team split summary. Its leg
  // totals could only be estimates, or a vacancy placeholder, shown with no label.
  const teamSplits = ordered.some(r => isTheoreticalRelayLegRowId(r.id))
    ? undefined
    : modified || ordered.some(r => r.relayTeamSplits)
      ? rebuildTeamSplitSummary(legTotals, newTeamStr)
      : ordered[0]?.relayTeamSplits;

  if (!modified) {
    ordered.forEach(row => finalResults.push(row));
    return;
  }

  ordered.forEach(row => {
    const idx =
      row.relayLegIndex != null
        ? Math.min(Math.max(0, row.relayLegIndex), outLegs.length - 1)
        : Math.min(Math.max(0, ordered.indexOf(row)), outLegs.length - 1);
    // `outLegs` is never empty here (the caller returns early on no canonical legs)
    // and `idx` is clamped into `[0, outLegs.length - 1]`.
    const legMeta = itemAt(outLegs, idx);
    const legDetail = legDetailsByIndex.get(idx);
    // A replaced leg holds another swimmer's time: the departed swimmer's estimate must not stay on the row.
    const { relayLegEstimate: departedEstimate, ...rowWithoutEstimate } = row;
    const keptEstimate = resolved.legReplacements.has(idx) ? undefined : departedEstimate;
    finalResults.push({
      ...rowWithoutEstimate,
      ...(keptEstimate === undefined ? {} : { relayLegEstimate: keptEstimate }),
      name: legMeta.name,
      classYear: legMeta.year,
      time: newTeamStr,
      finalsTime: newTeamStr,
      relayNames: outLegs,
      relayTeamTime: newTeamStr,
      relayLegSplit: undetailedLegTimes.get(idx) ?? legDetail?.legTotal ?? row.relayLegSplit,
      relayLegSplitDetail: legDetail,
      relayTeamSplits: teamSplits,
      relayMissingLeg: legMissingByIndex.get(idx),
      relayLegVacant: legVacantByIndex.get(idx) ?? false,
      // The leg was filled from a time-trial swim (opt-in): label it.
      ...(legTimeTrialByIndex.has(idx) ? { relayLegTimeTrial: true as const } : {}),
    });
  });
}

/**
 * One relay group from `simulateRoster`'s per-row dispatch: find its original
 * rows (by `key`, computed from the ORIGINAL, unmodified rows — see BUG 2 in
 * {@link reAddUnprocessedRelayGroups}), resolve every leg, rebuild the leg
 * splits, and push the resulting rows into `finalResults`. A relay with no
 * canonical legs to compare against (`legsCanonical` empty) is pushed
 * unchanged.
 */
function processRelayGroupForRosterSim(
  key: string,
  results: SwimmerResult[],
  legPool: SwimmerResult[],
  overrideList: RelayLegOverride[],
  removeSeniors: boolean,
  excluded: Set<string>,
  vacateLegs: Set<string>,
  finalResults: SwimmerResult[],
  relayLegSettings?: RelayLegMatchSettings
): void {
  const group = results.filter(x => x.isRelay && relayGroupKey(x) === key);
  if (group.length === 0) return;

  // `group.length === 0` returned above.
  const template = itemAt(group, 0);
  const evLower = template.event.toLowerCase();
  const ordered = [...group].sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));

  const legsCanonical: RelayLegCanonical[] =
    template.relayNames && template.relayNames.length > 0
      ? template.relayNames.map(n => ({ name: n.name, year: n.year }))
      : ordered.map(row => ({ name: row.name, year: String(row.classYear) }));

  if (legsCanonical.length === 0) {
    ordered.forEach(row => finalResults.push(row));
    return;
  }

  const resolved = resolveRelayLegs(
    legsCanonical,
    ordered,
    template,
    evLower,
    results,
    legPool,
    overrideList,
    removeSeniors,
    excluded,
    vacateLegs,
    relayLegSettings
  );

  // Null when the relay's label names no distance. No swim then matches a
  // leg (`isRelayLegEvent`), so a departing leg holder leaves the leg vacant;
  // the lineup audit names the label (`relay_distance_unreadable`).
  const legDistYards = relayLegDistanceYardsOfEvent(template.event);
  const { legTotals, legDetailsByIndex, undetailedLegTimes } = buildRelayLegSplitDetails(
    resolved.outLegs,
    ordered,
    evLower,
    resolved.legReplacements,
    legDistYards
  );

  emitRelayGroupRows(ordered, resolved, legTotals, legDetailsByIndex, undetailedLegTimes, finalResults);
}

/**
 * Safety: re-add only relay groups the main loop never processed. Compare against
 * the ORIGINAL-row keys in `processedRelayKeys` — a modified relay carries a changed
 * team clock, so recomputing keys from the emitted (modified) rows would never match
 * the original group and would re-add the pre-modification legs (including a removed
 * swimmer's leg under their original name, double-counting the relay). See BUG 2.
 */
function reAddUnprocessedRelayGroups(
  results: SwimmerResult[],
  processedRelayKeys: Set<string>,
  finalResults: SwimmerResult[]
): void {
  for (const r of results) {
    if (!r.isRelay) continue;
    const k = relayGroupKey(r);
    if (processedRelayKeys.has(k)) continue;
    const group = results.filter(x => x.isRelay && relayGroupKey(x) === k);
    group.forEach(row => finalResults.push(row));
    processedRelayKeys.add(k);
  }
}

/**
 * Apply the roster what-if to a gender's results: drop removed and (with
 * `removeSeniors`) graduating swimmers, and rebuild each relay whose legs they
 * held from `relayLegOverrides`.
 *
 * `relayLegOnlyPool` holds swims that may fill a relay leg named by an
 * override but are never an individual entry: the history candidates
 * `relayLegHistoryCandidates` builds (R1, plans/2026-09-24). They are searched
 * with the results and recruits when an override is resolved, and never
 * emitted.
 *
 * `relayLegSettings` carries `relayLegsAllowTimeTrials` (pass the workspace's
 * `scoringSettings`). Omitted, or without the field, no time-trial swim fills
 * a leg (user decision D9). When it is on, a leg filled from a time trial is
 * emitted with `relayLegTimeTrial: true` on that leg's relay row.
 */
export function simulateRoster(
  results: SwimmerResult[],
  recruits: SwimmerResult[],
  removeSeniors: boolean,
  excludedSwimmerNames?: Set<string>,
  relayLegOverrides: RelayLegOverride[] = [],
  vacateRelayLegNames: Set<string> = new Set(),
  relayLegOnlyPool: SwimmerResult[] = [],
  relayLegSettings?: RelayLegMatchSettings
): SwimmerResult[] {
  const excluded = excludedSwimmerNames ?? new Set<string>();
  // A key saved for a tied pair of relays (before the two were told apart) is
  // split into one override per relay; every reader below reads the split list.
  const overrideList = migrateTiedRelayOverrides(relayLegOverrides ?? [], results);
  const vacateLegs = vacateRelayLegNames ?? new Set<string>();
  const runRosterSim =
    removeSeniors || excluded.size > 0 || overrideList.length > 0 || vacateLegs.size > 0;
  if (!runRosterSim) {
    return [...results, ...recruits];
  }

  const staysOnRoster = (r: SwimmerResult): boolean => {
    if (excluded.has(canonicalSwimmerName(r.name))) return false;
    if (removeSeniors && isGraduatingClassYear(r.classYear)) return false;
    return true;
  };
  const basePool = results.filter(r => r.isRelay || staysOnRoster(r));

  const activeSwimmers = [...basePool, ...recruits];
  // The swims an override may resolve onto. The leg-only rows pass the same
  // roster gates, and never reach `finalResults`.
  const legOnly = (relayLegOnlyPool ?? []).filter(r => !r.isRelay && staysOnRoster(r));
  const legPool = legOnly.length > 0 ? [...activeSwimmers, ...legOnly] : activeSwimmers;

  const finalResults: SwimmerResult[] = [];
  const processedRelayKeys = new Set<string>();

  for (const r of activeSwimmers) {
    if (!r.isRelay) {
      finalResults.push(r);
      continue;
    }

    const k = relayGroupKey(r);
    if (processedRelayKeys.has(k)) continue;
    processedRelayKeys.add(k);

    processRelayGroupForRosterSim(
      k,
      results,
      legPool,
      overrideList,
      removeSeniors,
      excluded,
      vacateLegs,
      finalResults,
      relayLegSettings
    );
  }

  reAddUnprocessedRelayGroups(results, processedRelayKeys, finalResults);

  return finalResults;
}

/**
 * For UI cut badges only: the backstroke leadoff leg of a **400 Medley Relay** is
 * swum over 100 yards and compares to the 100 Backstroke standards. It is never
 * scored as an individual entry.
 *
 * The distance must be read off the **normalized** event name. HyTek labels the
 * event by leg — `Event 20 Men 4x100 Yard Medley Relay` — which contains `100`
 * and no literal `400`, so the previous raw-label `/\b400\b/` test never fired on
 * any real row in `data/meets.json`. `normalizeEventForCutline` folds
 * legs × leg-distance into the published total (`4x100 … Medley Relay` →
 * `400 Medley Relay`).
 *
 * The 200 Medley Relay leadoff is deliberately NOT mapped: no NCAA/NAIA table
 * held here publishes a 50 Backstroke standard, so there would be nothing to
 * compare against. See the round report.
 */
export function relaySplitQualificationCutEvent(res: SwimmerResult): string | null {
  if (!res.isRelay || res.relayLegStroke !== 'back') return null;
  const raw = String(res.event ?? '');
  if (!/medley/i.test(raw)) return null;

  // Primary path: the normalized, published event name.
  let normalized = '';
  try {
    normalized = normalizeEventForCutline(raw);
  } catch {
    normalized = '';
  }
  if (/\b400\b/.test(normalized) && /medley/i.test(normalized)) return '100 Backstroke';

  // FALLBACK — intentionally kept. If normalization ever fails, is changed, or
  // returns something this rule does not recognise, fall back to the original
  // raw-label test so the rule cannot silently stop firing. This is a superset of
  // the pre-fix behaviour, never a narrowing of it. (`4x50 … Medley Relay` still
  // returns null: neither the normalized `200 Medley Relay` nor the raw label
  // contains a standalone `400`.)
  if (/\b400\b/.test(raw)) return '100 Backstroke';
  return null;
}
