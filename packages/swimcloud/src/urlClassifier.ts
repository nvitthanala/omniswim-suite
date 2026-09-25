/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud URL classifier — pure, network-free, zero dependencies.
 *
 * ## The URL patterns here are NOT verified fact
 *
 * Every pattern in this file is transcribed from
 * `plans/2026-09-06/02-data-model-and-scoring.md` §1, whose own sourcing is
 * **prior-art scraper code (SwimScraper, maflancer/ACC-Swimming-Data) and search
 * results — not a live fetch**. A direct fetch could not confirm them:
 * SwimCloud serves a Cloudflare Managed/JS Challenge (HTTP 403) to any client
 * without a JS engine, so `/team/633/`, `/team/633/roster/`, `/results/` and
 * `/swimmer/` all 403 for a plain HTTP client
 * (`plans/2026-09-06/01-legal-and-access-strategy.md` §2).
 *
 * The patterns are consistent across every independent source found, which is
 * evidence, not proof. Do not downstream-cite this file as "the SwimCloud URL
 * scheme"; cite it as "the scheme we believe SwimCloud uses, pending
 * confirmation".
 *
 * ## Four of these patterns ARE now confirmed (2026-09-08)
 *
 * A human captured three real pages of meet 356467 with the browser extension
 * and they are archived as `tests/fixtures/swimcloud-real-*.html`. They confirm,
 * from markup SwimCloud actually served:
 *
 * - `/results/{meetId}/`                            → `meet`
 * - `/results/{meetId}/team/{teamId}/`              → `meetTeam`
 * - `/results/{meetId}/team/{teamId}/swims/`        → `meetTeamSwims`
 * - `/results/{meetId}/swimmer/{swimmerId}/`        → `meetSwimmer` (the athlete
 *   link shape used by every results row on all three pages)
 *
 * plus `?gender=M`/`?gender=F` and `?page=N` on the two team-scoped kinds, and
 * `/results/{meetId}/event/{n}/` as the target of every row's time link (so
 * `meetEvent`'s path is confirmed even though no `meetEvent` page was captured).
 *
 * ## Three more became confirmed (2026-09-09)
 *
 * - `/team/{teamId}/roster/?gender=`               → `teamRoster` (OQ-3)
 * - `/team/{teamId}/results/`                      → `teamResults`
 * - `/swimmer/{swimmerId}/times/`                  → `swimmerTimes` (OQ-4)
 *
 * `/swimmer/{swimmerId}/` is confirmed alongside `swimmerTimes` — the times
 * capture's own nav links it, and its page was captured too
 * (`tests/fixtures/swimcloud-real-swimmer-home-1472365.html`).
 *
 * Everything else in this file — the rest of the `/swimmer/` family and the
 * whole `/conference/` family — remains unconfirmed, and open question 2 in
 * `plans/2026-09-06/04-phasing.md` stays open for them.
 *
 * ## What the classifier guarantees
 *
 * It never guesses. Every input lands in exactly one of four outcomes
 * ({@link SwimCloudUrlClassification}):
 *
 * - `fetchable`   — a recognized pattern with a well-formed id/slug.
 * - `forbidden`   — a recognized SwimCloud path that robots.txt disallows. This
 *                   is *not* an error case: the path is understood, and the
 *                   answer is "no". It can never be narrowed to `fetchable`.
 * - `malformed`   — the shape of a known pattern, with an id/slug that is
 *                   missing or not of the required form. Never coerced.
 * - `unrecognized`— not a SwimCloud URL at all, or a SwimCloud path this
 *                   classifier does not model. Never treated as fetchable.
 *
 * There is deliberately no "probably fine" outcome and no boolean return: a
 * caller cannot accidentally treat a forbidden or malformed URL as fetchable by
 * forgetting to check a flag, because the id is not present on those variants.
 */

import type {
  SwimCloudConferenceSlug,
  SwimCloudMeetId,
  SwimCloudSwimmerId,
  SwimCloudTeamId,
} from './entities';

/* -------------------------------------------------------------------------- */
/* robots.txt denylist                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The four paths `https://www.swimcloud.com/robots.txt` disallows for a generic
 * (`User-agent: *`) client, quoted verbatim from the fetch recorded in
 * `plans/2026-09-06/01-legal-and-access-strategy.md` §1:
 *
 * ```
 * User-agent: *
 * Allow: /
 * Disallow: /api/
 * Disallow: /jsonapi/
 * Disallow: /team/{@literal *}/facilities/
 * Disallow: /tz_detect/
 * ```
 *
 * This is the one part of SwimCloud's access posture that is unambiguous, and it
 * is enforced in code rather than in prose — Track B has already accepted the
 * larger Terms-of-Use risk, and gets no exemption from this list regardless
 * (`01-legal-and-access-strategy.md` §4).
 *
 * Exported so the Phase 2 politeness wrapper can assert against the same list
 * rather than re-typing it.
 */
export const SWIMCLOUD_ROBOTS_DISALLOW_RULES = [
  '/api/',
  '/jsonapi/',
  '/team/*/facilities/',
  '/tz_detect/',
] as const;

/**
 * Paths under a `Disallow:` rule that this app fetches anyway, **by the
 * user's explicit decision on 2026-09-22**.
 *
 * The swimmer times page builds its table in the browser from
 * `/api/swimmers/{id}/profile_fastest_times/`, so no robots-compliant fetch
 * can read a swimmer's bests (see `SWIMCLOUD_DOM_RENDERED_PASSES` history in
 * `./crawlPlan.ts`). The user chose to call that one endpoint, knowing it
 * departs from robots.txt and from `01-legal-and-access-strategy.md` §4.
 *
 * The exemption is one exact path shape. Every other `/api/` and `/jsonapi/`
 * path stays forbidden, and the crawler calls this one sequentially, paced
 * like every other pass.
 */
