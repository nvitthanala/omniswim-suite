/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase U1b: turn the seed rows of a theoretical meet into the payload of a NEW
 * workspace whose meet results are those entries ranked by seed time. Pure. No
 * React, no fetch, no storage, no clock (the caller passes `createdAt`).
 *
 * Design: `docs/reference/THEORETICAL_MEET_PLAN.md`. The seed rows come from
 * `theoreticalMeetSeeds.ts` (`buildTheoreticalMeetSeeds`).
 *
 * ## What the scoring engine needs from a meet row
 *
 * Read from `scoringEngine.ts`, `utils.ts` (`calculatePoints` and the individual
 * scorers), `scorerRoster.ts` and `scoringDefaults.ts`, 2026-10-04:
 *
 * - **Where baseline reads rows.** `buildScoringBundle` reads
 *   `getSourceResults(workspace, gender)`: `sourceMenResults` / `sourceWomenResults`
 *   when present, else `menResults` / `womenResults`. The payload sets both
 *   (`meetCopyFromParsed`, the helper the PDF and SwimCloud-meet imports use).
 * - **Place.** Individual scoring groups rows by `event | roundSwam | rank`. Rows
 *   in one group are one tie. A group earns the average of the ladder places it
 *   covers. So `rank` must be a positive whole number, and two rows may share a
 *   rank only when they are tied.
 * - **Round.** `roundSwam` picks the table row. Tier `A` and `FIN` and unknown
 *   read `rank - 1`. Tier `B` reads `rank - 1` for an overall place above the A
 *   bracket. A prelims round scores only distance events and diving. A
 *   non-championship round (`Time Trial`, `C Final`) scores nothing. The NSISC
 *   scorer roster adds an athlete automatically only from an `A Final` or `B
 *   Final` row. So the rows use bands like the what-if projection's
 *   (`projectRanksInField`, `roundAndRankForPrelimsSeed`): places 1 to the A
 *   bracket are `A Final`, the next bracket is `B Final`, the rest are
 *   `C Final`. The what-if projection labels the rest `Preliminaries`. This file
 *   must not: a prelims row with a time makes `hasPrelimsData` true, and the
 *   prelims-vs-finals view then shows every team's prelims projection as 0 and an
 *   over/under equal to its whole total. `C Final` is scored as 0 and never
 *   reads as prelims (the real 2026 NSISC results ran A, B and C finals with C
 *   unscored: `tests/fixtures/nsisc-2026-relay-followups-r1.json`). The bracket is
 *   the merged settings' `aFinalBracketSize` (the engine's own `aFinalBracket`
 *   rule: half the table when absent). `rank` is the overall place for every band.
 * - **Points.** `calculatePoints` overwrites `points`. It uses a row's
 *   `pdfPoints` only when enough rows carry one (`resultsHavePdfPlacePoints`:
 *   at least 8 rows and 1 percent). These rows carry no `pdfPoints`, so the
 *   settings' own table applies. The stored `points` are the engine's own
 *   baseline values for these rows, so a reader of the raw rows sees the same
 *   number the Standings shows.
 * - **Ids.** `meet_results.id` and `source_meet_results.id` are primary keys across
 *   all workspaces. The id is `tmres|{workspaceId}|...` (the seed id with a new
 *   prefix), so it is unique per workspace and the same for the same input.
 * - **Not set:** `isPsychSheet`, `isRecruit`, `isExhibition`, `isTimeTrial`,
 *   `pdfPoints`, `relay*`. A row with none of these is a plain scored swim.
 *
 * ## Ties
 *
 * Standard competition ranking on an exact time tie (1, 2, 2, 4), the rule the
 * app uses to place injected recruits (`placeFieldByTime` behind
 * `prepareRecruitsForScoring`). A test pins this file's places to that function.
 *
 * ## Event order is a modelling choice, and it can move a total
 *
 * By default rows are ordered by the standard SCY program order (50, 100, 200,
 * 500, 1000, 1650 free; back; breast; fly; IM), the same list the cross-course
 * table uses. The engine processes events in row order when no row carries an
 * `Event N` label (it sorts by that number when there is one). NSISC scores 18
 * scorer units per team meet-wide, filled as events are processed, so for NSISC
 * the order can change which swimmers score. Measured on the three real teams
 * (Henderson State men): 931 in program order, 997 in the real 2026 NSISC order,
 * 897 in the reversed program order, a spread of 7 percent. This file invents no
 * event numbers.
 *
 * `eventOrder` replaces the default with the order of a real loaded meet
 * ({@link theoreticalEventOrderFromMeetResults}). It is applied to the row order,
 * which is the engine's own mechanism for rows with no `Event N` label.
 * `eventOrderSource` says which order ran, and the caveat says how far a total can
 * move with it.
 *
 * ## Provenance
 *
 * `SwimmerResult` has no source field and the workspace table has no column for
 * one, so provenance is returned beside the payload ({@link TheoreticalMeetWorkspaceBuild.sources}),
 * keyed by result id. It is not persisted. It is rebuilt from the captures.
 *
 * ## The meet label
 *
 * `loadedMeet.meetLabel` is {@link THEORETICAL_MEET_LABEL}. `loadedMeet.pdfFilename`
 * carries the same text. Every other screen that shows "what is loaded" reads
 * `pdfFilename` (the sidebar, `RosterSourceStep`, the Matrix meet step), and
 * `swimCloudMeetImportBridge` sets it the same way for a meet with no PDF. It is
 * a display string here, not a file.
 */

