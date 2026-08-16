/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two "cross-course" analyses proper:
 *
 *   1. buildCrossCourseTable — per swimmer x program event, actual SCY best vs
 *      best converted LCM/SCM (via convertSwimToSCY, which also remaps distance
 *      identity 400->500, 800->1000, 1500->1650), flagging rows where the
 *      converted time beats the actual SCY time.
 *   2. buildCoverageGaps — per program event, how thinly the team fields entries
 *      relative to the scoring depth / field size (uncontested-point spots).
 *
 * Test: npx tsx scripts/test_cross_course_arbitrage.mjs
 */

import { Gender, ScoringSettings, Workspace } from '../../types';
import { canonicalProgramEvent } from '../eventIdentity';
import { mergeScoringSettings } from '../scoringDefaults';
import { convertTimeToSeconds, isRelayResult, normalizeSwimmerName } from '../utils';
import {
  convertedHistorySwims,
  pickRecencyBest,
  planIsActive,
  teamHistoryWindow,
  type CrossCourseConvertedRef,
  type CrossCourseRow,
  type CrossCourseTable,
  type CrossCourseTimeRef,
} from './shared';

/** Canonical SCY individual program-event order (used to sort table + gaps). */
const PROGRAM_EVENT_ORDER: string[] = [
  '50 Freestyle',
  '100 Freestyle',
  '200 Freestyle',
  '500 Freestyle',
  '1000 Freestyle',
  '1650 Freestyle',
  '100 Backstroke',
  '200 Backstroke',
  '100 Breaststroke',
  '200 Breaststroke',
  '100 Butterfly',
  '200 Butterfly',
  '200 Individual Medley',
  '400 Individual Medley',
];

function programEventOrderIndex(event: string): number {
  const i = PROGRAM_EVENT_ORDER.indexOf(event);
  return i < 0 ? PROGRAM_EVENT_ORDER.length + 1 : i;
}

export type CoverageGap = {
  event: string;
  /** Distinct athletes from `team` entered in this event (active plans + results). */
  countTeamEntries: number;
  /** Distinct individual entries across all teams in results for this event. */
  fieldSize: number;
  /** Number of place-scoring slots (settings.scoringPoints.length). */
  scoringPlaces: number;
  /** Per-swimmer individual entry cap (settings.maxIndividualEntriesPerSwimmer). */
  capPerSwimmer: number;
  /** Scoring slots not yet filled by the field (max(0, scoringPlaces - fieldSize)). */
  openSlots: number;
  /** Sortable attractiveness score (higher = thinner coverage / more open points). */
  gapScore: number;
};

// --- cross-course best-time table -------------------------------------------

type EventBuckets = {
  scy: CrossCourseTimeRef[];
  converted: CrossCourseConvertedRef[];
};

/**
 * Per swimmer x SCY program event: actual SCY best vs best converted LCM/SCM.
 * Source is workspace.athleteHistory only (original rows are never mutated;
 * conversion happens on read). Program individual events only.
 */
export function buildCrossCourseTable(
  workspace: Workspace,
  opts: { team: string; gender: Gender; recencyMonths?: number }
): CrossCourseTable {
  const { history, cutoffMs } = teamHistoryWindow(workspace, opts);

  // athlete (display name) -> program event -> buckets
  const byAthlete = new Map<string, { display: string; events: Map<string, EventBuckets> }>();

  const getBuckets = (nameKey: string, display: string, event: string): EventBuckets => {
    let a = byAthlete.get(nameKey);
    if (!a) {
      a = { display, events: new Map() };
      byAthlete.set(nameKey, a);
    }
    let b = a.events.get(event);
    if (!b) {
      b = { scy: [], converted: [] };
      a.events.set(event, b);
    }
    return b;
  };

  for (const { swim: s, timeType, converted } of convertedHistorySwims(history)) {
    const programEvent = canonicalProgramEvent(converted.event);
    if (!programEvent) continue;
    const timeSec = convertTimeToSeconds(converted.time);
    if (!Number.isFinite(timeSec)) continue;

    const nameKey = normalizeSwimmerName(s.name);
    const buckets = getBuckets(nameKey, s.name, programEvent);
    if (timeType === 'SCY') {
      buckets.scy.push({
        time: converted.time,
        timeSec,
        meetLabel: s.meetLabel,
        date: s.date,
      });
    } else {
      buckets.converted.push({
        time: converted.time,
        timeSec,
        meetLabel: s.meetLabel,
        date: s.date,
        sourceTime: s.time,
        sourceCourse: timeType,
        sourceEvent: s.event,
      });
    }
  }

  const rows: CrossCourseRow[] = [];
  for (const { display, events } of byAthlete.values()) {
    for (const [event, buckets] of events) {
      const scyBest = pickRecencyBest(buckets.scy, cutoffMs);
      const convertedBest = pickRecencyBest(buckets.converted, cutoffMs);
      if (!scyBest && !convertedBest) continue;

      const convertedWins =
        !!convertedBest && (!scyBest || convertedBest.timeSec < scyBest.timeSec);
      const row: CrossCourseRow = {
        athlete: display,
        event,
        scyBest,
        convertedBest,
        effectiveBest: convertedWins ? 'converted' : 'scy',
      };
      if (scyBest && convertedBest && convertedBest.timeSec < scyBest.timeSec) {
        row.convertedWinsBy = Number((scyBest.timeSec - convertedBest.timeSec).toFixed(2));
      }
      rows.push(row);
    }
  }

  rows.sort((a, b) => {
    if (a.athlete !== b.athlete) return a.athlete.localeCompare(b.athlete);
    return programEventOrderIndex(a.event) - programEventOrderIndex(b.event);
  });

  return { rows };
}