export const SWIMCLOUD_ROBOTS_USER_EXEMPTIONS = ['/api/swimmers/{id}/profile_fastest_times/'] as const;

/** The swimmer id when `lower` is exactly the exempt path shape, else undefined. */
function exemptSwimmerFastestTimesId(lower: readonly string[]): SwimCloudSwimmerId | undefined {
  if (lower.length !== 4) return undefined;
  if (lower[0] !== 'api' || lower[1] !== 'swimmers' || lower[3] !== 'profile_fastest_times') return undefined;
  return NUMERIC_ID.test(lower[2]) ? (lower[2] as SwimCloudSwimmerId) : undefined;
}

/** One of the four robots.txt `Disallow:` lines. */
export type SwimCloudRobotsRule = (typeof SWIMCLOUD_ROBOTS_DISALLOW_RULES)[number];

/* -------------------------------------------------------------------------- */
/* Hosts                                                                       */
/* -------------------------------------------------------------------------- */

/** The canonical host, used when rebuilding a normalized URL. */
export const SWIMCLOUD_CANONICAL_HOST = 'www.swimcloud.com';

/** The registrable domain every SwimCloud URL must sit under. */
export const SWIMCLOUD_APEX_HOST = 'swimcloud.com';

/**
 * True when `hostname` is `swimcloud.com` or a subdomain of it.
 *
 * Takes an already-parsed hostname (from `URL`), never a raw string, so
 * `https://www.swimcloud.com@evil.example/team/633/` — whose *hostname* is
 * `evil.example` — cannot pass by looking like the right prefix.
 */
export function isSwimCloudHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === SWIMCLOUD_APEX_HOST || host.endsWith(`.${SWIMCLOUD_APEX_HOST}`);
}

/* -------------------------------------------------------------------------- */
/* Resources                                                                   */
/* -------------------------------------------------------------------------- */

/** The resource kinds this classifier models. */
export type SwimCloudResourceKind =
  | 'team'
  | 'teamRoster'
  | 'teamResults'
  | 'swimmer'
  | 'swimmerTimes'
  | 'swimmerFastestTimes'
  | 'meet'
  | 'meetEvent'
  | 'meetTeam'
  | 'meetTeamSwims'
  | 'meetTopTeams'
  | 'meetSwimmer'
  | 'conference';

/**
 * Query parameters on a roster URL (`/team/{id}/roster/?page=&gender=&season_id=`).
 *
 * Values are carried **verbatim as strings and are not interpreted**. In
 * particular the encoding SwimCloud uses for `gender` (`M`/`F`? `1`/`2`?
 * `Men`/`Women`?) is **unverified**, so mapping it to
 * {@link SwimCloudGender} here would be a guess. A caller that needs the
 * semantic gender must get it from the page content, not from this parameter.
 *
 * A parameter present with an empty value (`?page=`, exactly as the plan
 * documents the pattern) is treated as *not set* for the typed fields, but is
 * still visible in {@link raw}.
 */
export interface SwimCloudTeamRosterQuery {
  readonly page?: string;
  readonly gender?: string;
  readonly seasonId?: string;
  /**
   * Every query parameter on the URL, verbatim. Repeated keys keep the last
   * value — a repeated key is not something this classifier tries to be clever
   * about.
   */
  readonly raw: Readonly<Record<string, string>>;
}

/** Query parameters on a team meet-list URL (`/team/{id}/results/?page=&year=`). */
export interface SwimCloudTeamResultsQuery {
  readonly page?: string;
  readonly year?: string;
  /** Every query parameter on the URL, verbatim. See {@link SwimCloudTeamRosterQuery.raw}. */
  readonly raw: Readonly<Record<string, string>>;
}

/**
 * Query parameters on a meet page scoped to one team
 * (`/results/{meetId}/team/{teamId}/[swims/]?gender=&page=`).
 *
 * `gender` is carried **verbatim and is not interpreted**, exactly as on
 * {@link SwimCloudTeamRosterQuery}. A real capture
 * (`tests/fixtures/swimcloud-real-meet-team-swims-356467-team58-page1.html`)
 * does show `?gender=M` / `?gender=F` next to the printed words `Men` / `Women`
 * in the page's own gender dropdown, but that is the *page body* saying so.
 * Reading the semantic gender off this parameter would still be the classifier
 * deciding an encoding from one sample, so the parser reads the printed word
 * instead — see `parseTeamMeetSwimsHtml` in `./parser.ts`.
 *
 * `page` is the 1-based page of the paginated swims list. Page 1 is addressed
 * with no `page` parameter at all, so its absence means page 1 — but that
 * inference belongs to the parser, which can also see the pagination widget,
 * not here.
 */
export interface SwimCloudMeetTeamQuery {
  readonly page?: string;
  readonly gender?: string;
  /** Every query parameter on the URL, verbatim. See {@link SwimCloudTeamRosterQuery.raw}. */
  readonly raw: Readonly<Record<string, string>>;
}

/**
 * Which of the two conference URL shapes was matched.
 *
 * `plans/2026-09-06/02-data-model-and-scoring.md` §1 is internally inconsistent
 * here: it documents the pattern as `/country/usa/college/conference/{slug}/`
 * but gives `/conference/nsisc/` as the example. Both are therefore recognized,
 * and which one was seen is reported rather than normalized away — if it later
 * turns out only one is real, this field is what makes that discoverable
 * instead of silently papered over.
 */
export type SwimCloudConferenceUrlForm = 'country-scoped' | 'short';