import { Gender } from '@omniswim/core/types';
import type { LoadedMeetMeta, ScoringSettings, SwimmerResult } from '@omniswim/core/types';
import { canonicalMeetEventLabel, swimEventIdentity } from '@omniswim/core/lib/athleteHistory';
import { meetCopyFromParsed } from '@omniswim/core/lib/meetSource';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { calculatePoints, convertTimeToSeconds, isDivingEvent, isRelayResult, parseEventNumber } from '@omniswim/core/lib/utils';
import { PDF_POINTS_SETTINGS_MESSAGE, type TheoreticalMeetSeeds, type TheoreticalSeedSource } from './theoreticalMeetSeeds';

/* -------------------------------------------------------------------------- */
/* Label and detection                                                         */
/* -------------------------------------------------------------------------- */

/** The text that marks a workspace as a theoretical meet. */
export const THEORETICAL_MEET_LABEL = 'Theoretical meet (seeded from crawled teams)';

/** True when the workspace's loaded meet is a theoretical meet. Reads `loadedMeet.meetLabel` only. */
export function isTheoreticalMeet(workspace: { readonly loadedMeet?: Pick<LoadedMeetMeta, 'meetLabel'> | null } | null | undefined): boolean {
  return workspace?.loadedMeet?.meetLabel === THEORETICAL_MEET_LABEL;
}

export const EVENT_ORDER_CAVEAT =
  'Events run in the standard program order, not a published meet order. Under a meet-wide scorer cap (NSISC: 18 scorers per team) the order decides which swimmers fill the cap. NSISC totals can move by several percent with event order (measured up to 7% on real data).';
export const EVENT_ORDER_SUPPLIED_CAVEAT =
  'Events run in the order supplied from a loaded meet. Under a meet-wide scorer cap (NSISC: 18 scorers per team) the order decides which swimmers fill the cap, so these totals hold for that order only. NSISC totals can move by several percent with event order (measured up to 7% on real data).';
