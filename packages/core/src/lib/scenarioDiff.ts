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

type SwimmerSide = {
  displayName: string;
  /** event → contribution for change detection + per-event attribution. */
  byEvent: Map<string, { time: string; points: number }>;
  points: number;
};

type TeamSide = {
  /** Individuals keyed by canonical swimmer name. */
  individuals: Map<string, SwimmerSide>;
  /** Relay entries aggregated per event (points attributed to the relay row). */
  relays: Map<string, { time: string; points: number }>;
  total: number;
};

function scoreSide(
  workspace: Workspace,
  opts: ScenarioDiffOptions,
  mode: ScenarioDiffSideMode = 'whatIf'
): TeamSide {
  const ws: Workspace = opts.settings
    ? { ...workspace, scoringSettings: opts.settings }
    : workspace;
  // `baseline` must match buildScoringSnapshot's baseline bundle exactly, or a
  // baseline diff would disagree with the baseline total on the scoreboard.
  const isBaseline = mode === 'baseline';
  const bundle = buildScoringBundle({
    workspace: ws,
    gender: opts.gender,
    removeSeniors: isBaseline ? false : (opts.removeSeniors ?? false),
    applyWhatIf: !isBaseline,
    scorerRosterOverrides: isBaseline ? [] : ws.scorerRosterOverrides,
  });

  const teamKey = opts.team.trim();
  const rows = bundle.allScored.filter(
    r => String(r.team ?? '').trim() === teamKey && isCountedRow(r)
  );

  const individuals = new Map<string, SwimmerSide>();
  const relays = new Map<string, { time: string; points: number }>();
  let total = 0;

  for (const r of rows) {
    const pts = pointsOf(r);
    total += pts;
    const event = String(r.event ?? '').trim();
    if (isRelayResult(r)) {
      const prev = relays.get(event);
      const clock = relayTeamClock(r) || String(r.time ?? '').trim();
      if (prev) {
        prev.points += pts;
        // A/B relays or multi-leg rows: keep every distinct clock for change detection.
        if (clock && !prev.time.includes(clock)) {
          prev.time = prev.time ? `${prev.time}, ${clock}` : clock;
        }
      } else {
        relays.set(event, { time: clock, points: pts });
      }
      continue;
    }
    const key = canonicalSwimmerName(String(r.name ?? ''));
    let side = individuals.get(key);
    if (!side) {
      side = { displayName: String(r.name ?? '').trim(), byEvent: new Map(), points: 0 };
      individuals.set(key, side);
    }
    side.points += pts;
    const time = String(r.time ?? '').trim();
    const prev = side.byEvent.get(event);
    if (prev) {
      prev.points += pts;
      if (time && !prev.time.includes(time)) {
        prev.time = prev.time ? `${prev.time}, ${time}` : time;
      }
    } else {
      side.byEvent.set(event, { time, points: pts });
    }
  }

  return { individuals, relays, total };
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

  const swimmers: ScenarioSwimmerDiff[] = [];
  /** event → set of changed swimmer/relay keys (for swimmersChanged counts). */
  const changedByEvent = new Map<string, Set<string>>();
  const markChanged = (event: string, key: string) => {
    if (!changedByEvent.has(event)) changedByEvent.set(event, new Set());
    changedByEvent.get(event)!.add(key);
  };

  // ---- individuals -------------------------------------------------------
  const swimmerKeys = new Set([...then.individuals.keys(), ...now.individuals.keys()]);
  for (const key of swimmerKeys) {
    const t = then.individuals.get(key);
    const n = now.individuals.get(key);
    const eventsAdded: string[] = [];
    const eventsRemoved: string[] = [];
    const eventsChanged: ScenarioSwimmerDiff['eventsChanged'] = [];
    const events = new Set([...(t?.byEvent.keys() ?? []), ...(n?.byEvent.keys() ?? [])]);
    for (const event of events) {
      const te = t?.byEvent.get(event);
      const ne = n?.byEvent.get(event);
      if (te && !ne) {
        eventsRemoved.push(event);
        markChanged(event, key);
      } else if (!te && ne) {
        eventsAdded.push(event);
        markChanged(event, key);
      } else if (te && ne) {
        if (te.time !== ne.time) {
          eventsChanged.push({ event, timeThen: te.time, timeNow: ne.time });
          markChanged(event, key);
        } else if (Math.abs(te.points - ne.points) > EPS) {
          // Same swim, different points (field/caps moved around it).
          markChanged(event, key);
        }
      }
    }
    const pointsThen = t?.points ?? 0;
    const pointsNow = n?.points ?? 0;
    const deltaPoints = pointsNow - pointsThen;
    if (
      Math.abs(deltaPoints) <= EPS &&
      eventsAdded.length === 0 &&
      eventsRemoved.length === 0 &&
      eventsChanged.length === 0
    ) {
      continue;
    }
    swimmers.push({
      name: n?.displayName ?? t?.displayName ?? key,
      isRelay: false,
      eventsAdded: sortEventsByMeetOrder(eventsAdded),
      eventsRemoved: sortEventsByMeetOrder(eventsRemoved),
      eventsChanged,
      pointsThen,
      pointsNow,
      deltaPoints,
    });
  }

  // ---- relays (one row per relay event; points stay on the relay) --------
  const relayEvents = new Set([...then.relays.keys(), ...now.relays.keys()]);
  for (const event of relayEvents) {
    const t = then.relays.get(event);
    const n = now.relays.get(event);
    const relayKey = `relay:${event}`;
    const eventsAdded: string[] = [];
    const eventsRemoved: string[] = [];
    const eventsChanged: ScenarioSwimmerDiff['eventsChanged'] = [];
    if (t && !n) {
      eventsRemoved.push(event);
      markChanged(event, relayKey);
    } else if (!t && n) {
      eventsAdded.push(event);
      markChanged(event, relayKey);
    } else if (t && n) {
      if (t.time !== n.time) {
        eventsChanged.push({ event, timeThen: t.time, timeNow: n.time });
        markChanged(event, relayKey);
      } else if (Math.abs(t.points - n.points) > EPS) {
        markChanged(event, relayKey);
      }
    }
    const pointsThen = t?.points ?? 0;
    const pointsNow = n?.points ?? 0;
    const deltaPoints = pointsNow - pointsThen;
    if (
      Math.abs(deltaPoints) <= EPS &&
      eventsAdded.length === 0 &&
      eventsRemoved.length === 0 &&
      eventsChanged.length === 0
    ) {
      continue;
    }
    swimmers.push({
      name: event,
      isRelay: true,
      eventsAdded,
      eventsRemoved,
      eventsChanged,
      pointsThen,
      pointsNow,
      deltaPoints,
    });
  }

  // ---- per-event rollup --------------------------------------------------
  const eventPoints = (side: TeamSide, event: string): number => {
    let pts = side.relays.get(event)?.points ?? 0;
    for (const s of side.individuals.values()) {
      pts += s.byEvent.get(event)?.points ?? 0;
    }
    return pts;
  };
  const allEvents = new Set<string>();
  for (const side of [then, now]) {
    for (const s of side.individuals.values()) for (const e of s.byEvent.keys()) allEvents.add(e);
    for (const e of side.relays.keys()) allEvents.add(e);
  }
  const events: ScenarioEventDiff[] = [];
  for (const event of allEvents) {
    const pointsThen = eventPoints(then, event);
    const pointsNow = eventPoints(now, event);
    const delta = pointsNow - pointsThen;
    const swimmersChanged = changedByEvent.get(event)?.size ?? 0;
    if (Math.abs(delta) <= EPS && swimmersChanged === 0) continue;
    events.push({ event, pointsThen, pointsNow, delta, swimmersChanged });
  }

  swimmers.sort(
    (a, b) => Math.abs(b.deltaPoints) - Math.abs(a.deltaPoints) || a.name.localeCompare(b.name)
  );
  events.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.event.localeCompare(b.event));

  return {
    team: opts.team.trim(),
    gender: opts.gender,
    totals: { then: then.total, now: now.total, delta: now.total - then.total },
    swimmers,
    events,
  };
}
