/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The local HTTP surface the SwimCloud browser extension posts a crawl into —
 * `plans/2026-09-08/03-extension-crawler.md`'s "Route contract" and its five
 * non-negotiable security requirements.
 *
 * ```
 * POST   /api/swimcloud/captures            open or update one capture record
 * GET    /api/swimcloud/captures            list them (the Matrix picker)
 * GET    /api/swimcloud/captures/:id        one record
 * POST   /api/swimcloud/captures/:id/pages  one fetched page of the crawl
 * POST   /api/swimcloud/captures/:id/parse  parse the stored pages
 * DELETE /api/swimcloud/captures/:id        forget it, pages included
 * ```
 *
 * `/parse` arrived last (Phase 2c) and deliberately so: it was held back until
 * `packages/matrix/src/components/SwimCloudCapturePicker.tsx` existed to consume
 * it, because a response shape with no reader is a guess. See
 * {@link parseSwimCloudCapture} for what it does and does not promise.
 *
 * ## Why this is a module and not inline in `server.ts`
 *
 * Every route below is reachable without authentication (this suite ships with
 * auth off), so the pairing token, the loopback gate, the id validation and the
 * body cap *are* the access control. Security-relevant code that cannot be
 * exercised by a test is code that will regress —
 * `plans/2026-08-14/10-security-exposure.md` §4 makes exactly that argument
 * about `authMiddleware.ts`. `server.ts` starts its server at import time, so
 * nothing in it is testable in isolation. This module is, and
 * `tests/swimcloudCaptureRoutes.test.ts` drives all five guards through a real
 * Express app on a real socket against a real temp directory.
 *
 * ## Trust boundary
 *
 * Anything reaching these handlers came off the network. `req.body`,
 * `req.params.id` and every header are attacker-controlled strings until a
 * validator here says otherwise. Nothing is coerced, defaulted or repaired:
 * a malformed request is rejected with a status and a sentence, never
 * normalized into a plausible-looking capture.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler, Response, Router } from 'express';

import {
  captureIdForSubject,
  FileSystemSwimCloudCaptureStore,
  type SwimCloudCaptureCompleteness,
  type SwimCloudCapturePageRef,
  type SwimCloudCaptureRecord,
  type SwimCloudCaptureSubject,
  type SwimCloudCaptureTeamDiscovery,
} from '../../../packages/swimcloud/src/captureStore.ts';
import type { SwimCloudCacheEntry } from '../../../packages/swimcloud/src/cache.ts';
import type { SwimCloudCaptureTrack } from '../../../packages/swimcloud/src/entities.ts';
import { readSwimCloudClipboardPayload } from '../../../packages/swimcloud/src/clipboardPayload.ts';
import {
  parseMeetEventResultsHtml,
  parseSwimmerTimesHtml,
  parseTeamMeetSwimsHtml,
  parseTeamRosterHtml,
  type SwimCloudMeetEventResultsParse,
  type SwimCloudParseContext,
  type SwimCloudParseResult,
  type SwimCloudParseWarning,
  type SwimCloudRosterParse,
  type SwimCloudSwimmerTimesParse,
  type SwimCloudTeamMeetSwimsParse,
} from '../../../packages/swimcloud/src/parser.ts';
import {
  classifySwimCloudUrl,
  type SwimCloudResource,
  type SwimCloudResourceKind,
} from '../../../packages/swimcloud/src/urlClassifier.ts';
import { isLoopbackHost } from './loopbackHost.ts';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Mount point. The extension builds `http://127.0.0.1:{PORT}${BASE}` from this. */
export const SWIMCLOUD_CAPTURE_ROUTE_BASE = '/api/swimcloud/captures';

/** Header carrying the pairing token, as named in the route contract. */
export const SWIMCLOUD_CAPTURE_TOKEN_HEADER = 'X-Omniswim-Capture-Token';

/**
 * Per-route body cap, tighter than the app-wide 50 MB.
 *
 * One page of SwimCloud HTML is ~200 KB (`03-extension-crawler.md` §5 of the
 * security list), so 2 MB is ten times the largest legitimate request and still
 * three orders of magnitude below what the global parser would accept.
 */
export const SWIMCLOUD_CAPTURE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** The `limit` string handed to `express.json` — kept in sync with the byte constant above. */
export const SWIMCLOUD_CAPTURE_BODY_LIMIT = '2mb';

/**
 * The exact shape `captureIdForSubject` produces, and nothing wider.
 *
 * It emits `meet-{digits}`, `team-{digits}` or `team-{digits}-{season}`. The
 * character class therefore holds lowercase letters, digits and `-` only — no
 * `.`, so `..` cannot be spelled; no `/` or `\`, so no separator can be
 * introduced; no leading `-`, so an id can never be read as a flag by anything
 * downstream. The length cap is a sanity bound, not a claim about the id space.
 *
 * This is necessary but NOT sufficient on its own — see
 * {@link resolveCaptureFilePathWithinRoot} for the containment assertion that
 * backs it up, per `plans/2026-08-14/10-security-exposure.md` §2.
 */
export const SWIMCLOUD_CAPTURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * The `season` segment of a team subject, which flows through
 * `captureIdForSubject` straight into a filename.
 *
 * `clipboardPayload.ts` validates `season` as "some string", which is correct
 * for *its* job (is this the shape the extension produces). It is not enough
 * for a value that becomes a path component, and this route is where that
 * matters. `2026-2027` passes; `../../etc` does not.
 */
const SEASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

/** A page number in a URL query, as a bounded positive integer with no leading zeros. */
const PAGE_NUMBER = /^[1-9][0-9]{0,4}$/;

const CAPTURE_TRACKS: readonly SwimCloudCaptureTrack[] = [
  'browser-extension',
  'playwright',
  'synthetic-fixture',
];

const CAPTURE_COMPLETENESS: readonly SwimCloudCaptureCompleteness[] = [
  'in-progress',
  'every-planned-page-fetched',
  'partial',
  'failed',
];

const TEAM_DISCOVERY_SOURCES = ['topteams', 'meet-root-links-fallback'] as const;
const TEAM_DISCOVERY_COMPLETENESS = [
  'unproven',
  'verified-complete-for-this-capture',
  'user-confirmed',
] as const;

/* -------------------------------------------------------------------------- */
/* Pairing token                                                               */
/* -------------------------------------------------------------------------- */