export const THEORETICAL_PLACES_CAVEAT =
  'Nobody swam this meet. Places are the order of the seed times, within each event and gender. Rows ranked past the A and B brackets are marked C Final, which the engine scores as 0.';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TheoreticalWorkspaceErrorCode =
  /** The workspace id is empty, or `createdAt` is not a finite number. */
  | 'invalid-input'
  /** The scoring settings carry `usePdfPlacePoints: true`. Pass preset settings. */
  | 'invalid-scoring-settings'
  /** `eventOrder` holds a label that is not an event, or one event twice. */
  | 'invalid-event-order'
  /** A seed row was not built for this workspace id. */
  | 'meet-id-mismatch'
  /** The seeds hold no row. An empty meet is not a meet. */
  | 'no-seed-rows'
  /** A seed row is not a plain individual psych seed (a relay, a row already ranked, a foreign id). */
  | 'unexpected-seed-row'
  /** Two labels name one event in one gender. Scoring groups by the exact label, so this would split a field. */
  | 'event-label-conflict'
  /** A seed time does not read as a finite number of seconds. */
  | 'unrankable-time'
  /** Two rows got one id. */
  | 'row-id-collision';

export class TheoreticalWorkspaceError extends Error {
  readonly code: TheoreticalWorkspaceErrorCode;
  constructor(code: TheoreticalWorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'TheoreticalWorkspaceError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface TheoreticalMeetWorkspaceInput {
  /**
   * The id of the workspace to create. Must be the `meetId` the seeds were built
   * with, because every row id contains it.
   *
   * **It must be a fresh UUID: use {@link newTheoreticalWorkspaceId}.** `POST /api/workspaces`
   * with an id that already exists overwrites that workspace and deletes its rows
   * (`packages/db/src/WorkspaceService.ts`, `create`). This builder cannot see the
   * server, so it cannot check; a reused id would destroy a real workspace.
   */
  readonly workspaceId: string;
  /** Epoch milliseconds. Used for `createdAt` and `loadedMeet.uploadedAt`. */
  readonly createdAt: number;
  /** The output of `buildTheoreticalMeetSeeds`. */
  readonly seeds: TheoreticalMeetSeeds;
  /** The same scoring settings given to `buildTheoreticalMeetSeeds`. Merged with `conference` here, as the builder merges them. */
  readonly scoringSettings: ScoringSettings;
  /** The same conference given to `buildTheoreticalMeetSeeds`, for example `'NSISC'`. */
  readonly conference?: string;
  /** Workspace name. Default {@link defaultTheoreticalMeetName}. Sanitized either way. */
  readonly name?: string;
  /**
   * Individual-event labels in the order the meet runs them, for example from
   * {@link theoreticalEventOrderFromMeetResults} over a real loaded meet. HyTek labels
   * (`Event 35 Men 100 Yard Freestyle`), canonical labels (`100 Freestyle`) and the
   * course-qualified labels of the rows (`100 Free SCY`) all read. Relays and diving
   * are skipped. A label that is not an event, or one event twice, throws
   * `invalid-event-order`. Absent: the standard program order.
   *
   * The engine orders events by an `Event N` number in the label and, when no label
   * has one (these rows have none), by row order. So the order is applied to the row
   * order. No event number is written. Events the order does not name follow it in
   * program order, and `warnings` lists them.
   */
  readonly eventOrder?: readonly string[];
}

/** The body for `createWorkspace(name, body)` / `POST /api/workspaces`. Every field is a field of `Workspace`. */
export interface TheoreticalMeetWorkspacePayload {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly menResults: SwimmerResult[];
  readonly womenResults: SwimmerResult[];
  /** Separate copies of the meet rows, as a PDF import writes them (`meetCopyFromParsed`). */
  readonly sourceMenResults: SwimmerResult[];
  readonly sourceWomenResults: SwimmerResult[];
  readonly recruits: [];
  readonly scoringSettings: ScoringSettings;
  readonly conference?: string;
  readonly loadedMeet: LoadedMeetMeta;
}

export interface TheoreticalMeetWorkspaceBuild {
  readonly payload: TheoreticalMeetWorkspacePayload;
  /** Provenance per result id. Holds exactly one entry for each meet row. Not persisted anywhere. */
  readonly sources: ReadonlyMap<string, TheoreticalSeedSource>;
  /** Seed row id to result row id. */
  readonly resultIdBySeedId: ReadonlyMap<string, string>;
  /** The seed report, unchanged, so a UI shows one report. */
  readonly report: TheoreticalMeetSeeds['report'];
  /** The seed caveats, then this file's. */
  readonly caveats: readonly string[];
  /** The A bracket size the rows were banded with. */
  readonly aFinalBracketSize: number;
  /** `supplied`: the rows follow `eventOrder`. `program-default`: the standard program order. */
  readonly eventOrderSource: 'program-default' | 'supplied';
  /** Things the caller should show: events the supplied order did not name. Empty when there is nothing to say. */
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

const NAME_MAX = 120;

/** Collapse whitespace, drop control characters and angle brackets, cap the length. Empty stays empty. */
export function sanitizeWorkspaceName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > NAME_MAX ? `${cleaned.slice(0, NAME_MAX - 3).trimEnd()}...` : cleaned;
}

/** `Theoretical meet: 3 teams (A, B, C)`. A team with two genders counts once. */
export function defaultTheoreticalMeetName(teamNames: readonly string[]): string {
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const name of teamNames) {
    const key = name.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    distinct.push(name.trim());
  }
  const count = distinct.length;
  const head = `Theoretical meet: ${count} ${count === 1 ? 'team' : 'teams'}`;
  return sanitizeWorkspaceName(count === 0 ? head : `${head} (${distinct.join(', ')})`);
}

