/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase U1a: turn crawled team captures into the input of the theoretical-meet
 * seed builder (`theoreticalMeetSeeds.ts`). Pure logic over injected I/O. No
 * React, no fetch, no storage, no clock.
 *
 * Design: `docs/reference/THEORETICAL_MEET_PLAN.md`.
 *
 * ## What it reuses (and what it adds)
 *
 * - The capture list and the capture parse come from the app's own routes
 *   (`GET /api/swimcloud/captures`, `POST /api/swimcloud/captures/:id/parse`).
 *   They are injected as {@link TheoreticalCaptureDeps}, so a test passes fakes
 *   and the real UI passes `fetch` wrappers.
 * - The roster pairing is `pairRosterWithSwimmerTimes` and the times
 *   conversion is `convertAndAccountSwimmerTimes` from `rosterQueueImport.ts`.
 *   This file holds no second parser and no second converter.
 * - The roster season id is read with `parseTeamSeasonOptions` and
 *   `resolveSeasonOption` from `@omniswim/swimcloud/teamSeasons`.
 *
 * ## Rules
 *
 * 1. **A team is one gender.** Each capture holds one roster page per gender.
 *    Both genders of a team become two {@link CapturedTheoreticalTeam} entries.
 * 2. **The roster page names the team.** `teamName` comes from the roster parse.
 *    A roster page that does not state it throws `team-name-missing`. The one
 *    exception is SwimCloud's "No rosters found" page: it prints no name at all
 *    by design. It takes the name from the SAME capture's other roster page when
 *    that page states one, joined on the team id. The team's warnings say so.
 * 3. **Absent is not empty.** `rosterStatus: 'no_rosters_found'` only comes from
 *    the real empty-state page (the parser's `no-roster-posted` answer: an ok
 *    parse with no athletes and no printed team name, gender or season). A
 *    roster page that failed to parse throws `roster-page-unparsed`. A roster
 *    table with no rows throws `roster-table-empty`. Neither becomes an empty
 *    roster.
 * 4. **Times: undefined, [] and parse_failed are three different facts.**
 *    - `swims: undefined`, no `swimsStatus`: no times page for the athlete.
 *    - `swims: undefined`, `swimsStatus: 'parse_failed'`: a times page exists
 *      for the athlete's SwimCloud id and the capture parse produced nothing.
 *    - `swims: []`: the page parsed and held no usable swim.
 * 5. **The season id is never guessed.** `rosterSeasonId` is read from the
 *    roster page's own season table, for the capture subject's season label.
 *    No page bytes, no label, no match, or a contradiction with the page's own
 *    `season_id`: it stays `undefined` and the team carries a warning. A roster
 *    page whose printed season differs from the subject's label throws
 *    `season-label-mismatch`.
 * 6. **Completeness is reported, never rounded up.** A capture that is
 *    in-progress, partial, or short of its planned pages is accepted, and every
 *    one of its teams carries a warning with the counts. A `failed` capture
 *    throws `capture-failed`.
 * 7. **The bytes parsed are the bytes fetched, or the report says they are not.**
 *    The parse route reads whatever bytes the URL holds now, and one URL has one
 *    stored file shared by every capture, so a later crawl can replace what a
 *    capture record was written for. The route returns a hash of each stored page
 *    (`storedPages`). A used page whose hash differs from the record's gets a
 *    `page-bytes-drifted` warning, and its fetch time is replaced by the write
 *    time of the stored bytes (so a seed never keeps the old time as provenance).
 *    A page that cannot be checked is counted in `unverifiedPages`, never assumed
 *    clean.
 * 8. **Parse warnings are not dropped.** The parse's warning lines are counted by
 *    code (`parseWarnings`) in the capture summary and on every team of the capture.
 * 9. **A season id needs proof.** The URL names it (`season_id`), or the page prints
 *    the season. With neither, the table's selected option counts only when it is the
 *    subject's label. Otherwise `rosterSeasonId` stays undefined.
 *
 * ## Where the page bytes come from
 *
 * The parse route does not return page bytes, and the capture routes have no
 * route that does. `deps.readRosterPageHtml` is therefore optional. Without it
 * every team's `rosterSeasonId` is `undefined` and the seed builder's caveat
 * ("the roster season is not known") stands.
 */

