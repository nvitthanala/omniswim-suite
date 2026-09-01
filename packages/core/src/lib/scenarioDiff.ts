/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Scenario diff drill-down: compares a saved lineup scenario snapshot (full
 * Workspace content, fetched read-only — never restored) against the current
 * workspace for one team/gender. Both sides are scored through the exact same
 * engine path the Lineup step uses (buildWhatIfResults → calculatePoints via
 * buildScoringBundle), so per-event / per-swimmer deltas reconcile with the
 * projected totals shown in the UI. Pure + worker-friendly: no DOM, no React.
 */

import { Gender, ScoringSettings, SwimmerResult, Workspace } from '../types';
import { buildScoringBundle } from './scoringEngine';
import {
  canonicalSwimmerName,
  isRelayResult,
  looksLikeInstitutionTeamName,
  relayTeamClock,
  sortEventsByMeetOrder,
} from './utils';

/**
 * How one side of a diff is scored.
 *
 * - `whatIf`   — the working lineup: what-if edits applied, remove-seniors and
 *                scorer-roster overrides honoured. This is the normal side.
 * - `baseline` — the loaded meet as parsed, i.e. what-if OFF. Mirrors exactly
 *                the `baseline` bundle in `buildScoringSnapshot`
 *                (`applyWhatIf: false`, `removeSeniors: false`,
 *                `scorerRosterOverrides: []`), so a diff computed against it
 *                agrees with the baseline total shown on the scoreboard.
 */
export type ScenarioDiffSideMode = 'whatIf' | 'baseline';

export type ScenarioDiffOptions = {
  team: string;
  gender: Gender;
  /** Optional settings override applied to BOTH sides (apples-to-apples). */
  settings?: ScoringSettings;
  /** Mirror of the Lineup step's remove-seniors what-if toggle (default false). */
  removeSeniors?: boolean;
  /**
   * How the "then" side is scored. Defaults to `whatIf`, which is the
   * snapshot-vs-current comparison this module was written for.
   *
   * Pass `baseline` to diff the loaded meet against the working copy. Because
   * baseline is not a separate workspace — it is the same workspace scored with
   * what-if off — a baseline diff passes the SAME workspace as both arguments
   * and lets the mode do the work.
   */
  thenMode?: ScenarioDiffSideMode;
};

export type ScenarioSwimmerDiff = {
  /** Athlete display name; for relay rows, the relay event label. */
  name: string;
  /** True when this row aggregates a relay entry (points attributed here, not to legs). */
  isRelay: boolean;
  eventsAdded: string[];
  eventsRemoved: string[];
  eventsChanged: { event: string; timeThen: string; timeNow: string }[];
  pointsThen: number;
  pointsNow: number;
  deltaPoints: number;
};

export type ScenarioEventDiff = {
  event: string;
  pointsThen: number;
  pointsNow: number;
  delta: number;
  /** Distinct athletes/relay rows whose contribution to this event changed. */
  swimmersChanged: number;
};

export type ScenarioDiffResult = {
  team: string;
  gender: Gender;
  totals: { then: number; now: number; delta: number };
  /** Sorted top movers first (|deltaPoints| desc). Unchanged swimmers omitted. */
  swimmers: ScenarioSwimmerDiff[];
  /** Sorted |delta| desc. Unchanged events omitted. */
  events: ScenarioEventDiff[];
};

const EPS = 1e-6;

function pointsOf(r: SwimmerResult): number {
  return typeof r.points === 'number' && Number.isFinite(r.points) ? r.points : 0;
}

/** Same row exclusion the scoring engine's team aggregation applies. */
function isCountedRow(r: SwimmerResult): boolean {
  const tName = String(r.name ?? '').trim().toLowerCase();
  const tTeam = String(r.team ?? '').trim().toLowerCase();
  if (tName && tTeam === tName && !looksLikeInstitutionTeamName(r.team)) return false;
  return true;
}

/**
 * One side's contribution to one event, for a single swimmer or for a relay.
 * `time` may hold several comma-joined clocks when more than one row merges
 * into it (A/B relays, a swimmer entered twice in one event).
 */
type EntryContribution = { time: string; points: number };

type SwimmerSide = {
  displayName: string;
  /** event → contribution for change detection + per-event attribution. */
  byEvent: Map<string, EntryContribution>;
  points: number;
};

type TeamSide = {
  /** Individuals keyed by canonical swimmer name. */
  individuals: Map<string, SwimmerSide>;
  /** Relay entries aggregated per event (points attributed to the relay row). */
  relays: Map<string, EntryContribution>;
  total: number;
};

