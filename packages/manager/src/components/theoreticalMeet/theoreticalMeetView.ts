/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view model for the "Build theoretical meet" dialog. No React, no fetch, no clock
 * (callers pass `now`). Everything shown is read from the data layer's own output
 * (`theoreticalMeetFromCaptures`, `buildTheoreticalMeetSeeds`, `buildTheoreticalMeetWorkspace`).
 * Nothing here computes a competition value, a cut, or a roster fact.
 *
 * What this file decides, and only this:
 * - which captures can be picked, and why a capture cannot (`groupCaptures`);
 * - how old a capture is, in words (`describeCaptureAge`);
 * - one plain sentence for each error code the builders can throw (`describeTheoreticalError`);
 * - which scoring presets the picker offers and what each one resolves to (`buildScoringChoices`);
 * - which loaded meets can lend their event order (`eventOrderChoices`);
 * - the preview rows, the warnings and the caveat list (`buildPreviewModel`).
 */

import { Gender } from '@omniswim/core/types';
import { resolveTeamDivision } from '@omniswim/core/data/teamDivisions';
import type { NcaaDivision, ScoringSettings, SwimmerResult, Workspace } from '@omniswim/core/types';
import {
  BUILT_IN_SCORING_PRESETS,
  presetIdForConference,
  settingsForBuiltInScoringPreset,
} from '@omniswim/core/lib/scoringDefaults';
import {
  TheoreticalCaptureError,
  type TheoreticalCaptureErrorCode,
  type TheoreticalCaptureRecord,
  type TheoreticalMeetFromCapturesResult,
} from '../../lib/theoreticalMeetFromCaptures';
import {
  RELAYS_EXCLUDED_CAVEAT,
  TheoreticalMeetError,
  type TheoreticalMeetErrorCode,
  type TheoreticalMeetSeeds,
  type TheoreticalNoSeedAthlete,
} from '../../lib/theoreticalMeetSeeds';
import {
  TheoreticalWorkspaceError,
  isTheoreticalMeet,
  theoreticalEventOrderFromMeetResults,
  type TheoreticalMeetWorkspaceBuild,
  type TheoreticalWorkspaceErrorCode,
} from '../../lib/theoreticalMeetWorkspace';

/* -------------------------------------------------------------------------- */
/* Captures: grouping, eligibility, age                                        */
/* -------------------------------------------------------------------------- */

/** A capture older than this many days gets a stale hint. The age is always shown too. */
export const STALE_CAPTURE_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * What `GET /api/swimcloud/captures` returns for one capture, as far as this dialog reads it.
 * The data layer's own record type, plus the fields the list shows.
 */
export interface CaptureListRecord extends TheoreticalCaptureRecord {
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly label?: string;
  /** The school name the server read from the stored roster pages. Absent when none was readable. */
  readonly teamName?: string;
  /** Set when the roster pages of the capture print different names. Then no name is shown. */
  readonly teamNameWarning?: string;
}

export interface CaptureRow {
  readonly captureId: string;
  readonly teamId: string;
  readonly season: string | null;
  readonly status: 'ready' | 'blocked';
  /** Present when `status` is `blocked`: why the capture cannot be used yet. */
  readonly blockedReason: string | null;
  /** `YYYY-MM-DD` (UTC) of the newest stored page, or null when no time is recorded. */
  readonly capturedOn: string | null;
  /** Whole days since the capture, or null when no time is recorded. */
  readonly ageDays: number | null;
  /** Always set. "Captured 12 days ago." or "Capture time not recorded." */
  readonly ageText: string;
  /** Set only when the capture is older than {@link STALE_CAPTURE_DAYS}. States the age. */
  readonly staleHint: string | null;
  readonly pagesStored: number;
  readonly pagesPlanned: number;
  /** Stored swimmer-times pages. One per swimmer, so this is how many swimmers have times. */
  readonly swimmersCaptured: number;
  /** "14 of 14 planned pages stored. 6 swimmers with times." */
  readonly coverageText: string;
}

