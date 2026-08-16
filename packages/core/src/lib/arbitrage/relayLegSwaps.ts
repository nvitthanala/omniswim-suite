/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay-leg swap enumeration and the pure patch that applies one.
 *
 * Test: npx tsx scripts/test_relay_swaps.mjs
 */

import {
  Gender,
  RelayLegOverride,
  RelayLegStroke,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '../../types';
import { mergeScoringSettings } from '../scoringDefaults';
import { buildScorerRosterLookup, usesScorerRoster, type ScorerRosterLookup } from '../scorerRoster';
import {
  displayTimeForRelayLeg,
  parseRelayDistanceYards,
  relayEntryKey,
  relayLegDistanceYards,
} from '../relaySplits';
import {
  eventMatchesStrokeDistance,
  relayLegRequirements,
  relayStrokeForIndex,
  relayTemplateFromLeg,
  swimmerMatchesRelayLeg,
  upsertRelayLegOverride,
} from '../relayLegMatching';
import { countSwimmerEntries } from '../swimmerEntryLimits';
import { computeVacateRelayLegNames } from '../rosterLineupAudit';
import { convertTimeToSeconds, isRelayResult, normalizeSwimmerName } from '../utils';
import {
  convertedHistorySwims,
  pickRecencyBest,
  teamHistoryWindow,
  teamTotal,
  type CrossCourseTimeRef,
} from './shared';

// --- relay-leg swap enumeration ---------------------------------------------
//
// SCORING MODEL (important, drives what this surfaces):
//   The what-if engine NEVER re-ranks relays by time — a relay carries the rank
//   it was loaded with (projectRanksInField skips relays; calculatePoints scores
//   relays from their stored rank). So substituting a faster leg does NOT by
//   itself change a relay's placement points. A leg substitution changes team
//   points only through the ENGINE-NATIVE levers that a RelayLegOverride actually
//   moves: it fills a leg the projection has flagged for replacement (a
//   soft-removed/deleted holder, a senior removed, or — in roster mode — a
//   non-scorer whose leg simulateRoster vacates), and the fill flips the relay's
//   eligibility/completeness (roster all-scorer gate for non-A/B rounds, or the
//   legacy relayEligibleFromScorerPool meet-pool gate). On an all-A/B-final roster
//   field every relay is already eligible, so most legs yield a zero delta and are
//   filtered out — that is correct, not a miss.
//
// The override is scored EXACTLY like rankExactSwaps: a modified-workspace clone
// re-scored through buildWhatIfResults + calculatePoints (full re-score baseline;
// relay-leg counts are small so worst-case runtime stays modest — see the test's
// timing line). No incremental fast path: the override couples events through the
// meet-wide relay/pool state in ways that are not cheaply localizable, and
// correctness dominates here.
//
// CLOCK HOLD: the override sets manualLegTime to the departed leg's own split so
// the relay's team clock is unchanged by the substitution. Relay points depend on
// placement, not time, so this loses no accuracy — and it is REQUIRED: a changed
// clock makes simulateRoster re-emit the original (unmodified) leg rows under a
// new relayGroupKey, which cancels the eligibility gain in the full re-score. The
// incoming swimmer's real projected leg time is carried separately on `inTime`.

/** Best flat time an athlete owns at a relay-leg (distance, stroke), SCY-converted. */
type RelayLegTimeRef = CrossCourseTimeRef & {
  /** True when the best came from a converted LCM/SCM swim (not swum SCY). */
  converted?: boolean;
};

export type RelayLegSwap = {
  /** relayEntryKey of the target relay entry (team|event|round|rank|clock). */
  relayEntryKey: string;
  /** Relay event label as loaded (e.g. "200 Yard Medley Relay"). */
  relayEvent: string;
  /** Relay placement (which entry — 1 = fastest/A). */
  relayRank: number;
  roundSwam?: string;
  /** 0-based leg index. */
  legIndex: number;
  /** Stroke this leg swims (medley legs by index; free relays are all `free`). */
  stroke: RelayLegStroke;
  legDistanceYards: number;
  /** Current leg holder being replaced (may already be vacated/departed). */
  outAthlete: string;
  /** Outgoing leg split/time, when known. */
  outTime?: string;
  inAthlete: string;
  /** Incoming swimmer's projected leg time (SCY, cross-course best) — for display. */
  inTime: string;
  /** True when inTime came from a converted LCM/SCM swim. */
  inTimeConverted?: boolean;
  /** True when inTime is older than the recency window (only stale times existed). */
  inTimeStale?: boolean;
  /**
   * manualLegTime the override carries so the relay team clock is held constant
   * (the departed leg's split). Points are placement-based; holding the clock
   * keeps the delta free of simulateRoster's leg re-add artifact. Undefined when
   * the leg has no prior split to hold (the substitution then leaves the clock
   * unchanged on its own).
   */
  clockLegTime?: string;
  deltaPoints: number;
  newTotal: number;
  baseTotal: number;
};

export type RelayLegSwapRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  swaps: RelayLegSwap[];
  /** Number of (relay x leg x candidate) combinations re-scored. */
  candidatesEvaluated: number;
};

