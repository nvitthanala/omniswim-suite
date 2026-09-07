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
  Recruit,
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

// --- event-label classification ---------------------------------------------
//
// These regexes are module constants rather than inline literals so they carry
// names. It also keeps them measurable: a regex literal in call-argument position
// (`s.match(/.../)`) makes `lizard` silently drop the enclosing function from its
// report, which hid this function's complexity from the metric entirely.

/** Relay event labels — never an individual leg-time source. */
const RELAY_LABEL_RE = /\brelay\b/;
/** Medley / individual-medley labels — never a single-stroke leg-time source. */
const MEDLEY_LABEL_RE = /\bim\b|individual medley|medley/;
/** First 2-4 digit run in a label — the event distance. */
const EVENT_DISTANCE_RE = /(\d{2,4})/;

/**
 * Relay-leg stroke named by a lowercased individual event label, or null.
 *
 * ORDERED CHAIN, not a lookup table: this is a first-match-wins scan, so a label
 * naming more than one stroke resolves to the earlier test. Reordering it changes
 * which stroke a mixed label reports.
 */
function strokeFromEventLabel(lower: string): RelayLegStroke | null {
  if (/back/.test(lower)) return 'back';
  if (/breast/.test(lower)) return 'breast';
  if (/butterfly|\bfly\b/.test(lower)) return 'fly';
  if (/free/.test(lower)) return 'free';
  return null;
}

/** Parse an individual event label to its (distance yards, relay-leg stroke), or null. */
function individualStrokeDistance(
  event: string
): { dist: number; stroke: RelayLegStroke } | null {
  const lower = event.toLowerCase();
  if (RELAY_LABEL_RE.test(lower) || MEDLEY_LABEL_RE.test(lower)) return null;
  const m = lower.match(EVENT_DISTANCE_RE);
  if (!m) return null;
  const stroke = strokeFromEventLabel(lower);
  if (!stroke) return null;
  return { dist: parseInt(m[1], 10), stroke };
}

/** Append a ref to the (athlete, legKey) bucket, creating the nested maps on demand. */
function addLegTimeRef(
  buckets: Map<string, Map<string, RelayLegTimeRef[]>>,
  nameKey: string,
  legKey: string,
  ref: RelayLegTimeRef
): void {
  let byLeg = buckets.get(nameKey);
  if (!byLeg) {
    byLeg = new Map();
    buckets.set(nameKey, byLeg);
  }
  let refs = byLeg.get(legKey);
  if (!refs) {
    refs = [];
    byLeg.set(legKey, refs);
  }
  refs.push(ref);
}

/** Recency-weighted best ref per leg key, for one athlete. */
function bestRefPerLegKey(
  legs: Map<string, RelayLegTimeRef[]>,
  cutoffMs: number | null
): Map<string, RelayLegTimeRef> {
  const chosen = new Map<string, RelayLegTimeRef>();
  for (const [legKey, refs] of legs) {
    const best = pickRecencyBest(refs, cutoffMs);
    if (best) chosen.set(legKey, best);
  }
  return chosen;
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
    addLegTimeRef(buckets, normalizeSwimmerName(s.name), `${sd.dist}|${sd.stroke}`, {
      time: converted.time,
      timeSec,
      meetLabel: s.meetLabel,
      date: s.date,
      converted: timeType !== 'SCY',
    });
  }

  const out = new Map<string, Map<string, RelayLegTimeRef>>();
  for (const [nameKey, legs] of buckets) out.set(nameKey, bestRefPerLegKey(legs, cutoffMs));
  return out;
}

/** One team relay entry (its template row + ordered leg names). */
type RelayEntry = {
  template: SwimmerResult;
  entryKey: string;
  legNames: string[];
  legRows: SwimmerResult[];
};

/** A relay row belonging to this team and gender (gender-less rows count). */
function isTeamRelayRow(r: SwimmerResult, team: string, gender: Gender): boolean {
  if (!isRelayResult(r)) return false;
  if (String(r.team ?? '').trim() !== team) return false;
  return r.gender == null || r.gender === gender;
}

/** The leg rows of one relay entry, ordered by leg index. */
function legRowsForTemplate(
  results: SwimmerResult[],
  template: SwimmerResult,
  team: string
): SwimmerResult[] {
  const round = (template.roundSwam || '').trim();
  return results
    .filter(
      x =>
        x.isRelay &&
        String(x.team ?? '').trim() === team &&
        x.event === template.event &&
        x.rank === template.rank &&
        (x.roundSwam || '').trim() === round
    )
    .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
}