export interface CaptureTeamGroup {
  readonly teamId: string;
  readonly title: string;
  /** True when `title` is a school name. False means the title is the numeric team id. */
  readonly named: boolean;
  /** Division tag for the school name. `unknown division` when unnamed or not in the division table. */
  readonly divisionTag: DivisionTag;
  /** Why the school name is not shown, when two sources disagree. */
  readonly nameWarning: string | null;
  readonly rows: readonly CaptureRow[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function newestPageTime(record: CaptureListRecord): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const page of record.pages) {
    if (page.outcome !== 'ok') continue;
    const ms = Date.parse(page.retrievedAt);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = page.retrievedAt;
    }
  }
  if (best !== undefined) return best;
  return record.updatedAt !== undefined && Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : undefined;
}

/** The age sentence for a capture time. `staleHint` is set when the age passes {@link STALE_CAPTURE_DAYS}. */
export function describeCaptureAge(
  capturedAt: string | undefined,
  now: number
): { capturedOn: string | null; ageDays: number | null; ageText: string; staleHint: string | null } {
  const ms = capturedAt === undefined ? Number.NaN : Date.parse(capturedAt);
  if (!Number.isFinite(ms)) {
    return { capturedOn: null, ageDays: null, ageText: 'Capture time not recorded.', staleHint: null };
  }
  const ageDays = Math.max(0, Math.floor((now - ms) / DAY_MS));
  const when = ageDays === 0 ? 'today' : `${plural(ageDays, 'day')} ago`;
  const stale = ageDays > STALE_CAPTURE_DAYS;
  return {
    capturedOn: new Date(ms).toISOString().slice(0, 10),
    ageDays,
    ageText: `Captured ${when}.`,
    staleHint: stale
      ? `This capture is ${plural(ageDays, 'day')} old. Times may be out of date. Crawl the team again for fresh times.`
      : null,
  };
}

function blockedReason(record: CaptureListRecord): string | null {
  switch (record.completeness) {
    case 'every-planned-page-fetched':
      return record.pages.length === 0 ? 'The capture holds no pages.' : null;
    case 'in-progress':
      return 'The crawl is still running. Wait for it to finish.';
    case 'partial': {
      const missing = Math.max(0, record.plannedPageCount - record.pages.length);
      return missing > 0
        ? `The crawl stopped early. ${plural(missing, 'planned page')} not stored. Crawl the team again.`
        : 'The crawl stopped early. Crawl the team again.';
    }
    case 'failed':
      return 'The crawl failed. Crawl the team again.';
    default:
      return 'The capture state is not recognized.';
  }
}

function captureRow(record: CaptureListRecord, now: number): CaptureRow {
  const subject = record.subject;
  const teamId = subject.kind === 'team' ? subject.teamId : '';
  const season = subject.kind === 'team' && subject.season !== undefined ? subject.season : null;
  const reason = blockedReason(record);
  const age = describeCaptureAge(newestPageTime(record), now);
  const okPages = record.pages.filter(page => page.outcome === 'ok');
  const swimmersCaptured = okPages.filter(page => page.resourceKind === 'swimmerFastestTimes').length;
  const planned = record.plannedPageCount;
  const stored = okPages.length;
  const pages =
    planned > 0 ? `${stored} of ${plural(planned, 'planned page')} stored.` : `${plural(stored, 'page')} stored. No crawl plan was recorded.`;
  return {
    captureId: record.captureId,
    teamId,
    season,
    status: reason === null ? 'ready' : 'blocked',
    blockedReason: reason,
    capturedOn: age.capturedOn,
    ageDays: age.ageDays,
    ageText: age.ageText,
    staleHint: age.staleHint,
    pagesStored: stored,
    pagesPlanned: planned,
    swimmersCaptured,
    coverageText: `${pages} ${plural(swimmersCaptured, 'swimmer')} with times.`,
  };
}

/**
 * Team captures grouped by team. A meet capture is not a team and is left out. Within a team the
 * newest season comes first; ready captures come before blocked ones inside a season.
 */