/** A recognized, well-formed SwimCloud resource. Discriminated on `kind`. */
export type SwimCloudResource =
  | { readonly kind: 'team'; readonly teamId: SwimCloudTeamId }
  | {
      readonly kind: 'teamRoster';
      readonly teamId: SwimCloudTeamId;
      readonly query: SwimCloudTeamRosterQuery;
    }
  | {
      readonly kind: 'teamResults';
      readonly teamId: SwimCloudTeamId;
      readonly query: SwimCloudTeamResultsQuery;
    }
  | { readonly kind: 'swimmer'; readonly swimmerId: SwimCloudSwimmerId }
  /**
   * One swimmer's times page — `/swimmer/{id}/times/`.
   *
   * Confirmed real 2026-09-09 (`tests/fixtures/swimcloud-real-swimmer-times-1472365.html`),
   * which resolved OQ-4. Its default "Personal Bests" tab is a real,
   * server-rendered table — see `parseSwimmerTimesHtml` in `./parser.ts`.
   *
   * ## Why this is its own kind rather than `swimmer`
   *
   * {@link canonicalPathForResource} rebuilds a `swimmer` resource as
   * `/swimmer/{id}/`, and {@link SwimCloudUrlFetchable.canonicalUrl} — built
   * from that path — is documented as the status-keyed cache's key. Classifying
   * `/swimmer/{id}/times/` as `swimmer` would therefore hand two genuinely
   * different pages one cache key, so a times capture would overwrite a
   * home-page capture and be served back in its place. The `team` /
   * `teamRoster` / `teamResults` split exists for exactly this reason and this
   * follows it.
   *
   * The other three sub-pages the real capture's nav lists — `/meets/`,
   * `/standards/`, `/rankings/` — are **not** modelled. Their markup has never
   * been captured, and a URL pattern read off a nav bar is a pattern nobody has
   * fetched.
   */
  | { readonly kind: 'swimmerTimes'; readonly swimmerId: SwimCloudSwimmerId }
  /**
   * The JSON a swimmer's times page loads its Personal Bests table from —
   * `/api/swimmers/{id}/profile_fastest_times/`. The one `/api/` path that is
   * fetchable; see {@link SWIMCLOUD_ROBOTS_USER_EXEMPTIONS}.
   */
  | { readonly kind: 'swimmerFastestTimes'; readonly swimmerId: SwimCloudSwimmerId }
  | { readonly kind: 'meet'; readonly meetId: SwimCloudMeetId }
  | {
      readonly kind: 'meetEvent';
      readonly meetId: SwimCloudMeetId;
      /**
       * The `{n}` segment of `/results/{meetId}/event/{n}/`, kept as a string.
       *
       * **Unverified** whether `{n}` is the meet's printed event number or a
       * SwimCloud-internal event id. Held as a string so the two cannot be
       * conflated by arithmetic before anyone has checked which it is.
       */
      readonly eventRef: string;
    }
  /**
   * One team's page **within a meet** — `/results/{meetId}/team/{teamId}/`.
   *
   * **Not the same resource as `teamResults`**, despite both pairing a team
   * with the word "results". `teamResults` (`/team/{id}/results/`) is a team's
   * own list of the meets it swam. This is one meet's page, narrowed to one
   * team: a summary dashboard of that team's performance at that meet.
   *
   * Confirmed real (`tests/fixtures/swimcloud-real-meet-team-landing-356467-team58.html`).
   * It is a **summary**: top-5 swimmers and top-10 swims only, against an
   * "Entries" count in the hundreds. Its full swim list is
   * {@link SwimCloudResource} `meetTeamSwims`.
   */
  | {
      readonly kind: 'meetTeam';
      readonly meetId: SwimCloudMeetId;
      readonly teamId: SwimCloudTeamId;
      readonly query: SwimCloudMeetTeamQuery;
    }
  /**
   * One team's **full** swim list within a meet —
   * `/results/{meetId}/team/{teamId}/swims/`.
   *
   * Confirmed real (`tests/fixtures/swimcloud-real-meet-team-swims-356467-team58-page1.html`).
   * This is the only modelled SwimCloud page that carries a team's complete
   * results for a meet, and it is paginated at 30 rows per page and split by
   * gender with no combined view — so a complete capture of one team is
   * `pages × 2` visits, not one.
   */
  | {
      readonly kind: 'meetTeamSwims';
      readonly meetId: SwimCloudMeetId;
      readonly teamId: SwimCloudTeamId;
      readonly query: SwimCloudMeetTeamQuery;
    }
  /**
   * A meet's full team-standings page — `/results/{meetId}/topteams/`.
   *
   * Confirmed real 2026-09-08: the meet root's Teams card truncates on a
   * real meet (5 of 13 teams shown) and links here via a "More" caption —
   * the same pattern already confirmed for `topswimmers`/`topswims`. Two
   * real captures (13-team MPSF Championships, both genders) show this page
   * lists every competing team, including ones that scored zero (rank and
   * score both print as an em dash rather than being omitted) — see
   * `plans/2026-09-08/01-decisions.md`'s OQ-1b resolution and
   * `tests/fixtures/swimcloud-real-meet-topteams-379295-gender-{m,f}.html`.
   * Not scoped to a team — unlike `meetTeam`/`meetTeamSwims`, this page
   * covers the whole meet's field for one gender.
   */
  | {
      readonly kind: 'meetTopTeams';
      readonly meetId: SwimCloudMeetId;
      readonly query: SwimCloudMeetTeamQuery;
    }
  /**
   * One swimmer's page within a meet — `/results/{meetId}/swimmer/{swimmerId}/`.
   *
   * Modelled because it is the link shape every results **row** uses for its
   * athlete (confirmed on all three real fixtures) — not because the page
   * itself is a capture target. Without it, a results row's athlete link
   * classifies as `unknown-path` and the row loses its SwimCloud swimmer id,
   * which is the one identifier more reliable than the printed name.
   */
  | {
      readonly kind: 'meetSwimmer';
      readonly meetId: SwimCloudMeetId;
      readonly swimmerId: SwimCloudSwimmerId;
    }
  | {
      readonly kind: 'conference';
      readonly urlForm: 'country-scoped';
      readonly slug: SwimCloudConferenceSlug;
      /** `usa` in the documented pattern. Required on this form, never defaulted. */
      readonly country: string;
      /** `college` in the documented pattern. Required on this form, never defaulted. */
      readonly level: string;
    }
  | {
      readonly kind: 'conference';
      readonly urlForm: 'short';
      readonly slug: SwimCloudConferenceSlug;
    };

