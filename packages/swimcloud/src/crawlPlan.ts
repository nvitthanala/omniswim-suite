/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The meet-subject crawl planner — pure `state -> URL[]`, no network, no
 * clock, no DOM. Per `plans/2026-09-08/03-extension-crawler.md`: this is
 * what the extension's content script executes; it never decides the crawl
 * itself. Keeping planning here, not in the extension, is what makes "does
 * the crawl ever emit a denylisted or malformed URL" a plain unit test
 * against `classifySwimCloudUrl` rather than a live-traffic question.
 *
 * Every URL this module emits is built from a confirmed-real pattern in
 * `./urlClassifier.ts` — `meetTopTeams`, `meet`, `meetTeamSwims`, `teamRoster`,
 * `swimmerTimes`, `meetEvent` — never a guessed one. `teamRoster` joined that
 * list on 2026-09-09, when two real `/team/58/roster/?gender=` captures
 * resolved OQ-3; `swimmerTimes` joined it the same day, when a real
 * `/swimmer/1472365/times/` capture resolved OQ-4; `meetEvent` joined it on
 * 2026-09-10, when a real `/results/356467/event/26/` capture (fixture F9)
 * proved the per-event results page is what names a swim's round.
 *
 * The rest of the swimmer subject stays unplanned. The real capture's nav lists
 * `/meets/`, `/standards/` and `/rankings/` next to `/times/`, and none of the
 * three has been captured — a URL read off a nav bar is a URL nobody has
 * fetched, and this module does not plan against one.
 *
 * ## No `season_id` is ever emitted
 *
 * The roster and team-results pages filter by `season_id`, a numeric id whose
 * id-to-label table the page itself publishes (`29` → `2025-2026`, `30` →
 * `2026-2027`, downward from there). Nothing proves that numbering is stable
 * over time or shared across every team, so no URL here carries one and no
 * formula for deriving one exists anywhere in this package. A `season_id`-less
 * roster URL gets the server's own current season — which is what both real
 * captures show, each arriving with the current season pre-`selected`.
 */

import type { SwimCloudMeetId, SwimCloudSwimmerId, SwimCloudTeamId } from './entities';
import { SWIMCLOUD_CANONICAL_HOST, type SwimCloudResourceKind } from './urlClassifier';

export type SwimCloudCrawlGender = 'M' | 'F';

/** One URL the crawl should fetch next. Deliberately not a "task" with
 * retry/backoff state — that's the executor's job (the content script's
 * loop); this module only says what to fetch, in what order. */
export interface SwimCloudCrawlStep {
  readonly canonicalUrl: string;
  readonly resourceKind: SwimCloudResourceKind;
  /**
   * The meet whose crawl planned this step.
   *
   * Not necessarily a part of {@link canonicalUrl}: a `teamRoster` step's URL
   * is team-scoped, not meet-scoped, and this field records which meet crawl
   * asked for it so the capture stays attributable to one subject.
   */
  readonly meetId: SwimCloudMeetId;
  readonly teamId?: SwimCloudTeamId;
  /**
   * The swimmer a `swimmerTimes` step is for.
   *
   * Present only on swimmer-scoped steps. Like {@link teamId} on a `teamRoster`
   * step, it records the subject the URL is about, which is not the meet the
   * crawl is for.
   */
  readonly swimmerId?: SwimCloudSwimmerId;
  /**
   * The `/event/{n}/` reference a `meetEvent` step is for.
   *
   * Present only on event-scoped steps. Unlike {@link teamId} and
   * {@link swimmerId}, this one *is* part of {@link canonicalUrl}; it is
   * recorded anyway so a caller can group or resume by event without
   * re-parsing the URL string.
   */
  readonly eventRef?: string;
  readonly gender?: SwimCloudCrawlGender;
  readonly page?: number;
}

const GENDERS: readonly SwimCloudCrawlGender[] = ['M', 'F'];

function meetUrl(meetId: SwimCloudMeetId, gender: SwimCloudCrawlGender): string {
  return `https://${SWIMCLOUD_CANONICAL_HOST}/results/${meetId}/?gender=${gender}`;
}

function topTeamsUrl(meetId: SwimCloudMeetId, gender: SwimCloudCrawlGender): string {
  return `https://${SWIMCLOUD_CANONICAL_HOST}/results/${meetId}/topteams/?gender=${gender}`;
}

function teamRosterUrl(teamId: SwimCloudTeamId, gender: SwimCloudCrawlGender): string {
  return `https://${SWIMCLOUD_CANONICAL_HOST}/team/${teamId}/roster/?gender=${gender}`;
}