/** Ordered leg names: the template's own roster when it has one, else the leg rows. */
function legNamesForEntry(template: SwimmerResult, legRows: SwimmerResult[]): string[] {
  if (template.relayNames && template.relayNames.length > 0) {
    return template.relayNames.map(n => n.name);
  }
  return legRows.map(x => x.name);
}

/** Distinct team relay entries for a gender, deduped by relayEntryKey. */
function collectTeamRelayEntries(
  results: SwimmerResult[],
  team: string,
  gender: Gender
): RelayEntry[] {
  const seen = new Set<string>();
  const entries: RelayEntry[] = [];
  for (const r of results) {
    if (!isTeamRelayRow(r, team, gender)) continue;
    const template = relayTemplateFromLeg(results, r);
    const entryKey = relayEntryKey(template);
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);
    const legRows = legRowsForTemplate(results, template, team);
    entries.push({ template, entryKey, legNames: legNamesForEntry(template, legRows), legRows });
  }
  return entries;
}

/** Individual result rows for this team and gender. */
function teamIndividualResults(
  results: SwimmerResult[],
  team: string,
  gender: Gender
): SwimmerResult[] {
  return results.filter(
    r =>
      !r.isRelay &&
      (r.gender == null || r.gender === gender) &&
      String(r.team ?? '').trim() === team
  );
}

/** A recruit projected onto the SwimmerResult shape a leg override resolves against. */
function recruitAsLegCandidate(rec: Recruit): SwimmerResult {
  return {
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
  };
}

/** Individuals (results + recruits) an override could actually resolve onto a leg. */
function resolvableLegPool(workspace: Workspace, team: string, gender: Gender): SwimmerResult[] {
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const recruits = (workspace.recruits ?? []).filter(
    rec => rec.gender === gender && String(rec.team ?? '').trim() === team
  );
  return [...teamIndividualResults(results, team, gender), ...recruits.map(recruitAsLegCandidate)];
}

// --- ranking internals --------------------------------------------------------

/** Everything the per-candidate evaluation needs, assembled once per ranking. */
type LegSwapContext = {
  workspace: Workspace;
  /** Gender-specific result rows (the same array the ranking was keyed from). */
  results: SwimmerResult[];
  team: string;
  gender: Gender;
  settings: ScoringSettings;
  pool: SwimmerResult[];
  legTimeIndex: Map<string, Map<string, RelayLegTimeRef>>;
  rosterLookup: ScorerRosterLookup | null;
  relayCap: number;
  baseOverrides: RelayLegOverride[];
  baseTotal: number;
  baseTotalRounded: number;
  /** True when the projection flags this leg holder for replacement. */
  isReplaceableLeg: (name: string) => boolean;
};

/** The leg position a substitution is scored against. */
type LegTarget = {
  entry: RelayEntry;
  legIndex: number;
  stroke: RelayLegStroke;
  legDistanceYards: number;
  onRelay: Set<string>;
  outAthlete: string;
  outKey: string;
  outTime?: string;
  legKey: string;
  clockLegTime?: string;
};

/** The ranking returned when the team fields no relay entries for this gender. */
function emptyRelayLegRanking(team: string, gender: Gender): RelayLegSwapRanking {
  const genderLabel = gender === Gender.MEN ? "men's" : "women's";
  return {
    pointsMeaningful: false,
    reason: `No ${genderLabel} relay entries for ${team || 'this team'} to substitute legs on.`,
    swaps: [],
    candidatesEvaluated: 0,
  };
}

/**
 * Test for legs the projection flags for replacement: a non-scorer whose leg
 * simulateRoster vacates, or a soft-removed (deleted) holder. An override on a
 * healthy leg is a scorer no-op → guaranteed zero delta, so those legs are
 * skipped wholesale rather than re-scored against every candidate.
 */
function buildReplaceableLegTest(
  workspace: Workspace,
  results: SwimmerResult[],
  gender: Gender,
  settings: ScoringSettings
): (name: string) => boolean {
  const vacateNames = computeVacateRelayLegNames(
    results,
    gender,
    settings,
    workspace.scorerRosterOverrides ?? []
  );
  const deletedNames = new Set(
    (workspace.deletedSwimmers ?? [])
      .filter(d => d.gender === gender)
      .map(d => normalizeSwimmerName(d.name))
  );
  return (name: string): boolean => {
    const k = normalizeSwimmerName(name);
    return vacateNames.has(k) || deletedNames.has(k);
  };
}

/**
 * The clock-hold time the override carries (see CLOCK HOLD above).
 *
 * ORDERED, and the order is a rule: this mirrors simulateRoster, which prefers
 * the departed swimmer's own matching individual time when it exists and parses,
 * and only then falls back to the leg's recorded split. Swapping the two changes
 * which clock the relay holds, and with it the re-scored delta.
 */
