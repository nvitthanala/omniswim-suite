/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a (plans/2026-10-25/D7-DATA-SOURCING.md section 4): read one background roster page into a roster the docked
 * panel may store. It wraps `parseTeamRosterHtml` and `parseTeamSeasonOptions` and adds the checks they do not make.
 *
 * Outcomes:
 * - `members`: the page lists swimmers. Its heading reads exactly `Season {label} {Men|Women}` and agrees with the
 *   request, the selected season option and (for a chosen season) the target label.
 * - `verified-empty`: SwimCloud printed "No rosters found" (a real answer), the selected season option agrees with
 *   the target, and the final path is the requested path. The gender comes from the request: that page prints none.
 * - `refused`: anything else. A refusal means the caller writes nothing and keeps the earlier record. It is never a
 *   verified-empty roster and never a partial one.
 *
 * Rules held here:
 * - Default deny on parser warnings. Only `no-roster-posted` (on an empty page) is accepted; every other warning, known
 *   or new, refuses the page. That includes `unmapped-class-year` (D7 U7: an unmapped Class word refuses the whole roster).
 * - A Class cell of "-" or nothing is absent for that swimmer. It is never derived from anything else (R88).
 * - A `page=N` link with N of 2 or more, or pagination markup, refuses (D7 U8: R86 approves one page).
 * - The caller's season and gender are never given to the parser as a fallback: a page that dropped its heading must
 *   not be rescued by the request.
 * - Nothing joins swimmers by name. A roster row without a `/swimmer/{id}` link refuses the page.
 * - No clock, no network, no storage. The caller supplies `fetchedAt`.
 */
import { parseTeamRosterHtml } from '../rosterPage';
import { parseTeamSeasonOptions, TeamSeasonParseError } from '../teamSeasons';
import { collapseWhitespace, findElementSpans, htmlToText, stripNonContent } from '../html';
import { classTokens, readAttribute, startTagOf } from '../parseElements';
import { CLASS_HEADERS, normalizeHeader } from '../parseCells';

/** The slice of the extension's `RosterTarget` this parser reads. A real `RosterTarget` fits. */
export interface RosterFetchTarget {
  readonly teamId: string;
  readonly gender: 'M' | 'F';
  readonly season: { readonly kind: 'server-current' } | { readonly kind: 'option'; readonly value: string; readonly label: string };
}

export interface RosterFetchInput {
  readonly target: RosterFetchTarget;
  /** The path the overlay requested, from `fetchPathFor(target)`. */
  readonly requestedPath: string;
  /** The path of the response after redirects. */
  readonly finalPath: string;
  /** ISO 8601 instant of the fetch. The parser has no clock. */
  readonly fetchedAt: string;
  /**
   * For a `server-current` target only: the label the caller believes is current (the page's own season list). When given, a
   * page whose selected season differs refuses. Near the 1 September rollover the two can differ. Ignored for a chosen season.
   */
  readonly expectedSeasonLabel?: string;
}

export type RosterClassCode = 'FR' | 'SO' | 'JR' | 'SR' | 'GR';

export type RosterFetchRefusalCode =
  | 'request-mismatch'
  | 'redirected'
  | 'season-select-invalid'
  | 'season-not-selected'
  | 'season-mismatch'
  | 'gender-mismatch'
  | 'heading-missing'
  | 'heading-ambiguous'
  | 'heading-mismatch'
  | 'pagination'
  | 'parse-failed'
  | 'zero-data-rows'
  | 'missing-athlete-link'
  | 'unparsed-row'
  | 'contradicted-page-declaration'
  | 'unmapped-class-year'
  /** The members table has no Class column. Every class year would be absent, which is not what the page says: refuse (architect ruling 4). */
  | 'class-column-missing'
  | 'duplicate-swimmer-id'
  | 'unexpected-warning'
  | 'unexpected-parse';

