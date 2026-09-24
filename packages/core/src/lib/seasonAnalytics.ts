import type { Workspace } from '../types';
import { isRankableSwim, swimEventIdentity } from './bestTimeEligibility';
import {
  courseOfRecordFromEventLabel,
  isDivingEvent,
  type CourseOfRecordFromLabel,
} from './cutlineEventNames';

export type SwimmerTrend = {
  name: string;
  /** The label of the first swim seen for this trend, as recorded. */
  event: string;
  /**
   * The course every swim on this trend was recorded in. A yards swim and a
   * metres swim of one event are two trends: their times are not comparable.
   * `METRIC_UNSPECIFIED` is a label that says metres but not which pool.
   */
  course: CourseOfRecordFromLabel;
  /** The fastest time, or for a dive the highest score. */
  bestTime: string;
  meetCount: number;
  progression: { label: string; time: string }[];
};

export type TeamScoreTrend = {
  meetLabel: string;
  menTotal: number;
  womenTotal: number;
};

export type SeasonTrends = {
  swimmerTrends: SwimmerTrend[];
  teamScoreTrends: TeamScoreTrend[];
};

function parseTimeSeconds(t: string): number {
  const parts = t.trim().split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(t) || Infinity;
}

/**
 * `candidate` beats `held` as a trend's best. A swim is better when faster. A
 * dive's `time` holds judged points, so a dive is better when higher. A value
 * that is not a number never beats a real one.
 */
function isBetterMark(event: string, candidate: string, held: string): boolean {
  const next = parseTimeSeconds(candidate);
  const prev = parseTimeSeconds(held);
  if (!isDivingEvent(event)) return next < prev;
  if (!Number.isFinite(next)) return false;
  return !Number.isFinite(prev) || next > prev;
}

/**
 * The course a trend row was recorded in: the row's own `timeType` when it
 * has one, then what its label states, then SCY. SCY is the default because
 * a meet result carries no course field and every meet label in this repo is
 * short-course yards (the same default `buildCutlineTag` uses).
 */
function trendCourse(event: string, timeType: string | undefined): CourseOfRecordFromLabel {
  if (timeType === 'SCY' || timeType === 'SCM' || timeType === 'LCM') return timeType;
  return courseOfRecordFromEventLabel(event) ?? 'SCY';
}

/**
 * One trend per swimmer, event and course.
 *
 * The event half is `swimEventIdentity`, so `Event 35 Men 100 Yard Freestyle`
 * and `100 Free SCY` are one event, and a time trial stays its own. The
 * course half keeps a yards swim and a metres swim of one event apart; a
 * pasted row puts its course in `timeType`, not the label, so the raw-label
 * key this replaces mixed them.
 */
function trendKey(name: string, event: string, course: CourseOfRecordFromLabel): string {
  return `${name.toLowerCase()}::${swimEventIdentity(event)}::${course}`;
}

export function buildSeasonTrends(workspaces: Workspace[]): SeasonTrends {
  const swimmerMap = new Map<string, SwimmerTrend>();

  const record = (
    name: string,
    event: string,
    time: string,
    course: CourseOfRecordFromLabel,
    label: string
  ) => {
    const key = trendKey(name, event, course);
    const existing = swimmerMap.get(key);
    const entry = { label, time };
    if (!existing) {
      swimmerMap.set(key, {
        name,
        event,
        course,
        bestTime: time,
        meetCount: 1,
        progression: [entry],
      });
      return;
    }
    existing.meetCount += 1;
    existing.progression.push(entry);
    if (isBetterMark(event, time, existing.bestTime)) {
      existing.bestTime = time;
    }
  };

  for (const ws of workspaces) {
    const meetLabel = ws.loadedMeet?.meetLabel ?? ws.name;
    for (const r of [...(ws.menResults ?? []), ...(ws.womenResults ?? [])]) {
      if (r.isRelay || !r.name || !r.event || typeof r.time !== 'string') continue;
      record(r.name, r.event, r.time, trendCourse(r.event, undefined), meetLabel);
    }
    for (const h of ws.athleteHistory ?? []) {
      if (!h.name || !h.event || !h.time) continue;
      // A self-reported time or an extracted split is not a race: it is never a
      // best and is no point on a progression. Both are read from the flag or
      // from a pasted row's badge. See isRankableSwim.
      if (!isRankableSwim(h)) continue;
      record(h.name, h.event, h.time, trendCourse(h.event, h.timeType), 'history');
    }
  }

  const teamScoreTrends: TeamScoreTrend[] = workspaces
    .filter(ws => ws.officialTeamScores || (ws.menResults?.length ?? 0) > 0)
    .map(ws => {
      // `officialTeamScores.men`/`.women` absent (no official totals loaded)
      // falls back to the calculated sum; present-but-zero is a real official
      // total and must survive, not be read as falsy and overwritten by the
      // calculated fallback (the exact absent-vs-empty confusion CLAUDE.md's
      // provenance rule 4 warns about).
      const menScores = ws.officialTeamScores?.men;
      const womenScores = ws.officialTeamScores?.women;
      const menOfficialTotal = menScores ? Object.values(menScores).reduce((a, b) => a + b, 0) : null;
      const womenOfficialTotal = womenScores
        ? Object.values(womenScores).reduce((a, b) => a + b, 0)
        : null;
      return {
        meetLabel: ws.loadedMeet?.meetLabel ?? ws.name,
        menTotal:
          menOfficialTotal ?? (ws.menResults ?? []).reduce((s, r) => s + (Number(r.points) || 0), 0),
        womenTotal:
          womenOfficialTotal ??
          (ws.womenResults ?? []).reduce((s, r) => s + (Number(r.points) || 0), 0),
      };
    });

  const swimmerTrends = [...swimmerMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  return { swimmerTrends, teamScoreTrends };
}
