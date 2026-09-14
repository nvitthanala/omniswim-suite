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