// ---------------------------------------------------------------------------
// Scoring one side
// ---------------------------------------------------------------------------

/** Apply the caller's settings override, which must hit BOTH sides equally. */
function resolveSideWorkspace(workspace: Workspace, opts: ScenarioDiffOptions): Workspace {
  if (!opts.settings) return workspace;
  return { ...workspace, scoringSettings: opts.settings };
}

/**
 * Score one side and keep only the rows that count toward the requested team.
 *
 * `baseline` must match buildScoringSnapshot's baseline bundle exactly, or a
 * baseline diff would disagree with the baseline total on the scoreboard.
 */
function selectSideRows(
  ws: Workspace,
  opts: ScenarioDiffOptions,
  mode: ScenarioDiffSideMode
): SwimmerResult[] {
  const isBaseline = mode === 'baseline';
  const bundle = buildScoringBundle({
    workspace: ws,
    gender: opts.gender,
    removeSeniors: isBaseline ? false : (opts.removeSeniors ?? false),
    applyWhatIf: !isBaseline,
    scorerRosterOverrides: isBaseline ? [] : ws.scorerRosterOverrides,
  });
  const teamKey = opts.team.trim();
  return bundle.allScored.filter(
    r => String(r.team ?? '').trim() === teamKey && isCountedRow(r)
  );
}

/**
 * Keep every distinct clock on a merged contribution ("1:25.00, 1:29.00").
 * A/B relays and multi-leg rows collapse into one entry, and change detection
 * compares those joined strings, so a dropped clock would hide a real change.
 */
function appendDistinctClock(entry: EntryContribution, clock: string): void {
  if (!clock || entry.time.includes(clock)) return;
  entry.time = entry.time ? `${entry.time}, ${clock}` : clock;
}

/** Fold one relay row into the per-event relay aggregate. */
function accumulateRelayRow(
  relays: Map<string, EntryContribution>,
  r: SwimmerResult,
  event: string,
  pts: number
): void {
  const clock = relayTeamClock(r) || String(r.time ?? '').trim();
  const prev = relays.get(event);
  if (!prev) {
    relays.set(event, { time: clock, points: pts });
    return;
  }
  prev.points += pts;
  appendDistinctClock(prev, clock);
}

/** Fold one individual row into its swimmer's totals and per-event map. */
function accumulateIndividualRow(
  individuals: Map<string, SwimmerSide>,
  r: SwimmerResult,
  event: string,
  pts: number
): void {
  const key = canonicalSwimmerName(String(r.name ?? ''));
  let side = individuals.get(key);
  if (!side) {
    side = { displayName: String(r.name ?? '').trim(), byEvent: new Map(), points: 0 };
    individuals.set(key, side);
  }
  side.points += pts;
  const time = String(r.time ?? '').trim();
  const prev = side.byEvent.get(event);
  if (!prev) {
    side.byEvent.set(event, { time, points: pts });
    return;
  }
  prev.points += pts;
  appendDistinctClock(prev, time);
}

function scoreSide(
  workspace: Workspace,
  opts: ScenarioDiffOptions,
  mode: ScenarioDiffSideMode = 'whatIf'
): TeamSide {
  const ws = resolveSideWorkspace(workspace, opts);
  const rows = selectSideRows(ws, opts, mode);

  const individuals = new Map<string, SwimmerSide>();
  const relays = new Map<string, EntryContribution>();
  let total = 0;

  for (const r of rows) {
    const pts = pointsOf(r);
    total += pts;
    const event = String(r.event ?? '').trim();
    // Relay points stay on the relay row and are never attributed to its legs.
    if (isRelayResult(r)) accumulateRelayRow(relays, r, event, pts);
    else accumulateIndividualRow(individuals, r, event, pts);
  }

  return { individuals, relays, total };
}

// ---------------------------------------------------------------------------
// Comparing the two sides
// ---------------------------------------------------------------------------

/** What one row reports about the entries that moved under it. */
type EntryChangeBuckets = {
  eventsAdded: string[];
  eventsRemoved: string[];
  eventsChanged: ScenarioSwimmerDiff['eventsChanged'];
};

/** Records that one swimmer/relay key changed its contribution to an event. */
type MarkEventChanged = (event: string, key: string) => void;

/** Same, with the key already bound to the row being compared. */
type MarkRowEventChanged = (event: string) => void;