export type RelayLegSwapOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  recencyMonths?: number;
};

/** Parse an individual event label to its (distance yards, relay-leg stroke), or null. */
function individualStrokeDistance(
  event: string
): { dist: number; stroke: RelayLegStroke } | null {
  const lower = event.toLowerCase();
  if (/\brelay\b/.test(lower) || /\bim\b|individual medley|medley/.test(lower)) return null;
  const m = lower.match(/(\d{2,4})/);
  if (!m) return null;
  const dist = parseInt(m[1], 10);
  let stroke: RelayLegStroke | null = null;
  if (/back/.test(lower)) stroke = 'back';
  else if (/breast/.test(lower)) stroke = 'breast';
  else if (/butterfly|\bfly\b/.test(lower)) stroke = 'fly';
  else if (/free/.test(lower)) stroke = 'free';
  if (!stroke) return null;
  return { dist, stroke };
}

/** Per athlete → `${legDistanceYards}|${stroke}` → best SCY-converted leg time (recency-weighted). */
function buildRelayLegTimeIndex(
  workspace: Workspace,
  opts: { team: string; gender: Gender; recencyMonths?: number }
): Map<string, Map<string, RelayLegTimeRef>> {
  const { history, cutoffMs } = teamHistoryWindow(workspace, opts);

  // athlete → legKey → all candidate refs
  const buckets = new Map<string, Map<string, RelayLegTimeRef[]>>();
  for (const { swim: s, timeType, converted } of convertedHistorySwims(history)) {
    const sd = individualStrokeDistance(converted.event);
    if (!sd) continue;
    const timeSec = convertTimeToSeconds(converted.time);
    if (!Number.isFinite(timeSec)) continue;
    const nameKey = normalizeSwimmerName(s.name);
    const legKey = `${sd.dist}|${sd.stroke}`;
    let m = buckets.get(nameKey);
    if (!m) {
      m = new Map();
      buckets.set(nameKey, m);
    }
    let arr = m.get(legKey);
    if (!arr) {
      arr = [];
      m.set(legKey, arr);
    }
    arr.push({
      time: converted.time,
      timeSec,
      meetLabel: s.meetLabel,
      date: s.date,
      converted: timeType !== 'SCY',
    });
  }

  const out = new Map<string, Map<string, RelayLegTimeRef>>();
  for (const [nameKey, legs] of buckets) {
    const chosen = new Map<string, RelayLegTimeRef>();
    for (const [legKey, refs] of legs) {
      const best = pickRecencyBest(refs, cutoffMs);
      if (best) chosen.set(legKey, best);
    }
    out.set(nameKey, chosen);
  }
  return out;
}

/** One team relay entry (its template row + ordered leg names). */
type RelayEntry = {
  template: SwimmerResult;
  entryKey: string;
  legNames: string[];
  legRows: SwimmerResult[];
};

/** Distinct team relay entries for a gender, deduped by relayEntryKey. */
function collectTeamRelayEntries(
  results: SwimmerResult[],
  team: string,
  gender: Gender
): RelayEntry[] {
  const seen = new Set<string>();
  const entries: RelayEntry[] = [];
  for (const r of results) {
    if (!isRelayResult(r)) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    if (r.gender != null && r.gender !== gender) continue;
    const template = relayTemplateFromLeg(results, r);
    const entryKey = relayEntryKey(template);
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);
    const legRows = results
      .filter(
        x =>
          x.isRelay &&
          String(x.team ?? '').trim() === team &&
          x.event === template.event &&
          x.rank === template.rank &&
          (x.roundSwam || '').trim() === (template.roundSwam || '').trim()
      )
      .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
    const legNames =
      template.relayNames && template.relayNames.length > 0
        ? template.relayNames.map(n => n.name)
        : legRows.map(x => x.name);
    entries.push({ template, entryKey, legNames, legRows });
  }
  return entries;
}

/** Individuals (results + recruits) an override could actually resolve onto a leg. */
function resolvableLegPool(workspace: Workspace, team: string, gender: Gender): SwimmerResult[] {
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const pool: SwimmerResult[] = [];
  for (const r of results) {
    if (r.isRelay) continue;
    if (r.gender != null && r.gender !== gender) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    pool.push(r);
  }
  for (const rec of workspace.recruits ?? []) {
    if (rec.gender !== gender) continue;
    if (String(rec.team ?? '').trim() !== team) continue;
    pool.push({
      id: rec.id,
      rank: 0,
      name: rec.name,
      classYear: rec.classYear ?? 'UNKNOWN',
      team: rec.team,
      time: rec.time,
      points: 0,
      event: rec.event,
      gender: rec.gender,
      isRecruit: true,
    });
  }
  return pool;
}