function swimmerTimesUrl(swimmerId: SwimCloudSwimmerId): string {
  return `https://${SWIMCLOUD_CANONICAL_HOST}/swimmer/${swimmerId}/times/`;
}

function eventResultsUrl(meetId: SwimCloudMeetId, eventRef: string): string {
  return `https://${SWIMCLOUD_CANONICAL_HOST}/results/${meetId}/event/${eventRef}/`;
}

function teamSwimsUrl(
  meetId: SwimCloudMeetId,
  teamId: SwimCloudTeamId,
  gender: SwimCloudCrawlGender,
  page: number,
): string {
  const base = `https://${SWIMCLOUD_CANONICAL_HOST}/results/${meetId}/team/${teamId}/swims/?gender=${gender}`;
  return page <= 1 ? base : `${base}&page=${page}`;
}

/**
 * Step 1 of a meet-subject crawl: the two `topteams` URLs, the primary
 * team-discovery mechanism as of the 2026-09-08 OQ-1b resolution (see
 * `plans/2026-09-08/01-decisions.md`). Both genders, always — a meet's team
 * field can differ by gender (a program with only a women's team, say).
 */
export function planMeetTeamDiscovery(meetId: SwimCloudMeetId): readonly SwimCloudCrawlStep[] {
  return GENDERS.map((gender) => ({
    canonicalUrl: topTeamsUrl(meetId, gender),
    resourceKind: 'meetTopTeams' as const,
    meetId,
    gender,
  }));
}

/**
 * Fallback team-discovery, used only when {@link planMeetTeamDiscovery}'s
 * pages come back 404/malformed. Fetches the meet root instead — its Teams
 * card is known to truncate (OQ-1), so the caller must union the team links
 * from both genders and present them for user confirmation, per
 * `03-extension-crawler.md`'s "Fallback, used only if step 1 fails" rule.
 * This function only says what to fetch; the union/confirmation step is the
 * extension's, not the planner's.
 */
export function planMeetTeamDiscoveryFallback(meetId: SwimCloudMeetId): readonly SwimCloudCrawlStep[] {
  return GENDERS.map((gender) => ({
    canonicalUrl: meetUrl(meetId, gender),
    resourceKind: 'meet' as const,
    meetId,
    gender,
  }));
}

export interface SwimCloudMeetSwimsCrawlInput {
  readonly meetId: SwimCloudMeetId;
  /** Teams to crawl, in the order their standings/discovery step returned them. */
  readonly teamIds: readonly SwimCloudTeamId[];
  /**
   * Total pages already known for a team+gender, from a previously-fetched
   * page 1's `pagination.totalPages` — keyed `${teamId}:${gender}`. An
   * absent entry plans page 1 only; call this function again once that
   * page's pagination is known to get the rest of that team-gender's pages.
   * This is deliberately re-invokable rather than one-shot, matching how
   * the real crawl actually learns page counts one fetch at a time.
   */
  readonly knownTotalPages?: Readonly<Record<string, number>>;
}

/**
 * Every `meetTeamSwims` page still needed for a meet's full-field crawl,
 * team-by-team, men then women within a team, page 1 upward within a
 * gender — deterministic, so a resumed crawl reproduces the same order and
 * a diff of two crawls is meaningful.
 */
export function planMeetTeamSwims(input: SwimCloudMeetSwimsCrawlInput): readonly SwimCloudCrawlStep[] {
  const steps: SwimCloudCrawlStep[] = [];
  for (const teamId of input.teamIds) {
    for (const gender of GENDERS) {
      const totalPages = input.knownTotalPages?.[`${teamId}:${gender}`] ?? 1;
      for (let page = 1; page <= totalPages; page += 1) {
        steps.push({
          canonicalUrl: teamSwimsUrl(input.meetId, teamId, gender, page),
          resourceKind: 'meetTeamSwims' as const,
          meetId: input.meetId,
          teamId,
          gender,
          page,
        });
      }
    }
  }
  return steps;
}

export interface SwimCloudMeetEventResultsCrawlInput {
  readonly meetId: SwimCloudMeetId;
  /**
   * The `/event/{n}/` references to fetch, in the order the caller discovered
   * them.
   *
   * The caller gets these by parsing each team's swims list with
   * `parseTeamMeetSwimsHtml` and reading `swims[].event.eventRef` — the only
   * place a swims-list row states which results page it belongs to. How that
   * list is assembled is the caller's business; this planner only turns it into
   * URLs.
   */
  readonly eventRefs: readonly string[];
}