export function groupCaptures(records: readonly CaptureListRecord[], now: number): CaptureTeamGroup[] {
  const groups = new Map<string, { names: Set<string>; warnings: Set<string>; rows: CaptureRow[] }>();
  for (const record of records) {
    if (record.subject.kind !== 'team') continue;
    const row = captureRow(record, now);
    const group = groups.get(row.teamId) ?? { names: new Set<string>(), warnings: new Set<string>(), rows: [] };
    groups.set(row.teamId, group);
    group.rows.push(row);
    const name = (record.teamName ?? record.label ?? '').trim();
    if (name.length > 0) group.names.add(name);
    if (record.teamNameWarning !== undefined) group.warnings.add(record.teamNameWarning);
  }
  return [...groups.entries()]
    .map(([teamId, group]) => {
      const disagree = group.names.size > 1;
      const named = group.names.size === 1 && group.warnings.size === 0;
      const name = named ? [...group.names][0] : null;
      const nameWarning = disagree
        ? `The captures of team ${teamId} carry different school names (${[...group.names].join(' / ')}), so no school name is shown.`
        : group.warnings.size > 0
          ? [...group.warnings][0]
          : null;
      return {
        teamId,
        title: name ?? `Team ${teamId}`,
        named,
        divisionTag: teamDivisionTag(name),
        nameWarning,
        rows: [...group.rows].sort(
          (a, b) => (b.season ?? '').localeCompare(a.season ?? '') || Number(a.status === 'blocked') - Number(b.status === 'blocked')
        ),
      };
    })
    .sort((a, b) => a.teamId.localeCompare(b.teamId, undefined, { numeric: true }));
}

/* -------------------------------------------------------------------------- */
/* Division tag                                                                */
/* -------------------------------------------------------------------------- */

export interface DivisionTag {
  /** `NCAA D2`, `NAIA`, or `unknown division`. */
  readonly text: string;
  /** The division, or null when the app's division table does not give one. Null is never D1. */
  readonly division: NcaaDivision | null;
  /** The canonical school name the table matched, or null. */
  readonly canonicalTeam: string | null;
}

/**
 * Whether the app's division table knows this school name. Reads the same strict lookup the seed
 * builder uses (`divisionForTeamOrNull`, which is `resolveTeamDivision(name).division`). No name, no
 * match, or a discontinued program: `unknown division`. It never falls back to D1.
 */
export function teamDivisionTag(schoolName: string | null): DivisionTag {
  const unknown: DivisionTag = { text: 'unknown division', division: null, canonicalTeam: null };
  if (schoolName === null || schoolName.trim().length === 0) return unknown;
  const resolution = resolveTeamDivision(schoolName);
  if (resolution.division === null) return { ...unknown, canonicalTeam: resolution.canonicalTeam };
  return {
    text: resolution.division === 'NAIA' ? 'NAIA' : `NCAA ${resolution.division}`,
    division: resolution.division,
    canonicalTeam: resolution.canonicalTeam,
  };
}

/** Every capture id in the groups that can be picked. */
export function selectableCaptureIds(groups: readonly CaptureTeamGroup[]): string[] {
  return groups.flatMap(group => group.rows.filter(row => row.status === 'ready').map(row => row.captureId));
}

