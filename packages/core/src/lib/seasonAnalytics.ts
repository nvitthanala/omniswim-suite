import type { Workspace } from '../types';
import { isRankableSwim, isRelayShapedEventLabel, swimEventIdentity } from './bestTimeEligibility';
import {
  courseOfRecordFromEventLabel,
  isDivingEvent,
  normalizeEventForCutline,
  type CourseOfRecordFromLabel,
} from './cutlineEventNames';
import { isTheoreticalMeet } from './theoreticalMeetLabel';
import { matchOfficialTeamKey } from './teamScoreMatching';
import { recordAt } from './indexedAccess';

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

/**
 * One chosen team's score in one meet.
 *
 * A meet the team did not enter has NO entry in `teamScoreTrends` at all. A
 * gender the team did not enter in a meet it did is `null` — absent, not 0.
 * A real 0 (the team entered and scored nothing) stays 0.
 */
export type TeamScoreTrend = {
  meetLabel: string;
  /** The chosen team's men's score in this meet, or `null` when the meet holds none for it. */
  menTotal: number | null;
  /** The chosen team's women's score in this meet, or `null` when the meet holds none for it. */
  womenTotal: number | null;
  /** Where each total came from. `null` exactly when its total is `null`. */
  menSource: TeamScoreSource | null;
  womenSource: TeamScoreSource | null;
  /**
   * Rows of the chosen team in this meet whose points could not be read as a
   * number. They are skipped, not counted as 0, so a non-zero value here means
   * a calculated total is a lower bound.
   */
  unreadablePointRows: number;
};

/** A total taken from the meet's published team scores, or summed from the team's calculated rows. */
export type TeamScoreSource = 'official' | 'calculated';

/** Why `teamScoreTrends` holds what it holds. A picker reads this; an empty list alone does not say. */
export type TeamScoreSelection =
  /** A team was chosen: passed in, or the only team the meets name. */
  | 'chosen'
  /** No team was passed and the meets name more than one. Nothing is plotted until one is chosen. */
  | 'team-required'
  /** The meets name no team at all. */
  | 'no-teams'
  /** A team was passed that no meet names. Plotting nothing is the answer; it is not a score of 0. */
  | 'team-not-in-any-meet';

export type SeasonTrendsOptions = {
  /**
   * The team whose score is plotted, matched on its trimmed, case-folded name.
   * Omit it to get the only team the meets name when there is exactly one. With
   * several, `teamScoreSelection` is `'team-required'` and no point is emitted.
   * {@link defaultSeasonTeam} reads the active workspace's own team.
   */
  team?: string;
};

export type SeasonTrends = {
  swimmerTrends: SwimmerTrend[];
  /** The chosen team's score per meet it entered. A meet without the team is absent. */
  teamScoreTrends: TeamScoreTrend[];
  /** The team `teamScoreTrends` is for, as the meets spell it, or `null` when none is chosen. */
  team: string | null;
  /** Every team the (non-theoretical) meets name, sorted by name: the picker's list. */
  availableTeams: string[];
  teamScoreSelection: TeamScoreSelection;
  /** Sum of `unreadablePointRows` over `teamScoreTrends`. */
  unreadablePointRows: number;
};

const teamKey = (name: unknown): string => String(name ?? '').trim().toLowerCase();

/** Collects names once each, first spelling wins. */
function nameCollector() {
  const seen = new Map<string, string>();
  return {
    add(name: unknown) {
      const key = teamKey(name);
      if (key && !seen.has(key)) seen.set(key, String(name).trim());
    },
    values: () => [...seen.values()],
  };
}

/**
 * Every team the meets name, from their result rows and their published team
 * scores, once each and sorted by name. A theoretical meet is left out: nobody
 * swam it.
 */