/**
 * One `/results/{meetId}/event/{n}/` page per **distinct** event reference —
 * the round-resolution half of a meet crawl.
 *
 * A team's swims list says what its swimmers did; it does not say which round
 * any of it was, and a swimmer who made finals appears twice on it with nothing
 * to tell the rows apart. This page type is the only one that names the round,
 * and it is also the only one that publishes the real meet `Score` for a
 * finals swim. See `parseMeetEventResultsHtml`.
 *
 * ## Meet-scoped, not team-scoped — this is the whole point of the dedupe
 *
 * One event page holds **every team's** swimmers in that event, in every round.
 * A meet crawl that planned event pages per team would fetch the same URL once
 * per team in the field: a 40-team meet with a 42-event program would fetch
 * 1,680 pages to learn what 42 pages say. Repeated references collapse here,
 * first occurrence winning the position, the same way
 * {@link planMeetSwimmerTimes} collapses a swimmer who appears on two rosters —
 * and for the same reason: the URL is scoped to the event alone, so a repeat is
 * genuinely the same page and not a distinct one.
 *
 * That is also why this does **not** take a gender. A `/event/{n}/` page is one
 * gender's event already (event 26 is "100 Breast Men Finals"), and the page's
 * own gender toggle points at a *different* event id rather than a `?gender=`
 * variant of this one — so adding a gender parameter would be inventing one.
 * Both genders' pages arrive naturally, because both genders' swims lists name
 * their own event references.
 *
 * ## No `page`
 *
 * The real capture carries no `c-pagination` widget: all four rounds and forty
 * rows of a 17-swimmer event arrived on one page. Whether a very large event's
 * page ever paginates is **unproven**, and planning a guessed page range would
 * fetch URLs nothing has shown to exist. Same rule as
 * {@link planMeetTeamRosters}: a crawler that later learns otherwise calls this
 * again, it does not guess now.
 */
export function planMeetEventResults(
  input: SwimCloudMeetEventResultsCrawlInput,
): readonly SwimCloudCrawlStep[] {
  const steps: SwimCloudCrawlStep[] = [];
  const seen = new Set<string>();
  for (const eventRef of input.eventRefs) {
    if (eventRef.length === 0 || seen.has(eventRef)) {
      continue;
    }
    seen.add(eventRef);
    steps.push({
      canonicalUrl: eventResultsUrl(input.meetId, eventRef),
      resourceKind: 'meetEvent' as const,
      meetId: input.meetId,
      eventRef,
    });
  }
  return steps;
}

export interface SwimCloudMeetRostersCrawlInput {
  /** The meet whose crawl this is. Recorded on every step; it is not part of a roster URL. */
  readonly meetId: SwimCloudMeetId;
  /** Teams to fetch rosters for, in the order their discovery step returned them. */
  readonly teamIds: readonly SwimCloudTeamId[];
}

/**
 * One `/team/{teamId}/roster/?gender={M|F}` page per discovered team, both
 * genders — the roster half of a meet crawl.
 *
 * A meet's swims tell you who swam; the roster tells you who is on the program,
 * with their class year, which a results page never states. Both genders are
 * always planned, for the same reason {@link planMeetTeamDiscovery} does it: a
 * school sponsors swimming per gender, and a program that does not exist
 * returns an empty roster, which is a real answer and not an error.
 *
 * Ordering matches {@link planMeetTeamSwims} — team by team, men then women —
 * so a resumed crawl reproduces the same sequence.
 *
 * ## No `season_id`, no `page`
 *
 * No `season_id`: see this module's header. No `page` either — neither real
 * roster capture carries a `c-pagination` widget, so 35 rows arrived on one
 * page and there is no page-2 link to follow. The filter form does hold a
 * hidden `page` input, so the parameter exists; whether a roster large enough
 * to need it ever paginates is **unproven**, and planning a guessed page range
 * would fetch URLs nothing has shown to exist. Left as an open question rather
 * than guessed: a crawler that later learns a roster paginates should call this
 * again with a page count, the way {@link planMeetTeamSwims} learns one.
 */
export function planMeetTeamRosters(
  input: SwimCloudMeetRostersCrawlInput,
): readonly SwimCloudCrawlStep[] {
  const steps: SwimCloudCrawlStep[] = [];
  for (const teamId of input.teamIds) {
    for (const gender of GENDERS) {
      steps.push({
        canonicalUrl: teamRosterUrl(teamId, gender),
        resourceKind: 'teamRoster' as const,
        meetId: input.meetId,
        teamId,
        gender,
      });
    }
  }
  return steps;
}