/* -------------------------------------------------------------------------- */
/* Classification outcomes                                                     */
/* -------------------------------------------------------------------------- */

/** Why a URL that looked like a known pattern was rejected. */
export type SwimCloudMalformedReason =
  /** The pattern's id/slug segment is absent entirely (e.g. `/team/`). */
  | 'missing-id'
  /** The id segment is present but is not a positive integer without leading zeros. */
  | 'invalid-id'
  /** `/results/{meetId}/event/` with no `{n}`. */
  | 'missing-event-ref'
  /** `/results/{meetId}/event/{n}/` where `{n}` is not a positive integer. */
  | 'invalid-event-ref'
  /** `/country/usa/college/conference/` or `/conference/` with no slug. */
  | 'missing-slug'
  /** A slug present but not of the conservative slug shape this classifier accepts. */
  | 'invalid-slug';

/** Why a URL was not recognized as a SwimCloud resource at all. */
export type SwimCloudUnrecognizedReason =
  /** Empty input, or a string no URL parser accepts. */
  | 'unparseable-url'
  /** A scheme other than `http:`/`https:` (`mailto:`, `javascript:`, `file:`, …). */
  | 'unsupported-scheme'
  /** Parsed fine, but the host is not `swimcloud.com` or a subdomain of it. */
  | 'not-swimcloud-host'
  /** A SwimCloud URL whose path matches none of the modelled patterns. */
  | 'unknown-path';

/** A recognized SwimCloud URL that robots.txt permits fetching. */
export interface SwimCloudUrlFetchable {
  readonly outcome: 'fetchable';
  /** The caller's input, verbatim. */
  readonly input: string;
  /**
   * The path rebuilt from the matched {@link resource} rather than echoed from
   * the input — see {@link canonicalPathForResource}. Keyword segments are
   * lowercase; ids and slugs appear exactly as the resource holds them.
   */
  readonly canonicalPath: string;
  /**
   * `https://www.swimcloud.com` + {@link canonicalPath} + the original query
   * string. Suitable as the key for the Phase 2 status-keyed cache, since roster
   * page 2 and roster page 3 are genuinely different resources, while
   * `/TEAM/633` and `/team/633/` are not.
   */
  readonly canonicalUrl: string;
  readonly resource: SwimCloudResource;
}

/** A recognized SwimCloud path that robots.txt disallows. Never fetch this. */
export interface SwimCloudUrlForbidden {
  readonly outcome: 'forbidden';
  readonly input: string;
  readonly canonicalPath: string;
  /** Which `Disallow:` line matched. */
  readonly rule: SwimCloudRobotsRule;
  /** Always `'robots.txt'`; present so a UI can say *why* without hardcoding the reason. */
  readonly source: 'robots.txt';
  readonly detail: string;
}

/** A URL matching the shape of a known pattern, with an unusable id or slug. */
export interface SwimCloudUrlMalformed {
  readonly outcome: 'malformed';
  readonly input: string;
  readonly canonicalPath: string;
  /** The pattern it looked like. Reported so a UI can say "this looks like a team URL, but…". */
  readonly kind: SwimCloudResourceKind;
  readonly reason: SwimCloudMalformedReason;
  readonly detail: string;
}

/** Not a SwimCloud resource URL. */
export interface SwimCloudUrlUnrecognized {
  readonly outcome: 'unrecognized';
  readonly input: string;
  readonly reason: SwimCloudUnrecognizedReason;
  readonly detail: string;
  /** Present when the input parsed far enough to have a path. */
  readonly canonicalPath?: string;
  /** Present when the input parsed far enough to have a host. */
  readonly hostname?: string;
}

/** The complete result of {@link classifySwimCloudUrl}. */
export type SwimCloudUrlClassification =
  | SwimCloudUrlFetchable
  | SwimCloudUrlForbidden
  | SwimCloudUrlMalformed
  | SwimCloudUrlUnrecognized;

/**
 * Rebuild the canonical site-relative path for a resource.
 *
 * The inverse direction of {@link classifySwimCloudUrl}: given a resource the
 * classifier produced (or that a caller assembled from ids it already holds),
 * produce the one path that addresses it. Query parameters are **not** included
 * — they are carried separately on the roster/results resources.
 *
 * Exported because both the browser extension and the Phase 2 fetcher need to
 * turn "team 633's roster" back into a URL, and neither should be re-deriving
 * the string format by hand.
 */
export function canonicalPathForResource(resource: SwimCloudResource): string {
  switch (resource.kind) {
    case 'team':
      return `/team/${resource.teamId}/`;
    case 'teamRoster':
      return `/team/${resource.teamId}/roster/`;
    case 'teamResults':
      return `/team/${resource.teamId}/results/`;
    case 'swimmer':
      return `/swimmer/${resource.swimmerId}/`;
    case 'swimmerTimes':
      return `/swimmer/${resource.swimmerId}/times/`;
    case 'swimmerFastestTimes':
      return `/api/swimmers/${resource.swimmerId}/profile_fastest_times/`;
    case 'meet':
      return `/results/${resource.meetId}/`;
    case 'meetEvent':
      return `/results/${resource.meetId}/event/${resource.eventRef}/`;
    case 'meetTeam':
      return `/results/${resource.meetId}/team/${resource.teamId}/`;
    case 'meetTeamSwims':
      return `/results/${resource.meetId}/team/${resource.teamId}/swims/`;
    case 'meetTopTeams':
      return `/results/${resource.meetId}/topteams/`;
    case 'meetSwimmer':
      return `/results/${resource.meetId}/swimmer/${resource.swimmerId}/`;
    case 'conference':
      if (resource.urlForm === 'short') {
        return `/conference/${resource.slug}/`;
      }
      return `/country/${resource.country}/${resource.level}/conference/${resource.slug}/`;
  }
}