/* -------------------------------------------------------------------------- */
/* Ids                                                                         */
/* -------------------------------------------------------------------------- */

const SEED_PREFIX = 'tmseed|';
const RESULT_PREFIX = 'tmres|';

/** The meet-row id for a seed-row id: the same scheme under the prefix `tmres`. */
export function theoreticalResultRowId(seedRowId: string): string {
  if (!seedRowId.startsWith(SEED_PREFIX)) {
    throw new TheoreticalWorkspaceError('unexpected-seed-row', `The row id ${seedRowId} is not a theoretical seed id.`);
  }
  return `${RESULT_PREFIX}${seedRowId.slice(SEED_PREFIX.length)}`;
}

/* -------------------------------------------------------------------------- */
/* Event order                                                                 */
/* -------------------------------------------------------------------------- */

/** The standard SCY individual program order. Same list as the cross-course table's `PROGRAM_EVENT_ORDER`. */
const PROGRAM_ORDER: readonly string[] = [
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

/** Index in the program order. An event the list does not hold sorts after it. */
function programIndex(event: string): number {
  const canonical = canonicalMeetEventLabel(event);
  const index = canonical === null ? -1 : PROGRAM_ORDER.indexOf(canonical);
  return index < 0 ? PROGRAM_ORDER.length : index;
}

/** A canonical individual-event label starts with a distance. Anything else is not an event. */
const LOOKS_LIKE_EVENT = /^\d{2,4}\s+\S/;

/** Canonical label to its place in the supplied order. Throws on a label that is not an event or a repeated event. */
function parseEventOrder(order: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const raw of order) {
    if (typeof raw !== 'string') {
      throw new TheoreticalWorkspaceError('invalid-event-order', `eventOrder holds ${JSON.stringify(raw)}, which is not a label.`);
    }
    // Relays and diving have no individual canonical label. They are not rows here, so they are skipped.
    if (/\brelay\b/i.test(raw) || isDivingEvent(raw)) continue;
    const canonical = canonicalMeetEventLabel(raw);
    if (canonical === null || !LOOKS_LIKE_EVENT.test(canonical)) {
      throw new TheoreticalWorkspaceError('invalid-event-order', `eventOrder holds ${JSON.stringify(raw)}, which does not read as an individual event.`);
    }
    if (index.has(canonical)) {
      throw new TheoreticalWorkspaceError('invalid-event-order', `eventOrder names ${canonical} twice.`);
    }
    index.set(canonical, index.size);
  }
  return index;
}