export interface SwimCloudMeetSwimmerTimesCrawlInput {
  /** The meet whose crawl this is. Recorded on every step; it is not part of a swimmer-times URL. */
  readonly meetId: SwimCloudMeetId;
  /**
   * Swimmers to fetch times for, in the order the caller discovered them.
   *
   * The extension gets these by parsing each team's roster with
   * `parseTeamRosterHtml` and reading `athletes[].swimCloudSwimmerId`. How that
   * list is assembled is the caller's business; this planner only turns it into
   * URLs.
   */
  readonly swimmerIds: readonly SwimCloudSwimmerId[];
}

/**
 * One `/swimmer/{swimmerId}/times/` page per swimmer — the career-bests half of
 * a meet crawl.
 *
 * A meet's swims say what a swimmer did *at that meet*; this page says what
 * they have ever done, per course-qualified event. That is what a lineup
 * decision needs and what no results page carries.
 *
 * ## No gender parameter, no season, no page
 *
 * **No gender.** A roster page is one gender's list and a swims list is filtered
 * by gender, so both planners emit two URLs per subject. A swimmer is one
 * person: the real capture's URL takes no `gender` at all, and adding one would
 * be inventing a parameter.
 *
 * **No `season_id`.** Same rule as everywhere in this module — see the header.
 * The real capture's `#swimmer-profile-times` does carry a `data-season-ids`
 * list, but nothing proves that id space is stable, and the page it came from
 * was fetched with no season parameter at all.
 *
 * **No `page`.** The real capture carries no `c-pagination` widget — 29 rows
 * arrived on one page with no page-2 link. Whether a bests table ever
 * paginates is **unproven**, and it is structurally unlikely to (the table has
 * one row per event, not per swim). Left as an open question rather than
 * guessed: planning a page range nothing has shown to exist would fetch URLs
 * that may 404.
 *
 * ## Repeated ids collapse
 *
 * Duplicate swimmer ids yield one step each, first occurrence winning the
 * position. This differs from {@link planMeetTeamSwims} and
 * {@link planMeetTeamRosters}, which do not dedupe, and the difference is the
 * point: their URLs are team-scoped, so a repeated team id genuinely addresses
 * a distinct URL set per team. A swimmer-times URL is scoped to the swimmer
 * alone, and one swimmer legitimately appears on more than one roster a caller
 * unioned — so without this, one crawl would fetch the same URL twice.
 */
export function planMeetSwimmerTimes(
  input: SwimCloudMeetSwimmerTimesCrawlInput,
): readonly SwimCloudCrawlStep[] {
  const steps: SwimCloudCrawlStep[] = [];
  const seen = new Set<SwimCloudSwimmerId>();
  for (const swimmerId of input.swimmerIds) {
    if (seen.has(swimmerId)) {
      continue;
    }
    seen.add(swimmerId);
    steps.push({
      canonicalUrl: swimmerTimesUrl(swimmerId),
      resourceKind: 'swimmerTimes' as const,
      meetId: input.meetId,
      swimmerId,
    });
  }
  return steps;
}

/* -------------------------------------------------------------------------- */
/* Crawl scope — which passes a crawl commits to before it starts              */
/* -------------------------------------------------------------------------- */

/**
 * One optional pass of a meet crawl, named by the resource kind its pages are.
 *
 * Team discovery is deliberately **not** in this union. Every crawl fetches the
 * two `meetTopTeams` pages (or their `meet` fallback) because that is how the
 * team list a coach confirms is produced; there is no crawl without it, so
 * offering it as a choice would be offering a choice that does not exist. The
 * four below are the ones a crawl can honestly decline.
 *
 * Typed as a subset of {@link SwimCloudResourceKind} rather than as its own
 * string union: a pass name that is not a real resource kind would not compile,
 * so the scope table and the classifier cannot drift apart.
 */
export type SwimCloudCrawlPass = Extract<
  SwimCloudResourceKind,
  'meetTeamSwims' | 'meetEvent' | 'teamRoster' | 'swimmerTimes'
>;

/**
 * Every pass, in the order a crawl runs them. Also the canonical order any
 * recorded pass list is written in, so two records that plan the same passes
 * serialize identically.
 */
export const SWIMCLOUD_CRAWL_PASSES: readonly SwimCloudCrawlPass[] = [
  'meetTeamSwims',
  'meetEvent',
  'teamRoster',
  'swimmerTimes',
];