/** Narrowing helper: `true` only for the one outcome that may be fetched. */
export function isFetchableSwimCloudUrl(
  classification: SwimCloudUrlClassification,
): classification is SwimCloudUrlFetchable {
  return classification.outcome === 'fetchable';
}

/**
 * Narrowing helper for the robots.txt denylist.
 *
 * Phase 2's fetcher wrapper must reject on this **before issuing any request**
 * (`plans/2026-09-06/03-architecture.md` §1.2).
 */
export function isForbiddenSwimCloudUrl(
  classification: SwimCloudUrlClassification,
): classification is SwimCloudUrlForbidden {
  return classification.outcome === 'forbidden';
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A SwimCloud id: a positive integer, no leading zeros, no sign, no separators.
 *
 * The length cap is a sanity bound, not a claim about SwimCloud's id space —
 * ids observed in the wild run from 3 digits (an old team at 405) to 8
 * (`10028935`). Anything past 18 digits is a malformed input, not an id.
 * Validated as a **string** throughout: `Number('123abc')` is `NaN` but
 * `parseInt('123abc')` is `123`, and only one of those two mistakes has to be
 * made once.
 */
const NUMERIC_ID = /^[1-9][0-9]{0,17}$/;

/**
 * Conservative slug shape for a conference. Deliberately narrow: an unexpected
 * slug comes back `malformed` (loud, visible in the import UI) rather than being
 * passed through to a fetch that would 404.
 */
const CONFERENCE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Matches a leading `scheme:` per RFC 3986. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function parseInput(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    if (trimmed.startsWith('/')) {
      // Path-only input, which the browser extension will produce naturally.
      // Note `//evil.example/x` is protocol-relative and resolves to that host;
      // the host check below is what rejects it, not this branch.
      return new URL(trimmed, `https://${SWIMCLOUD_CANONICAL_HOST}`);
    }
    if (HAS_SCHEME.test(trimmed)) {
      return new URL(trimmed);
    }
    // Scheme-less host form, e.g. `www.swimcloud.com/team/633/`, which is what
    // several browsers put on the clipboard when copying an address.
    return new URL(`https://${trimmed}`);
  } catch {
    return null;
  }
}

function splitSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

function canonicalPathOf(segments: readonly string[]): string {
  if (segments.length === 0) {
    return '/';
  }
  return `/${segments.join('/')}/`;
}

function readQuery(url: URL): Record<string, string> {
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  return raw;
}

/** Empty-string parameters mean "present but unset" and are reported as absent. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

/**
 * Matches robots.txt prefix semantics against the normalized path.
 *
 * Two deliberate choices, both erring toward *refusing* a fetch — the only
 * direction in which erring is safe, since a false `forbidden` costs one manual
 * check while a false `fetchable` crosses the one line in this project's access
 * posture that is unambiguous:
 *
 * 1. The path is normalized to always carry a trailing slash before matching, so
 *    `/api` is treated the same as `/api/`. Strict robots.txt prefix matching
 *    would let `/api` through on a technicality.
 * 2. `Disallow: /team/{@literal *}/facilities/` uses a wildcard that matches any
 *    characters *including slashes*, so any `facilities` segment under `/team/`
 *    matches, not only the third segment.
 */
function robotsRuleFor(segments: readonly string[]): SwimCloudRobotsRule | null {
  const lower = segments.map((segment) => segment.toLowerCase());
  const path = canonicalPathOf(lower);

  if (path.startsWith('/api/')) {
    return '/api/';
  }
  if (path.startsWith('/jsonapi/')) {
    return '/jsonapi/';
  }
  if (path.startsWith('/tz_detect/')) {
    return '/tz_detect/';
  }
  if (lower[0] === 'team' && lower.indexOf('facilities') >= 2) {
    return '/team/*/facilities/';
  }
  return null;
}

function unrecognized(
  input: string,
  reason: SwimCloudUnrecognizedReason,
  detail: string,
  extra?: { canonicalPath?: string; hostname?: string },
): SwimCloudUrlUnrecognized {
  return {
    outcome: 'unrecognized',
    input,
    reason,
    detail,
    ...(extra?.canonicalPath === undefined ? {} : { canonicalPath: extra.canonicalPath }),
    ...(extra?.hostname === undefined ? {} : { hostname: extra.hostname }),
  };
}

function malformed(
  input: string,
  canonicalPath: string,
  kind: SwimCloudResourceKind,
  reason: SwimCloudMalformedReason,
  detail: string,
): SwimCloudUrlMalformed {
  return { outcome: 'malformed', input, canonicalPath, kind, reason, detail };
}

/* -------------------------------------------------------------------------- */
/* Per-keyword path classifiers                                                */
/*                                                                              */
/* Each of these mirrors one `switch (lower[0])` case that used to live inline */
/* in `classifySwimCloudUrl`. They are pure extractions — same branches, same  */
/* order, same messages — pulled out only so each one is independently under  */
/* the complexity ceiling. `fetchable` is threaded through as a parameter      */
/* rather than closed over, since these functions no longer sit inside the    */
/* body that defines it.                                                       */
/* -------------------------------------------------------------------------- */

/** Shared shape every path classifier below is called with. */
interface PathClassifyArgs {
  readonly input: string;
  readonly segments: readonly string[];
  readonly lower: readonly string[];
  readonly canonicalPath: string;
  readonly parsed: URL;
  readonly fetchable: (resource: SwimCloudResource) => SwimCloudUrlFetchable;
}