// --- team coverage gaps -----------------------------------------------------

/**
 * Per program event: how thinly the team fields entries relative to scoring
 * depth and field size. No heuristic point guesses — just counts and a sortable
 * gapScore (higher = thinner coverage / more open uncontested points).
 */
export function buildCoverageGaps(
  workspace: Workspace,
  opts: { team: string; gender: Gender; settings?: ScoringSettings }
): CoverageGap[] {
  const team = opts.team.trim();
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const scoringPlaces = merged.scoringPoints.length;
  const capPerSwimmer = merged.maxIndividualEntriesPerSwimmer ?? 3;

  const results =
    opts.gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const activePlans = (workspace.meetEntryPlans ?? []).filter(
    p => p.gender === opts.gender && planIsActive(p, workspace.activeEntryIds)
  );

  // fieldSize (all teams) and team entry counts, per program event.
  const fieldByEvent = new Map<string, Set<string>>();
  const teamByEvent = new Map<string, Set<string>>();

  const noteField = (event: string, team_: string, name: string) => {
    let set = fieldByEvent.get(event);
    if (!set) {
      set = new Set();
      fieldByEvent.set(event, set);
    }
    set.add(`${team_}|${normalizeSwimmerName(name)}`);
  };
  const noteTeam = (event: string, name: string) => {
    let set = teamByEvent.get(event);
    if (!set) {
      set = new Set();
      teamByEvent.set(event, set);
    }
    set.add(normalizeSwimmerName(name));
  };

  for (const r of results) {
    if (r.gender != null && r.gender !== opts.gender) continue;
    if (isRelayResult(r)) continue;
    if (r.isExhibition || r.isTimeTrial) continue;
    const event = canonicalProgramEvent(r.event);
    if (!event) continue;
    const rTeam = String(r.team ?? '').trim();
    noteField(event, rTeam, r.name);
    if (rTeam === team) noteTeam(event, r.name);
  }
  for (const p of activePlans) {
    if (String(p.team ?? '').trim() !== team) continue;
    const event = canonicalProgramEvent(p.event);
    if (!event) continue;
    noteTeam(event, p.name);
  }

  const gaps: CoverageGap[] = PROGRAM_EVENT_ORDER.map(event => {
    const fieldSize = fieldByEvent.get(event)?.size ?? 0;
    const countTeamEntries = teamByEvent.get(event)?.size ?? 0;
    const openSlots = Math.max(0, scoringPlaces - fieldSize);
    // Thinner coverage ranks higher; a wholly un-entered event is the strongest gap.
    const gapScore = countTeamEntries === 0 ? openSlots + 1 : openSlots;
    return {
      event,
      countTeamEntries,
      fieldSize,
      scoringPlaces,
      capPerSwimmer,
      openSlots,
      gapScore,
    };
  });

  gaps.sort((a, b) => {
    if (b.gapScore !== a.gapScore) return b.gapScore - a.gapScore;
    return programEventOrderIndex(a.event) - programEventOrderIndex(b.event);
  });

  return gaps;
}