/**
 * The pass whose *content* another pass is planned from.
 *
 * Neither of these is a preference. A `meetEvent` page's URL is only knowable
 * from an `/event/{n}/` reference printed on a swims list, and a `swimmerTimes`
 * page's URL is only knowable from a swimmer id printed on a roster. A scope
 * that asked for the dependent pass without its prerequisite would plan zero
 * pages for it and report that as success — the silent empty this whole module
 * is written against. {@link crawlScopeDependencyGaps} is the check; a test
 * runs it over every built-in scope.
 */
export const SWIMCLOUD_CRAWL_PASS_PREREQUISITE: Readonly<
  Partial<Record<SwimCloudCrawlPass, SwimCloudCrawlPass>>
> = {
  meetEvent: 'meetTeamSwims',
  swimmerTimes: 'teamRoster',
};

/**
 * Passes whose page builds its table **in the browser**, so a fetched copy of
 * the HTML never contains the data.
 *
 * ## The evidence, measured 2026-09-20 against the archived capture
 *
 * `data/swimcloud-captures/` holds a real 234-page crawl of meet 356467. Of its
 * 184 `swimmerTimes` requests, 111 returned HTTP 429 and **73 returned HTTP
 * 200**. Every one of those 73 stored bodies:
 *
 *   - is a complete document (ends `</html>`), 15-17 KB;
 *   - contains **zero** `<table>` elements;
 *   - loads `/media/webpack/swimmerProfileTimes/index.*.js`;
 *   - renders only the shell — nav, the swimmer's name and school, and the
 *     Home / Meets / Times / Rankings tab strip.
 *
 * For contrast, 10 of 10 sampled `meetTeamSwims` bodies from the same crawl do
 * contain their tables. Those pages are server-rendered; this one is not.
 *
 * ## Why the codebase previously believed otherwise
 *
 * `parser.ts` asserted the Personal Bests table was "fully server-rendered (no
 * click needed)", citing a real 2026-09-09 capture. That capture is
 * `tests/fixtures/swimcloud-real-swimmer-times-1472365.html`, and its own header
 * records how it was taken: *"via the browser extension (Track A, clipboard)"*.
 * Track A copies the **rendered DOM** out of a live tab, after the page's
 * JavaScript has run. It is therefore evidence that the table exists on screen,
 * and no evidence at all about what the server sends. Building a `fetch`-based
 * pass on that inference is what produced 184 requests that could not succeed.
 *
 * ## What this means
 *
 * Pacing is not the issue. A crawl that hit zero rate limits would still parse
 * zero rows from this pass, because the bytes do not contain the table. The
 * data is reachable only by reading the DOM of a rendered page — which is what
 * the clipboard path already does, one swimmer at a time, with a human present.
 *
 * Listed here rather than deleted so the planner can *explain* the gap instead
 * of silently planning nothing, and so a future capture that proves the server
 * has started sending the table can remove the entry with evidence.
 */
export const SWIMCLOUD_DOM_RENDERED_PASSES: readonly SwimCloudCrawlPass[] = ['swimmerTimes'];

/** True when a fetched copy of this pass's page cannot contain its data. */
export function passRequiresRenderedDom(pass: SwimCloudCrawlPass): boolean {
  return SWIMCLOUD_DOM_RENDERED_PASSES.includes(pass);
}

/**
 * The passes a scope asks for that a fetch-based crawl cannot satisfy.
 *
 * Reported, never silently dropped: a coach who picked a scope naming season
 * bests has to be told why none arrived, and "0 swimmers captured" on its own
 * reads as "this team has no swimmers".
 */
export function scopePassesNeedingRenderedDom(
  scope: SwimCloudCrawlScope,
): readonly SwimCloudCrawlPass[] {
  return scope.passes.filter(passRequiresRenderedDom);
}

/**
 * Which job a crawl is for. Chosen before the first request, on the same panel
 * that confirms the team list.
 *
 * The three map onto the three things this app is used for, not onto the four
 * passes — a coach picks a job, not a page kind. `'everything'` is the default
 * and is exactly what every crawl did before scopes existed.
 */
export type SwimCloudCrawlScopeId = 'meet-results' | 'roster-and-season-bests' | 'everything';

export interface SwimCloudCrawlScope {
  readonly id: SwimCloudCrawlScopeId;
  /** Radio-button text. Short enough for a panel a coach reads once. */
  readonly label: string;
  /** One sentence saying what the scope is for and what it therefore skips. */
  readonly summary: string;
  /** The passes this scope plans, in {@link SWIMCLOUD_CRAWL_PASSES} order. */
  readonly passes: readonly SwimCloudCrawlPass[];
}