/** On-disk shape of `data/swimcloud-pairing-token.json`. */
export interface SwimCloudPairingTokenFile {
  /** 48 lowercase hex characters — 24 bytes from `crypto.randomBytes`. */
  readonly token: string;
  /** ISO-8601 instant the token was minted. */
  readonly createdAt: string;
  /** Human-facing reminder of what the file is. Ignored on read. */
  readonly note?: string;
}

export interface SwimCloudPairingToken {
  readonly token: string;
  readonly filePath: string;
  /** True when this call minted a new token rather than reading an existing one. */
  readonly created: boolean;
}

/** 24 random bytes as hex. Long enough that guessing is not a threat model. */
const PAIRING_TOKEN_BYTES = 24;
const PAIRING_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

export function swimCloudPairingTokenFilePath(dataDir: string): string {
  return path.join(dataDir, 'swimcloud-pairing-token.json');
}

/**
 * Read the pairing token from disk, minting and persisting one on first run.
 *
 * Persisted rather than regenerated per process so restarting the app does not
 * silently invalidate the token the coach already pasted into the extension's
 * options page — a token that changes under you is a token people work around.
 *
 * A file that exists but does not hold a well-formed token is replaced, not
 * trusted: a truncated or hand-edited token would otherwise become a weak
 * secret nobody noticed. The replacement is loud (`created: true`), so the
 * startup banner tells the user to re-pair.
 */
