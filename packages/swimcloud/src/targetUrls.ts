/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Turns pasted text into crawl targets: SwimCloud teams and conferences.
 *
 * The user pastes one or many links. Links may be split by newlines, spaces or
 * commas. Each link becomes a target or a named rejection. Nothing is dropped
 * without a line saying why, except a repeat of a target already in the list.
 *
 * ## The denylist is not duplicated here
 *
 * `classifySwimCloudUrl` in `./urlClassifier.ts` already enforces the robots.txt
 * list (`/api/`, `/jsonapi/`, `/team/{@literal *}/facilities/`, `/tz_detect/`)
 * and answers `forbidden` before any pattern match. This module asks it first.
 * The one `/api/` path the app fetches by the user's decision
 * (`/api/swimmers/{id}/profile_fastest_times/`) classifies as fetchable there.
 * It is still under `/api/`, so a pasted target link to it is `denylisted` here.
 *
 * Pure: no network, no DOM, no clock.
 */

import type { SwimCloudConferenceSlug, SwimCloudTeamId } from './entities';
import { SWIMCLOUD_APEX_HOST, SWIMCLOUD_CANONICAL_HOST, classifySwimCloudUrl } from './urlClassifier';

/** A team to crawl. Any `/team/{id}/...` link normalises to this. */
export interface SwimCloudTeamTarget {
  readonly kind: 'team';
  readonly teamId: SwimCloudTeamId;
}

/** A conference whose member teams are to be found. Built from `/country/{country}/college/conference/{slug}/`. */
export interface SwimCloudConferenceTarget {
  readonly kind: 'conference';
  /** The slug, lower-cased, for example `nsisc` for a link that wrote `NSISC`. */
  readonly slug: SwimCloudConferenceSlug;
  /** The country segment of the link, lowercased, for example `usa`. */
  readonly country: string;
}

export type CrawlTarget = SwimCloudTeamTarget | SwimCloudConferenceTarget;

export type CrawlTargetRejectionReason =
  /** Not an `http://` or `https://` URL. */
  | 'not-a-url'
  /** The host is not exactly `www.swimcloud.com` or `swimcloud.com`, or the link carries a port or a login. */
  | 'wrong-host'
  /** A path the robots.txt denylist covers. */
  | 'denylisted'
  /** `/team/` with no id, or an id that is not a positive integer without leading zeros. */
  | 'invalid-team-id'
  /** A conference link whose slug is not of the accepted shape. */
  | 'invalid-conference-slug'
  /** Any other SwimCloud path. */
  | 'unsupported';

export interface CrawlTargetRejection {
  /** The pasted token, verbatim. */
  readonly text: string;
  readonly reason: CrawlTargetRejectionReason;
}

export interface CrawlTargetParse {
  /** Teams and conferences in first-seen order, one per team id and one per country and slug. */
  readonly targets: readonly CrawlTarget[];
  readonly rejected: readonly CrawlTargetRejection[];
}

const TOKEN_SEPARATOR = /[\s,]+/;
const HTTP_URL = /^https?:\/\//i;
const TEAM_ID = /^[1-9][0-9]{0,17}$/;

function hostIsSwimCloud(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const exactHost = host === SWIMCLOUD_CANONICAL_HOST || host === SWIMCLOUD_APEX_HOST;
  return exactHost && url.port === '' && url.username === '' && url.password === '';
}

type SingleParse =
  | { readonly target: CrawlTarget }
  | { readonly reason: CrawlTargetRejectionReason };

function parseTeamPath(segments: readonly string[]): SingleParse {
  const teamId = segments[1];
  if (teamId === undefined || !TEAM_ID.test(teamId)) return { reason: 'invalid-team-id' };
  // Only the id is kept, so any sub-page of a team (roster, results, ...) names the same team.
  // Denylisted sub-pages such as /facilities/ were rejected before this point.
  return { target: { kind: 'team', teamId } };
}

function parseConferenceLink(token: string): SingleParse {
  const classified = classifySwimCloudUrl(token);
  if (classified.outcome === 'malformed' && classified.kind === 'conference') {
    return { reason: classified.reason === 'invalid-slug' ? 'invalid-conference-slug' : 'unsupported' };
  }
  if (classified.outcome !== 'fetchable' || classified.resource.kind !== 'conference') {
    return { reason: 'unsupported' };
  }
  const resource = classified.resource;
  // `/conference/{slug}/` names no country, and a country is part of the identity
  // this target records. It is not defaulted to `usa`.
  if (resource.urlForm !== 'country-scoped' || resource.level !== 'college') return { reason: 'unsupported' };
  // Case is not identity: `NSISC` and `nsisc` name one conference. The country is.
  return { target: { kind: 'conference', slug: resource.slug.toLowerCase(), country: resource.country.toLowerCase() } };
}

function parseOneToken(token: string): SingleParse {
  if (!HTTP_URL.test(token)) return { reason: 'not-a-url' };
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return { reason: 'not-a-url' };
  }
  if (!hostIsSwimCloud(url)) return { reason: 'wrong-host' };

  const classified = classifySwimCloudUrl(token);
  if (classified.outcome === 'forbidden') return { reason: 'denylisted' };
  if (classified.outcome === 'fetchable' && classified.resource.kind === 'swimmerFastestTimes') {
    return { reason: 'denylisted' };
  }

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const first = segments[0]?.toLowerCase();
  if (first === 'team') return parseTeamPath(segments);
  if (first === 'country') return parseConferenceLink(token);
  return { reason: 'unsupported' };
}

/**
 * Parse pasted text into crawl targets.
 *
 * - Splits on newlines, spaces and commas.
 * - Accepts `https://` and `http://` links whose host is exactly
 *   `www.swimcloud.com` or `swimcloud.com`.
 * - `/team/{id}/` and any team sub-page, with or without a query, become
 *   `{ kind: 'team', teamId }`.
 * - `/country/{country}/college/conference/{slug}/` becomes
 *   `{ kind: 'conference', slug, country }`.
 * - Everything else is in `rejected` with a reason. Nothing is guessed.
 * - A team id seen twice, or a conference (lower-cased slug plus country) seen
 *   twice, is kept once, at its first position. The slug is lower-cased in the output.
 */
export function parseCrawlTargetInput(text: string): CrawlTargetParse {
  const targets: CrawlTarget[] = [];
  const rejected: CrawlTargetRejection[] = [];
  const seenTeams = new Set<string>();
  const seenConferences = new Set<string>();

  for (const token of text.split(TOKEN_SEPARATOR)) {
    if (token.length === 0) continue;
    const parsed = parseOneToken(token);
    if ('reason' in parsed) {
      rejected.push({ text: token, reason: parsed.reason });
      continue;
    }
    const target = parsed.target;
    const seen = target.kind === 'team' ? seenTeams : seenConferences;
    // A conference is the lower-cased slug in one country. The same slug in another country is another target.
    const key = target.kind === 'team' ? target.teamId : `${target.country}/${target.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return { targets, rejected };
}
