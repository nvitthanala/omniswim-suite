/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The extra SwimCloud requests the overlay may make, and the only place that builds their URLs
 * (D7 section 3). Pure: this file imports nothing, so the overlay, the docked panel and tests share it.
 *
 * Every path here is same-origin, a plain GET, and one of two shapes: a team-window simulator call
 * (recon item 5) or a team roster page (packages/swimcloud/src/crawlPlan.ts, teamRosterUrl and
 * teamSeasonRosterUrl). `targetForPath` is the inverse. The queue refuses any target whose path does
 * not survive `fetchPathFor` then `targetForPath` then `fetchPathFor` unchanged, so it can never send
 * a URL this file did not build.
 */

export type SimGender = 'M' | 'F';

/** `GET /api/teams/{id}/simulator/`, the same call the simulator page makes, for another window or course. */
export type TeamWindowTarget = {
  readonly kind: 'team-window';
  readonly teamId: string;
  readonly gender: SimGender;
  readonly course: 'Y' | 'L';
  readonly from: string;
  readonly to: string;
  readonly timeToUse: 'fastest' | 'average';
};

/** `GET /team/{id}/roster/`. `season` is the server's current season, or an option the page's own `<select name="season_id">` listed. */
export type RosterTarget = {
  readonly kind: 'team-roster';
  readonly teamId: string;
  readonly gender: SimGender;
  readonly season: { readonly kind: 'server-current' } | { readonly kind: 'option'; readonly value: string; readonly label: string };
};

export type FetchTarget = TeamWindowTarget | RosterTarget;
export type FetchFeature = 'roster' | 'lcm' | 'split-window' | 'extended-window';
export const FETCH_FEATURES: readonly FetchFeature[] = ['roster', 'lcm', 'split-window', 'extended-window'];

/** Minimum gap between two request starts, retries included. Copied from legacy/extensions/swimcloud-companion/src/crawlPacing.ts:14 (`MIN_DELAY_MS`). */
export const FETCH_MIN_DELAY_MS = 3000;
/** Retries after a 429 before the run stops. Copied from legacy/extensions/swimcloud-companion/src/rateLimitBackoff.ts:47 (`MAX_RATE_LIMIT_RETRIES`). */
export const FETCH_MAX_RETRIES = 3;
/** First backoff step. Copied from legacy/extensions/swimcloud-companion/src/rateLimitBackoff.ts:56 (`BASE_BACKOFF_MS`). */
export const FETCH_BASE_BACKOFF_MS = 3000;
/** Longest wait for one retry. Copied from legacy/extensions/swimcloud-companion/src/rateLimitBackoff.ts:59 (`MAX_BACKOFF_MS`). */
export const FETCH_MAX_BACKOFF_MS = 60000;
/** The Web Lock that keeps two tabs from fetching at once. */
export const FETCH_LOCK_NAME = 'omniswim-swimcloud-fetch';

/** How long `requests` requests take at the pacing floor, ignoring the time each response takes: (n - 1) * 3000. Zero for none. */
export function runEstimateMs(requests: number): number {
  return Math.max(0, requests - 1) * FETCH_MIN_DELAY_MS;
}

const TEAM_ID = /^[1-9]\d{0,9}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A `season_id` option value. The page's numeric ids are not proven site-wide (teamSeasons.ts), so any short token with no character that needs URL encoding passes. */
const SEASON_VALUE = /^[0-9A-Za-z_-]{1,16}$/;
const GENDERS: readonly string[] = ['M', 'F'];
/** A real calendar date. `Date.parse('2026-02-30')` is not an error in V8, so the text is compared after the round trip. */
const isRealDate = (v: string): boolean => ISO_DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function need(ok: boolean, what: string): void {
  if (!ok) throw new RangeError(`fetchPathFor: bad ${what}`);
}

/** The path and query for a target. Throws a `RangeError` for a field that is not a plain token. The only URL builder. */
export function fetchPathFor(t: FetchTarget): string {
  need(TEAM_ID.test(t.teamId), 'teamId');
  need(GENDERS.includes(t.gender), 'gender');
  if (t.kind === 'team-window') {
    need(t.course === 'Y' || t.course === 'L', 'course');
    need(isRealDate(t.from), 'from');
    need(isRealDate(t.to), 'to');
    need(t.timeToUse === 'fastest' || t.timeToUse === 'average', 'timeToUse');
    return `/api/teams/${t.teamId}/simulator/?start_date=${t.from}&end_date=${t.to}&eventgender=${t.gender}&eventcourse=${t.course}&divecourse=6&time_to_use=${t.timeToUse}`;
  }
  if (t.season.kind === 'server-current') return `/team/${t.teamId}/roster/?gender=${t.gender}`;
  need(SEASON_VALUE.test(t.season.value), 'season value');
  return `/team/${t.teamId}/roster/?page=1&gender=${t.gender}&season_id=${t.season.value}&sort=name`;
}

const WINDOW_PATH = /^\/api\/teams\/(\d+)\/simulator\/\?start_date=([^&]*)&end_date=([^&]*)&eventgender=([^&]*)&eventcourse=([^&]*)&divecourse=6&time_to_use=([^&]*)$/;
const ROSTER_CURRENT_PATH = /^\/team\/(\d+)\/roster\/\?gender=([^&]*)$/;
const ROSTER_SEASON_PATH = /^\/team\/(\d+)\/roster\/\?page=1&gender=([^&]*)&season_id=([^&]*)&sort=name$/;

/**
 * The inverse of `fetchPathFor`. `null` for anything else: another path, another key order, an extra
 * key, or a value that needs encoding. A chosen-season roster path does not carry the season label, so
 * the target it returns has `label: ''`. Callers compare paths, not targets.
 */
export function targetForPath(path: string): FetchTarget | null {
  let target: FetchTarget | null = null;
  let m: RegExpMatchArray | null;
  if ((m = WINDOW_PATH.exec(path))) {
    target = { kind: 'team-window', teamId: m[1]!, from: m[2]!, to: m[3]!, gender: m[4] as SimGender, course: m[5] as 'Y' | 'L', timeToUse: m[6] as 'fastest' | 'average' };
  } else if ((m = ROSTER_CURRENT_PATH.exec(path))) {
    target = { kind: 'team-roster', teamId: m[1]!, gender: m[2] as SimGender, season: { kind: 'server-current' } };
  } else if ((m = ROSTER_SEASON_PATH.exec(path))) {
    target = { kind: 'team-roster', teamId: m[1]!, gender: m[2] as SimGender, season: { kind: 'option', value: m[3]!, label: '' } };
  }
  if (!target) return null;
  try {
    // The regexes only locate fields. Rebuilding the path applies every field check and the exact spelling.
    return fetchPathFor(target) === path ? target : null;
  } catch {
    return null;
  }
}

/** The path for a target, or `null` when the target is malformed or its path would not round-trip. Used by the queue to refuse. */
export function roundTripPath(t: FetchTarget): string | null {
  try {
    const path = fetchPathFor(t);
    const back = targetForPath(path);
    return back && fetchPathFor(back) === path ? path : null;
  } catch {
    return null;
  }
}