/**
 * The order a loaded meet runs its individual events in, as canonical labels, from the `Event N` numbers
 * in its result rows (the engine's own ordering key, `parseEventNumber`). Relays and time trials are left
 * out. Rows with no `Event N` label contribute nothing. Pass the result as `eventOrder`.
 */
export function theoreticalEventOrderFromMeetResults(results: readonly SwimmerResult[]): string[] {
  const first = new Map<string, number>();
  for (const row of results) {
    if (isRelayResult(row) || row.isTimeTrial === true) continue;
    const number = parseEventNumber(row.event);
    const canonical = canonicalMeetEventLabel(row.event);
    if (number === null || canonical === null || !LOOKS_LIKE_EVENT.test(canonical)) continue;
    const seen = first.get(canonical);
    if (seen === undefined || number < seen) first.set(canonical, number);
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);
}

/**
 * A fresh workspace id. `POST /api/workspaces` with an id that already exists overwrites that workspace
 * and deletes its rows (`WorkspaceService.create`), so a new meet must never reuse an id. Use this for
 * `workspaceId`; the seed builder's `meetId` is the same value.
 */
export function newTheoreticalWorkspaceId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID === undefined) {
    throw new TheoreticalWorkspaceError('invalid-input', 'No crypto.randomUUID is available, so no fresh workspace id can be made.');
  }
  return webCrypto.randomUUID();
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

type Seeded = { readonly row: SwimmerResult; readonly seconds: number };

/** Standard competition ranking, fastest first, a shared place only on an exact time tie (1, 2, 2, 4). */
function placesFastestFirst(field: readonly Seeded[]): Map<SwimmerResult, number> {
  const sorted = [...field].sort((a, b) => a.seconds - b.seconds);
  const places = new Map<SwimmerResult, number>();
  let place = 0;
  let previous = Number.NaN;
  sorted.forEach((entry, index) => {
    if (index === 0 || entry.seconds !== previous) place = index + 1;
    previous = entry.seconds;
    places.set(entry.row, place);
  });
  return places;
}

function roundForPlace(place: number, bracket: number): string {
  if (place <= bracket) return 'A Final';
  if (place <= bracket * 2) return 'B Final';
  return 'C Final';
}

/** The engine's own A bracket rule (`aFinalBracket` in `utils.ts`): the setting, else half the table. */
function aFinalBracketOf(settings: ScoringSettings): number {
  return settings.aFinalBracketSize ?? Math.floor(settings.scoringPoints.length / 2);
}

function requirePlainSeed(row: SwimmerResult, workspaceIdPart: string): void {
  if (!row.id.startsWith(`${SEED_PREFIX}${workspaceIdPart}|`)) {
    throw new TheoreticalWorkspaceError('meet-id-mismatch', `The seed row ${row.id} was not built for workspace ${workspaceIdPart}.`);
  }
  if (row.isRelay === true || row.isPsychSheet !== true || row.isRecruit === true || row.isExhibition === true || row.isTimeTrial === true) {
    throw new TheoreticalWorkspaceError('unexpected-seed-row', `The row ${row.id} is not a plain individual psych seed.`);
  }
  if (row.gender !== Gender.MEN && row.gender !== Gender.WOMEN) {
    throw new TheoreticalWorkspaceError('unexpected-seed-row', `The row ${row.id} has gender ${JSON.stringify(row.gender)}.`);
  }
}