function resolveClockHoldTime(
  results: SwimmerResult[],
  relayEvent: string,
  legIndex: number,
  outAthlete: string,
  legRow: SwimmerResult | undefined
): string | undefined {
  const req = relayLegRequirements(relayEvent, legIndex);
  const departedIndiv = results.find(
    s =>
      !s.isRelay &&
      s.name === outAthlete &&
      eventMatchesStrokeDistance(s.event, req.legDistanceYards, req.keywords)
  );
  if (departedIndiv && Number.isFinite(convertTimeToSeconds(departedIndiv.time))) {
    return departedIndiv.time;
  }
  const rawSplit = legRow?.relayLegSplit;
  if (rawSplit && rawSplit !== 'NT') return rawSplit;
  return undefined;
}

/** Facts about one leg of one relay entry, resolved once for all candidates. */
function buildLegTarget(
  ctx: LegSwapContext,
  entry: RelayEntry,
  legIndex: number,
  evLower: string,
  legDistanceYards: number,
  onRelay: Set<string>
): LegTarget {
  const stroke = relayStrokeForIndex(evLower, legIndex);
  const outAthlete = entry.legNames[legIndex] ?? '';
  const legRow = entry.legRows.find(r => (r.relayLegIndex ?? -1) === legIndex);
  return {
    entry,
    legIndex,
    stroke,
    legDistanceYards,
    onRelay,
    outAthlete,
    outKey: normalizeSwimmerName(outAthlete),
    outTime: legRow ? displayTimeForRelayLeg(legRow) : undefined,
    legKey: `${legDistanceYards}|${stroke}`,
    clockLegTime: resolveClockHoldTime(
      ctx.results,
      entry.template.event,
      legIndex,
      outAthlete,
      legRow
    ),
  };
}

/**
 * True when the candidate already holds the per-swimmer relay-entry cap.
 * The `>= 999` early exit preserves the original short-circuit: an effectively
 * unlimited cap skips the entry count entirely rather than paying for it per
 * candidate.
 */
function isAtRelayEntryCap(cand: SwimmerResult, ctx: LegSwapContext): boolean {
  if (ctx.relayCap >= 999) return false;
  const counts = countSwimmerEntries(ctx.results, ctx.team, ctx.gender, cand.name);
  return counts.relayCount >= ctx.relayCap;
}

/**
 * Eligibility for one leg. ORDERED CHAIN, kept explicit rather than collapsed:
 * `candidatesEvaluated` counts exactly the candidates that clear EVERY gate, and
 * the cheap identity tests deliberately precede the two expensive ones (the
 * roster lookup and the entry count).
 */
function isEligibleLegCandidate(
  cand: SwimmerResult,
  candKey: string,
  target: LegTarget,
  ctx: LegSwapContext
): boolean {
  if (candKey === target.outKey) return false;
  if (target.onRelay.has(candKey)) return false;
  if (!swimmerMatchesRelayLeg(cand, target.entry.template.event, target.legIndex)) return false;
  if (ctx.rosterLookup && !ctx.rosterLookup.isScorer(cand.name, ctx.team, ctx.gender)) return false;
  return !isAtRelayEntryCap(cand, ctx);
}

/** Full re-score of the workspace with this substitution applied. */
function scoreLegSubstitution(
  ctx: LegSwapContext,
  target: LegTarget,
  cand: SwimmerResult
): { newTotal: number; deltaPoints: number } {
  const override: RelayLegOverride = {
    relayEntryKey: target.entry.entryKey,
    legIndex: target.legIndex,
    assigneeName: cand.name,
    classYear: cand.classYear,
    ...(target.clockLegTime ? { manualLegTime: target.clockLegTime } : {}),
    source: 'manual',
  };
  const modWs: Workspace = {
    ...ctx.workspace,
    relayLegOverrides: upsertRelayLegOverride(ctx.baseOverrides, override),
  };
  const newTotal = teamTotal(modWs, ctx.gender, ctx.team, ctx.settings);
  return { newTotal, deltaPoints: Number((newTotal - ctx.baseTotal).toFixed(3)) };
}