export type RosterFetchOutcome =
  | {
      readonly kind: 'members';
      readonly teamId: string;
      /** `YYYY-YYYY`, the label the page printed and the selected option carried. */
      readonly seasonLabel: string;
      readonly gender: 'Men' | 'Women';
      /** Swimmer ids in page order, each unique. */
      readonly memberIds: readonly string[];
      /** Present only when at least one member has a class year. A member with "-" or no cell has no key. */
      readonly classYears?: Readonly<Record<string, RosterClassCode>>;
      readonly parser: { readonly name: 'readRosterFetch'; readonly confidence: string };
    }
  | {
      readonly kind: 'verified-empty';
      readonly teamId: string;
      readonly seasonLabel: string;
      readonly gender: 'Men' | 'Women';
      readonly parser: { readonly name: 'readRosterFetch'; readonly confidence: string };
    }
  | { readonly kind: 'refused'; readonly code: RosterFetchRefusalCode; readonly detail: string };

const SWIMCLOUD_ORIGIN = 'https://www.swimcloud.com';
const PARSER_NAME = 'readRosterFetch' as const;
const GENDER_WORD = { M: 'Men', F: 'Women' } as const;
const CLASS_CODES: readonly string[] = ['FR', 'SO', 'JR', 'SR', 'GR'];

const refuse = (code: RosterFetchRefusalCode, detail: string): RosterFetchOutcome => ({ kind: 'refused', code, detail });

/** `/team/{id}/roster/?...&gender=X...` must name this target's team and gender. */
function pathMatchesTarget(path: string, target: RosterFetchTarget): boolean {
  const m = /^\/team\/(\d+)\/roster\/\?(.*)$/.exec(path);
  if (!m) return false;
  if (m[1] !== target.teamId) return false;
  const query = new URLSearchParams(m[2]);
  if (query.get('gender') !== target.gender) return false;
  if (target.season.kind === 'option') return query.get('season_id') === target.season.value;
  return !query.has('season_id');
}

/**
 * A second page of results. Refuses on a link whose `page` is not 1, on `rel="next"`, and on a pagination class. Real rosters of 24 to 44
 * rows carry none of these (D7 live check 5); the hidden `<input name="page" value="1">` of the filter form is not a link.
 */