/**
 * Exact team-points delta of substituting a rostered athlete onto each relay leg.
 * For every distinct team relay entry × leg × eligible candidate, attach a
 * RelayLegOverride and full re-score through buildWhatIfResults + calculatePoints
 * (same pipeline as rankExactSwaps). Only positive deltas, de-duped per
 * (relayEntryKey, legIndex, inAthlete), sorted descending.
 *
 * Candidates are drawn from the team's individuals (result/recruit rows) that
 * stroke- and distance-match the leg (medley legs by index; free relays use free)
 * — the pool a RelayLegOverride can actually resolve a name onto — enriched with
 * the athlete's SCY-converted cross-course best for the leg (converted/stale
 * flags reused from the recency machinery). Eligibility mirrors what the scorer
 * enforces today: roster-mode candidates must be scorers, and a candidate at the
 * per-swimmer relay-entry cap is skipped.
 */
export function rankRelayLegSwaps(
  workspace: Workspace,
  opts: RelayLegSwapOptions
): RelayLegSwapRanking {
  const team = opts.team.trim();
  const gender = opts.gender;
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const relayEntries = collectTeamRelayEntries(results, team, gender);
  if (relayEntries.length === 0) {
    return {
      pointsMeaningful: false,
      reason: `No ${gender === Gender.MEN ? "men's" : "women's"} relay entries for ${team || 'this team'} to substitute legs on.`,
      swaps: [],
      candidatesEvaluated: 0,
    };
  }

  const legTimeIndex = buildRelayLegTimeIndex(workspace, {
    team,
    gender,
    recencyMonths: opts.recencyMonths,
  });
  const pool = resolvableLegPool(workspace, team, gender);

  const rosterMode = usesScorerRoster(merged);
  const rosterLookup: ScorerRosterLookup | null = rosterMode
    ? buildScorerRosterLookup(results, merged, workspace.scorerRosterOverrides ?? [], gender)
    : null;
  const relayCap = merged.maxRelayEntriesPerSwimmer ?? 999;

  // A substitution only moves points on a leg the projection flags for replacement
  // (a non-scorer whose leg simulateRoster vacates, or a soft-removed holder); an
  // override on a healthy leg is a scorer no-op → guaranteed zero delta. Skip those
  // legs wholesale rather than re-score every candidate against them.
  const vacateNames = computeVacateRelayLegNames(
    results,
    gender,
    merged,
    workspace.scorerRosterOverrides ?? []
  );
  const deletedNames = new Set(
    (workspace.deletedSwimmers ?? [])
      .filter(d => d.gender === gender)
      .map(d => normalizeSwimmerName(d.name))
  );
  const legIsReplaceable = (name: string): boolean => {
    const k = normalizeSwimmerName(name);
    return vacateNames.has(k) || deletedNames.has(k);
  };

  const baseTotal = teamTotal(workspace, gender, team, merged);
  const baseTotalRounded = Number(baseTotal.toFixed(3));

  const baseOverrides = workspace.relayLegOverrides ?? [];
  const bestByKey = new Map<string, RelayLegSwap>();
  let candidatesEvaluated = 0;

  for (const entry of relayEntries) {
    const evLower = entry.template.event.toLowerCase();
    const legDistYards = relayLegDistanceYards(parseRelayDistanceYards(entry.template.event));
    const onRelay = new Set(entry.legNames.filter(Boolean).map(n => normalizeSwimmerName(n)));

    for (let legIndex = 0; legIndex < entry.legNames.length; legIndex++) {
      const stroke = relayStrokeForIndex(evLower, legIndex);
      const outAthlete = entry.legNames[legIndex] ?? '';
      const outKey = normalizeSwimmerName(outAthlete);
      // Only a replaceable leg can gain points; healthy scorer legs are no-ops.
      if (!legIsReplaceable(outAthlete)) continue;
      const legRow = entry.legRows.find(r => (r.relayLegIndex ?? -1) === legIndex);
      const outTime = legRow ? displayTimeForRelayLeg(legRow) : undefined;
      const legKey = `${legDistYards}|${stroke}`;

      // Clock-hold time: the value simulateRoster would treat as this leg's prior
      // split, so a substitution leaves the team clock unchanged (see CLOCK HOLD).
      // Mirrors simulateRoster: the departed swimmer's own matching individual time
      // when it exists (and is finite), else the leg's recorded split.
      const req = relayLegRequirements(entry.template.event, legIndex);
      const departedIndiv = results.find(
        s =>
          !s.isRelay &&
          s.name === outAthlete &&
          eventMatchesStrokeDistance(s.event, req.legDistanceYards, req.keywords)
      );
      const departedSec = departedIndiv ? convertTimeToSeconds(departedIndiv.time) : NaN;
      const rawSplit = legRow?.relayLegSplit;
      const clockLegTime =
        departedIndiv && Number.isFinite(departedSec)
          ? departedIndiv.time
          : rawSplit && rawSplit !== 'NT'
            ? rawSplit
            : undefined;

      // Candidates: stroke/distance-matching individuals not already on this relay.
      for (const cand of pool) {
        const candKey = normalizeSwimmerName(cand.name);
        if (candKey === outKey) continue;
        if (onRelay.has(candKey)) continue;
        if (!swimmerMatchesRelayLeg(cand, entry.template.event, legIndex)) continue;
        if (rosterLookup && !rosterLookup.isScorer(cand.name, team, gender)) continue;
        if (relayCap < 999) {
          const counts = countSwimmerEntries(results, team, gender, cand.name);
          if (counts.relayCount >= relayCap) continue;
        }

        candidatesEvaluated += 1;

        const bestRef = legTimeIndex.get(candKey)?.get(legKey);
        const inTime = bestRef?.time ?? cand.time;

        const override: RelayLegOverride = {
          relayEntryKey: entry.entryKey,
          legIndex,
          assigneeName: cand.name,
          classYear: cand.classYear,
          ...(clockLegTime ? { manualLegTime: clockLegTime } : {}),
          source: 'manual',
        };
        const modWs: Workspace = {
          ...workspace,
          relayLegOverrides: upsertRelayLegOverride(baseOverrides, override),
        };
        const newTotal = teamTotal(modWs, gender, team, merged);
        const deltaPoints = Number((newTotal - baseTotal).toFixed(3));
        if (deltaPoints <= 0) continue;

        const dedupKey = `${entry.entryKey}|${legIndex}|${candKey}`;
        const swap: RelayLegSwap = {
          relayEntryKey: entry.entryKey,
          relayEvent: entry.template.event,
          relayRank: Number(entry.template.rank) || 0,
          roundSwam: entry.template.roundSwam,
          legIndex,
          stroke,
          legDistanceYards: legDistYards,
          outAthlete,
          outTime,
          inAthlete: cand.name,
          inTime,
          inTimeConverted: bestRef?.converted ? true : undefined,
          inTimeStale: bestRef?.stale ? true : undefined,
          clockLegTime,
          deltaPoints,
          newTotal: Number(newTotal.toFixed(3)),
          baseTotal: baseTotalRounded,
        };
        const prior = bestByKey.get(dedupKey);
        if (!prior || swap.deltaPoints > prior.deltaPoints) bestByKey.set(dedupKey, swap);
      }
    }
  }

  const swaps = [...bestByKey.values()].sort((a, b) => b.deltaPoints - a.deltaPoints);
  return { pointsMeaningful: true, swaps, candidatesEvaluated };
}