/** Keep the picked ids that are still pickable, in list order. Used after the list reloads. */
export function pruneSelection(selected: readonly string[], groups: readonly CaptureTeamGroup[]): string[] {
  const allowed = new Set(selectableCaptureIds(groups));
  return selected.filter(id => allowed.has(id));
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export interface TheoreticalProblem {
  readonly code: string;
  /** One short plain sentence naming the problem. */
  readonly message: string;
  /** The builder's own text (names the athlete, team or capture). Shown beneath the sentence. */
  readonly detail: string | null;
  /** True when trying again can help (the network or the server). False when the data must change. */
  readonly retryable: boolean;
}

/** One plain sentence per data-layer error code. `Record<Code, string>` makes a missing code a compile error. */
export const CAPTURE_ERROR_SENTENCES: Readonly<Record<TheoreticalCaptureErrorCode, string>> = {
  'invalid-input': 'Pick at least one team, and pick each capture only once.',
  'capture-not-found': 'This capture is no longer in the capture store. Reload the list.',
  'capture-not-a-team': 'This capture is a meet, not a team. Pick a team capture.',
  'capture-failed': 'This crawl failed, so its data cannot be used. Crawl the team again.',
  'malformed-capture': 'The stored capture is damaged or incomplete. Crawl the team again.',
  'no-roster-pages': 'This capture holds no roster page. Crawl the team again with rosters included.',
  'roster-page-unparsed': 'A roster page was stored but could not be read. Crawl the team again.',
  'roster-table-empty': 'A roster page has a table with no swimmers. Crawl the team again.',
  'team-name-missing': 'A roster page does not state the team name, so the team cannot be named.',
  'team-name-conflict': 'Two roster pages of this capture name different teams. Crawl the team again.',
  'roster-gender-missing': 'A roster page does not say whether it is the men or the women, so it cannot be used.',
  'roster-gender-contradiction': 'A roster page says one gender but its address asks for the other. Crawl the team again.',
  'duplicate-roster-gender': 'This capture holds two roster pages for the same gender. Crawl the team again.',
  'team-id-mismatch': 'A roster page belongs to another team than this capture. Crawl the team again.',
  'season-label-mismatch': 'A roster page is for a different season than this capture. Crawl the team again.',
};

export const SEED_ERROR_SENTENCES: Readonly<Record<TheoreticalMeetErrorCode, string>> = {
  'unknown-course': 'The meet course is not one the app knows.',
  'course-not-supported': 'Only short course yards (SCY) meets can be built so far. Long course and short course meters are not supported yet.',
  'unknown-team-gender': 'A team has a gender the meet does not know.',
  'athlete-gender-mismatch': 'A swimmer is listed on a roster of the other gender. Crawl the team again.',
  'swim-gender-mismatch': 'A captured swim is for the other gender than its team. Crawl the team again.',
  'invalid-scoring-settings': 'These scoring settings cannot build a meet. Pick a scoring preset instead.',
  'athlete-without-name': 'A roster swimmer has no usable name.',
  'name-collision-in-team': 'Two swimmers on one team have the same name, so their times would be merged. Fix the roster, then crawl again.',
  'roster-status-required': 'A team roster is empty and the capture does not say why. Crawl the team again.',
  'invalid-input': 'The meet input is not valid. Reload the dialog and try again.',
  'duplicate-team': 'The same team and gender were given twice. Pick each capture once.',
  'seed-provenance-missing': 'A seed time could not be traced to a captured swim, so the meet was not built.',
  'row-id-collision': 'Two meet rows got the same id, so the meet was not built.',
};

export const WORKSPACE_ERROR_SENTENCES: Readonly<Record<TheoreticalWorkspaceErrorCode, string>> = {
  'invalid-input': 'The new workspace could not be made from this input. Reload the dialog and try again.',
  'invalid-scoring-settings': 'These scoring settings score from a PDF points column, which a theoretical meet does not have. Pick a scoring preset instead.',
  'invalid-event-order': 'The event order copied from the loaded meet is not usable. Choose program order.',
  'meet-id-mismatch': 'The seed rows were built for a different workspace id. Go back and preview again.',
  'no-seed-rows': 'No swimmer has a usable seed time, so there is no meet to build. Check the crawl for swimmer times.',
  'unexpected-seed-row': 'A seed row is not a plain individual entry, so the meet was not built.',
  'event-label-conflict': 'Two labels name one event, which would split its field, so the meet was not built.',
  'unrankable-time': 'A seed time is not a valid time, so places cannot be set. The meet was not built.',
  'row-id-collision': 'Two meet rows got the same id, so the meet was not built.',
};

/** The error name the problem came from. Several classes reuse a code. */
function lookup<T extends string>(table: Readonly<Record<T, string>>, code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code as T] : undefined;
}

/** A failed capture-route call. `status` is the HTTP status, or 0 when the server was not reached. */
export class CaptureApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CaptureApiError';
    this.status = status;
  }
}

