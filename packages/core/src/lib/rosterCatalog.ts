/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browser-friendly client mirror of the server-side RosterCatalogService.
 *
 * Owns the canonical data shape used by Manager UI components and the
 * scoring engine. The server routes (`/api/roster/*`) speak this shape
 * verbatim, so the client never has to remap. Helpers here translate raw
 * pasted/CSV input into `CatalogEventTime` rows with their normalized SCY
 * companion already populated, regardless of course.
 */
import { Gender, NcaaDivision } from '../types';
import { convertTimeToSeconds, convertToSCY, normalizeSwimmerName } from './utils';
import { compareTimeToCutline } from './cutlineUtils';

export type CatalogGender = 'Men' | 'Women';
export type CatalogTimeType = 'SCY' | 'LCM' | 'SCM';
export type CatalogSource = 'paste' | 'csv' | 'ocr' | 'manual' | 'pdf' | 'json';
export type CatalogComputedCut = 'A' | 'B' | null;

export interface CatalogTeam {
  id: string;
  name: string;
  shortName?: string | null;
  division?: string | null;
  gender: CatalogGender;
  color?: string | null;
  notes?: string | null;
  sortIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogAthlete {
  id: string;
  teamId: string;
  fullName: string;
  nameKey: string;
  classYear?: string | null;
  gender: CatalogGender;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogEventTime {
  id: string;
  athleteId: string;
  event: string;
  timeText: string;
  timeSeconds: number;
  timeSecondsScy: number;
  timeType: CatalogTimeType;
  source: CatalogSource;
  swimcloudBadge?: string | null;
  computedCut?: CatalogComputedCut;
  meetLabel?: string | null;
  swimDate?: string | null;
  isEligible: boolean;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogTeamRoster {
  team: CatalogTeam;
  athletes: (CatalogAthlete & { times: CatalogEventTime[] })[];
}

export interface CatalogRosterExport {
  teams: CatalogTeam[];
  athletes: CatalogAthlete[];
  times: CatalogEventTime[];
}

// -------------------- Helpers --------------------

/** Strip a course suffix ("50 Free SCY") ΓåÆ "50 Free". */
export function stripCourseSuffix(event: string): string {
  return event.replace(/\b(SCY|LCM|SCM)\b/gi, '').replace(/\s+/g, ' ').trim();
}

/**
 * Build (or rebuild) a `CatalogEventTime` from raw input. Always populates
 * `timeSecondsScy` so downstream comparisons don't have to convert lazily.
 *
 * Acceptable forms:
 *  - `timeText: "20.84"`, `timeType: "SCY"`
 *  - `timeText: "23.45"`, `timeType: "LCM"` (converted via known factors)
 *  - `timeText: "1:45.08"`, `timeType: "SCY"`
 */
export function buildStoredSwim(args: {
  id?: string;
  athleteId: string;
  event: string;
  timeText: string;
  timeType: CatalogTimeType;
  source: CatalogSource;
  gender: Gender | CatalogGender;
  division?: NcaaDivision;
  swimcloudBadge?: string | null;
  meetLabel?: string | null;
  swimDate?: string | null;
  notes?: string | null;
  isEligible?: boolean;
}): CatalogEventTime {
  const now = Date.now();
  const event = stripCourseSuffix(args.event);
  const sec = convertTimeToSeconds(args.timeText);
  const scyText = convertToSCY(args.timeText, event, args.gender as Gender, args.timeType);
  const secScy = convertTimeToSeconds(scyText);

  // Only compute a cut for SCY-or-converted-to-SCY times; LCM/SCM should be
  // compared against cutlines in their native course where the table forbids
  // cross-course equivalents.
  const cut =
    args.division && Number.isFinite(secScy) && secScy > 0
      ? compareTimeToCutline(secScy, args.gender as Gender, event, args.division).achieved
      : null;

  return {
    id: args.id || `t_${now}_${Math.random().toString(36).slice(2, 8)}`,
    athleteId: args.athleteId,
    event,
    timeText: args.timeText,
    timeSeconds: Number.isFinite(sec) ? sec : 0,
    timeSecondsScy: Number.isFinite(secScy) ? secScy : 0,
    timeType: args.timeType,
    source: args.source,
    swimcloudBadge: args.swimcloudBadge ?? null,
    computedCut: cut,
    meetLabel: args.meetLabel ?? null,
    swimDate: args.swimDate ?? null,
    isEligible: args.isEligible === false ? false : true,
    notes: args.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Map `Gender` enum to `CatalogGender`. */
export function toCatalogGender(g: Gender): CatalogGender {
  return g === Gender.WOMEN ? 'Women' : 'Men';
}

/** Compute a stable lowercase name key from a swimmer's full name. */
export function athleteNameKey(name: string): string {
  return normalizeSwimmerName(name);
}

/** Pick the single best event per `event` (lowest SCY time). */
export function bestTimesByEvent(times: CatalogEventTime[]): Map<string, CatalogEventTime> {
  const map = new Map<string, CatalogEventTime>();
  for (const t of times) {
    const cur = map.get(t.event);
    if (!cur || t.timeSecondsScy < cur.timeSecondsScy) {
      map.set(t.event, t);
    }
  }
  return map;
}

/** Count of unique events the athlete has stored (any course/version). */
export function eventCountForAthlete(times: CatalogEventTime[]): number {
  return new Set(times.map(t => t.event)).size;
}

/** Events sorted by SCY ascending (best first). */
export function sortedTimesByScy(times: CatalogEventTime[]): CatalogEventTime[] {
  return [...times].sort((a, b) => a.timeSecondsScy - b.timeSecondsScy);
}

/** Filter times within a specific declared course ΓÇö handy for badges/tooltips. */
export function timesOfCourse(
  times: CatalogEventTime[],
  course: CatalogTimeType
): CatalogEventTime[] {
  return times.filter(t => t.timeType === course);
}

// -------------------- Eligibility helpers --------------------

/** Toggle one time record within an in-memory roster (used by UI before persist). */
export function toggleEligibilityInList(
  times: CatalogEventTime[],
  timeId: string,
  isEligible: boolean
): CatalogEventTime[] {
  return times.map(t => (t.id === timeId ? { ...t, isEligible, updatedAt: Date.now() } : t));
}

// -------------------- JSON Format (canonical) --------------------

/**
 * Canonical JSON shape used by the Manager import wizard. Validation happens
 * server-side; the wizard pre-checks the shape so most calls succeed.
 */
export interface RosterCatalogImportJson {
  team: {
    name: string;
    gender: CatalogGender;
    division?: NcaaDivision | string | null;
    shortName?: string | null;
    color?: string | null;
    notes?: string | null;
  };
  athletes: Array<{
    fullName: string;
    classYear?: string | null;
    events: Array<{
      event: string;
      timeText: string;
      timeType: CatalogTimeType;
      swimcloudBadge?: 'X' | 'U' | 'A' | 'B' | string | null;
      meetLabel?: string | null;
      swimDate?: string | null;
      isEligible?: boolean;
    }>;
  }>;
}

/**
 * Quick shape check used by the wizard before posting to the server. Returns
 * `null` when valid; otherwise returns a list of human-readable issues with
 * the failing JSON path.
 */
export function validateRosterCatalogJson(raw: unknown): string[] | null {
  const issues: string[] = [];
  if (raw == null || typeof raw !== 'object') {
    issues.push('Top-level value must be an object');
    return issues;
  }
  const root = raw as Record<string, unknown>;
  const team = root.team as Record<string, unknown> | undefined;
  if (!team || typeof team.name !== 'string' || !team.name.trim()) {
    issues.push('team.name must be a non-empty string');
  }
  if (team && team.gender !== 'Men' && team.gender !== 'Women') {
    issues.push("team.gender must be 'Men' or 'Women'");
  }
  const athletes = Array.isArray(root.athletes) ? root.athletes : null;
  if (!athletes) {
    issues.push('athletes must be an array');
    return issues;
  }
  athletes.forEach((a, i) => {
    if (!a || typeof a !== 'object') {
      issues.push(`athletes[${i}] must be an object`);
      return;
    }
    const ath = a as Record<string, unknown>;
    if (typeof ath.fullName !== 'string' || !ath.fullName.trim()) {
      issues.push(`athletes[${i}].fullName must be a non-empty string`);
    }
    if (!Array.isArray(ath.events)) {
      issues.push(`athletes[${i}].events must be an array`);
      return;
    }
    (ath.events as unknown[]).forEach((e, j) => {
      if (!e || typeof e !== 'object') {
        issues.push(`athletes[${i}].events[${j}] must be an object`);
        return;
      }
      const ev = e as Record<string, unknown>;
      if (typeof ev.event !== 'string') issues.push(`athletes[${i}].events[${j}].event required`);
      if (typeof ev.timeText !== 'string')
        issues.push(`athletes[${i}].events[${j}].timeText required`);
      if (ev.timeType !== 'SCY' && ev.timeType !== 'LCM' && ev.timeType !== 'SCM') {
        issues.push(`athletes[${i}].events[${j}].timeType must be SCY|LCM|SCM`);
      }
    });
  });
  if (issues.length > 0) return issues;
  return null;
}

// -------------------- Stat helpers --------------------

/** Compact "athlete├ùevents" summary string. */
export function rosterSummary(roster: CatalogTeamRoster): {
  athleteCount: number;
  eventCount: number;
  eligibleEventCount: number;
} {
  let eligible = 0;
  let total = 0;
  for (const a of roster.athletes) {
    for (const t of a.times) {
      total++;
      if (t.isEligible) eligible++;
    }
  }
  return {
    athleteCount: roster.athletes.length,
    eventCount: total,
    eligibleEventCount: eligible,
  };
}

/** Re-export to keep consumers from needing the utils module separately. */
export { convertTimeToSeconds };