export function seasonTeams(allWorkspaces: Workspace[]): string[] {
  const names = nameCollector();
  for (const ws of allWorkspaces) {
    if (isTheoreticalMeet(ws)) continue;
    const rowTeams = nameCollector();
    for (const r of ws.menResults ?? []) rowTeams.add(r.team);
    for (const r of ws.womenResults ?? []) rowTeams.add(r.team);
    for (const name of rowTeams.values()) names.add(name);
    // A published team score names a team no row carries only when the meet
    // lists a team nobody swam for. A key a row's team already matches is the
    // same team under the printed spelling ("Henderson State University
    // Henderson State University"), not another one.
    for (const block of [ws.officialTeamScores?.men, ws.officialTeamScores?.women]) {
      if (!block) continue;
      const claimed = new Set(rowTeams.values().map(t => matchOfficialTeamKey(t, block)));
      for (const key of Object.keys(block)) if (!claimed.has(key)) names.add(key);
    }
  }
  return names.values().sort((a, b) => a.localeCompare(b));
}

/**
 * The team a workspace is about: the one team its rows (results, recruits,
 * planned entries) name, or `null` when they name none or more than one.
 *
 * Never a guess. A workspace that mixes teams has no single "own team" in its
 * data, so this answers `null` and a picker must ask.
 */
export function defaultSeasonTeam(workspace: Workspace | null | undefined): string | null {
  if (!workspace) return null;
  const names = nameCollector();
  for (const r of workspace.menResults ?? []) names.add(r.team);
  for (const r of workspace.womenResults ?? []) names.add(r.team);
  for (const r of workspace.recruits ?? []) names.add(r.team);
  for (const r of workspace.meetEntryPlans ?? []) names.add(r.team);
  const all = names.values();
  return all.length === 1 ? (all[0] ?? null) : null;
}

type GenderScore = { total: number | null; source: TeamScoreSource | null; unreadable: number };

const NO_SCORE: GenderScore = { total: null, source: null, unreadable: 0 };

/**
 * The score of one team in one gender's block of a meet: the published total
 * when the meet published that block, else the sum of the team's calculated rows.
 * `total` is `null` when the meet holds nothing for the team.
 */
function teamScoreForGender(
  published: Record<string, number> | undefined,
  rows: Workspace['menResults'],
  team: string
): GenderScore {
  const wanted = teamKey(team);
  if (published) {
    // The same ambiguity-safe matcher the reconciliation view uses: a printed
    // "Henderson State University Henderson State University" is this team.
    const key = matchOfficialTeamKey(team, published);
    // A published total is a published total, 0 included.
    if (key !== undefined) return { total: recordAt(published, key), source: 'official', unreadable: 0 };
    // Published, and this team's name matched no entry. The rows below say
    // whether the team swam at all: if it did, its calculated sum is shown and
    // labelled as calculated; if not, the meet holds no score for it.
  }
  let total = 0;
  let found = false;
  let unreadable = 0;
  for (const r of rows ?? []) {
    if (teamKey(r.team) !== wanted) continue;
    found = true;
    const points = typeof r.points === 'number' ? r.points : Number(r.points);
    if (r.points == null || r.points === '' || !Number.isFinite(points)) unreadable += 1;
    else total += points;
  }
  return found ? { total, source: 'calculated', unreadable } : NO_SCORE;
}