/** One plain sentence for any error the flow can meet. Never hides the builder's own text. */
export function describeTheoreticalError(error: unknown): TheoreticalProblem {
  if (error instanceof TheoreticalCaptureError) {
    return { code: error.code, message: lookup(CAPTURE_ERROR_SENTENCES, error.code) ?? 'This capture cannot be read.', detail: error.message, retryable: false };
  }
  if (error instanceof TheoreticalMeetError) {
    return { code: error.code, message: lookup(SEED_ERROR_SENTENCES, error.code) ?? 'The meet could not be built.', detail: error.message, retryable: false };
  }
  if (error instanceof TheoreticalWorkspaceError) {
    return { code: error.code, message: lookup(WORKSPACE_ERROR_SENTENCES, error.code) ?? 'The workspace could not be built.', detail: error.message, retryable: false };
  }
  if (error instanceof CaptureApiError) {
    if (error.status === 404) {
      return {
        code: 'capture-routes-unavailable',
        message: 'The capture routes are not available on this server. They run only when the server is bound to this computer.',
        detail: error.message,
        retryable: false,
      };
    }
    return {
      code: error.status === 0 ? 'capture-server-unreachable' : `capture-http-${error.status}`,
      message: error.status === 0 ? 'The server did not answer. Check that the app is running, then try again.' : 'The server could not read the captures. Try again.',
      detail: error.message,
      retryable: true,
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  return { code: 'unknown', message: 'Something went wrong. Try again.', detail: text.length > 0 ? text : null, retryable: true };
}

/* -------------------------------------------------------------------------- */
/* Scoring and event order                                                     */
/* -------------------------------------------------------------------------- */

export interface ScoringChoice {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly citation: string;
  readonly description: string;
  /**
   * The workspace conference this preset names, only when exactly one conference name is bound to it
   * and the app maps that name back to this preset. Otherwise undefined: no conference is guessed.
   */
  readonly conference: string | undefined;
}

/**
 * The presets the picker offers: every built-in preset that carries its own points table. A preset
 * whose table the governing body leaves to the host has no settings, so it is not offered.
 * Nothing here is chosen for the user: no team, division or name selects a preset.
 */
export function buildScoringChoices(): ScoringChoice[] {
  const choices: ScoringChoice[] = [];
  for (const preset of BUILT_IN_SCORING_PRESETS) {
    if (preset.requiresHostPublishedTable === true || preset.settings === undefined) continue;
    const only = preset.conferenceMatches !== undefined && preset.conferenceMatches.length === 1 ? preset.conferenceMatches[0] : undefined;
    const conference = only !== undefined && presetIdForConference(only) === preset.id ? only : undefined;
    choices.push({ id: preset.id, label: preset.label, group: preset.group, citation: preset.citation, description: preset.description, conference });
  }
  return choices;
}

/** The settings and conference a picked preset resolves to. Throws for an unknown id (never a default). */
export function resolveScoringChoice(id: string): { settings: ScoringSettings; conference: string | undefined } {
  const choice = buildScoringChoices().find(c => c.id === id);
  if (choice === undefined) throw new Error(`Scoring preset ${id} is not offered for a theoretical meet.`);
  return { settings: settingsForBuiltInScoringPreset(id), conference: choice.conference };
}

export interface EventOrderChoice {
  readonly workspaceId: string;
  readonly name: string;
  readonly eventCount: number;
}

type EventOrderSource = Pick<Workspace, 'id' | 'name' | 'menResults' | 'womenResults' | 'loadedMeet'>;

/**
 * Loaded meets that can lend their event order. A workspace qualifies only when its rows carry
 * `Event N` labels (the engine's own ordering key). A theoretical meet has none, so it never qualifies.
 */
export function eventOrderChoices(workspaces: readonly EventOrderSource[]): EventOrderChoice[] {
  const choices: EventOrderChoice[] = [];
  for (const workspace of workspaces) {
    if (isTheoreticalMeet(workspace)) continue;
    const rows: SwimmerResult[] = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
    const order = theoreticalEventOrderFromMeetResults(rows);
    if (order.length > 0) choices.push({ workspaceId: workspace.id, name: workspace.name, eventCount: order.length });
  }
  return choices;
}

/** The event order of one workspace, or undefined when it has none. Same rule as {@link eventOrderChoices}. */
export function eventOrderOf(workspace: EventOrderSource | undefined): string[] | undefined {
  if (workspace === undefined || isTheoreticalMeet(workspace)) return undefined;
  const order = theoreticalEventOrderFromMeetResults([...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])]);
  return order.length > 0 ? order : undefined;
}

/* -------------------------------------------------------------------------- */
/* Combining per-capture reads                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Join the per-capture results into the one shape `buildTheoreticalMeetSeeds` takes, in the order of
 * `captureIds`. The data layer reads each capture on its own, so this is the same result as one
 * call with every id. A capture with no result yet throws: a partial meet is never built.
 */