/** One gender's meet rows: placed, banded, ordered. Points are filled in by the caller. */
function rankGender(
  seedRows: readonly SwimmerResult[],
  bracket: number,
  workspaceIdPart: string,
  order: ReadonlyMap<string, number> | undefined,
  notNamed: Set<string>
): SwimmerResult[] {
  const fields = new Map<string, Seeded[]>();
  const labelOf = new Map<string, string>();
  for (const row of seedRows) {
    requirePlainSeed(row, workspaceIdPart);
    const seconds = convertTimeToSeconds(row.time);
    if (!Number.isFinite(seconds)) {
      throw new TheoreticalWorkspaceError('unrankable-time', `The row ${row.id} has the time ${JSON.stringify(row.time)}, which is not a finite number of seconds.`);
    }
    const identity = swimEventIdentity(row.event);
    const known = labelOf.get(identity);
    if (known !== undefined && known !== row.event) {
      throw new TheoreticalWorkspaceError('event-label-conflict', `The labels ${JSON.stringify(known)} and ${JSON.stringify(row.event)} name one event. Scoring would split the field.`);
    }
    labelOf.set(identity, row.event);
    const field = fields.get(identity) ?? [];
    field.push({ row, seconds });
    fields.set(identity, field);
  }

  const ranked: Array<{ row: SwimmerResult; seconds: number; order: number }> = [];
  // A supplied order comes first; events it does not name follow in program order.
  const AFTER_SUPPLIED = 1_000;
  const rankOf = (identity: string): number => {
    const label = labelOf.get(identity) as string;
    const supplied = order === undefined ? undefined : order.get(canonicalMeetEventLabel(label) ?? '');
    if (order !== undefined && supplied === undefined) notNamed.add(label);
    return supplied ?? AFTER_SUPPLIED + programIndex(label);
  };
  const identities = [...fields.keys()].sort((a, b) => {
    const byOrder = rankOf(a) - rankOf(b);
    return byOrder !== 0 ? byOrder : a.localeCompare(b);
  });
  identities.forEach((identity, eventIndex) => {
    const field = fields.get(identity) as Seeded[];
    const places = placesFastestFirst(field);
    for (const { row, seconds } of field) {
      const place = places.get(row) as number;
      const { isPsychSheet: _psych, ...rest } = row;
      void _psych;
      ranked.push({
        order: eventIndex,
        seconds,
        row: { ...rest, id: theoreticalResultRowId(row.id), rank: place, points: 0, roundSwam: roundForPlace(place, bracket) },
      });
    }
  });
  ranked.sort((a, b) => a.order - b.order || (a.row.rank as number) - (b.row.rank as number) || a.seconds - b.seconds || a.row.team.localeCompare(b.row.team) || a.row.name.localeCompare(b.row.name));
  return ranked.map(entry => entry.row);
}

/* -------------------------------------------------------------------------- */
/* The builder                                                                 */
/* -------------------------------------------------------------------------- */

const encodeIdPart = (part: string): string => encodeURIComponent(part.trim());

/**
 * Build the payload of a new workspace from theoretical-meet seeds.
 *
 * Throws {@link TheoreticalWorkspaceError}: an empty workspace id or a
 * `createdAt` that is not finite (`invalid-input`), seeds with no row
 * (`no-seed-rows`), a row built for another workspace (`meet-id-mismatch`), a
 * row that is not a plain individual seed (`unexpected-seed-row`), two labels
 * for one event (`event-label-conflict`), a time that is not a number
 * (`unrankable-time`), two rows with one id (`row-id-collision`).
 */