/**
 * The scope table. Pure data — no DOM, no network, no clock — so "does the
 * meet-results scope plan a swimmer-times page" is a unit test, exactly as
 * "does the planner emit a denylisted URL" already is.
 */
export const SWIMCLOUD_CRAWL_SCOPES: readonly SwimCloudCrawlScope[] = [
  {
    id: 'meet-results',
    label: 'Meet results only',
    summary:
      'Every team’s swims at this meet, plus the per-event pages that say which round each swim was. Skips team rosters and swimmers’ personal-best pages.',
    passes: ['meetTeamSwims', 'meetEvent'],
  },
  {
    id: 'roster-and-season-bests',
    label: 'Rosters and season bests only',
    summary:
      'Every team’s roster, plus one personal-bests page per rostered swimmer. Skips this meet’s own results.',
    passes: ['teamRoster', 'swimmerTimes'],
  },
  {
    id: 'everything',
    label: 'Everything',
    summary:
      'Meet results, per-event rounds, rosters and every rostered swimmer’s personal bests. The most requests, and the longest.',
    passes: ['meetTeamSwims', 'meetEvent', 'teamRoster', 'swimmerTimes'],
  },
];

/**
 * What a crawl runs when nobody chose. Identical to the four passes every
 * crawl ran before scopes existed, so an un-chosen scope changes nothing.
 */
export const DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID: SwimCloudCrawlScopeId = 'everything';

/**
 * The scope with this id.
 *
 * Throws on an id that is not in the table rather than returning a default.
 * A caller holding a `SwimCloudCrawlScopeId` got it from the type system or
 * from {@link readSwimCloudCrawlScopeId}; an id that reaches here and is not
 * known means the table and the union disagree, which is a bug to surface, not
 * to paper over with "everything".
 */
export function swimCloudCrawlScope(id: SwimCloudCrawlScopeId): SwimCloudCrawlScope {
  const found = SWIMCLOUD_CRAWL_SCOPES.find((scope) => scope.id === id);
  if (found === undefined) {
    throw new Error(`swimCloudCrawlScope: no scope is defined for id ${JSON.stringify(id)}.`);
  }
  return found;
}

/** The default scope as a value. */
export function defaultSwimCloudCrawlScope(): SwimCloudCrawlScope {
  return swimCloudCrawlScope(DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID);
}

/**
 * A scope id read off an untrusted value (an HTTP body, a stored record, an
 * `<input>` value), or `undefined`.
 *
 * `undefined` means **not stated**, never "everything". The difference is the
 * whole point of recording a scope: a capture that predates scopes must read as
 * "scope not recorded", not as a full crawl it was never proved to be.
 */
export function readSwimCloudCrawlScopeId(value: unknown): SwimCloudCrawlScopeId | undefined {
  if (typeof value !== 'string') return undefined;
  return SWIMCLOUD_CRAWL_SCOPES.find((scope) => scope.id === value)?.id;
}

/** A pass name read off an untrusted value, or `undefined`. Same rule as above. */
export function readSwimCloudCrawlPass(value: unknown): SwimCloudCrawlPass | undefined {
  if (typeof value !== 'string') return undefined;
  return SWIMCLOUD_CRAWL_PASSES.find((pass) => pass === value);
}

/** Whether `scope` plans `pass` at all. */
export function crawlScopePlansPass(scope: SwimCloudCrawlScope, pass: SwimCloudCrawlPass): boolean {
  return scope.passes.includes(pass);
}

/**
 * The passes `scope` does **not** plan, in canonical order.
 *
 * This is the list a UI must be able to name. A capture narrowed to meet
 * results holds zero roster pages and reports `'every-planned-page-fetched'`,
 * which at the manifest level is indistinguishable from a full crawl. The
 * difference is exactly this list.
 */
export function passesOutsideCrawlScope(scope: SwimCloudCrawlScope): readonly SwimCloudCrawlPass[] {
  return SWIMCLOUD_CRAWL_PASSES.filter((pass) => !crawlScopePlansPass(scope, pass));
}

/**
 * Passes `scope` plans whose prerequisite it does not — empty for a coherent
 * scope. See {@link SWIMCLOUD_CRAWL_PASS_PREREQUISITE}.
 */
export function crawlScopeDependencyGaps(scope: SwimCloudCrawlScope): readonly SwimCloudCrawlPass[] {
  return scope.passes.filter((pass) => {
    const needs = SWIMCLOUD_CRAWL_PASS_PREREQUISITE[pass];
    return needs !== undefined && !crawlScopePlansPass(scope, needs);
  });
}