import { Gender } from '@omniswim/core/types';
import type { SwimCloudAthlete, SwimCloudCaptureSubject } from '@omniswim/swimcloud/entities';
import type { SwimCloudRosterParse, SwimCloudSwimmerTimesParse } from '@omniswim/swimcloud/parser';
import { parseTeamSeasonOptions, resolveSeasonOption } from '@omniswim/swimcloud/teamSeasons';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import type { TheoreticalMeetAthleteInput, TheoreticalMeetTeamInput } from './theoreticalMeetSeeds';
import { convertAndAccountSwimmerTimes, pairRosterWithSwimmerTimes, type RosterQueueEntry } from './rosterQueueImport';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TheoreticalCaptureErrorCode =
  /** `captureIds` is empty, or lists one id twice. */
  | 'invalid-input'
  /** No capture in `deps.listCaptures()` has the id. */
  | 'capture-not-found'
  /** The capture's subject is not a team. */
  | 'capture-not-a-team'
  /** The capture record is marked `failed`. */
  | 'capture-failed'
  /** The capture record or the parse response lacks a field this file reads, or answers for another capture. */
  | 'malformed-capture'
  /** The capture holds no roster page at all. */
  | 'no-roster-pages'
  /** A roster page was fetched ok and the parse produced nothing for it. */
  | 'roster-page-unparsed'
  /** A roster page holds a table with no rows. It is not the "No rosters found" page. */
  | 'roster-table-empty'
  /** A roster page does not state the team name (and is not the "No rosters found" page). */
  | 'team-name-missing'
  /** Two roster pages of one capture state different team names. */
  | 'team-name-conflict'
  /** A roster page states no gender and the page record names none this file reads. */
  | 'roster-gender-missing'
  /** A roster page's printed gender contradicts the gender filter of its own URL. */
  | 'roster-gender-contradiction'
  /** Two roster pages of one capture are for one gender. This file does not merge pages. */
  | 'duplicate-roster-gender'
  /** The roster page names another team id than the capture subject. */
  | 'team-id-mismatch'
  /** The roster page's printed season differs from the capture subject's season label. */
  | 'season-label-mismatch';

export class TheoreticalCaptureError extends Error {
  readonly code: TheoreticalCaptureErrorCode;
  readonly captureId?: string;
  constructor(code: TheoreticalCaptureErrorCode, message: string, captureId?: string) {
    super(message);
    this.name = 'TheoreticalCaptureError';
    this.code = code;
    if (captureId !== undefined) this.captureId = captureId;
  }
}

/* -------------------------------------------------------------------------- */
/* Injected I/O                                                                */
/* -------------------------------------------------------------------------- */

/** The fields of a stored page record this file reads. The real record has more. */
export interface TheoreticalCapturePageRef {
  readonly canonicalUrl: string;
  readonly resourceKind: string;
  /** The gender filter letter SwimCloud wrote in the URL (`'M'` or `'F'`), when the record names it. */
  readonly gender?: string;
  readonly teamId?: string;
  /** ISO-8601. */
  readonly retrievedAt: string;
  readonly outcome: string;
  /** SHA-256 of the bytes at fetch time, as the crawl recorded them. Absent on a record with no hash. */
  readonly sha256?: string;
}

/** The fields of a stored capture record this file reads. `GET /api/swimcloud/captures` returns full records. */
export interface TheoreticalCaptureRecord {
  readonly captureId: string;
  readonly subject: SwimCloudCaptureSubject;
  readonly completeness: 'in-progress' | 'every-planned-page-fetched' | 'partial' | 'failed';
  readonly plannedPageCount: number;
  readonly pages: readonly TheoreticalCapturePageRef[];
}

/**
 * What the parse route read for one stored page: the hash of the bytes it parsed, and the write time of
 * those bytes. The parse reads whatever bytes the URL holds now, which can differ from the bytes the
 * capture record was written for (a later crawl of the same URL overwrites them).
 */
export interface TheoreticalStoredPageStamp {
  readonly canonicalUrl: string;
  readonly resourceKind: string;
  /** The stored entry's own `retrievedAt`: when these bytes were last written. */
  readonly entryRetrievedAt: string;
  /** SHA-256 of the stored bytes, computed when they were read for the parse. */
  readonly contentSha256: string;
}

/** The fields of `POST /api/swimcloud/captures/:id/parse` this file reads. */
export interface TheoreticalCaptureParse {
  readonly captureId: string;
  readonly rosters: readonly SwimCloudRosterParse[];
  readonly swimmerTimes: readonly SwimCloudSwimmerTimesParse[];
  /** The parse's own warning lines (`warnings` in the route response). Absent: none were returned. */
  readonly warnings?: readonly string[];
  /** One stamp per stored page the parse read (`storedPages` in the route response). Absent on a server that does not return it. */
  readonly storedPages?: readonly TheoreticalStoredPageStamp[];
}