/** `/team/{id}/`, `/team/{id}/roster/`, `/team/{id}/results/`. */
function classifyTeamPath(args: PathClassifyArgs): SwimCloudUrlClassification {
  const { input, segments, lower, canonicalPath, parsed, fetchable } = args;
  // `/team/` is a real page on the site, but it is not a team resource. It is
  // reported as a malformed team URL rather than as an unknown path because
  // that is the more useful message in the paste-import UI ("this looks like
  // a team link but carries no team id"), and because both outcomes are
  // equally un-fetchable.
  if (segments.length === 1) {
    return malformed(input, canonicalPath, 'team', 'missing-id', 'Team URL carries no team id.');
  }
  const teamId = segments[1];
  if (!NUMERIC_ID.test(teamId)) {
    return malformed(
      input,
      canonicalPath,
      'team',
      'invalid-id',
      `Team id ${JSON.stringify(teamId)} is not a positive integer without leading zeros.`,
    );
  }
  if (segments.length === 2) {
    return fetchable({ kind: 'team', teamId });
  }
  if (segments.length === 3 && lower[2] === 'roster') {
    const raw = readQuery(parsed);
    const page = nonEmpty(raw['page']);
    const gender = nonEmpty(raw['gender']);
    const seasonId = nonEmpty(raw['season_id']);
    return fetchable({
      kind: 'teamRoster',
      teamId,
      query: {
        ...(page === undefined ? {} : { page }),
        ...(gender === undefined ? {} : { gender }),
        ...(seasonId === undefined ? {} : { seasonId }),
        raw,
      },
    });
  }
  if (segments.length === 3 && lower[2] === 'results') {
    const raw = readQuery(parsed);
    const page = nonEmpty(raw['page']);
    const year = nonEmpty(raw['year']);
    return fetchable({
      kind: 'teamResults',
      teamId,
      query: {
        ...(page === undefined ? {} : { page }),
        ...(year === undefined ? {} : { year }),
        raw,
      },
    });
  }
  return unrecognized(
    input,
    'unknown-path',
    `Team sub-path ${canonicalPath} is not one of the modelled patterns (/team/{id}/, /team/{id}/roster/, /team/{id}/results/).`,
    { canonicalPath, hostname: parsed.hostname },
  );
}

/** `/swimmer/{id}/`, `/swimmer/{id}/times/`. */
function classifySwimmerPath(args: PathClassifyArgs): SwimCloudUrlClassification {
  const { input, segments, lower, canonicalPath, parsed, fetchable } = args;
  if (segments.length === 1) {
    return malformed(input, canonicalPath, 'swimmer', 'missing-id', 'Swimmer URL carries no swimmer id.');
  }
  const swimmerId = segments[1];
  if (!NUMERIC_ID.test(swimmerId)) {
    return malformed(
      input,
      canonicalPath,
      'swimmer',
      'invalid-id',
      `Swimmer id ${JSON.stringify(swimmerId)} is not a positive integer without leading zeros.`,
    );
  }
  if (segments.length === 2) {
    return fetchable({ kind: 'swimmer', swimmerId });
  }
  if (segments.length === 3 && lower[2] === 'times') {
    // `/swimmer/{id}/times/` — confirmed real 2026-09-09, and the only
    // swimmer sub-page any capture covers. It carries no query parameters
    // at all on the real capture, so none are modelled here.
    return fetchable({ kind: 'swimmerTimes', swimmerId });
  }
  return unrecognized(
    input,
    'unknown-path',
    `Swimmer sub-path ${canonicalPath} is not modelled. The real capture's nav lists /meets/, /standards/ and /rankings/ alongside /times/, but only /times/ has been captured, and this classifier does not model a pattern read off a nav bar.`,
    { canonicalPath, hostname: parsed.hostname },
  );
}

/** `/results/{meetId}/event/{n}/`, the `lower[2] === 'event'` arm of `classifyResultsPath`. */
function classifyMeetEventSubPath(
  args: PathClassifyArgs,
  meetId: SwimCloudMeetId,
): SwimCloudUrlClassification | undefined {
  const { input, segments, canonicalPath, fetchable } = args;
  if (segments.length === 3) {
    return malformed(
      input,
      canonicalPath,
      'meetEvent',
      'missing-event-ref',
      'Meet event URL carries no event reference.',
    );
  }
  const eventRef = segments[3];
  if (!NUMERIC_ID.test(eventRef)) {
    return malformed(
      input,
      canonicalPath,
      'meetEvent',
      'invalid-event-ref',
      `Event reference ${JSON.stringify(eventRef)} is not a positive integer without leading zeros.`,
    );
  }
  if (segments.length === 4) {
    return fetchable({ kind: 'meetEvent', meetId, eventRef });
  }
  // Falls through to the caller's final "not one of the modelled patterns"
  // outcome when there are extra segments past `{n}`, same as before.
  return undefined;
}

/** `/results/{meetId}/topteams/`, the `lower[2] === 'topteams'` arm. */
function classifyMeetTopTeamsSubPath(
  args: PathClassifyArgs,
  meetId: SwimCloudMeetId,
): SwimCloudUrlClassification {
  const { input, segments, canonicalPath, parsed, fetchable } = args;
  // `/results/{meetId}/topteams/` — confirmed real 2026-09-08. No id
  // segment beyond the meet; gender/sort are query params, same
  // convention as the meet root itself.
  if (segments.length === 3) {
    const raw = readQuery(parsed);
    const page = nonEmpty(raw['page']);
    const gender = nonEmpty(raw['gender']);
    const query: SwimCloudMeetTeamQuery = {
      ...(page === undefined ? {} : { page }),
      ...(gender === undefined ? {} : { gender }),
      raw,
    };
    return fetchable({ kind: 'meetTopTeams', meetId, query });
  }
  return unrecognized(
    input,
    'unknown-path',
    `Meet topteams sub-path ${canonicalPath} is not the modelled pattern (/results/{meetId}/topteams/).`,
    { canonicalPath, hostname: parsed.hostname },
  );
}