function parseTimeSeconds(t: string): number {
  const parts = t.trim().split(':');
  const [minutes, seconds] = parts;
  if (parts.length === 2 && minutes !== undefined && seconds !== undefined) {
    return parseFloat(minutes) * 60 + parseFloat(seconds);
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

/**
 * Which team the score trend plots. A requested team must be one the meets
 * name; with no request, the one team the meets name; with several, none (a
 * caller must choose). Never a guess.
 */
function selectSeasonTeam(
  availableTeams: string[],
  requestedTeam: string | undefined
): { team: string | null; selection: TeamScoreSelection } {
  const requested = requestedTeam?.trim() ? requestedTeam : undefined;
  if (requested !== undefined) {
    const team = availableTeams.find(t => teamKey(t) === teamKey(requested)) ?? null;
    return { team, selection: team === null ? 'team-not-in-any-meet' : 'chosen' };
  }
  const [onlyTeam] = availableTeams;
  if (availableTeams.length === 1 && onlyTeam !== undefined) return { team: onlyTeam, selection: 'chosen' };
  return { team: null, selection: availableTeams.length === 0 ? 'no-teams' : 'team-required' };
}

/**
 * One point per meet that holds a score for `team`. `officialTeamScores` absent
 * (no official totals loaded) falls back to the sum of the team's calculated
 * rows; a published 0 is a real total and survives (CLAUDE.md provenance rule
 * 4). A meet that holds no score for the team emits no point: absent, not 0.
 */
function teamScoreTrendsFor(workspaces: Workspace[], team: string): TeamScoreTrend[] {
  const out: TeamScoreTrend[] = [];
  for (const ws of workspaces) {
    const men = teamScoreForGender(ws.officialTeamScores?.men, ws.menResults, team);
    const women = teamScoreForGender(ws.officialTeamScores?.women, ws.womenResults, team);
    if (men.total === null && women.total === null) continue;
    out.push({
      meetLabel: ws.loadedMeet?.meetLabel ?? ws.name,
      menTotal: men.total,
      womenTotal: women.total,
      menSource: men.source,
      womenSource: women.source,
      unreadablePointRows: men.unreadable + women.unreadable,
    });
  }
  return out;
}

/**
 * A theoretical meet is skipped. Nobody swam it: its rows are all-time bests laid out as a meet, and its points
 * and estimated relays are projections. Counting them would put a meet that never happened on the cross-meet
 * chart and add best times to a swimmer's progression a second time.
 */
export function buildSeasonTrends(
  allWorkspaces: Workspace[],
  options: SeasonTrendsOptions = {}
): SeasonTrends {
  const workspaces = allWorkspaces.filter(ws => !isTheoreticalMeet(ws));
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

  const availableTeams = seasonTeams(workspaces);
  const { team, selection: teamScoreSelection } = selectSeasonTeam(availableTeams, options.team);
  const teamScoreTrends = team === null ? [] : teamScoreTrendsFor(workspaces, team);

  const swimmerTrends = [...swimmerMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  return {
    swimmerTrends,
    teamScoreTrends,
    team,
    availableTeams,
    teamScoreSelection,
    unreadablePointRows: teamScoreTrends.reduce((n, t) => n + t.unreadablePointRows, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Season progression: one swimmer, one event, meet by meet                    */
/* -------------------------------------------------------------------------- */

/** One meet on the progression's shared axis: a meet the chosen team swam the chosen event at. */
export type ProgressionMeet = {
  /** The workspace id. Two meets can share a label; they never share an id. */
  id: string;
  label: string;
};

/** A swimmer's measured time at one meet. When they swam the event twice there, the faster swim. */
export type ProgressionPoint = {
  time: string;
  /** `time` in seconds, read from the recorded text. */
  seconds: number;
  /** How many swims of the event the swimmer has at this meet. 2 means prelims and finals. */
  swimsAtMeet: number;
};

export type SwimmerProgression = {
  name: string;
  /**
   * One slot per entry of `meets`, in that order. `null` means the swimmer has no
   * measured time at that meet: a gap, never an interpolated or zero value.
   */
  points: (ProgressionPoint | null)[];
  /** Meets with a point. */
  meetsSwum: number;
  /** Index into `meets` of the first meet with a point. */
  firstIndex: number;
  /** Index into `meets` of the fastest point; the earliest meet when two tie. */
  bestIndex: number;
  firstTime: string;
  bestTime: string;
  /**
   * Seconds from the first meet's time to the best time, to the hundredth. `null`
   * with a single meet (no drop to measure yet). `0` is a real answer: the first
   * swim is still the best.
   */
  dropSeconds: number | null;
};

export type ProgressionEventOption = {
  /** Pass this as `eventKey`. Event identity plus course. */
  key: string;
  /** The published event name, e.g. `100 Freestyle`, with ` time trial` when it is one. */
  label: string;
  course: CourseOfRecordFromLabel;
  swimmerCount: number;
};

export type SeasonProgressionsOptions = {
  /** The team to read, as `buildSeasonTrends` resolved it (`SeasonTrends.team`). `null` reads none. */
  team: string | null;
  /** An option's `key`. Absent or unknown, the event most of the team's swimmers swam is read. */
  eventKey?: string | null;
};

export type SeasonProgressions = {
  team: string | null;
  /** Every event the team has a result row in, dives and relays left out. Empty when `team` is `null`. */
  events: ProgressionEventOption[];
  /** The option that was read, or `null` when there are no events. */
  selectedEventKey: string | null;
  /** The meets the team swam the selected event at, in workspace-list order (no meet date is stored). */
  meets: ProgressionMeet[];
  /** One per swimmer of the team, sorted by name. */
  swimmers: SwimmerProgression[];
  /** Rows of the selected event whose time could not be read as a time. They are left out, not counted as 0. */
  unreadableTimeRows: number;
};

/**
 * `52.10`, `1:02.00`, `15:12.5`, and the same with HyTek's record flag (`54.86R`).
 * Anything else (`DQ`, `NS`, `52.10x`, `-`) is not a time.
 */
const MEASURED_TIME = /^(?:(\d{1,2}):([0-5]\d(?:\.\d{1,3})?)|(\d{1,2}(?:\.\d{1,3})?))R?$/;

function measuredSeconds(time: unknown): number | null {
  if (typeof time !== 'string') return null;
  const m = MEASURED_TIME.exec(time.trim());
  if (!m) return null;
  const seconds = m[1] !== undefined && m[2] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

const hundredths = (seconds: number): number => Math.round(seconds * 100) / 100;

type ProgressionSwim = {
  workspaceId: string;
  meetLabel: string;
  name: string;
  eventKey: string;
  eventLabel: string;
  course: CourseOfRecordFromLabel;
  time: string;
  seconds: number | null;
};

/** The swims of one team that can sit on a progression: not a relay, a dive, a projection or a seed. */
function progressionSwimsOf(allWorkspaces: Workspace[], team: string): ProgressionSwim[] {
  const wanted = teamKey(team);
  const swims: ProgressionSwim[] = [];
  for (const ws of allWorkspaces) {
    if (isTheoreticalMeet(ws)) continue;
    const meetLabel = ws.loadedMeet?.meetLabel ?? ws.name;
    for (const r of [...(ws.menResults ?? []), ...(ws.womenResults ?? [])]) {
      if (teamKey(r.team) !== wanted) continue;
      if (r.isRelay || r.isPsychSheet || r.isRecruit || r.convertedFrom) continue;
      if (!r.name || !r.event || isRelayShapedEventLabel(r.event) || isDivingEvent(r.event)) continue;
      const course = trendCourse(r.event, undefined);
      const raw = String(r.event).replace(/\s+/g, ' ').trim();
      const base = normalizeEventForCutline(raw) || raw;
      const identity = swimEventIdentity(r.event);
      swims.push({
        workspaceId: ws.id,
        meetLabel,
        name: r.name,
        eventKey: `${identity}::${course}`,
        eventLabel: identity.endsWith(' time trial') ? `${base} time trial` : base,
        course,
        time: String(r.time ?? '').trim().replace(/R$/, ''),
        seconds: measuredSeconds(r.time),
      });
    }
  }
  return swims;
}

/**
 * The events the team has a row in. An event whose every time is unreadable is
 * still listed, with no swimmers, so the unreadable count is not silent.
 */
function progressionEventsOf(swims: readonly ProgressionSwim[]): ProgressionEventOption[] {
  const found = new Map<string, { label: string; course: CourseOfRecordFromLabel; swimmers: Set<string> }>();
  for (const s of swims) {
    const held = found.get(s.eventKey) ?? { label: s.eventLabel, course: s.course, swimmers: new Set<string>() };
    if (s.seconds !== null) held.swimmers.add(s.name.toLowerCase());
    found.set(s.eventKey, held);
  }
  return [...found.entries()]
    .map(([key, v]) => ({ key, label: v.label, course: v.course, swimmerCount: v.swimmers.size }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.course.localeCompare(b.course));
}

/** The faster of two points at one meet, with the count of swims there. */
function mergePointsAtMeet(held: ProgressionPoint | null, time: string, seconds: number): ProgressionPoint {
  if (held === null) return { time, seconds, swimsAtMeet: 1 };
  return {
    time: seconds < held.seconds ? time : held.time,
    seconds: Math.min(seconds, held.seconds),
    swimsAtMeet: held.swimsAtMeet + 1,
  };
}

/** One slot per meet for each swimmer. `swims` are the readable swims of one event. */
function progressionSlotsOf(
  swims: readonly ProgressionSwim[],
  meets: readonly ProgressionMeet[]
): Map<string, { name: string; slots: (ProgressionPoint | null)[] }> {
  const byName = new Map<string, { name: string; slots: (ProgressionPoint | null)[] }>();
  for (const s of swims) {
    if (s.seconds === null) continue;
    const key = s.name.toLowerCase();
    const entry = byName.get(key) ?? { name: s.name, slots: meets.map(() => null) };
    byName.set(key, entry);
    const at = meets.findIndex(m => m.id === s.workspaceId);
    entry.slots[at] = mergePointsAtMeet(entry.slots[at] ?? null, s.time.trim(), s.seconds);
  }
  return byName;
}

/** First meet, fastest meet and drop for one swimmer's slots. `null` when every slot is a gap. */
function summarizeProgression(name: string, slots: (ProgressionPoint | null)[]): SwimmerProgression | null {
  let firstIndex = -1;
  let bestIndex = -1;
  let meetsSwum = 0;
  slots.forEach((p, i) => {
    if (p === null) return;
    meetsSwum += 1;
    if (firstIndex === -1) firstIndex = i;
    const best = bestIndex === -1 ? null : slots[bestIndex];
    if (!best || p.seconds < best.seconds) bestIndex = i;
  });
  const first = slots[firstIndex];
  const best = slots[bestIndex];
  if (!first || !best) return null;
  return {
    name,
    points: slots,
    meetsSwum,
    firstIndex,
    bestIndex,
    firstTime: first.time,
    bestTime: best.time,
    dropSeconds: meetsSwum < 2 ? null : hundredths(first.seconds - best.seconds),
  };
}

/**
 * Each swimmer's measured times across the meets the team swam, for one event.
 *
 * Only what was swum counts: a meet's own result rows. Athlete history rows are
 * left out (they belong to no meet, so they have no place in a season, and an
 * old personal best would become the "first swim"). Relays, dives (scored in
 * points, higher is better), psych sheet rows, recruit rows and converted
 * projections are left out. A theoretical meet is skipped, as in
 * {@link buildSeasonTrends}.
 *
 * The axis is the meets (workspaces) the team swam the event at, in workspace
 * order, which is the workspace list's order (`sort_index`, then `created_at`;
 * a user can reorder it). No meet date is stored, so that is the only order
 * there is, and the same one `teamScoreTrends` uses. A swimmer who missed one of those meets has a `null`
 * point there.
 */
export function buildSeasonProgressions(
  allWorkspaces: Workspace[],
  options: SeasonProgressionsOptions
): SeasonProgressions {
  const empty: SeasonProgressions = {
    team: options.team,
    events: [],
    selectedEventKey: null,
    meets: [],
    swimmers: [],
    unreadableTimeRows: 0,
  };
  if (options.team === null) return empty;

  const swims = progressionSwimsOf(allWorkspaces, options.team);
  const events = progressionEventsOf(swims);
  const [firstEvent] = events;
  if (firstEvent === undefined) return empty;

  const requested = options.eventKey ?? null;
  const chosen =
    events.find(e => e.key === requested) ??
    events.reduce((top, e) => (e.swimmerCount > top.swimmerCount ? e : top), firstEvent);

  const ofEvent = swims.filter(s => s.eventKey === chosen.key);
  const readable = ofEvent.filter(s => s.seconds !== null);
  const meets: ProgressionMeet[] = [];
  for (const s of readable) {
    if (!meets.some(m => m.id === s.workspaceId)) meets.push({ id: s.workspaceId, label: s.meetLabel });
  }

  const swimmers: SwimmerProgression[] = [];
  for (const { name, slots } of progressionSlotsOf(readable, meets).values()) {
    const summary = summarizeProgression(name, slots);
    if (summary) swimmers.push(summary);
  }
  swimmers.sort((a, b) => a.name.localeCompare(b.name));

  return {
    team: options.team,
    events,
    selectedEventKey: chosen.key,
    meets,
    swimmers,
    unreadableTimeRows: ofEvent.length - readable.length,
  };
}