export interface TheoreticalCaptureDeps {
  /** `GET /api/swimcloud/captures`. */
  listCaptures(): Promise<readonly TheoreticalCaptureRecord[]>;
  /** `POST /api/swimcloud/captures/:id/parse`. */
  parseCapture(captureId: string): Promise<TheoreticalCaptureParse>;
  /**
   * The stored HTML of one roster page, or `undefined` when the bytes are not
   * available. Optional: there is no route for it today (see the file header).
   * Used only to read the page's own season table.
   */
  readRosterPageHtml?(captureId: string, canonicalUrl: string): Promise<string | undefined>;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One team and gender, ready for `buildTheoreticalMeetSeeds`.
 * Assignable to {@link TheoreticalMeetTeamInput}; the extra fields are provenance.
 */
export interface CapturedTheoreticalTeam extends TheoreticalMeetTeamInput {
  readonly captureId: string;
  /** When the roster page was fetched. */
  readonly retrievedAt: string;
  readonly captureCompleteness: TheoreticalCaptureRecord['completeness'];
  /** Pages stored with outcome `ok`. */
  readonly pagesPresent: number;
  /** The capture's `plannedPageCount`. `0` means the crawl committed to no plan. */
  readonly pagesPlanned: number;
  /** Capture-level and team-level warnings, in plain words. Never empty by accident: no warning means nothing to report. */
  readonly warnings: readonly string[];
}

/** One capture's coverage, in the order the capture ids were given. */
export interface TheoreticalCaptureSummary {
  readonly captureId: string;
  readonly teamId: string;
  readonly season?: string;
  readonly completeness: TheoreticalCaptureRecord['completeness'];
  readonly pagesPresent: number;
  readonly pagesPlanned: number;
  /** Warnings that belong to the capture, not to one team. */
  readonly warnings: readonly string[];
  /** Canonical URLs of used pages whose stored bytes no longer hash to what the crawl recorded. */
  readonly driftedPages: readonly string[];
  /** How many used pages could not be checked (no recorded hash, no stored stamp, or no stamps at all). */
  readonly unverifiedPages: number;
  /** The parse's warning lines, counted by code. Nothing is dropped: an unknown shape counts as `other`. */
  readonly parseWarnings: TheoreticalParseWarningSummary;
}

export interface TheoreticalParseWarningSummary {
  readonly total: number;
  /** In order of first appearance. */
  readonly byCode: Readonly<Record<string, number>>;
  /** Every line, as the route returned it. */
  readonly lines: readonly string[];
}

export interface TheoreticalMeetFromCapturesResult {
  /** In capture order, then the roster page order inside each capture. Pass to `buildTheoreticalMeetSeeds` as `teams`. */
  readonly teams: readonly CapturedTheoreticalTeam[];
  readonly captures: readonly TheoreticalCaptureSummary[];
  /** Every warning once, each prefixed with its capture id. */
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Small readers                                                               */
/* -------------------------------------------------------------------------- */

const GENDER_BY_FILTER_LETTER: Readonly<Record<string, Gender>> = { M: Gender.MEN, F: Gender.WOMEN };

function malformed(captureId: string, message: string): TheoreticalCaptureError {
  return new TheoreticalCaptureError('malformed-capture', message, captureId);
}

function requireRecord(captureId: string, record: TheoreticalCaptureRecord): void {
  if (record.subject?.kind !== 'team') {
    throw new TheoreticalCaptureError('capture-not-a-team', `Capture ${captureId} is not a team capture.`, captureId);
  }
  if (!Array.isArray(record.pages)) throw malformed(captureId, `Capture ${captureId} has no page list.`);
  if (typeof record.plannedPageCount !== 'number' || !Number.isFinite(record.plannedPageCount)) {
    throw malformed(captureId, `Capture ${captureId} has no plannedPageCount.`);
  }
  if (record.completeness === 'failed') {
    throw new TheoreticalCaptureError(
      'capture-failed',
      `Capture ${captureId} is marked failed. Crawl the team again before building a meet from it.`,
      captureId
    );
  }
  const known = ['in-progress', 'every-planned-page-fetched', 'partial'];
  if (!known.includes(record.completeness)) {
    throw malformed(captureId, `Capture ${captureId} has completeness ${JSON.stringify(record.completeness)}.`);
  }
}

function requireParse(captureId: string, parse: TheoreticalCaptureParse): void {
  if (parse?.captureId !== captureId) {
    throw malformed(captureId, `The parse answered for capture ${String(parse?.captureId)}, not ${captureId}.`);
  }
  if (!Array.isArray(parse.rosters) || !Array.isArray(parse.swimmerTimes)) {
    throw malformed(captureId, `The parse of capture ${captureId} has no rosters or swimmerTimes list.`);
  }
}

/** Completeness warning, with the counts. `undefined` when the capture says it fetched every planned page and holds them. */
function completenessWarning(record: TheoreticalCaptureRecord, pagesPresent: number): string | undefined {
  const planned = record.plannedPageCount;
  const counts = `${pagesPresent} of ${planned} planned page(s) stored with outcome ok`;
  if (record.completeness === 'in-progress') {
    return `Capture ${record.captureId} is still in progress (${counts}). Rosters or times may be missing.`;
  }
  if (record.completeness === 'partial') {
    return `Capture ${record.captureId} is partial (${counts}). Rosters or times may be missing.`;
  }
  if (pagesPresent < planned) {
    return `Capture ${record.captureId} says it fetched every planned page, but only ${counts}. Rosters or times may be missing.`;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Roster pages                                                                */
/* -------------------------------------------------------------------------- */

type RosterPage = {
  readonly parse: SwimCloudRosterParse;
  readonly ref: TheoreticalCapturePageRef;
};

/**
 * Pair each roster parse with the stored page it came from.
 *
 * The parse response keeps no URL per roster, only the order of the pages that
 * parsed. When every `ok` roster page parsed, the n-th parse is the n-th page.
 * When any did not, the order no longer tells which is which, so this throws.
 */
function pairRosterPages(record: TheoreticalCaptureRecord, parse: TheoreticalCaptureParse): RosterPage[] {
  const refs = record.pages.filter(p => p.resourceKind === 'teamRoster' && p.outcome === 'ok');
  if (refs.length === 0) {
    throw new TheoreticalCaptureError('no-roster-pages', `Capture ${record.captureId} holds no roster page.`, record.captureId);
  }
  if (parse.rosters.length !== refs.length) {
    throw new TheoreticalCaptureError(
      'roster-page-unparsed',
      `Capture ${record.captureId} stores ${refs.length} roster page(s) but only ${parse.rosters.length} parsed. A roster that did not parse is not an empty roster.`,
      record.captureId
    );
  }
  return refs.map((ref, i) => ({ ref, parse: parse.rosters[i] }));
}

/** Gender of a roster page, with how it was learned. */
type ResolvedGender = { gender: Gender; fromFilterLetter: boolean };

function genderOfPage(captureId: string, page: RosterPage): ResolvedGender {
  const letter = page.ref.gender;
  const fromLetter = letter === undefined ? undefined : GENDER_BY_FILTER_LETTER[letter];
  const printed = page.parse.gender;
  if (printed !== undefined) {
    if (fromLetter !== undefined && fromLetter !== (printed as Gender)) {
      throw new TheoreticalCaptureError(
        'roster-gender-contradiction',
        `The roster page ${page.ref.canonicalUrl} prints ${printed}, but its URL filter is gender=${String(letter)}.`,
        captureId
      );
    }
    return { gender: printed as Gender, fromFilterLetter: false };
  }
  if (fromLetter === undefined) {
    throw new TheoreticalCaptureError(
      'roster-gender-missing',
      `The roster page ${page.ref.canonicalUrl} prints no gender and its record names no gender filter this file reads.`,
      captureId
    );
  }
  return { gender: fromLetter, fromFilterLetter: true };
}

/**
 * A parsed page carries athletes, or it is the real "No rosters found" page. Both are an ok parse.
 *
 * The empty-state page states nothing about itself: the parse holds no team name, gender or season. A page
 * with no athletes that DOES state one of them is a roster table with no rows (the parser's
 * `zero-data-rows` answer, for example a wrong season filter). That is not the empty-state page, so it is
 * not called `no_rosters_found`: it throws.
 */
function rosterStatusOf(captureId: string, page: RosterPage): 'parsed' | 'no_rosters_found' {
  const { parse } = page;
  if (parse.athletes.length > 0) return 'parsed';
  if (parse.teamName !== undefined || parse.gender !== undefined || parse.season !== undefined) {
    throw new TheoreticalCaptureError(
      'roster-table-empty',
      `The roster page ${page.ref.canonicalUrl} holds a roster table with no rows. That is not SwimCloud's "No rosters found" page, so it is not called an empty roster.`,
      captureId
    );
  }
  return 'no_rosters_found';
}

function teamNameFor(
  captureId: string,
  page: RosterPage,
  pages: readonly RosterPage[],
  warnings: string[]
): string {
  const own = page.parse.teamName?.trim();
  if (own !== undefined && own.length > 0) return own;
  if (rosterStatusOf(captureId, page) !== 'no_rosters_found') {
    throw new TheoreticalCaptureError(
      'team-name-missing',
      `The roster page ${page.ref.canonicalUrl} does not state the team name.`,
      captureId
    );
  }
  // The empty-state page prints no name. Join on the team id to the capture's other roster page.
  const teamId = page.parse.swimCloudTeamId;
  const siblings = new Set(
    pages
      .filter(p => p !== page && p.parse.swimCloudTeamId === teamId && (p.parse.teamName ?? '').trim().length > 0)
      .map(p => (p.parse.teamName as string).trim())
  );
  if (teamId === undefined || siblings.size === 0) {
    throw new TheoreticalCaptureError(
      'team-name-missing',
      `The roster page ${page.ref.canonicalUrl} is SwimCloud's "No rosters found" page, which prints no team name, and no other roster page of capture ${captureId} states one.`,
      captureId
    );
  }
  if (siblings.size > 1) {
    throw new TheoreticalCaptureError(
      'team-name-conflict',
      `The roster pages of capture ${captureId} state different team names: ${[...siblings].join(' / ')}.`,
      captureId
    );
  }
  const name = [...siblings][0];
  warnings.push(`The team name "${name}" comes from this capture's other roster page. This page is SwimCloud's "No rosters found" page and prints no name.`);
  return name;
}

/* -------------------------------------------------------------------------- */
/* Season id                                                                   */
/* -------------------------------------------------------------------------- */

function seasonIdFromUrl(canonicalUrl: string): string | undefined {
  try {
    return new URL(canonicalUrl).searchParams.get('season_id') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SwimCloud season id of the roster page's own season table, for the
 * subject's label. `undefined` (with a warning) in every case that is not an
 * exact answer. Never computed from the label.
 */
async function resolveRosterSeasonId(
  deps: TheoreticalCaptureDeps,
  record: TheoreticalCaptureRecord,
  page: RosterPage,
  warnings: string[]
): Promise<string | undefined> {
  const label = record.subject.kind === 'team' ? record.subject.season : undefined;
  if (label === undefined) {
    warnings.push('The capture subject has no season label, so the roster season id is not known.');
    return undefined;
  }
  if (page.parse.season !== undefined && page.parse.season !== label) {
    throw new TheoreticalCaptureError(
      'season-label-mismatch',
      `Capture ${record.captureId} is labelled ${label}, but the roster page ${page.ref.canonicalUrl} prints season ${page.parse.season}.`,
      record.captureId
    );
  }
  if (deps.readRosterPageHtml === undefined) {
    warnings.push('No roster page bytes were available, so the roster season id is not known.');
    return undefined;
  }
  const html = await deps.readRosterPageHtml(record.captureId, page.ref.canonicalUrl);
  if (html === undefined) {
    warnings.push('The roster page bytes are not stored, so the roster season id is not known.');
    return undefined;
  }
  let options;
  try {
    options = parseTeamSeasonOptions(html);
  } catch (error) {
    warnings.push(`The roster page's season table did not parse (${error instanceof Error ? error.message : String(error)}), so the roster season id is not known.`);
    return undefined;
  }
  const match = resolveSeasonOption(options, label);
  if (match === undefined) {
    warnings.push(`This team's own season table does not list ${label}, so the roster season id is not known.`);
    return undefined;
  }
  const inUrl = seasonIdFromUrl(page.ref.canonicalUrl);
  if (inUrl !== undefined && inUrl !== match.seasonId) {
    warnings.push(
      `The roster page URL asks for season_id=${inUrl}, but its season table lists ${label} as ${match.seasonId}. The roster season id is not known.`
    );
    return undefined;
  }
  // Proof the page is for this season: the URL asked for it (checked above), or the page prints it.
  // The season table lists every season the team has, so listing the label proves nothing by itself.
  if (inUrl !== undefined || page.parse.season === label) return match.seasonId;
  // No URL id and no printed season. The table's selected option is the server's current season; it
  // proves the page's season only when it is the label the capture was made for.
  const selected = options.find(option => option.selected);
  if (selected !== undefined && selected.label === label) return match.seasonId;
  warnings.push(
    selected === undefined
      ? `The roster page URL names no season_id, the page prints no season and its season table marks none selected, so nothing proves which season the page is for. The roster season id is not known.`
      : `The roster page URL names no season_id and the page prints no season, and its season table marks ${selected.label} selected, not ${label}, so nothing proves which season the page is for. The roster season id is not known.`
  );
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Athletes and their times                                                    */
/* -------------------------------------------------------------------------- */

/** SwimCloud swimmer id to the stored times page (first one wins), for every `ok` times page the capture holds. */
function timesPageRefs(record: TheoreticalCaptureRecord): { ok: Map<string, TheoreticalCapturePageRef>; notOk: number } {
  const ok = new Map<string, TheoreticalCapturePageRef>();
  let notOk = 0;
  for (const page of record.pages) {
    if (page.resourceKind !== 'swimmerFastestTimes' && page.resourceKind !== 'swimmerTimes') continue;
    if (page.outcome !== 'ok') {
      notOk += 1;
      continue;
    }
    const classified = classifySwimCloudUrl(page.canonicalUrl);
    const resource = classified.outcome === 'fetchable' ? classified.resource : undefined;
    if (resource === undefined || (resource.kind !== 'swimmerFastestTimes' && resource.kind !== 'swimmerTimes')) {
      throw malformed(record.captureId, `The times page ${page.canonicalUrl} does not classify as a swimmer times page.`);
    }
    if (!ok.has(resource.swimmerId)) ok.set(resource.swimmerId, page);
  }
  return { ok, notOk };
}

function buildAthletes(
  record: TheoreticalCaptureRecord,
  parse: TheoreticalCaptureParse,
  roster: SwimCloudRosterParse,
  teamName: string,
  gender: Gender,
  timesRefs: ReadonlyMap<string, TheoreticalCapturePageRef>,
  consumed: Set<SwimCloudSwimmerTimesParse>,
  warnings: string[]
): TheoreticalMeetAthleteInput[] {
  const entries: RosterQueueEntry[] = roster.athletes.map(a => ({
    swimCloudSwimmerId: a.swimCloudSwimmerId,
    name: a.name,
    captured: false,
  }));
  const pairings = pairRosterWithSwimmerTimes(entries, parse.swimmerTimes);
  return roster.athletes.map((athlete: SwimCloudAthlete, index): TheoreticalMeetAthleteInput => {
    const { entry, parse: timesParse } = pairings[index];
    const ref = athlete.swimCloudSwimmerId === undefined ? undefined : timesRefs.get(athlete.swimCloudSwimmerId);
    const provenance = {
      captureId: record.captureId,
      ...(ref === undefined ? {} : { retrievedAt: ref.retrievedAt }),
    };
    if (timesParse === undefined) {
      // A page exists for this id and nothing parsed from it: say so. No page: no claim.
      return ref === undefined ? { athlete, swims: undefined, ...provenance } : { athlete, swims: undefined, swimsStatus: 'parse_failed', ...provenance };
    }
    consumed.add(timesParse);
    // The times JSON names no swimmer. An id match to this roster row is an id join on one capture.
    const named =
      timesParse.name === undefined && entry.swimCloudSwimmerId !== undefined && entry.swimCloudSwimmerId === timesParse.swimCloudSwimmerId
        ? { ...timesParse, name: entry.name }
        : timesParse;
    const accounted = convertAndAccountSwimmerTimes(named, {
      team: teamName,
      gender,
      ...(ref === undefined ? {} : { retrievedAt: ref.retrievedAt }),
    });
    if (accounted.ok) return { athlete, swims: accounted.swims, ...provenance };
    if (accounted.reason === 'no-usable-times') return { athlete, swims: [], ...provenance };
    warnings.push(`${athlete.name}: the times page could not be converted (${accounted.message})`);
    return { athlete, swims: undefined, swimsStatus: 'parse_failed', ...provenance };
  });
}

/* -------------------------------------------------------------------------- */
/* Page bytes and parse warnings                                               */
/* -------------------------------------------------------------------------- */

const USED_PAGE_KINDS = ['teamRoster', 'swimmerFastestTimes', 'swimmerTimes'];

const shortSha = (sha: string): string => `${sha.slice(0, 12)}...`;

type Verification = {
  /** Used pages whose stored bytes hash to something other than what the crawl recorded. */
  drifted: Map<string, TheoreticalStoredPageStamp>;
  unverified: number;
  warnings: string[];
};

/**
 * Compare the hash the crawl recorded for each used page with the hash of the bytes the parse read.
 * The parse reads whatever the URL holds now. A later crawl of the same URL overwrites the bytes, so
 * a capture record can describe a page whose bytes are no longer there. A page that cannot be
 * checked is counted, never assumed clean.
 */
function verifyStoredPages(record: TheoreticalCaptureRecord, parse: TheoreticalCaptureParse): Verification {
  const used = record.pages.filter(p => p.outcome === 'ok' && USED_PAGE_KINDS.includes(p.resourceKind));
  const stamps = new Map((parse.storedPages ?? []).map(stamp => [stamp.canonicalUrl, stamp] as const));
  const result: Verification = { drifted: new Map(), unverified: 0, warnings: [] };
  for (const ref of used) {
    const stamp = stamps.get(ref.canonicalUrl);
    if (ref.sha256 === undefined || stamp === undefined) {
      result.unverified += 1;
      continue;
    }
    if (stamp.contentSha256 === ref.sha256) continue;
    result.drifted.set(ref.canonicalUrl, stamp);
    result.warnings.push(
      `page-bytes-drifted: ${ref.canonicalUrl} was fetched as sha256 ${shortSha(ref.sha256)}, but the stored bytes hash to ${shortSha(stamp.contentSha256)}. ` +
        `The stored bytes were parsed. The page's fetch time is replaced by the time the stored bytes were written (${stamp.entryRetrievedAt}).`
    );
  }
  if (result.unverified > 0) {
    result.warnings.push(
      parse.storedPages === undefined
        ? `${result.unverified} page(s) could not be checked against the fetched bytes: the capture parse returned no page hashes.`
        : `${result.unverified} page(s) could not be checked against the fetched bytes: no recorded hash, or no stored bytes.`
    );
  }
  return result;
}

/** The page ref with its time replaced by the stored bytes' own write time, when the bytes drifted. */
function withStoredTime(ref: TheoreticalCapturePageRef, drifted: ReadonlyMap<string, TheoreticalStoredPageStamp>): TheoreticalCapturePageRef {
  const stamp = drifted.get(ref.canonicalUrl);
  return stamp === undefined ? ref : { ...ref, retrievedAt: stamp.entryRetrievedAt };
}

/**
 * The code of one parse warning line. The route writes four shapes:
 * `{url} (row N): {code} — {message}`, `{url}: {code} — {message}`, `Could not parse {url}: ...`
 * and `No stored content for {url} (...)`. Anything else is `other`.
 */
function parseWarningCode(line: string): string {
  if (line.startsWith('Could not parse ')) return 'page-not-parsed';
  if (line.startsWith('No stored content for ')) return 'no-stored-content';
  const match = /: ([a-z][a-z0-9-]*) — /.exec(line);
  return match === null ? 'other' : match[1];
}

/** Count the parse's warning lines by code. Exported for the report UI and the tests. */
export function summarizeParseWarnings(lines: readonly string[]): TheoreticalParseWarningSummary {
  const byCode: Record<string, number> = {};
  for (const line of lines) {
    const code = parseWarningCode(line);
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return { total: lines.length, byCode, lines: [...lines] };
}

/* -------------------------------------------------------------------------- */
/* One capture                                                                 */
/* -------------------------------------------------------------------------- */

async function teamsOfCapture(
  deps: TheoreticalCaptureDeps,
  record: TheoreticalCaptureRecord
): Promise<{ teams: CapturedTheoreticalTeam[]; summary: TheoreticalCaptureSummary }> {
  const captureId = record.captureId;
  requireRecord(captureId, record);
  const subject = record.subject as Extract<SwimCloudCaptureSubject, { kind: 'team' }>;
  const parse = await deps.parseCapture(captureId);
  requireParse(captureId, parse);

  const pagesPresent = record.pages.filter(p => p.outcome === 'ok').length;
  const captureWarnings: string[] = [];
  const completeness = completenessWarning(record, pagesPresent);
  if (completeness !== undefined) captureWarnings.push(completeness);

  const verification = verifyStoredPages(record, parse);
  captureWarnings.push(...verification.warnings);
  const parseWarnings = summarizeParseWarnings(parse.warnings ?? []);
  if (parseWarnings.total > 0) {
    const counts = Object.entries(parseWarnings.byCode).map(([code, n]) => `${code} x${n}`).join(', ');
    captureWarnings.push(`The capture parse reported ${parseWarnings.total} warning(s): ${counts}.`);
  }

  const pages = pairRosterPages(record, parse).map(page => ({ ...page, ref: withStoredTime(page.ref, verification.drifted) }));
  for (const page of pages) {
    const id = page.parse.swimCloudTeamId;
    if (id !== undefined && id !== subject.teamId) {
      throw new TheoreticalCaptureError(
        'team-id-mismatch',
        `The roster page ${page.ref.canonicalUrl} is for team ${id}, but capture ${captureId} is for team ${subject.teamId}.`,
        captureId
      );
    }
  }
  const notOkRoster = record.pages.filter(p => p.resourceKind === 'teamRoster' && p.outcome !== 'ok');
  for (const page of notOkRoster) {
    captureWarnings.push(`The roster page ${page.canonicalUrl} was recorded with outcome ${page.outcome}. No team was made from it.`);
  }

  const { ok: rawTimesRefs, notOk } = timesPageRefs(record);
  const timesRefs = new Map([...rawTimesRefs].map(([id, ref]) => [id, withStoredTime(ref, verification.drifted)] as const));
  if (notOk > 0) {
    captureWarnings.push(`${notOk} swimmer times page(s) were recorded with a non-ok outcome. Those swimmers count as having no times captured.`);
  }

  const genders = pages.map(page => genderOfPage(captureId, page));
  const seenGender = new Set<Gender>();
  for (const { gender } of genders) {
    if (seenGender.has(gender)) {
      throw new TheoreticalCaptureError('duplicate-roster-gender', `Capture ${captureId} holds two roster pages for ${gender}. This file does not merge roster pages.`, captureId);
    }
    seenGender.add(gender);
  }
  const letterCorroborated = genders.some(g => !g.fromFilterLetter);

  const consumed = new Set<SwimCloudSwimmerTimesParse>();
  const teams: CapturedTheoreticalTeam[] = [];
  for (const [index, page] of pages.entries()) {
    const teamWarnings: string[] = [];
    const { gender, fromFilterLetter } = genders[index];
    if (fromFilterLetter && !letterCorroborated) {
      teamWarnings.push(`The gender of this "No rosters found" page comes from its URL filter (gender=${String(page.ref.gender)}), and no parsed roster page of this capture confirms that reading.`);
    }
    const teamName = teamNameFor(captureId, page, pages, teamWarnings);
    const rosterSeasonId = await resolveRosterSeasonId(deps, record, page, teamWarnings);
    const rosterStatus = rosterStatusOf(captureId, page);
    const athletes =
      rosterStatus === 'no_rosters_found'
        ? []
        : buildAthletes(record, parse, page.parse, teamName, gender, timesRefs, consumed, teamWarnings);
    teams.push({
      teamName,
      gender,
      rosterStatus,
      ...(rosterSeasonId === undefined ? {} : { rosterSeasonId }),
      athletes,
      captureId,
      retrievedAt: page.ref.retrievedAt,
      captureCompleteness: record.completeness,
      pagesPresent,
      pagesPlanned: record.plannedPageCount,
      warnings: [...captureWarnings, ...teamWarnings],
    });
  }

  const unmatched = parse.swimmerTimes.filter(t => !consumed.has(t)).length;
  if (unmatched > 0) {
    const line = `${unmatched} parsed swimmer times page(s) match no athlete on this capture's roster pages. They are not used.`;
    captureWarnings.push(line);
    for (const [i, team] of teams.entries()) teams[i] = { ...team, warnings: [...team.warnings, line] };
  }

  return {
    teams,
    summary: {
      captureId,
      teamId: subject.teamId,
      ...(subject.season === undefined ? {} : { season: subject.season }),
      completeness: record.completeness,
      pagesPresent,
      pagesPlanned: record.plannedPageCount,
      warnings: captureWarnings,
      driftedPages: [...verification.drifted.keys()],
      unverifiedPages: verification.unverified,
      parseWarnings,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read crawled team captures and return the teams the seed builder takes.
 *
 * `captureIds` are the captures to use, in the team order the meet should have.
 * A capture id names one team at one season (`team-412-2026-2027`). Throws
 * {@link TheoreticalCaptureError}; see the file header for each code.
 */
export async function theoreticalMeetFromCaptures(
  captureIds: readonly string[],
  deps: TheoreticalCaptureDeps
): Promise<TheoreticalMeetFromCapturesResult> {
  if (captureIds.length === 0) {
    throw new TheoreticalCaptureError('invalid-input', 'No capture ids were given.');
  }
  const unique = new Set(captureIds);
  if (unique.size !== captureIds.length) {
    throw new TheoreticalCaptureError('invalid-input', 'A capture id was given twice.');
  }
  const records = await deps.listCaptures();
  const teams: CapturedTheoreticalTeam[] = [];
  const captures: TheoreticalCaptureSummary[] = [];
  const warnings: string[] = [];
  for (const captureId of captureIds) {
    const record = records.find(r => r.captureId === captureId);
    if (record === undefined) {
      throw new TheoreticalCaptureError('capture-not-found', `Capture ${captureId} is not in the capture list.`, captureId);
    }
    const built = await teamsOfCapture(deps, record);
    teams.push(...built.teams);
    captures.push(built.summary);
    for (const line of built.summary.warnings) warnings.push(`${captureId}: ${line}`);
    for (const team of built.teams) {
      for (const line of team.warnings.filter(w => !built.summary.warnings.includes(w))) {
        warnings.push(`${captureId} (${team.teamName}, ${team.gender}): ${line}`);
      }
    }
  }
  return { teams, captures, warnings: [...new Set(warnings)] };
}