export function loadOrCreateSwimCloudPairingToken(dataDir: string): SwimCloudPairingToken {
  const filePath = swimCloudPairingTokenFilePath(dataDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SwimCloudPairingTokenFile>;
    if (typeof parsed?.token === 'string' && PAIRING_TOKEN_PATTERN.test(parsed.token)) {
      return { token: parsed.token, filePath, created: false };
    }
  } catch {
    // Missing, unreadable or not JSON — all mean "no usable token", and all are
    // handled the same way: mint one. Never fall back to a fixed default.
  }

  const token = crypto.randomBytes(PAIRING_TOKEN_BYTES).toString('hex');
  const contents: SwimCloudPairingTokenFile = {
    token,
    createdAt: new Date().toISOString(),
    note: 'Paste this token into the SwimCloud Companion extension options page. Anyone holding it can write into the local capture store. Delete this file to revoke and re-pair.',
  };
  fs.mkdirSync(dataDir, { recursive: true });
  // 0600 where the platform honours it. Windows ignores the mode; the file is
  // still inside the user profile and is gitignored, which is the real control.
  fs.writeFileSync(filePath, `${JSON.stringify(contents, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { token, filePath, created: true };
}

/**
 * Constant-time token comparison.
 *
 * The length check short-circuits, which leaks only the token's *length* — the
 * token length is a public constant of this protocol, so that leaks nothing.
 * The value comparison, which is the part an attacker could otherwise walk one
 * byte at a time, runs in `crypto.timingSafeEqual`.
 */
export function timingSafeTokenEquals(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* captureId validation and path containment                                   */
/* -------------------------------------------------------------------------- */

export function isValidSwimCloudCaptureId(value: unknown): value is string {
  return typeof value === 'string' && SWIMCLOUD_CAPTURE_ID_PATTERN.test(value);
}

/**
 * The capture-manifest path a `captureId` would resolve to, or `undefined` if
 * it would land anywhere but directly inside `<captureRoot>/captures/`.
 *
 * `FileSystemSwimCloudCaptureStore.captureFilePath` builds its path by plain
 * string concatenation (`` `${root}/captures/${captureId}.json` ``) and does no
 * containment check of its own. That is fine for a trusted caller and is not
 * fine for one whose `captureId` came off the network, so the check lives here,
 * at the trust boundary, using the same resolve-and-assert-under-root pattern
 * `plans/2026-08-14/10-security-exposure.md` §2 prescribes (and that
 * `scripts/test_server_binding.mjs` already exercises for the upload path).
 *
 * Page bytes need no equivalent guard: `cache.ts`'s `fileNameFor` percent-
 * encodes every character outside `[A-Za-z0-9._-]` and appends a hash suffix,
 * so no canonical URL can produce a separator or a bare `..` filename.
 */
export function resolveCaptureFilePathWithinRoot(
  captureRoot: string,
  captureId: string,
): string | undefined {
  if (!isValidSwimCloudCaptureId(captureId)) return undefined;
  const capturesDir = path.resolve(captureRoot, 'captures');
  const target = path.resolve(capturesDir, `${captureId}.json`);
  if (path.dirname(target) !== capturesDir) return undefined;
  if (!target.startsWith(capturesDir + path.sep)) return undefined;
  return target;
}

/* -------------------------------------------------------------------------- */
/* Body readers — validate, never repair                                       */
/* -------------------------------------------------------------------------- */

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function fail<T>(message: string): Read<T> {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A capture subject, with the extra `season` charset guard this route needs.
 *
 * Mirrors `clipboardPayload.ts`'s private `readSubject` on purpose rather than
 * importing it: that function is not exported, and `packages/swimcloud`'s
 * public API is fixed for this change. The shapes are two lines each and are
 * pinned by `tests/swimcloudClipboardPayload.test.ts` on that side and
 * `tests/swimcloudCaptureRoutes.test.ts` on this one, so a drift is a test
 * failure rather than a silent divergence.
 */
export function readCaptureSubject(value: unknown): Read<SwimCloudCaptureSubject> {
  if (!isPlainObject(value)) {
    return fail('"subject" must be an object: { kind: "meet", meetId } or { kind: "team", teamId, season? }.');
  }
  if (value.kind === 'meet') {
    if (typeof value.meetId !== 'string' || value.meetId.length === 0) {
      return fail('A meet subject needs a non-empty string "meetId".');
    }
    return { ok: true, value: { kind: 'meet', meetId: value.meetId } };
  }
  if (value.kind === 'team') {
    if (typeof value.teamId !== 'string' || value.teamId.length === 0) {
      return fail('A team subject needs a non-empty string "teamId".');
    }
    if (value.season !== undefined) {
      if (typeof value.season !== 'string' || !SEASON_PATTERN.test(value.season)) {
        return fail('A team subject\'s "season" must look like "2026-2027" (letters, digits and hyphens, 32 chars max).');
      }
      return { ok: true, value: { kind: 'team', teamId: value.teamId, season: value.season } };
    }
    return { ok: true, value: { kind: 'team', teamId: value.teamId } };
  }
  return fail('"subject.kind" must be "meet" or "team".');
}

function readOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): Read<T | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return fail(`"${field}" must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}.`);
}

function readOptionalCount(value: unknown, field: string): Read<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return { ok: true, value };
  }
  return fail(`"${field}" must be a non-negative integer.`);
}

function readOptionalStringArray(value: unknown, field: string): Read<readonly string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return { ok: true, value: value as readonly string[] };
  }
  return fail(`"${field}" must be an array of strings.`);
}

function readOptionalLabel(value: unknown): Read<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'string' && value.length <= 512) return { ok: true, value };
  return fail('"label" must be a string of at most 512 characters.');
}

function readOptionalTeamDiscovery(value: unknown): Read<SwimCloudCaptureTeamDiscovery | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(value)) return fail('"teamDiscovery" must be an object.');

  const source = readOptionalEnum(value.source, TEAM_DISCOVERY_SOURCES, 'teamDiscovery.source');
  if (!source.ok) return fail(source.message);
  if (source.value === undefined) return fail('"teamDiscovery.source" is required when teamDiscovery is present.');

  const completeness = readOptionalEnum(
    value.completeness,
    TEAM_DISCOVERY_COMPLETENESS,
    'teamDiscovery.completeness',
  );
  if (!completeness.ok) return fail(completeness.message);
  if (completeness.value === undefined) {
    return fail('"teamDiscovery.completeness" is required when teamDiscovery is present.');
  }

  const genders = readOptionalStringArray(value.genders, 'teamDiscovery.genders');
  if (!genders.ok) return fail(genders.message);
  const teamIds = readOptionalStringArray(value.teamIds, 'teamDiscovery.teamIds');
  if (!teamIds.ok) return fail(teamIds.message);

  return {
    ok: true,
    value: {
      source: source.value,
      completeness: completeness.value,
      genders: genders.value ?? [],
      teamIds: teamIds.value ?? [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Page-ref derivation                                                         */
/* -------------------------------------------------------------------------- */

interface PageFacets {
  readonly resourceKind: SwimCloudResourceKind;
  readonly meetId?: string;
  readonly teamId?: string;
  readonly gender?: string;
  readonly page?: number;
}

/** A `?page=` value, or absent. Never coerced — `page=abc` yields no page number. */
function readPageNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !PAGE_NUMBER.test(raw)) return undefined;
  return Number(raw);
}

/**
 * The descriptive facets a `SwimCloudCapturePageRef` carries, read off the
 * classifier's resource rather than re-parsed from the URL string.
 *
 * These are labels for a progress panel, not identity: `canonicalUrl` is what
 * identifies a page. A facet the URL does not carry is omitted, never guessed —
 * in particular `gender` is passed through verbatim (`'M'`/`'F'` as SwimCloud
 * writes it) and is never mapped to `'Men'`/`'Women'`, because
 * `urlClassifier.ts` is explicit that the encoding is unverified.
 */
function pageFacetsFor(resource: SwimCloudResource): PageFacets {
  /** `gender` and `page`, spread-ready, from a query that may carry neither. */
  const queryFacets = (query: { readonly gender?: string; readonly page?: string }) => {
    const page = readPageNumber(query.page);
    return {
      ...(query.gender === undefined ? {} : { gender: query.gender }),
      ...(page === undefined ? {} : { page }),
    };
  };

  switch (resource.kind) {
    case 'meet':
      return { resourceKind: 'meet', meetId: resource.meetId };
    case 'meetEvent':
      return { resourceKind: 'meetEvent', meetId: resource.meetId };
    case 'meetSwimmer':
      return { resourceKind: 'meetSwimmer', meetId: resource.meetId };
    case 'meetTopTeams':
      return { resourceKind: 'meetTopTeams', meetId: resource.meetId, ...queryFacets(resource.query) };
    case 'meetTeam':
    case 'meetTeamSwims':
      return {
        resourceKind: resource.kind,
        meetId: resource.meetId,
        teamId: resource.teamId,
        ...queryFacets(resource.query),
      };
    case 'team':
      return { resourceKind: 'team', teamId: resource.teamId };
    case 'teamRoster':
      return { resourceKind: 'teamRoster', teamId: resource.teamId, ...queryFacets(resource.query) };
    case 'teamResults':
      return { resourceKind: 'teamResults', teamId: resource.teamId, ...queryFacets(resource.query) };
    case 'swimmer':
      return { resourceKind: 'swimmer' };
    case 'swimmerTimes':
      // Same facets as `swimmer`: `PageFacets` carries meet and team ids, and a
      // swimmer-times URL has neither. The swimmer id stays in `canonicalUrl`,
      // which is what identifies the page.
      return { resourceKind: 'swimmerTimes' };
    case 'conference':
      return { resourceKind: 'conference' };
  }
}

/** Two subjects name the same crawl target. Season is deliberately not compared — see the pages route. */
function subjectsAgree(a: SwimCloudCaptureSubject, b: SwimCloudCaptureSubject): boolean {
  if (a.kind === 'meet' && b.kind === 'meet') return a.meetId === b.meetId;
  if (a.kind === 'team' && b.kind === 'team') return a.teamId === b.teamId;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Parsing a stored capture                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The resource kinds this route has a parser for, each paired with exactly one
 * parser by {@link parsePageOfKind}.
 *
 * A crawl stores several kinds of page, and most of them are not parse targets.
 * `meetTopTeams` and `meetTeam` were fetched to *discover* which teams competed,
 * not to read swims off, and `parseTeamMeetSwimsHtml` would either fail on them
 * or read a truncated summary card as though it were the team's full list — see
 * that function's own "Which page to give it" table. `swimmer` (the profile
 * root) is likewise excluded: `parseSwimmerTimesHtml` deliberately refuses its
 * narrower "Latest Results" table rather than reading it as a bests list.
 *
 * So a page of any other kind is skipped **silently**: it was never a candidate,
 * and warning about it would train a reader to ignore the warning list. Only a
 * page that *should* have parsed and did not is warned about.
 *
 * `meetEvent` joined the list on 2026-09-10. It was excluded before that for
 * the plainest possible reason — nothing parsed it. It is now the page type
 * that resolves which **round** a swim was contested in, and the only one that
 * publishes real meet points for an individual swim; see
 * `parseMeetEventResultsHtml`.
 *
 * `satisfies` rather than an annotation, so a typo here is a compile error
 * *and* {@link ParseableResourceKind} stays the exact four-member union the
 * dispatch switch is checked for exhaustiveness against.
 */
const PARSEABLE_RESOURCE_KINDS = [
  'meetTeamSwims',
  'meetEvent',
  'teamRoster',
  'swimmerTimes',
] as const satisfies readonly SwimCloudResourceKind[];

/** One of the {@link PARSEABLE_RESOURCE_KINDS}. */
type ParseableResourceKind = (typeof PARSEABLE_RESOURCE_KINDS)[number];

function isParseableResourceKind(kind: SwimCloudResourceKind): kind is ParseableResourceKind {
  return (PARSEABLE_RESOURCE_KINDS as readonly SwimCloudResourceKind[]).includes(kind);
}

/** What `POST /api/swimcloud/captures/:id/parse` answers with. */
export interface SwimCloudCaptureParseResponse {
  readonly captureId: string;
  /** The stored record's own subject, passed through unchanged. */
  readonly subject: SwimCloudCaptureSubject;
  /** One entry per `meetTeamSwims` page that parsed, in stored page order. */
  readonly parses: readonly SwimCloudTeamMeetSwimsParse[];
  /**
   * One entry per `teamRoster` page that parsed, in stored page order.
   *
   * Kept in its own list rather than merged into {@link parses}: a roster parse
   * and a swims parse are different shapes answering different questions, and a
   * consumer must know which one it is holding. A polymorphic list would make
   * that a runtime check the type system could not enforce.
   *
   * A team's roster is one page per gender with no combined view, so a fully
   * crawled team yields two entries here, not one.
   */
  readonly rosters: readonly SwimCloudRosterParse[];
  /** One entry per `swimmerTimes` page that parsed, in stored page order. See {@link rosters} for why these are separate lists. */
  readonly swimmerTimes: readonly SwimCloudSwimmerTimesParse[];
  /**
   * One entry per `meetEvent` page (`/results/{meetId}/event/{n}/`) that
   * parsed, in stored page order. Its own list, same reasoning as
   * {@link rosters}.
   *
   * **Absent-versus-empty matters more here than anywhere else in this
   * response.** These parses are what
   * `swimCloudTeamMeetSwimsToSwimmerResults` uses to resolve a swim's round —
   * and a swim with no matching entry here is deliberately *excluded* from the
   * import rather than scored on a guess. So an empty array is a real
   * statement: "this capture holds no per-event page", which a caller reads as
   * "prelims and finals cannot be told apart in it", never as "there were no
   * finals". A capture stored before this route learned to read event pages
   * answers `[]` with no warning, because it genuinely holds no such page.
   */
  readonly eventResults: readonly SwimCloudMeetEventResultsParse[];
  /**
   * One human-readable line per problem across all four parseable kinds, never
   * thrown.
   *
   * Empty result lists with an empty `warnings` is a real and honest answer: it
   * means the capture holds no page of that kind yet. That is a fact about the
   * crawl's progress, not a client error, so it is a 200 — see the route. In
   * particular a capture stored before this route learned to read rosters and
   * swimmer times answers `rosters: []` and `swimmerTimes: []` with no warning,
   * because it genuinely holds no such page.
   */
  readonly warnings: readonly string[];
}

/** One parser warning as a line a coach can read, with the page it came from. */
function warningLine(canonicalUrl: string, warning: SwimCloudParseWarning): string {
  const where = warning.rowIndex === undefined ? '' : ` (row ${warning.rowIndex})`;
  return `${canonicalUrl}${where}: ${warning.code} — ${warning.message}`;
}

/**
 * One page's parse, tagged with the kind that produced it.
 *
 * The tag is what lets {@link parseSwimCloudCapture} put the data in the right
 * response list without a cast: narrowing on `kind` narrows `result` with it.
 */
type ParsedCapturePage =
  | { readonly kind: 'meetTeamSwims'; readonly result: SwimCloudParseResult<SwimCloudTeamMeetSwimsParse> }
  | { readonly kind: 'meetEvent'; readonly result: SwimCloudParseResult<SwimCloudMeetEventResultsParse> }
  | { readonly kind: 'teamRoster'; readonly result: SwimCloudParseResult<SwimCloudRosterParse> }
  | { readonly kind: 'swimmerTimes'; readonly result: SwimCloudParseResult<SwimCloudSwimmerTimesParse> };

/**
 * Run the one parser that belongs to `kind`.
 *
 * **No parser options are passed, for any kind.** The context's `sourceUrl` is
 * the classifier's own canonical URL rather than anything a caller typed, and
 * every parser reads the ids it needs off it. An option would be this route
 * asserting a fact it does not hold — telling `parseTeamRosterHtml` a gender,
 * say, which that parser documents as outranking the page's own printed word.
 * The URL's `?gender=` value is deliberately not forwarded for the same reason
 * `SwimCloudTeamRosterQuery` refuses to interpret it.
 */
function parsePageOfKind(
  kind: ParseableResourceKind,
  html: string,
  context: SwimCloudParseContext,
): ParsedCapturePage {
  switch (kind) {
    case 'meetTeamSwims':
      return { kind, result: parseTeamMeetSwimsHtml(html, context) };
    case 'meetEvent':
      return { kind, result: parseMeetEventResultsHtml(html, context) };
    case 'teamRoster':
      return { kind, result: parseTeamRosterHtml(html, context) };
    case 'swimmerTimes':
      return { kind, result: parseSwimmerTimesHtml(html, context) };
  }
}

/**
 * Append one page's failure line and its parser warnings, and hand back the
 * parsed data only when there is some.
 *
 * Returning `T | undefined` rather than a boolean is what keeps "absent ≠ empty"
 * a type rule here: a caller cannot push a half-parse into a response list,
 * because a failed parse hands it nothing to push.
 */
function collectParse<T>(
  canonicalUrl: string,
  result: SwimCloudParseResult<T>,
  warnings: string[],
): T | undefined {
  if (!result.ok) {
    warnings.push(`Could not parse ${canonicalUrl}: ${result.failure.message}`);
  }
  for (const warning of result.warnings) {
    warnings.push(warningLine(canonicalUrl, warning));
  }
  return result.ok ? result.data : undefined;
}

/**
 * Parse every parseable page of one stored capture.
 *
 * ## One bad page does not lose the other seven
 *
 * `plans/2026-09-08/03-extension-crawler.md`'s error table says unexpected
 * markup "does not stop the crawl... marks that one page's plan branch
 * `'partial'` and continues". This is that rule applied at parse time instead of
 * fetch time: a page that fails, throws, or has no stored bytes contributes a
 * warning and the loop moves on. Discarding a whole eight-page capture because
 * page 6 of 8 changed shape would be the worse failure by a wide margin.
 *
 * Nothing here fabricates. A page that did not parse produces no entry in any
 * result list — never a half-filled or defaulted one — which is `CLAUDE.md`'s
 * "absent ≠ empty" rule: the caller sees a shorter list and a warning saying
 * which page is missing, not a plausible-looking parse of markup that was not
 * there.
 *
 * ## Four kinds, four lists, one warning list
 *
 * `meetTeamSwims`, `meetEvent`, `teamRoster` and `swimmerTimes` each go through
 * their own parser into their own response field. The rules above apply
 * identically to all four — a missing-bytes page warns and is skipped whatever
 * kind it is — and the warnings from all four land in one list, each line
 * already naming the page it came from.
 *
 * Exported so a caller (or a test) can parse a record it already holds without
 * going through HTTP.
 */
export async function parseSwimCloudCapture(
  store: FileSystemSwimCloudCaptureStore,
  capture: SwimCloudCaptureRecord,
): Promise<SwimCloudCaptureParseResponse> {
  const parses: SwimCloudTeamMeetSwimsParse[] = [];
  const rosters: SwimCloudRosterParse[] = [];
  const swimmerTimes: SwimCloudSwimmerTimesParse[] = [];
  const eventResults: SwimCloudMeetEventResultsParse[] = [];
  const warnings: string[] = [];

  for (const page of capture.pages) {
    if (!isParseableResourceKind(page.resourceKind)) continue;

    // Bytes are read only for an `'ok'` attempt. `putPage` is called with no
    // entry for every other outcome, so there is nothing to read — and on the
    // one path where stale bytes could survive (an `'ok'` page later re-fetched
    // into an `'http-error'`), parsing them would present a previous capture's
    // content as this attempt's. The recorded outcome is the fact; the stale
    // bytes are not.
    const entry = page.outcome === 'ok' ? await store.readPage(page.canonicalUrl) : undefined;
    if (entry === undefined) {
      warnings.push(`No stored content for ${page.canonicalUrl} (outcome: ${page.outcome})`);
      continue;
    }

    // The canonical URL is what each parser reads its ids off, and it is the
    // classifier's own output rather than anything a caller typed. No override
    // option is passed for that reason — see {@link parsePageOfKind}.
    const context: SwimCloudParseContext = {
      sourceUrl: page.canonicalUrl,
      retrievedAt: page.retrievedAt,
      track: capture.track,
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    };

    let parsed: ParsedCapturePage;
    try {
      parsed = parsePageOfKind(page.resourceKind, entry.html, context);
    } catch (err) {
      // The parsers are written not to throw, so reaching here is a real defect.
      // It is still surfaced rather than swallowed, and it still costs one page
      // rather than the request.
      warnings.push(`Could not parse ${page.canonicalUrl}: ${String(err)}`);
      continue;
    }

    switch (parsed.kind) {
      case 'meetTeamSwims': {
        const data = collectParse(page.canonicalUrl, parsed.result, warnings);
        if (data !== undefined) parses.push(data);
        break;
      }
      case 'meetEvent': {
        const data = collectParse(page.canonicalUrl, parsed.result, warnings);
        if (data !== undefined) eventResults.push(data);
        break;
      }
      case 'teamRoster': {
        const data = collectParse(page.canonicalUrl, parsed.result, warnings);
        if (data !== undefined) rosters.push(data);
        break;
      }
      case 'swimmerTimes': {
        const data = collectParse(page.canonicalUrl, parsed.result, warnings);
        if (data !== undefined) swimmerTimes.push(data);
        break;
      }
    }
  }

  return {
    captureId: capture.captureId,
    subject: capture.subject,
    parses,
    rosters,
    swimmerTimes,
    eventResults,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Middleware                                                                  */
/* -------------------------------------------------------------------------- */

function requireCaptureToken(expected: string): RequestHandler {
  return (req, res, next) => {
    const received = req.get(SWIMCLOUD_CAPTURE_TOKEN_HEADER);
    if (typeof received !== 'string' || received.length === 0) {
      res.status(401).json({
        error: `Missing ${SWIMCLOUD_CAPTURE_TOKEN_HEADER} header`,
        details:
          'The SwimCloud capture routes require the pairing token printed in this server\'s startup banner. Paste it into the extension\'s options page.',
      });
      return;
    }
    if (!timingSafeTokenEquals(expected, received)) {
      res.status(403).json({
        error: 'Invalid SwimCloud capture pairing token',
        details:
          'The token does not match this server\'s. Re-copy it from the startup banner, or delete data/swimcloud-pairing-token.json to mint a new one.',
      });
      return;
    }
    next();
  };
}

/**
 * Reject an over-large body from its `Content-Length` before any parser reads it.
 *
 * This is not redundant with `express.json({ limit })`. `server.ts` applies a
 * 50 MB `express.json` at the app level; body-parser is a no-op once `req.body`
 * is already set, so a route-level parser mounted *after* the global one would
 * silently inherit 50 MB. The router is therefore mounted before the global
 * parser AND carries this header check, so the 2 MB cap survives a future
 * reordering of `startServer()` instead of quietly evaporating.
 *
 * A chunked request declares no length; `express.json`'s own stream-length
 * accounting is the backstop for that case.
 */
function enforceCaptureBodyLimit(limitBytes: number): RequestHandler {
  return (req, res, next) => {
    const declared = req.get('content-length');
    if (declared !== undefined) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > limitBytes) {
        res.status(413).json({
          error: 'SwimCloud capture payload too large',
          details: `This route accepts at most ${limitBytes} bytes; the request declared ${declared}.`,
        });
        return;
      }
    }
    next();
  };
}

/**
 * Narrow CORS, only when an extension origin has been configured.
 *
 * ## Why this is off by default, and why that is not an oversight
 *
 * `plans/2026-09-08/03-extension-crawler.md`, "Where the crawl loop actually
 * runs", puts the localhost POST in the **background service worker**, not the
 * content script — the content script fetches SwimCloud same-origin and relays
 * each page to the worker over `chrome.runtime.sendMessage`. A Manifest V3
 * service worker's `fetch()` to a host listed in `host_permissions`
 * (`http://127.0.0.1/*`, which the plan's manifest additions grant) is not
 * subject to page CORS: the extension origin holds the permission, so Chrome
 * issues the request without a preflight and without checking an
 * `Access-Control-Allow-Origin` on the response. Emitting one would be
 * decoration, and decoration on a security header is worse than nothing —
 * it reads like a control that is being enforced.
 *
 * `OMNI_SWIMCLOUD_EXTENSION_ORIGIN` exists for the one case that would change
 * the answer: an extension build that posts from a content script or an
 * options page instead. Set it to the exact `chrome-extension://<id>` origin
 * and this middleware allows precisely that origin, the one header, and the
 * three methods these routes use. It is never `*`, and no placeholder id is
 * invented while Phase 3 is unbuilt.
 */
function narrowCors(origin: string): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Vary', 'Origin');
    if (req.get('origin') === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${SWIMCLOUD_CAPTURE_TOKEN_HEADER}`);
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      // A preflight cannot carry the pairing token by definition, so it is
      // answered before the token gate — and it reveals nothing but the
      // policy above.
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Turns body-parser's own failures into this file's `{ error, details }` shape. */
const captureErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const type = (err as { type?: unknown } | null)?.type;
  const status = (err as { status?: unknown } | null)?.status;
  if (type === 'entity.too.large') {
    res.status(413).json({
      error: 'SwimCloud capture payload too large',
      details: `This route accepts at most ${SWIMCLOUD_CAPTURE_BODY_LIMIT_BYTES} bytes.`,
    });
    return;
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({
      error: 'Invalid SwimCloud capture request',
      details: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  res.status(500).json({ error: 'SwimCloud capture route failed', details: String(err) });
};

/* -------------------------------------------------------------------------- */
/* Router                                                                      */
/* -------------------------------------------------------------------------- */

export interface SwimCloudCaptureRouterOptions {
  readonly store: FileSystemSwimCloudCaptureStore;
  /** The directory the store was constructed with. Used for the containment assertion. */
  readonly captureRoot: string;
  readonly pairingToken: string;
  /** `chrome-extension://<id>`, from `OMNI_SWIMCLOUD_EXTENSION_ORIGIN`. Omitted in the normal case. */
  readonly extensionOrigin?: string;
  /** Override only in tests. Defaults to {@link SWIMCLOUD_CAPTURE_BODY_LIMIT_BYTES}. */
  readonly bodyLimitBytes?: number;
}

/**
 * Build the capture router. Exported so a test can mount it on a bare app;
 * production goes through {@link registerSwimCloudCaptureRoutes}, which adds
 * the loopback gate.
 *
 * Middleware order is load-bearing:
 *   1. CORS (if configured) — answers preflights, which carry no token.
 *   2. Pairing token — nothing below runs for an unpaired caller, so an
 *      unauthenticated request never has its body read at all.
 *   3. Body-size cap, then the JSON parser.
 *   4. Handlers.
 *   5. Error handler, translating parser failures.
 */
export function createSwimCloudCaptureRouter(options: SwimCloudCaptureRouterOptions): Router {
  const { store, captureRoot, pairingToken } = options;
  const bodyLimitBytes = options.bodyLimitBytes ?? SWIMCLOUD_CAPTURE_BODY_LIMIT_BYTES;
  const router = express.Router();

  if (options.extensionOrigin !== undefined && options.extensionOrigin.length > 0) {
    router.use(narrowCors(options.extensionOrigin));
  }
  router.use(requireCaptureToken(pairingToken));
  router.use(enforceCaptureBodyLimit(bodyLimitBytes));
  router.use(express.json({ limit: bodyLimitBytes }));

  /**
   * Validate a path or derived `captureId` and answer the request if it fails.
   * Returns `undefined` once a response has been sent, so every caller reads as
   * `const id = guardCaptureId(...); if (id === undefined) return;`.
   */
  function guardCaptureId(candidate: unknown, res: Response): string | undefined {
    if (!isValidSwimCloudCaptureId(candidate)) {
      res.status(400).json({
        error: 'Invalid capture id',
        details: `A capture id must match ${SWIMCLOUD_CAPTURE_ID_PATTERN.source} — got ${JSON.stringify(candidate)}.`,
      });
      return undefined;
    }
    if (resolveCaptureFilePathWithinRoot(captureRoot, candidate) === undefined) {
      res.status(400).json({
        error: 'Invalid capture id',
        details: 'That capture id does not resolve to a file inside the capture store.',
      });
      return undefined;
    }
    return candidate;
  }

  /* --- POST /api/swimcloud/captures — open or update a capture record ----- */
  router.post('/', async (req, res) => {
    try {
      const body: unknown = req.body;
      if (!isPlainObject(body)) {
        return res.status(400).json({ error: 'Capture body must be a JSON object' });
      }

      const subject = readCaptureSubject(body.subject);
      if (!subject.ok) {
        return res.status(400).json({ error: 'Invalid capture subject', details: subject.message });
      }

      // A client-supplied captureId is honoured (it lets a caller re-open a
      // record it already holds) but is validated exactly as a path parameter
      // is. The derived id is validated too: `season` reaches
      // `captureIdForSubject` from the request body, so "we computed it
      // ourselves" is not the same as "it is safe".
      const captureId = guardCaptureId(
        body.captureId === undefined ? captureIdForSubject(subject.value) : body.captureId,
        res,
      );
      if (captureId === undefined) return undefined;

      if (Array.isArray(body.pages) && body.pages.length > 0) {
        return res.status(400).json({
          error: 'Capture pages are not accepted here',
          details: `Post each fetched page to ${SWIMCLOUD_CAPTURE_ROUTE_BASE}/${captureId}/pages. This route owns the record, not its pages.`,
        });
      }

      const track = readOptionalEnum(body.track, CAPTURE_TRACKS, 'track');
      if (!track.ok) return res.status(400).json({ error: 'Invalid capture track', details: track.message });

      const completeness = readOptionalEnum(body.completeness, CAPTURE_COMPLETENESS, 'completeness');
      if (!completeness.ok) {
        return res.status(400).json({ error: 'Invalid capture completeness', details: completeness.message });
      }

      const plannedPageCount = readOptionalCount(body.plannedPageCount, 'plannedPageCount');
      if (!plannedPageCount.ok) {
        return res.status(400).json({ error: 'Invalid plannedPageCount', details: plannedPageCount.message });
      }

      const notes = readOptionalStringArray(body.notes, 'notes');
      if (!notes.ok) return res.status(400).json({ error: 'Invalid notes', details: notes.message });

      const label = readOptionalLabel(body.label);
      if (!label.ok) return res.status(400).json({ error: 'Invalid label', details: label.message });

      const teamDiscovery = readOptionalTeamDiscovery(body.teamDiscovery);
      if (!teamDiscovery.ok) {
        return res.status(400).json({ error: 'Invalid teamDiscovery', details: teamDiscovery.message });
      }

      // Every field is a partial update: an omitted field keeps whatever the
      // stored record holds, so a progress ping that carries only
      // `{ subject, completeness }` cannot wipe a plannedPageCount or a label
      // that an earlier request established.
      const existing = await store.getCapture(captureId);
      const now = new Date().toISOString();
      const resolvedLabel = label.value ?? existing?.label;
      const resolvedDiscovery = teamDiscovery.value ?? existing?.teamDiscovery;
      const record: SwimCloudCaptureRecord = {
        captureId,
        subject: subject.value,
        ...(resolvedLabel === undefined ? {} : { label: resolvedLabel }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        // This route is the extension's transport, so an unstated track is
        // `'browser-extension'` — the truth about how the bytes arrived, not a
        // guess. A stated track outside the three known values is rejected
        // above rather than silently replaced.
        track: track.value ?? existing?.track ?? 'browser-extension',
        completeness: completeness.value ?? existing?.completeness ?? 'in-progress',
        ...(resolvedDiscovery === undefined ? {} : { teamDiscovery: resolvedDiscovery }),
        // `0` here means "no plan committed yet", which is what a capture looks
        // like before the crawler has read `pagination.totalPages`. It is not a
        // claim that zero pages exist — `completeness` is what carries that,
        // and a fresh record is `'in-progress'`.
        plannedPageCount: plannedPageCount.value ?? existing?.plannedPageCount ?? 0,
        // Pages arrive through the pages route only. `upsertCapture` merges by
        // canonicalUrl, so an empty list preserves everything already stored.
        pages: [],
        notes: notes.value ?? existing?.notes ?? [],
      };

      const saved = await store.upsertCapture(record);
      return res.status(existing === undefined ? 201 : 200).json(saved);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to open capture', details: String(err) });
    }
  });

  /* --- GET /api/swimcloud/captures — the picker's list -------------------- */
  router.get('/', async (_req, res) => {
    try {
      const captures = [...(await store.listCaptures())].sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
        return a.captureId < b.captureId ? -1 : 1;
      });
      return res.json(captures);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to list captures', details: String(err) });
    }
  });

  /* --- GET /api/swimcloud/captures/:id ------------------------------------ */
  router.get('/:id', async (req, res) => {
    const captureId = guardCaptureId(req.params.id, res);
    if (captureId === undefined) return undefined;
    try {
      const record = await store.getCapture(captureId);
      if (record === undefined) {
        return res.status(404).json({ error: `Capture not found: ${captureId}` });
      }
      return res.json(record);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to read capture', details: String(err) });
    }
  });

  /* --- POST /api/swimcloud/captures/:id/pages — one crawled page ---------- */
  router.post('/:id/pages', async (req, res) => {
    const captureId = guardCaptureId(req.params.id, res);
    if (captureId === undefined) return undefined;

    // `readSwimCloudClipboardPayload` owns payload-shape validation for both
    // versions and never throws, so this route re-serializes the parsed body
    // rather than re-implementing the checks. The cost is one round trip
    // through JSON for ~200 KB; the benefit is one validator, not two that can
    // disagree about what version 2 means.
    let serialized: string;
    try {
      serialized = JSON.stringify(req.body ?? null);
    } catch (err) {
      return res.status(400).json({ error: 'Unreadable capture page body', details: String(err) });
    }
    const read = readSwimCloudClipboardPayload(serialized ?? '');
    if (!read.ok) {
      return res.status(400).json({
        error: 'Invalid capture page payload',
        details: read.message,
        reason: read.reason,
      });
    }
    if (read.payload.omniswimSwimCloudCapture !== 2) {
      return res.status(400).json({
        error: 'This route needs a version 2 capture payload',
        details:
          'A version 1 payload is the single-page clipboard shape and carries no subject. Post `omniswimSwimCloudCapture: 2` with a subject, or use the clipboard import.',
      });
    }
    const payload = read.payload;

    // The canonical URL is the cache key and the page identity, so it is taken
    // from the classifier, never from the raw sourceUrl. A forbidden or
    // unmodelled path is refused here rather than stored: `SwimCloudCapturePageRef`
    // requires a `resourceKind`, and there is no honest value for a path this
    // repo does not model.
    const classification = classifySwimCloudUrl(payload.sourceUrl);
    if (classification.outcome !== 'fetchable') {
      return res.status(400).json({
        error: 'Capture page sourceUrl is not a fetchable SwimCloud resource',
        details: classification.detail,
        outcome: classification.outcome,
      });
    }

    try {
      const capture = await store.getCapture(captureId);
      if (capture === undefined) {
        return res.status(404).json({
          error: `Capture not found: ${captureId}`,
          details: `Open it with POST ${SWIMCLOUD_CAPTURE_ROUTE_BASE} before posting pages to it.`,
        });
      }

      // A page whose subject disagrees with the capture it is being filed under
      // would silently attribute one meet's results to another. Season is not
      // compared: a per-page payload may legitimately omit it while the record
      // carries one, and the team id is what identifies the crawl target.
      if (!subjectsAgree(capture.subject, payload.subject)) {
        return res.status(409).json({
          error: 'Capture page subject does not match the capture',
          details: `Capture ${captureId} is ${JSON.stringify(capture.subject)}; the page claims ${JSON.stringify(payload.subject)}.`,
        });
      }

      const canonicalUrl = classification.canonicalUrl;
      const facets = pageFacetsFor(classification.resource);
      const httpStatus = payload.httpStatus;
      // An absent status means the extension recorded no non-200 outcome, which
      // is the successful case in the v2 payload contract.
      const succeeded = httpStatus === undefined || (httpStatus >= 200 && httpStatus < 300);

      // Bytes are stored only for a successful fetch. `SwimCloudCapturePageRef`
      // states that `sha256` is absent for a non-'ok' outcome, and the body of
      // a 404 is an error page, not the resource — the recorded facts (status,
      // outcome, detail) are what a 404 actually contributes.
      const entry: SwimCloudCacheEntry | undefined = succeeded
        ? {
            canonicalUrl,
            html: payload.html,
            // `'provisional'`, always. `'final'` means "immutable, never
            // re-fetch" (see cache.ts), and nothing in this payload proves the
            // meet is over. A later, deliberate step may promote it; a
            // transport route may not.
            status: 'provisional',
            retrievedAt: payload.retrievedAt,
            track: payload.track,
            sha256: crypto.createHash('sha256').update(payload.html, 'utf8').digest('hex'),
            ...(httpStatus === undefined ? {} : { httpStatus }),
          }
        : undefined;

      const pageRef: SwimCloudCapturePageRef = {
        canonicalUrl,
        resourceKind: facets.resourceKind,
        ...(facets.meetId === undefined ? {} : { meetId: facets.meetId }),
        ...(facets.teamId === undefined ? {} : { teamId: facets.teamId }),
        ...(facets.gender === undefined ? {} : { gender: facets.gender }),
        ...(facets.page === undefined ? {} : { page: facets.page }),
        retrievedAt: payload.retrievedAt,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(entry === undefined
          ? {}
          : { sha256: entry.sha256, bytes: Buffer.byteLength(payload.html, 'utf8') }),
        cacheStatus: 'provisional',
        outcome: succeeded ? 'ok' : 'http-error',
        ...(succeeded ? {} : { detail: `SwimCloud returned HTTP ${String(httpStatus)} for this page.` }),
      };

      await store.putPage(captureId, entry, pageRef);
      const updated = await store.getCapture(captureId);
      return res.json({ captureId, page: pageRef, capture: updated });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to store capture page', details: String(err) });
    }
  });

  /* --- POST /api/swimcloud/captures/:id/parse — read the stored pages ----- */
  router.post('/:id/parse', async (req, res) => {
    // Same `guardCaptureId` as every other id-bearing route, reached through the
    // same token gate, the same loopback registration and the same body cap —
    // this handler is registered inside the one router so it cannot drift out of
    // that middleware stack.
    const captureId = guardCaptureId(req.params.id, res);
    if (captureId === undefined) return undefined;

    // A body is accepted and ignored. There is no filter parameter yet, and
    // inventing one before the picker asks for it would be a guess at a contract.
    try {
      const capture = await store.getCapture(captureId);
      if (capture === undefined) {
        return res.status(404).json({ error: `Capture not found: ${captureId}` });
      }
      return res.json(await parseSwimCloudCapture(store, capture));
    } catch (err) {
      return res.status(500).json({ error: 'Failed to parse capture', details: String(err) });
    }
  });

  /* --- DELETE /api/swimcloud/captures/:id --------------------------------- */
  router.delete('/:id', async (req, res) => {
    const captureId = guardCaptureId(req.params.id, res);
    if (captureId === undefined) return undefined;
    try {
      const existing = await store.getCapture(captureId);
      if (existing === undefined) {
        return res.status(404).json({ error: `Capture not found: ${captureId}` });
      }
      await store.deleteCapture(captureId, { withPages: true });
      return res.json({ success: true, captureId, pagesDeleted: existing.pages.length });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete capture', details: String(err) });
    }
  });

  router.use(captureErrorHandler);
  return router;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export interface SwimCloudCaptureRoutesOptions extends SwimCloudCaptureRouterOptions {
  /** The address the server will bind. Registration happens only for a loopback address. */
  readonly host: string;
}

export type SwimCloudCaptureRoutesRegistration =
  | {
      readonly registered: true;
      readonly base: string;
      /** Present only when `OMNI_SWIMCLOUD_EXTENSION_ORIGIN` narrowed CORS to an origin. */
      readonly corsOrigin?: string;
    }
  | {
      readonly registered: false;
      readonly reason: 'non-loopback-host';
      readonly detail: string;
    };

/**
 * Mount the capture routes, but only on a loopback bind.
 *
 * Requirement 2 of `03-extension-crawler.md`'s security list, and the reason it
 * is a *registration* gate rather than a per-request check: a route that exists
 * and answers 403 still advertises that this machine holds a capture store. On
 * `OMNI_HOST=0.0.0.0` the path simply does not exist, and the startup banner
 * says why.
 *
 * Call this BEFORE `app.use(express.json({ limit: '50mb' }))` — see
 * {@link enforceCaptureBodyLimit} for what goes wrong otherwise.
 */
export function registerSwimCloudCaptureRoutes(
  app: Express,
  options: SwimCloudCaptureRoutesOptions,
): SwimCloudCaptureRoutesRegistration {
  if (!isLoopbackHost(options.host)) {
    return {
      registered: false,
      reason: 'non-loopback-host',
      detail: `Bound to ${options.host || '0.0.0.0'}, which is reachable from the network. The SwimCloud capture routes accept writes into the local capture store, so they are registered on a loopback bind only.`,
    };
  }
  app.use(SWIMCLOUD_CAPTURE_ROUTE_BASE, createSwimCloudCaptureRouter(options));
  return {
    registered: true,
    base: SWIMCLOUD_CAPTURE_ROUTE_BASE,
    ...(options.extensionOrigin === undefined || options.extensionOrigin.length === 0
      ? {}
      : { corsOrigin: options.extensionOrigin }),
  };
}

/**
 * The startup-banner lines for whatever {@link registerSwimCloudCaptureRoutes}
 * decided. Kept here so the token is printed by the same module that mints it.
 */
export function swimCloudCaptureBannerLines(
  registration: SwimCloudCaptureRoutesRegistration,
  token: SwimCloudPairingToken,
): readonly string[] {
  if (!registration.registered) {
    return [`SwimCloud capture routes: NOT REGISTERED — ${registration.detail}`];
  }
  return [
    `SwimCloud capture routes: ${registration.base} (loopback only)`,
    `  Pairing token: ${token.token}`,
    `  Paste it into the SwimCloud Companion extension options page. Stored in ${token.filePath}.`,
    ...(token.created ? ['  A new token was minted, so any previously paired extension must be re-paired.'] : []),
    ...(registration.corsOrigin === undefined
      ? []
      : [`  CORS narrowed to ${registration.corsOrigin} (OMNI_SWIMCLOUD_EXTENSION_ORIGIN).`]),
  ];
}