function emptyBuckets(): EntryChangeBuckets {
  return { eventsAdded: [], eventsRemoved: [], eventsChanged: [] };
}

/**
 * Classify how one event's contribution changed and record it.
 *
 * The chain is ordered and the order is a rule, not an accident: presence
 * beats clock, and clock beats points. An entry that vanished is "removed",
 * never "the clock changed"; a re-swum entry is "changed", never "the points
 * moved". Reordering these branches changes which label a coach sees.
 *
 * Every branch that fires marks the event as changed. Only the added, removed
 * and clock-changed cases put anything in the row's own lists.
 */
function recordEntryChange(
  buckets: EntryChangeBuckets,
  event: string,
  thenEntry: EntryContribution | undefined,
  nowEntry: EntryContribution | undefined,
  onChanged: MarkRowEventChanged
): void {
  if (!thenEntry && !nowEntry) return;
  if (!nowEntry) {
    buckets.eventsRemoved.push(event);
    onChanged(event);
    return;
  }
  if (!thenEntry) {
    buckets.eventsAdded.push(event);
    onChanged(event);
    return;
  }
  if (thenEntry.time !== nowEntry.time) {
    buckets.eventsChanged.push({ event, timeThen: thenEntry.time, timeNow: nowEntry.time });
    onChanged(event);
    return;
  }
  // Same swim, different points (field/caps moved around it). The event counts
  // as changed, but nothing lands in the row's added/removed/changed lists.
  if (Math.abs(thenEntry.points - nowEntry.points) > EPS) onChanged(event);
}

/** A row with no point movement and no entry churn is omitted from the diff. */
function isUnchangedRow(deltaPoints: number, buckets: EntryChangeBuckets): boolean {
  return (
    Math.abs(deltaPoints) <= EPS &&
    buckets.eventsAdded.length === 0 &&
    buckets.eventsRemoved.length === 0 &&
    buckets.eventsChanged.length === 0
  );
}

/** Compare every event either side of one swimmer touched. */
function diffSwimmerEvents(
  thenSide: SwimmerSide | undefined,
  nowSide: SwimmerSide | undefined,
  onChanged: MarkRowEventChanged
): EntryChangeBuckets {
  const buckets = emptyBuckets();
  const events = new Set([
    ...(thenSide?.byEvent.keys() ?? []),
    ...(nowSide?.byEvent.keys() ?? []),
  ]);
  for (const event of events) {
    recordEntryChange(
      buckets,
      event,
      thenSide?.byEvent.get(event),
      nowSide?.byEvent.get(event),
      onChanged
    );
  }
  return buckets;
}

function buildIndividualDiffs(
  then: TeamSide,
  now: TeamSide,
  markChanged: MarkEventChanged
): ScenarioSwimmerDiff[] {
  const rows: ScenarioSwimmerDiff[] = [];
  const swimmerKeys = new Set([...then.individuals.keys(), ...now.individuals.keys()]);
  for (const key of swimmerKeys) {
    const t = then.individuals.get(key);
    const n = now.individuals.get(key);
    const buckets = diffSwimmerEvents(t, n, event => markChanged(event, key));
    const pointsThen = t?.points ?? 0;
    const pointsNow = n?.points ?? 0;
    const deltaPoints = pointsNow - pointsThen;
    if (isUnchangedRow(deltaPoints, buckets)) continue;
    rows.push({
      name: n?.displayName ?? t?.displayName ?? key,
      isRelay: false,
      eventsAdded: sortEventsByMeetOrder(buckets.eventsAdded),
      eventsRemoved: sortEventsByMeetOrder(buckets.eventsRemoved),
      eventsChanged: buckets.eventsChanged,
      pointsThen,
      pointsNow,
      deltaPoints,
    });
  }
  return rows;
}