/**
 * Pages per team this scope commits to **before a single page is read**.
 *
 * Two per included structural pass, one per gender: page 1 of each team+gender's
 * swims, and each team+gender's roster. `meetEvent` and `swimmerTimes`
 * contribute **nothing** here, and that is not an oversight — their page counts
 * are not knowable until a swims list or a roster has been parsed, and quoting
 * a guess for them is precisely what this panel line exists to stop.
 */
export function crawlScopeFloorPagesPerTeam(scope: SwimCloudCrawlScope): number {
  let perTeam = 0;
  if (crawlScopePlansPass(scope, 'meetTeamSwims')) perTeam += 2;
  if (crawlScopePlansPass(scope, 'teamRoster')) perTeam += 2;
  return perTeam;
}

/**
 * What a capture record remembers about the crawls that filled it.
 *
 * Two fields because they answer two different questions and a single one would
 * answer neither honestly:
 *
 * - {@link latestScopeId} — the scope the most recent crawl ran under. What the
 *   panel showed the coach who started it.
 * - {@link plannedPasses} — every pass **any** crawl of this capture has
 *   planned, unioned. A capture is cumulative: pages merge by canonical URL
 *   across runs, so a meet-results crawl followed by a full one holds both
 *   sets, and only the union is a true statement about what the stored pages
 *   cover. This is the field a consumer reads before telling a coach that an
 *   empty roster list means "never fetched".
 */
export interface SwimCloudCaptureCrawlScope {
  readonly latestScopeId: SwimCloudCrawlScopeId;
  readonly plannedPasses: readonly SwimCloudCrawlPass[];
}

/** Put a pass list in {@link SWIMCLOUD_CRAWL_PASSES} order, dropping duplicates. */
export function orderCrawlPasses(passes: readonly SwimCloudCrawlPass[]): readonly SwimCloudCrawlPass[] {
  return SWIMCLOUD_CRAWL_PASSES.filter((pass) => passes.includes(pass));
}

/** The record one crawl under `scope` posts to the capture store. */
export function crawlScopeRecordFor(scope: SwimCloudCrawlScope): SwimCloudCaptureCrawlScope {
  return { latestScopeId: scope.id, plannedPasses: orderCrawlPasses(scope.passes) };
}

/**
 * Merge a newly-posted scope record into whatever the capture already held.
 *
 * `plannedPasses` unions — a second crawl never un-plans what a first one
 * already fetched, and claiming it did would make a capture that genuinely
 * holds roster pages report that rosters were never planned. `latestScopeId`
 * takes the incoming value, because it is by definition about the latest crawl.
 */
export function mergeCaptureCrawlScopes(
  existing: SwimCloudCaptureCrawlScope | undefined,
  incoming: SwimCloudCaptureCrawlScope,
): SwimCloudCaptureCrawlScope {
  return {
    latestScopeId: incoming.latestScopeId,
    plannedPasses: orderCrawlPasses([...(existing?.plannedPasses ?? []), ...incoming.plannedPasses]),
  };
}

/**
 * Whether a stored capture is known to have planned `pass`.
 *
 * Three answers, not two. `'not-recorded'` is a capture written before scopes
 * existed (`data/swimcloud-captures/` holds a real one): nothing on disk says
 * which passes it planned, so "it has no roster pages" and "it never asked for
 * roster pages" cannot be told apart, and a UI must say that rather than pick
 * one. `CLAUDE.md`'s "absent is not empty", one level up from a parser.
 */
export function capturePlannedPassStatus(
  recorded: SwimCloudCaptureCrawlScope | undefined,
  pass: SwimCloudCrawlPass,
): 'planned' | 'not-planned' | 'not-recorded' {
  if (recorded === undefined) return 'not-recorded';
  return recorded.plannedPasses.includes(pass) ? 'planned' : 'not-planned';
}

/**
 * Passes `next` plans that the stored capture has never planned — what a
 * re-crawl under a wider scope will newly fetch.
 *
 * Empty for a re-run at the same or a narrower scope. Not a resume decision:
 * resume is decided per URL by the extension's `captureResume.ts`, which
 * already re-fetches anything the store holds no bytes for. This exists so the
 * panel can say what widening the scope is about to add, before the coach
 * commits to the wait.
 */
export function passesNewlyPlannedBy(
  recorded: SwimCloudCaptureCrawlScope | undefined,
  next: SwimCloudCrawlScope,
): readonly SwimCloudCrawlPass[] {
  if (recorded === undefined) return orderCrawlPasses(next.passes);
  return orderCrawlPasses(next.passes).filter((pass) => !recorded.plannedPasses.includes(pass));
}