/** `/results/{meetId}/team/{teamId}/` and `.../swims/`, the `lower[2] === 'team'` arm. */
function classifyMeetTeamSubPath(args: PathClassifyArgs, meetId: SwimCloudMeetId): SwimCloudUrlClassification {
  const { input, segments, lower, canonicalPath, parsed, fetchable } = args;
  // Deliberately not folded into the `/team/{id}/...` branch above: the team id
  // is the *third* segment here, and the resource is a meet's page narrowed to
  // a team, not a team's own page. See `SwimCloudResource`'s `meetTeam` member
  // for why that distinction is worth two kinds.
  if (segments.length === 3) {
    return malformed(input, canonicalPath, 'meetTeam', 'missing-id', 'Meet team URL carries no team id.');
  }
  const teamId = segments[3];
  if (!NUMERIC_ID.test(teamId)) {
    return malformed(
      input,
      canonicalPath,
      'meetTeam',
      'invalid-id',
      `Team id ${JSON.stringify(teamId)} is not a positive integer without leading zeros.`,
    );
  }
  if (segments.length === 4 || (segments.length === 5 && lower[4] === 'swims')) {
    const raw = readQuery(parsed);
    const page = nonEmpty(raw['page']);
    const gender = nonEmpty(raw['gender']);
    const query: SwimCloudMeetTeamQuery = {
      ...(page === undefined ? {} : { page }),
      ...(gender === undefined ? {} : { gender }),
      raw,
    };
    return fetchable(
      segments.length === 4
        ? { kind: 'meetTeam', meetId, teamId, query }
        : { kind: 'meetTeamSwims', meetId, teamId, query },
    );
  }
  // `/swimmers/`, `/pb/` and `/sb/` are real sibling sub-pages (seen on
  // the real team-landing capture) and are deliberately left unmodelled:
  // nothing needs them yet, and inventing a pattern is what this
  // classifier's header forbids.
  return unrecognized(
    input,
    'unknown-path',
    `Meet team sub-path ${canonicalPath} is not one of the modelled patterns (/results/{meetId}/team/{teamId}/, /results/{meetId}/team/{teamId}/swims/).`,
    { canonicalPath, hostname: parsed.hostname },
  );
}

/** `/results/{meetId}/swimmer/{swimmerId}/`, the `lower[2] === 'swimmer'` arm. */
function classifyMeetSwimmerSubPath(
  args: PathClassifyArgs,
  meetId: SwimCloudMeetId,
): SwimCloudUrlClassification | undefined {
  const { input, segments, canonicalPath, fetchable } = args;
  if (segments.length === 3) {
    return malformed(
      input,
      canonicalPath,
      'meetSwimmer',
      'missing-id',
      'Meet swimmer URL carries no swimmer id.',
    );
  }
  const swimmerId = segments[3];
  if (!NUMERIC_ID.test(swimmerId)) {
    return malformed(
      input,
      canonicalPath,
      'meetSwimmer',
      'invalid-id',
      `Swimmer id ${JSON.stringify(swimmerId)} is not a positive integer without leading zeros.`,
    );
  }
  if (segments.length === 4) {
    return fetchable({ kind: 'meetSwimmer', meetId, swimmerId });
  }
  // Falls through to the caller's final "not one of the modelled patterns"
  // outcome, same as before.
  return undefined;
}

/** `/results/{meetId}/...` — meet root, event, topteams, team and swimmer sub-paths. */
function classifyResultsPath(args: PathClassifyArgs): SwimCloudUrlClassification {
  const { input, segments, lower, canonicalPath, parsed, fetchable } = args;
  if (segments.length === 1) {
    return malformed(input, canonicalPath, 'meet', 'missing-id', 'Meet URL carries no meet id.');
  }
  const meetId = segments[1] as SwimCloudMeetId;
  if (!NUMERIC_ID.test(meetId)) {
    return malformed(
      input,
      canonicalPath,
      'meet',
      'invalid-id',
      `Meet id ${JSON.stringify(meetId)} is not a positive integer without leading zeros.`,
    );
  }
  if (segments.length === 2) {
    return fetchable({ kind: 'meet', meetId });
  }
  if (lower[2] === 'event') {
    const result = classifyMeetEventSubPath(args, meetId);
    if (result !== undefined) return result;
  }
  if (lower[2] === 'topteams') {
    return classifyMeetTopTeamsSubPath(args, meetId);
  }
  if (lower[2] === 'team') {
    return classifyMeetTeamSubPath(args, meetId);
  }
  if (lower[2] === 'swimmer') {
    const result = classifyMeetSwimmerSubPath(args, meetId);
    if (result !== undefined) return result;
  }
  return unrecognized(
    input,
    'unknown-path',
    `Meet sub-path ${canonicalPath} is not one of the modelled patterns (/results/{meetId}/, /results/{meetId}/event/{n}/, /results/{meetId}/team/{teamId}/[swims/], /results/{meetId}/swimmer/{id}/).`,
    { canonicalPath, hostname: parsed.hostname },
  );
}