/**
 * Pure workspace patch that enacts one {@link RelayLegSwap}: upsert a
 * RelayLegOverride assigning the incoming swimmer to the target relay leg,
 * replacing any prior override for that (relayEntryKey, legIndex). The override
 * carries the swap's `clockLegTime` as manualLegTime so re-scoring reproduces the
 * ranking's newTotal exactly (the clock-hold that keeps the point delta free of
 * simulateRoster's leg re-add artifact — see CLOCK HOLD above). Same patch/inverse
 * contract as applyExactSwap — the inverse restores the full prior
 * relayLegOverrides array (exact round-trip). No mutation, no I/O.
 */
export function applyRelayLegSwap(
  workspace: Workspace,
  swap: RelayLegSwap,
  _opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const baseOverrides = workspace.relayLegOverrides ?? [];
  const override: RelayLegOverride = {
    relayEntryKey: swap.relayEntryKey,
    legIndex: swap.legIndex,
    assigneeName: swap.inAthlete,
    ...(swap.clockLegTime ? { manualLegTime: swap.clockLegTime } : {}),
    source: 'manual',
  };
  const patch: Partial<Workspace> = {
    relayLegOverrides: upsertRelayLegOverride(baseOverrides, override),
  };
  const inverse: Partial<Workspace> = { relayLegOverrides: baseOverrides };
  const outLabel = swap.outAthlete && swap.outAthlete !== '—' ? swap.outAthlete : 'vacant leg';
  const description = `${swap.relayEvent} leg ${swap.legIndex + 1} (${swap.stroke}): +${swap.inAthlete} (${swap.inTime}), −${outLabel}`;
  return { patch, inverse, description };
}