/* -------------------------------------------------------------------------- */
/* The scoped plan a crawl actually commits to                                 */
/* -------------------------------------------------------------------------- */

export interface SwimCloudScopedMeetCrawlInput {
  readonly meetId: SwimCloudMeetId;
  /** Teams the coach confirmed, in the order the discovery step returned them. */
  readonly teamIds: readonly SwimCloudTeamId[];
  readonly scope: SwimCloudCrawlScope;
  /** Passed straight through to {@link planMeetTeamSwims}; see that input's doc comment. */
  readonly knownTotalPages?: Readonly<Record<string, number>>;
}

/**
 * Every up-front decision one scope makes, as one value.
 *
 * The two step arrays are **empty**, not absent, when the scope declines that
 * pass. An empty array is what the crawl loop then iterates zero times, so a
 * declined pass costs no request and needs no second branch at the call site.
 *
 * The two booleans are flags rather than step arrays because neither pass's
 * steps exist yet: a `meetEvent` URL is only knowable once a swims list has
 * been parsed, and a `swimmerTimes` URL only once a roster has been. They say
 * whether to run the pass at all, which is the decision this type owns.
 */
export interface SwimCloudScopedMeetCrawlPlan {
  readonly scope: SwimCloudCrawlScope;
  /** Page 1 of every confirmed team+gender's swims, or every known page when `knownTotalPages` is given. */
  readonly swimsSteps: readonly SwimCloudCrawlStep[];
  readonly rosterSteps: readonly SwimCloudCrawlStep[];
  readonly plansEventResults: boolean;
  readonly plansSwimmerTimes: boolean;
  /**
   * Passes the scope named that a fetch-based crawl cannot satisfy, so a UI can
   * say which data will not arrive and why, instead of reporting an empty
   * result as though the source had nothing to give.
   *
   * See {@link SWIMCLOUD_DOM_RENDERED_PASSES}.
   */
  readonly declinedNeedingRenderedDom: readonly SwimCloudCrawlPass[];
}

/**
 * The structural plan for one meet crawl under one scope.
 *
 * This is the single place a scope turns into "which requests happen", so the
 * question "does the meet-results scope fetch a roster page" is answered by a
 * pure function and a unit test rather than by reading a 250-line crawl loop.
 * The crawl loop calls this twice — once before any page count is known and
 * again with `knownTotalPages` — and both calls go through the same gate, so a
 * pass cannot be declined up front and then quietly re-planned later.
 *
 * Throws on an incoherent scope (one that plans a dependent pass without its
 * prerequisite — see {@link crawlScopeDependencyGaps}) rather than planning it
 * anyway. Such a scope would plan zero pages for the dependent pass and let the
 * capture report every planned page as fetched, which is the silent empty this
 * module exists to prevent.
 */
export function planScopedMeetCrawl(input: SwimCloudScopedMeetCrawlInput): SwimCloudScopedMeetCrawlPlan {
  const gaps = crawlScopeDependencyGaps(input.scope);
  if (gaps.length > 0) {
    throw new Error(
      `planScopedMeetCrawl: scope ${JSON.stringify(input.scope.id)} plans ${gaps.join(', ')} ` +
        'without the pass each one is planned from, so those passes would silently plan zero pages.',
    );
  }
  return {
    scope: input.scope,
    swimsSteps: crawlScopePlansPass(input.scope, 'meetTeamSwims')
      ? planMeetTeamSwims({
          meetId: input.meetId,
          teamIds: input.teamIds,
          ...(input.knownTotalPages === undefined ? {} : { knownTotalPages: input.knownTotalPages }),
        })
      : [],
    rosterSteps: crawlScopePlansPass(input.scope, 'teamRoster')
      ? planMeetTeamRosters({ meetId: input.meetId, teamIds: input.teamIds })
      : [],
    plansEventResults: crawlScopePlansPass(input.scope, 'meetEvent'),
    // Planned only when the scope asks for it AND a fetched page could actually
    // carry the data. See SWIMCLOUD_DOM_RENDERED_PASSES: the swimmer-times page
    // builds its table in the browser, so fetching it spends requests to store
    // a shell. On the one measured crawl that was 184 of 234 pages -- 78.6% of
    // all traffic -- for zero parsed rows.
    plansSwimmerTimes:
      crawlScopePlansPass(input.scope, 'swimmerTimes') && !passRequiresRenderedDom('swimmerTimes'),
    /** Asked for by the scope but skipped because a fetch cannot satisfy them. */
    declinedNeedingRenderedDom: scopePassesNeedingRenderedDom(input.scope),
  };
}