/** `/country/{country}/{level}/conference/{slug}/`. */
function classifyCountryPath(args: PathClassifyArgs): SwimCloudUrlClassification {
  const { input, segments, lower, canonicalPath, parsed, fetchable } = args;
  if (lower[3] === 'conference') {
    if (segments.length === 4) {
      return malformed(
        input,
        canonicalPath,
        'conference',
        'missing-slug',
        'Conference URL carries no conference slug.',
      );
    }
    const slug = segments[4];
    if (!CONFERENCE_SLUG.test(slug)) {
      return malformed(
        input,
        canonicalPath,
        'conference',
        'invalid-slug',
        `Conference slug ${JSON.stringify(slug)} is not of the accepted slug shape.`,
      );
    }
    if (segments.length === 5) {
      return fetchable({
        kind: 'conference',
        urlForm: 'country-scoped',
        slug,
        country: lower[1],
        level: lower[2],
      });
    }
  }
  return unrecognized(
    input,
    'unknown-path',
    `Country path ${canonicalPath} is not the modelled conference pattern (/country/{country}/{level}/conference/{slug}/).`,
    { canonicalPath, hostname: parsed.hostname },
  );
}

/** `/conference/{slug}/`. */
function classifyConferencePath(args: PathClassifyArgs): SwimCloudUrlClassification {
  const { input, segments, canonicalPath, parsed, fetchable } = args;
  if (segments.length === 1) {
    return malformed(
      input,
      canonicalPath,
      'conference',
      'missing-slug',
      'Conference URL carries no conference slug.',
    );
  }
  const slug = segments[1];
  if (!CONFERENCE_SLUG.test(slug)) {
    return malformed(
      input,
      canonicalPath,
      'conference',
      'invalid-slug',
      `Conference slug ${JSON.stringify(slug)} is not of the accepted slug shape.`,
    );
  }
  if (segments.length === 2) {
    return fetchable({ kind: 'conference', urlForm: 'short', slug });
  }
  return unrecognized(input, 'unknown-path', `Conference sub-path ${canonicalPath} is not modelled.`, {
    canonicalPath,
    hostname: parsed.hostname,
  });
}

/** Lookup table of the top-level keyword segments this classifier models. */
const PATH_CLASSIFIERS: Readonly<
  Record<string, (args: PathClassifyArgs) => SwimCloudUrlClassification>
> = {
  team: classifyTeamPath,
  swimmer: classifySwimmerPath,
  results: classifyResultsPath,
  country: classifyCountryPath,
  conference: classifyConferencePath,
};

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Classify a pasted string as a SwimCloud resource URL.
 *
 * Pure: no network, no clock, no globals beyond the standard `URL` parser.
 *
 * Accepted input shapes:
 * - a full URL — `https://www.swimcloud.com/team/633/`
 * - a scheme-less host form — `www.swimcloud.com/team/633/`
 * - a site-relative path — `/team/633/` (what a content script will have)
 *
 * Trailing slashes are optional everywhere; `/team/633` and `/team/633/` are the
 * same resource. Keyword segments match case-insensitively; ids and slugs are
 * preserved as written.
 *
 * @example
 * const c = classifySwimCloudUrl('https://www.swimcloud.com/results/193735/event/12/');
 * if (c.outcome === 'fetchable' && c.resource.kind === 'meetEvent') {
 *   c.resource.meetId;   // '193735'
 *   c.resource.eventRef; // '12'
 * }
 */
export function classifySwimCloudUrl(url: string): SwimCloudUrlClassification {
  const input = url;
  const parsed = parseInput(input);

  if (parsed === null) {
    return unrecognized(input, 'unparseable-url', 'Input is empty or is not a parseable URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return unrecognized(
      input,
      'unsupported-scheme',
      `Only http: and https: are supported; got ${parsed.protocol}`,
    );
  }

  if (!isSwimCloudHost(parsed.hostname)) {
    return unrecognized(
      input,
      'not-swimcloud-host',
      `Host ${parsed.hostname} is not swimcloud.com or a subdomain of it.`,
      { hostname: parsed.hostname },
    );
  }

  const segments = splitSegments(parsed.pathname);
  const lower = segments.map((segment) => segment.toLowerCase());
  // Reported on the non-fetchable outcomes, where there is no resource to
  // rebuild from. Lowercased so the message is stable regardless of how the
  // caller typed it.
  const canonicalPath = canonicalPathOf(lower);

  // robots.txt is checked FIRST and unconditionally. A denylisted path is a
  // recognized SwimCloud path whose answer is "no" — it must never fall through
  // to pattern matching, and a malformed id inside it must not downgrade it to
  // a softer outcome.
  const exemptSwimmerId = exemptSwimmerFastestTimesId(lower);
  const rule = exemptSwimmerId === undefined ? robotsRuleFor(segments) : null;
  if (rule !== null) {
    return {
      outcome: 'forbidden',
      input,
      canonicalPath,
      rule,
      source: 'robots.txt',
      detail: `robots.txt disallows ${rule} for User-agent: *; this path is never fetchable by any access track.`,
    };
  }

  if (segments.length === 0) {
    return unrecognized(input, 'unknown-path', 'The site root is not a modelled resource.', {
      canonicalPath,
      hostname: parsed.hostname,
    });
  }

  const fetchable = (resource: SwimCloudResource): SwimCloudUrlFetchable => {
    const resourcePath = canonicalPathForResource(resource);
    return {
      outcome: 'fetchable',
      input,
      canonicalPath: resourcePath,
      canonicalUrl: `https://${SWIMCLOUD_CANONICAL_HOST}${resourcePath}${parsed.search}`,
      resource,
    };
  };

  if (exemptSwimmerId !== undefined) {
    return fetchable({ kind: 'swimmerFastestTimes', swimmerId: exemptSwimmerId });
  }

  const classifyPath = PATH_CLASSIFIERS[lower[0]];
  if (classifyPath === undefined) {
    return unrecognized(
      input,
      'unknown-path',
      `Path ${canonicalPath} matches none of the modelled SwimCloud patterns.`,
      { canonicalPath, hostname: parsed.hostname },
    );
  }
  return classifyPath({ input, segments, lower, canonicalPath, parsed, fetchable });
}