export function findRosterPagination(html: string): string | null {
  const cleaned = stripNonContent(html);
  for (const m of cleaned.matchAll(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const href = (m[2] ?? m[3] ?? '').replace(/&amp;/gi, '&');
    const q = href.indexOf('?');
    if (q < 0) continue;
    const page = new URLSearchParams(href.slice(q + 1).replace(/#.*$/, '')).get('page');
    if (page !== null && page !== '1') return `a link to page=${page}`;
  }
  for (const m of cleaned.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
    if (/\brel\s*=\s*["']?[^"'>]*\bnext\b/i.test(m[0])) return 'a rel="next" link';
  }
  for (const m of cleaned.matchAll(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const token = (m[2] ?? m[3] ?? '').split(/\s+/).find((t) => /^(?:c-)?(?:pagination|paginator|pager)(?:$|[-_])/i.test(t));
    if (token) return `the "${token}" class`;
  }
  return null;
}

interface SelectedSeason { readonly value: string; readonly label: string }

function selectedSeason(html: string): { readonly season: SelectedSeason } | { readonly refusal: RosterFetchOutcome } {
  let options;
  try {
    options = parseTeamSeasonOptions(html);
  } catch (error) {
    if (error instanceof TeamSeasonParseError) return { refusal: refuse('season-select-invalid', `${error.code}: ${error.message}`) };
    throw error;
  }
  const selected = options.filter((o) => o.selected);
  if (selected.length !== 1) return { refusal: refuse('season-not-selected', `the season select marks ${selected.length} options as selected, not 1`) };
  const only = selected[0]!;
  return { season: { value: only.seasonId, label: only.label } };
}

/** The text of every `<h2 class="c-title">` that starts with "Season". */
function seasonHeadings(cleaned: string): string[] {
  return findElementSpans(cleaned, 'h2')
    .filter((h) => classTokens(startTagOf(h.html)).includes('c-title'))
    .map((h) => collapseWhitespace(htmlToText(h.inner)))
    .filter((text) => /^season\b/i.test(text));
}

/** The `value` of every `<input name="gender">` the filter form marks `checked`. */
function checkedGenderValues(cleaned: string): string[] {
  const out: string[] = [];
  for (const m of cleaned.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (readAttribute(tag, 'name') !== 'gender') continue;
    if (readAttribute(tag, 'checked') !== undefined || /\schecked(?=[\s/>])/i.test(tag)) out.push(readAttribute(tag, 'value') ?? '');
  }
  return out;
}

function hasClassColumn(cleaned: string): boolean {
  return findElementSpans(cleaned, 'th').some((th) => (CLASS_HEADERS as readonly string[]).includes(normalizeHeader(htmlToText(th.inner))));
}

type Parsed = Extract<ReturnType<typeof parseTeamRosterHtml>, { ok: true }>;
interface PageContext {
  readonly input: RosterFetchInput;
  readonly season: SelectedSeason;
  readonly wanted: 'Men' | 'Women';
  readonly cleaned: string;
  readonly headings: readonly string[];
  readonly parsed: Parsed;
}

/** The request, the redirect, the selected season and pagination: checks that hold for every page. */
function checkPage(html: string, input: RosterFetchInput): { readonly season: SelectedSeason } | { readonly refusal: RosterFetchOutcome } {
  const { target, requestedPath, finalPath } = input;
  if (!pathMatchesTarget(requestedPath, target)) {
    return { refusal: refuse('request-mismatch', `the requested path ${requestedPath} does not name team ${target.teamId}, gender ${target.gender} and the target season`) };
  }
  if (finalPath !== requestedPath) return { refusal: refuse('redirected', `asked for ${requestedPath}, answered at ${finalPath}`) };
  const picked = selectedSeason(html);
  if ('refusal' in picked) return picked;
  const { season } = picked;
  if (target.season.kind === 'option') {
    if (season.value !== target.season.value || season.label !== target.season.label) {
      return { refusal: refuse('season-mismatch', `asked for season ${target.season.value} (${target.season.label}); the page selects ${season.value} (${season.label})`) };
    }
  } else if (input.expectedSeasonLabel !== undefined && season.label !== input.expectedSeasonLabel) {
    return { refusal: refuse('season-mismatch', `the current season is ${input.expectedSeasonLabel}; the page selects ${season.label}`) };
  }
  const pagination = findRosterPagination(html);
  if (pagination !== null) return { refusal: refuse('pagination', `the page shows ${pagination}; only one page of a roster is approved (R86)`) };
  return picked;
}

/** The empty state is a real answer, accepted only on positive evidence. */
function readEmptyPage(ctx: PageContext): RosterFetchOutcome {
  const { input, season, wanted, cleaned, headings, parsed } = ctx;
  if (parsed.data.athletes.length !== 0 || parsed.data.rowCount !== 0) return refuse('unexpected-parse', 'an empty-state page also listed swimmers');
  const other = parsed.warnings.find((w) => w.code !== 'no-roster-posted');
  if (other) return refuse('unexpected-warning', `${other.code}: ${other.message}`);
  const exact = `Season ${season.label} ${wanted}`;
  if (headings.length === 1 && headings[0] !== exact) return refuse('heading-mismatch', `expected "${exact}", the page says "${headings[0]}"`);
  // The empty page prints no heading gender. The request supplies it; a checked filter radio, if there is one, must agree.
  const checked = checkedGenderValues(cleaned);
  if (checked.some((v) => v !== input.target.gender)) {
    return refuse('gender-mismatch', `the request is for gender ${input.target.gender}; the filter form checks ${checked.join(', ')}`);
  }
  return { kind: 'verified-empty', teamId: input.target.teamId, seasonLabel: season.label, gender: wanted, parser: { name: PARSER_NAME, confidence: parsed.confidence } };
}

/** Default deny: the known refusals first, for a clear message, then any other warning. */
function warningRefusal(warnings: Parsed['warnings']): RosterFetchOutcome | null {
  const order: readonly RosterFetchRefusalCode[] = ['zero-data-rows', 'missing-athlete-link', 'unparsed-row', 'contradicted-page-declaration', 'unmapped-class-year'];
  for (const code of order) {
    const hit = warnings.find((w) => w.code === code);
    if (hit) return refuse(code, hit.raw !== undefined ? `${hit.message} (${JSON.stringify(hit.raw)})` : hit.message);
  }
  const first = warnings[0];
  return first ? refuse('unexpected-warning', `${first.code}: ${first.message}`) : null;
}

/** The heading must be exactly `Season {label} {Men|Women}` for this page and request. */
function headingRefusal(ctx: PageContext): RosterFetchOutcome | null {
  const { season, wanted, headings, parsed } = ctx;
  const { data } = parsed;
  if (headings.length === 0) return refuse('heading-missing', 'the page has no "Season ..." heading');
  const exact = `Season ${season.label} ${wanted}`;
  if (headings[0] !== exact) {
    const said = /\s(Men|Women)$/i.exec(headings[0] ?? '')?.[1];
    return refuse(said !== undefined && said !== wanted ? 'gender-mismatch' : 'heading-mismatch', `expected "${exact}", the page says "${headings[0]}"`);
  }
  // Defence in depth: the parser's own reading must agree with the heading and must have come from the page, not from a fallback.
  if (data.seasonSource !== 'page' || data.season !== season.label || data.genderSource !== 'page' || data.gender !== wanted) {
    return refuse('unexpected-parse', `the parser read season ${String(data.season)} (${String(data.seasonSource)}), gender ${String(data.gender)} (${String(data.genderSource)})`);
  }
  return null;
}

/** A members page. */
function readMembersPage(ctx: PageContext): RosterFetchOutcome {
  const { input, season, wanted, cleaned, parsed } = ctx;
  const { data } = parsed;
  const early = headingRefusal(ctx) ?? warningRefusal(parsed.warnings);
  if (early) return early;
  if (!hasClassColumn(cleaned)) return refuse('class-column-missing', 'the members table has no Class column, so no class year can be read');
  if (data.athletes.length === 0 || data.athletes.length !== data.rowCount) return refuse('unexpected-parse', `${data.athletes.length} swimmers from ${data.rowCount} rows`);
  const memberIds: string[] = [];
  const seen = new Set<string>();
  const classYears: Record<string, RosterClassCode> = {};
  for (const athlete of data.athletes) {
    const id = athlete.swimCloudSwimmerId;
    if (id === undefined) return refuse('missing-athlete-link', `a row for ${JSON.stringify(athlete.name)} has no swimmer id`);
    if (seen.has(id)) return refuse('duplicate-swimmer-id', `swimmer ${id} is listed twice`);
    seen.add(id);
    memberIds.push(id);
    if (athlete.classYear === undefined) continue; // "-" or an empty cell: absent for this swimmer
    if (!CLASS_CODES.includes(athlete.classYear)) return refuse('unmapped-class-year', `class year ${String(athlete.classYear)} for swimmer ${id}`);
    classYears[id] = athlete.classYear as RosterClassCode;
  }
  return {
    kind: 'members',
    teamId: input.target.teamId,
    seasonLabel: season.label,
    gender: wanted,
    memberIds,
    ...(Object.keys(classYears).length > 0 ? { classYears } : {}),
    parser: { name: PARSER_NAME, confidence: parsed.confidence },
  };
}

/** Read one roster page. Never throws for page content; a refusal is a value. */
export function readRosterFetch(html: string, input: RosterFetchInput): RosterFetchOutcome {
  const checked = checkPage(html, input);
  if ('refusal' in checked) return checked.refusal;
  const cleaned = stripNonContent(html);
  const headings = seasonHeadings(cleaned);
  if (headings.length > 1) return refuse('heading-ambiguous', `the page has ${headings.length} "Season ..." headings`);
  // Parser input: the canonical host makes the URL classifiable. The target's season and gender are NOT passed (no caller fallback).
  const parsed = parseTeamRosterHtml(html, { sourceUrl: `${SWIMCLOUD_ORIGIN}${input.requestedPath}`, retrievedAt: input.fetchedAt, track: 'browser-extension' });
  if (!parsed.ok) return refuse('parse-failed', `${parsed.failure.code}: ${parsed.failure.message}`);
  const ctx: PageContext = { input, season: checked.season, wanted: GENDER_WORD[input.target.gender], cleaned, headings, parsed };
  return parsed.warnings.some((w) => w.code === 'no-roster-posted') ? readEmptyPage(ctx) : readMembersPage(ctx);
}