/** One row per relay event; the points stay on the relay, not on its legs. */
function buildRelayDiffs(
  then: TeamSide,
  now: TeamSide,
  markChanged: MarkEventChanged
): ScenarioSwimmerDiff[] {
  const rows: ScenarioSwimmerDiff[] = [];
  const relayEvents = new Set([...then.relays.keys(), ...now.relays.keys()]);
  for (const event of relayEvents) {
    const t = then.relays.get(event);
    const n = now.relays.get(event);
    const relayKey = `relay:${event}`;
    const buckets = emptyBuckets();
    recordEntryChange(buckets, event, t, n, () => markChanged(event, relayKey));
    const pointsThen = t?.points ?? 0;
    const pointsNow = n?.points ?? 0;
    const deltaPoints = pointsNow - pointsThen;
    if (isUnchangedRow(deltaPoints, buckets)) continue;
    rows.push({
      name: event,
      isRelay: true,
      // Not meet-order sorted, unlike the individual lists: a relay row covers
      // exactly one event, so each list holds at most one entry.
      eventsAdded: buckets.eventsAdded,
      eventsRemoved: buckets.eventsRemoved,
      eventsChanged: buckets.eventsChanged,
      pointsThen,
      pointsNow,
      deltaPoints,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Per-event rollup
// ---------------------------------------------------------------------------

/** One side's total for one event: its relay aggregate plus every individual. */
function eventPointsFor(side: TeamSide, event: string): number {
  let pts = side.relays.get(event)?.points ?? 0;
  for (const s of side.individuals.values()) {
    pts += s.byEvent.get(event)?.points ?? 0;
  }
  return pts;
}

/** Every event either side scored, individual or relay. */
function collectScoredEvents(sides: TeamSide[]): Set<string> {
  const allEvents = new Set<string>();
  for (const side of sides) {
    for (const s of side.individuals.values()) for (const e of s.byEvent.keys()) allEvents.add(e);
    for (const e of side.relays.keys()) allEvents.add(e);
  }
  return allEvents;
}

function buildEventDiffs(
  then: TeamSide,
  now: TeamSide,
  changedByEvent: Map<string, Set<string>>
): ScenarioEventDiff[] {
  const rows: ScenarioEventDiff[] = [];
  for (const event of collectScoredEvents([then, now])) {
    const pointsThen = eventPointsFor(then, event);
    const pointsNow = eventPointsFor(now, event);
    const delta = pointsNow - pointsThen;
    const swimmersChanged = changedByEvent.get(event)?.size ?? 0;
    if (Math.abs(delta) <= EPS && swimmersChanged === 0) continue;
    rows.push({ event, pointsThen, pointsNow, delta, swimmersChanged });
  }
  return rows;
}

/** event → set of changed swimmer/relay keys (for swimmersChanged counts). */
function markEventChanged(
  changedByEvent: Map<string, Set<string>>,
  event: string,
  key: string
): void {
  let keys = changedByEvent.get(event);
  if (!keys) {
    keys = new Set();
    changedByEvent.set(event, keys);
  }
  keys.add(key);
}

/** Top movers first, then alphabetical so equal swings order predictably. */
function byTopMover(a: ScenarioSwimmerDiff, b: ScenarioSwimmerDiff): number {
  return Math.abs(b.deltaPoints) - Math.abs(a.deltaPoints) || a.name.localeCompare(b.name);
}

function byLargestEventSwing(a: ScenarioEventDiff, b: ScenarioEventDiff): number {
  return Math.abs(b.delta) - Math.abs(a.delta) || a.event.localeCompare(b.event);
}

/**
 * Per-event / per-swimmer diff between a saved scenario snapshot (`snapshotContent`,
 * the "then" side) and the current lineup (`current`, the "now" side), scored
 * through the same what-if engine path. Relay point changes are attributed to a
 * relay row named by the relay event — never to individual leg swimmers.
 */
export function computeScenarioDiff(
  current: Workspace,
  snapshotContent: Workspace,
  opts: ScenarioDiffOptions
): ScenarioDiffResult {
  const then = scoreSide(snapshotContent, opts, opts.thenMode ?? 'whatIf');
  const now = scoreSide(current, opts, 'whatIf');

  const changedByEvent = new Map<string, Set<string>>();
  const markChanged = (event: string, key: string) =>
    markEventChanged(changedByEvent, event, key);

  // Both passes must run before the rollup: it reads the marks they leave, and
  // running it first measurably empties every swimmersChanged count.
  //
  // Individuals before relays is the original order, kept as-is. It is not
  // load-bearing on any data in this repo: the sort below breaks an equal-delta
  // tie by name, so this order could only show through for an individual and a
  // relay row sharing both a name and a |delta| — swapping the two passes
  // leaves every row of the golden corpus byte-identical.
  const swimmers = [
    ...buildIndividualDiffs(then, now, markChanged),
    ...buildRelayDiffs(then, now, markChanged),
  ];
  const events = buildEventDiffs(then, now, changedByEvent);

  swimmers.sort(byTopMover);
  events.sort(byLargestEventSwing);

  return {
    team: opts.team.trim(),
    gender: opts.gender,
    totals: { then: then.total, now: now.total, delta: now.total - then.total },
    swimmers,
    events,
  };
}