export function combineCaptureResults(
  captureIds: readonly string[],
  byId: Readonly<Record<string, TheoreticalMeetFromCapturesResult | undefined>>
): TheoreticalMeetFromCapturesResult {
  const teams: TheoreticalMeetFromCapturesResult['teams'][number][] = [];
  const captures: TheoreticalMeetFromCapturesResult['captures'][number][] = [];
  const warnings: string[] = [];
  for (const id of captureIds) {
    const result = byId[id];
    if (result === undefined) throw new Error(`Capture ${id} has not been read yet.`);
    teams.push(...result.teams);
    captures.push(...result.captures);
    warnings.push(...result.warnings);
  }
  return { teams, captures, warnings: [...new Set(warnings)] };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

const NO_SEED_TEXT: Readonly<Record<TheoreticalNoSeedAthlete['reason'], string>> = {
  no_usable_swim: 'the times page held no usable swim',
  diving_not_supported: 'diving only',
  no_swim_in_meet_course: 'no swim in short course yards',
  no_event_in_program: 'no swim in an event of this meet',
};

export interface PreviewSwimmer {
  readonly name: string;
  readonly chosen: readonly { readonly event: string; readonly time: string; readonly isExhibition: boolean }[];
  /** Events the entry caps left out. */
  readonly leftOutByCap: number;
  /** Events dropped because their best swim is exhibition (only when exhibition seeds are excluded). */
  readonly excludedExhibitionEvents: readonly string[];
}

export interface PreviewTeamRow {
  readonly key: string;
  readonly teamName: string;
  readonly genderLabel: string;
  readonly rowsCreated: number;
  readonly swimmerCount: number;
  readonly athletesWithNoTimes: readonly string[];
  readonly timesParseFailed: readonly string[];
  /** No seed in short course yards, with the reason in words. Diving-only swimmers are in `divingExcluded`. */
  readonly noSeedInCourse: readonly { readonly name: string; readonly reason: string }[];
  readonly divingExcluded: readonly string[];
  readonly duplicatesAcrossTeams: readonly string[];
  /** Entries whose seed swim is exhibition at its source (not scored at that meet). They are tagged on the chip. */
  readonly exhibitionSeedsUsed: number;
  /** Events left with no seed because the exhibition seeds were switched off. */
  readonly exhibitionEventsExcluded: number;
  readonly swimmers: readonly PreviewSwimmer[];
}

export interface PreviewWarning {
  readonly kind: 'drift' | 'other';
  readonly text: string;
}

export interface PreviewModel {
  readonly teams: readonly PreviewTeamRow[];
  readonly totalRows: number;
  readonly teamCount: number;
  /** Entries seeded from exhibition swims, over all teams. */
  readonly exhibitionSeedsUsed: number;
  /** Events dropped for an exhibition best, over all teams. */
  readonly exhibitionEventsExcluded: number;
  /** Shown as a visible list. Every caveat of the report, then the ones this dialog owns. Each once. */
  readonly caveats: readonly string[];
  /** Warnings, not errors: they never block Create. */
  readonly warnings: readonly PreviewWarning[];
  readonly eventOrderSource: TheoreticalMeetWorkspaceBuild['eventOrderSource'];
}

function genderLabel(gender: Gender): string {
  return gender === Gender.WOMEN ? 'Women' : 'Men';
}

function dedupe(lines: readonly string[]): string[] {
  return [...new Set(lines)];
}

function classifyWarning(text: string): PreviewWarning {
  return { kind: text.includes('page-bytes-drifted') ? 'drift' : 'other', text };
}

/** The sentence that replaces the raw drift line. The raw line stays in the data layer's result. */
export function describeDrift(driftedPageCount: number, unverifiedPageCount: number): string | null {
  const parts: string[] = [];
  if (driftedPageCount > 0) {
    parts.push(`${plural(driftedPageCount, 'stored page')} changed after the crawl recorded ${driftedPageCount === 1 ? 'it' : 'them'}. The newer pages were used.`);
  }
  if (unverifiedPageCount > 0) {
    parts.push(`${plural(unverifiedPageCount, 'stored page')} could not be checked against the crawl record.`);
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/** Everything the Preview step draws, from the three data-layer results. */
export function buildPreviewModel(
  captures: TheoreticalMeetFromCapturesResult,
  seeds: TheoreticalMeetSeeds,
  built: TheoreticalMeetWorkspaceBuild
): PreviewModel {
  const teams: PreviewTeamRow[] = seeds.report.teams.map((team, index) => ({
    key: `${index}|${team.teamName}|${team.gender}`,
    teamName: team.teamName,
    genderLabel: genderLabel(team.gender),
    rowsCreated: team.rowsCreated,
    swimmerCount: team.eventsChosenPerSwimmer.length,
    athletesWithNoTimes: team.athletesWithNoTimes.map(a => a.name),
    timesParseFailed: team.athletesWithTimesParseFailed.map(a => a.name),
    noSeedInCourse: team.athletesWithNoSeedInMeetCourse
      .filter(a => a.reason !== 'diving_not_supported')
      .map(a => ({ name: a.name, reason: NO_SEED_TEXT[a.reason] })),
    divingExcluded: team.athletesWithNoSeedInMeetCourse.filter(a => a.reason === 'diving_not_supported').map(a => a.name),
    duplicatesAcrossTeams: team.duplicateAcrossTeams.map(d => `${d.name} (entered for ${d.enteredForTeam}, skipped for ${d.skippedForTeam})`),
    exhibitionSeedsUsed: team.exhibitionSeedsUsed,
    exhibitionEventsExcluded: team.exhibitionEventsExcluded,
    swimmers: team.eventsChosenPerSwimmer
      .map(s => ({
        name: s.name,
        chosen: s.events.filter(e => e.chosen).map(e => ({ event: e.event, time: e.time, isExhibition: e.isExhibition === true })),
        leftOutByCap: s.events.filter(e => !e.chosen).length,
        excludedExhibitionEvents: [...(s.excludedExhibitionEvents ?? [])],
      }))
      .filter(s => s.chosen.length > 0 || s.excludedExhibitionEvents.length > 0),
  }));

  // Every caveat comes from the report (the exhibition lines too). Only "relays are not included" is
  // guaranteed here, because it always holds until relays exist.
  const caveats = dedupe([...built.caveats, ...(built.caveats.includes(RELAYS_EXCLUDED_CAVEAT) ? [] : [RELAYS_EXCLUDED_CAVEAT])]);

  const driftedPages = captures.captures.reduce((sum, c) => sum + c.driftedPages.length, 0);
  const unverifiedPages = captures.captures.reduce((sum, c) => sum + c.unverifiedPages, 0);
  const driftSentence = describeDrift(driftedPages, unverifiedPages);
  const otherWarnings = dedupe([...captures.warnings.filter(w => !w.includes('page-bytes-drifted')), ...built.warnings]).map(classifyWarning);
  const warnings: PreviewWarning[] = [...(driftSentence === null ? [] : [{ kind: 'drift' as const, text: driftSentence }]), ...otherWarnings];

  return {
    teams,
    totalRows: seeds.report.totalRows,
    teamCount: new Set(teams.map(t => t.teamName)).size,
    exhibitionSeedsUsed: teams.reduce((sum, t) => sum + t.exhibitionSeedsUsed, 0),
    exhibitionEventsExcluded: teams.reduce((sum, t) => sum + t.exhibitionEventsExcluded, 0),
    caveats,
    warnings,
    eventOrderSource: built.eventOrderSource,
  };
}

/** Team names in team order, one per team (a team with two genders counts once). */
export function teamNamesOf(captures: TheoreticalMeetFromCapturesResult): string[] {
  return [...new Set(captures.teams.map(t => t.teamName))];
}

/** Whether the Create button may be pressed. Reasons are returned so the dialog can say why not. */
export function createBlockers(args: {
  readonly selectedCount: number;
  readonly scoringChoiceId: string | null;
  readonly problem: TheoreticalProblem | null;
  readonly previewReady: boolean;
  readonly creating: boolean;
}): string[] {
  const reasons: string[] = [];
  if (args.selectedCount === 0) reasons.push('Pick at least one team.');
  if (args.scoringChoiceId === null) reasons.push('Pick the scoring rules.');
  if (args.problem !== null) reasons.push(args.problem.message);
  else if (!args.previewReady && args.selectedCount > 0 && args.scoringChoiceId !== null) reasons.push('The teams are still being read.');
  if (args.creating) reasons.push('The workspace is being created.');
  return reasons;
}