/** Assemble the surfaced swap record for one scored substitution. */
function buildRelayLegSwap(
  ctx: LegSwapContext,
  target: LegTarget,
  cand: SwimmerResult,
  bestRef: RelayLegTimeRef | undefined,
  newTotal: number,
  deltaPoints: number
): RelayLegSwap {
  return {
    relayEntryKey: target.entry.entryKey,
    relayEvent: target.entry.template.event,
    relayRank: Number(target.entry.template.rank) || 0,
    roundSwam: target.entry.template.roundSwam,
    legIndex: target.legIndex,
    stroke: target.stroke,
    legDistanceYards: target.legDistanceYards,
    outAthlete: target.outAthlete,
    outTime: target.outTime,
    inAthlete: cand.name,
    inTime: bestRef?.time ?? cand.time,
    inTimeConverted: bestRef?.converted ? true : undefined,
    inTimeStale: bestRef?.stale ? true : undefined,
    clockLegTime: target.clockLegTime,
    deltaPoints,
    newTotal: Number(newTotal.toFixed(3)),
    baseTotal: ctx.baseTotalRounded,
  };
}

/** Keep the highest-delta swap per (relay entry, leg, incoming athlete). */
function keepBestSwap(
  bestByKey: Map<string, RelayLegSwap>,
  dedupKey: string,
  swap: RelayLegSwap
): void {
  const prior = bestByKey.get(dedupKey);
  if (!prior || swap.deltaPoints > prior.deltaPoints) bestByKey.set(dedupKey, swap);
}

/** Score every eligible candidate against one leg. Returns how many were re-scored. */
function collectSwapsForLegTarget(
  ctx: LegSwapContext,
  target: LegTarget,
  bestByKey: Map<string, RelayLegSwap>
): number {
  let evaluated = 0;
  // Candidates: stroke/distance-matching individuals not already on this relay.
  for (const cand of ctx.pool) {
    const candKey = normalizeSwimmerName(cand.name);
    if (!isEligibleLegCandidate(cand, candKey, target, ctx)) continue;

    evaluated += 1;
    const { newTotal, deltaPoints } = scoreLegSubstitution(ctx, target, cand);
    if (deltaPoints <= 0) continue;

    const bestRef = ctx.legTimeIndex.get(candKey)?.get(target.legKey);
    const swap = buildRelayLegSwap(ctx, target, cand, bestRef, newTotal, deltaPoints);
    keepBestSwap(bestByKey, `${target.entry.entryKey}|${target.legIndex}|${candKey}`, swap);
  }
  return evaluated;
}

/** Score every replaceable leg of one relay entry. Returns how many were re-scored. */
function collectSwapsForEntry(
  ctx: LegSwapContext,
  entry: RelayEntry,
  bestByKey: Map<string, RelayLegSwap>
): number {
  const evLower = entry.template.event.toLowerCase();
  const legDistanceYards = relayLegDistanceYards(parseRelayDistanceYards(entry.template.event));
  const onRelay = new Set(entry.legNames.filter(Boolean).map(n => normalizeSwimmerName(n)));

  let evaluated = 0;
  for (let legIndex = 0; legIndex < entry.legNames.length; legIndex++) {
    // Only a replaceable leg can gain points; healthy scorer legs are no-ops.
    if (!ctx.isReplaceableLeg(entry.legNames[legIndex] ?? '')) continue;
    const target = buildLegTarget(ctx, entry, legIndex, evLower, legDistanceYards, onRelay);
    evaluated += collectSwapsForLegTarget(ctx, target, bestByKey);
  }
  return evaluated;
}

/** Assemble the per-ranking context (pool, indexes, gates, baseline total). */
function buildLegSwapContext(
  workspace: Workspace,
  opts: RelayLegSwapOptions,
  team: string,
  gender: Gender,
  merged: ScoringSettings,
  results: SwimmerResult[]
): LegSwapContext {
  const baseTotal = teamTotal(workspace, gender, team, merged);
  return {
    workspace,
    results,
    team,
    gender,
    settings: merged,
    pool: resolvableLegPool(workspace, team, gender),
    legTimeIndex: buildRelayLegTimeIndex(workspace, {
      team,
      gender,
      recencyMonths: opts.recencyMonths,
    }),
    rosterLookup: usesScorerRoster(merged)
      ? buildScorerRosterLookup(results, merged, workspace.scorerRosterOverrides ?? [], gender)
      : null,
    relayCap: merged.maxRelayEntriesPerSwimmer ?? 999,
    baseOverrides: workspace.relayLegOverrides ?? [],
    baseTotal,
    baseTotalRounded: Number(baseTotal.toFixed(3)),
    isReplaceableLeg: buildReplaceableLegTest(workspace, results, gender, merged),
  };
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
  if (relayEntries.length === 0) return emptyRelayLegRanking(team, gender);

  const ctx = buildLegSwapContext(workspace, opts, team, gender, merged, results);
  const bestByKey = new Map<string, RelayLegSwap>();
  let candidatesEvaluated = 0;
  for (const entry of relayEntries) {
    candidatesEvaluated += collectSwapsForEntry(ctx, entry, bestByKey);
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