export function buildTheoreticalMeetWorkspace(input: TheoreticalMeetWorkspaceInput): TheoreticalMeetWorkspaceBuild {
  if (typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) {
    throw new TheoreticalWorkspaceError('invalid-input', 'The workspace id is empty. Row ids are scoped by it.');
  }
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) {
    throw new TheoreticalWorkspaceError('invalid-input', 'createdAt must be a finite number of milliseconds.');
  }
  const { seeds } = input;
  if (seeds.rows.length === 0) {
    throw new TheoreticalWorkspaceError('no-seed-rows', 'The seeds hold no row, so there is no meet to build. See the report for why each athlete made none.');
  }

  if (input.scoringSettings?.usePdfPlacePoints === true) {
    throw new TheoreticalWorkspaceError('invalid-scoring-settings', PDF_POINTS_SETTINGS_MESSAGE);
  }
  const settings = mergeScoringSettings(input.scoringSettings, { conference: input.conference });
  const bracket = aFinalBracketOf(settings);
  const idPart = encodeIdPart(input.workspaceId);

  const order = input.eventOrder === undefined ? undefined : parseEventOrder(input.eventOrder);
  const notNamed = new Set<string>();
  const men = rankGender(seeds.rows.filter(r => r.gender === Gender.MEN), bracket, idPart, order, notNamed);
  const women = rankGender(seeds.rows.filter(r => r.gender === Gender.WOMEN), bracket, idPart, order, notNamed);
  if (men.length + women.length !== seeds.rows.length) {
    throw new TheoreticalWorkspaceError('unexpected-seed-row', 'A seed row has a gender other than Men or Women.');
  }

  // The engine's own baseline points, so a raw reader sees what Standings shows.
  // Same arguments as `buildScoringBundle`: both genders' rows are the PDF hint.
  const hint = [...men, ...women];
  const scoreOptions = { conferenceForMerge: input.conference, resultsForPdfHint: hint };
  const pointsById = new Map<string, number>();
  for (const scored of [...calculatePoints(men, settings, scoreOptions), ...calculatePoints(women, settings, scoreOptions)]) {
    pointsById.set(scored.id, typeof scored.points === 'number' ? scored.points : 0);
  }
  const withPoints = (rows: SwimmerResult[]): SwimmerResult[] => rows.map(r => ({ ...r, points: pointsById.get(r.id) ?? 0 }));
  const menResults = withPoints(men);
  const womenResults = withPoints(women);

  const resultIdBySeedId = new Map<string, string>();
  const sources = new Map<string, TheoreticalSeedSource>();
  const seen = new Set<string>();
  for (const seedRow of seeds.rows) {
    const resultId = theoreticalResultRowId(seedRow.id);
    if (seen.has(resultId)) throw new TheoreticalWorkspaceError('row-id-collision', `Two rows share the id ${resultId}.`);
    seen.add(resultId);
    resultIdBySeedId.set(seedRow.id, resultId);
    const source = seeds.sources.get(seedRow.id);
    if (source === undefined) {
      throw new TheoreticalWorkspaceError('unexpected-seed-row', `The seed row ${seedRow.id} has no provenance record.`);
    }
    sources.set(resultId, source);
  }

  const teamNames = seeds.report.teams.map(t => t.teamName);
  const requested = input.name === undefined ? '' : sanitizeWorkspaceName(input.name);
  const name = requested.length > 0 ? requested : defaultTheoreticalMeetName(teamNames);

  const copy = meetCopyFromParsed(menResults, womenResults);
  const payload: TheoreticalMeetWorkspacePayload = {
    id: input.workspaceId,
    name,
    createdAt: input.createdAt,
    menResults: copy.menResults as SwimmerResult[],
    womenResults: copy.womenResults as SwimmerResult[],
    sourceMenResults: copy.sourceMenResults as SwimmerResult[],
    sourceWomenResults: copy.sourceWomenResults as SwimmerResult[],
    recruits: [],
    scoringSettings: settings,
    ...(input.conference === undefined ? {} : { conference: input.conference }),
    loadedMeet: {
      pdfFilename: THEORETICAL_MEET_LABEL,
      uploadedAt: input.createdAt,
      meetLabel: THEORETICAL_MEET_LABEL,
      ...(input.conference === undefined ? {} : { conference: input.conference }),
    },
  };
  return {
    payload,
    sources,
    resultIdBySeedId,
    report: seeds.report,
    caveats: [...new Set([...seeds.report.caveats, THEORETICAL_PLACES_CAVEAT, order === undefined ? EVENT_ORDER_CAVEAT : EVENT_ORDER_SUPPLIED_CAVEAT])],
    aFinalBracketSize: bracket,
    eventOrderSource: order === undefined ? 'program-default' : 'supplied',
    warnings:
      notNamed.size === 0
        ? []
        : [`${notNamed.size} event(s) are not in the supplied event order and run after it in program order: ${[...notNamed].sort().join(', ')}.`],
  };
}
