/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A conference home page: `/country/usa/college/conference/{slug}/`.
 *
 * ## This page is not the member list
 *
 * The real capture (`tests/fixtures/swimcloud-real-conference-nsisc.html`) is
 * the conference **home** page. It names teams only incidentally: the team
 * logo beside a top swim, the team link under a commitment, the team link
 * under a top swimmer. The three teams it links (58, 48, 412) are the teams
 * that happened to have a top swim, a commitment or a top swimmer this week.
 * It does not list every team. The member list is on the Teams tab, which this
 * page links (`.../conference/nsisc/teams/`) and no capture of it exists yet.
 *
 * So the result carries `complete: false` as a literal type, and every
 * successful parse carries a `conference-teams-list-incomplete` warning. A
 * caller must fetch the Teams tab before treating any set of teams as the
 * conference's members. Teams named only in a meet title ("Alabama vs Delta
 * State") have no team link here and are not extracted.
 *
 * ## Fail loudly
 *
 * - The capture URL must be a conference URL, and the page's canonical link
 *   must name the same slug, or the parse fails (`source-url-mismatch`).
 * - A page with no section headings and no Teams-tab link is not this page
 *   (a Cloudflare challenge page looks like that) and fails
 *   (`expected-structure-missing`).
 * - A missing display name, a missing Teams-tab link and a page with no team
 *   links each raise a warning and leave the field absent. Nothing is rebuilt
 *   from the slug or guessed.
 *
 * Pure: no network, no DOM, no clock.
 */

import { collapseWhitespace, decodeHtmlEntities, htmlToText, stripNonContent } from './html';
import { fail, succeed } from './parser';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parser';
import { SWIMCLOUD_CANONICAL_HOST, classifySwimCloudUrl } from './urlClassifier';

const REAL_CAPTURE = 'real-capture-verified' as const;

/** Where on the page a team was seen: the nearest section heading above the link. */
export interface SwimCloudConferenceTeamSighting {
  /** The heading text, verbatim (`'Top swims'`, `'Commitments'`). Absent for a link before the first heading. */
  readonly section?: string;
  /** How many links to this team sit under that heading. */
  readonly count: number;
}

/** A team the page mentions with a team link. */
export interface SwimCloudConferenceTeamMention {
  readonly teamId: string;
  /** Distinct printed names, from the link's `title` or its text, in order first seen. Image `alt` text is not used. */
  readonly names: readonly string[];
  /** One entry per section, in order first seen. */
  readonly sightings: readonly SwimCloudConferenceTeamSighting[];
  /** Total team links to this team on the page. */
  readonly linkCount: number;
}

/** What {@link parseConferenceHomeHtml} returns. */
export interface SwimCloudConferenceHome {
  readonly kind: 'conference-home';
  /** From the capture URL, lower-cased. */
  readonly slug: string;
  /** `usa`, from a country-scoped capture URL. Absent for the short `/conference/{slug}/` form. */
  readonly country?: string;
  /** `college`, same rule as `country`. */
  readonly level?: string;
  /** The `<title>` before ` | Swimcloud`: `'New South'`. Absent when the title has no such shape. */
  readonly displayName?: string;
  /** Absolute URL of the page's own Teams tab link. Absent when the page has none; never rebuilt from the slug. */
  readonly teamsTabUrl?: string;
  /**
   * Always `false`. This page is not the member list; see the file header.
   * A literal type so no code path can set it to true.
   */
  readonly complete: false;
  /** Teams this page links, in order first seen. A subset of the conference's teams, of unknown size. */
  readonly mentionedTeams: readonly SwimCloudConferenceTeamMention[];
}

function attr(tagAttrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tagAttrs);
  if (match === null) return undefined;
  return decodeHtmlEntities(match[2] ?? match[3] ?? '');
}

function conferenceSlugOf(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const c = classifySwimCloudUrl(href);
  if (c.outcome !== 'fetchable' || c.resource.kind !== 'conference') return undefined;
  return c.resource.slug.toLowerCase();
}

function absoluteUrl(href: string): string {
  return /^https?:\/\//i.test(href) ? href : `https://${SWIMCLOUD_CANONICAL_HOST}${href.startsWith('/') ? '' : '/'}${href}`;
}

function readDisplayName(content: string): string | undefined {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content);
  if (title === null) return undefined;
  const hit = /^(.+?)\s*\|\s*Swimcloud$/i.exec(htmlToText(title[1] ?? ''));
  return hit === null || (hit[1] ?? '').trim().length === 0 ? undefined : (hit[1] ?? '').trim();
}

function readTeamsTabHref(content: string, slug: string): string | undefined {
  const pattern = new RegExp(`/conference/${slug}/teams/?$`, 'i');
  for (const m of content.matchAll(/<a\b([^>]*)>/gi)) {
    const href = attr(m[1] ?? '', 'href');
    if (href === undefined) continue;
    const path = href.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '';
    if (pattern.test(path)) return href;
  }
  return undefined;
}

interface Heading {
  readonly at: number;
  readonly text: string;
}

function readSectionHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  for (const m of content.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)) {
    const classes = (attr(m[2] ?? '', 'class') ?? '').split(/\s+/);
    if (!classes.includes('c-section__title')) continue;
    out.push({ at: m.index ?? 0, text: htmlToText(m[3] ?? '') });
  }
  return out;
}

interface TeamAccumulator {
  names: string[];
  sections: Map<string, { section?: string; count: number }>;
  linkCount: number;
}

function readMentions(content: string, headings: readonly Heading[]): SwimCloudConferenceTeamMention[] {
  const byTeam = new Map<string, TeamAccumulator>();
  for (const m of content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1] ?? '', 'href');
    if (href === undefined) continue;
    const c = classifySwimCloudUrl(href);
    if (c.outcome !== 'fetchable' || !('teamId' in c.resource)) continue;
    const teamId = c.resource.teamId;
    const at = m.index ?? 0;
    const heading = [...headings].reverse().find((h) => h.at < at);
    const entry: TeamAccumulator = byTeam.get(teamId) ?? { names: [], sections: new Map(), linkCount: 0 };
    byTeam.set(teamId, entry);
    entry.linkCount += 1;
    for (const raw of [attr(m[1] ?? '', 'title'), htmlToText(m[2] ?? '')]) {
      const name = raw === undefined ? '' : collapseWhitespace(raw);
      if (name.length > 0 && !entry.names.includes(name)) entry.names.push(name);
    }
    const key = heading?.text ?? '';
    const sighting = entry.sections.get(key) ?? { ...(heading === undefined ? {} : { section: heading.text }), count: 0 };
    sighting.count += 1;
    entry.sections.set(key, sighting);
  }
  return [...byTeam].map(([teamId, e]) => ({
    teamId,
    names: e.names,
    sightings: [...e.sections.values()],
    linkCount: e.linkCount,
  }));
}

/**
 * Parse a conference home page. See the file header: the result is **never**
 * the member list, and says so in `complete` and in a warning.
 */
export function parseConferenceHomeHtml(
  html: string,
  context: SwimCloudParseContext,
): SwimCloudParseResult<SwimCloudConferenceHome> {
  if (html.trim().length === 0) return fail(context, 'empty-input', 'The HTML input is empty.', [], REAL_CAPTURE);
  const classification = classifySwimCloudUrl(context.sourceUrl);
  if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'conference') {
    return fail(context, 'source-url-mismatch', `Source URL ${context.sourceUrl} is not a conference home URL.`, [], REAL_CAPTURE);
  }
  const resource = classification.resource;
  const slug = resource.slug.toLowerCase();
  const content = stripNonContent(html);

  const canonical = /<link\b([^>]*)>/gi;
  for (const m of content.matchAll(canonical)) {
    if ((attr(m[1] ?? '', 'rel') ?? '').toLowerCase() !== 'canonical') continue;
    const canonicalSlug = conferenceSlugOf(attr(m[1] ?? '', 'href'));
    if (canonicalSlug !== undefined && canonicalSlug !== slug) {
      return fail(context, 'source-url-mismatch', `Source URL names conference ${slug} but the page's canonical link names ${canonicalSlug}.`, [], REAL_CAPTURE);
    }
  }

  const headings = readSectionHeadings(content);
  const teamsTabHref = readTeamsTabHref(content, slug);
  if (headings.length === 0 && teamsTabHref === undefined) {
    return fail(context, 'expected-structure-missing', 'No section headings and no Teams-tab link: this is not a conference home page (a challenge or error page looks like this).', [], REAL_CAPTURE);
  }

  const warnings: SwimCloudParseWarning[] = [
    {
      code: 'conference-teams-list-incomplete',
      message: `This is the conference home page, not the Teams tab. It names teams only incidentally (top swims, commitments, top swimmers), so mentionedTeams is a subset of unknown size and is not the member list. Fetch ${teamsTabHref === undefined ? 'the Teams tab' : absoluteUrl(teamsTabHref)} for members.`,
    },
  ];
  const displayName = readDisplayName(content);
  if (displayName === undefined) {
    warnings.push({ code: 'conference-name-absent', message: 'The page title has no "{name} | Swimcloud" shape; displayName left absent.' });
  }
  if (teamsTabHref === undefined) {
    warnings.push({ code: 'conference-teams-tab-absent', message: 'The page links no Teams tab; teamsTabUrl left absent, not rebuilt from the slug.' });
  }
  const mentionedTeams = readMentions(content, headings);
  if (mentionedTeams.length === 0) {
    warnings.push({ code: 'conference-no-team-mentions', message: 'The page links no team. That is a gap in this page, not a statement that the conference has no teams.' });
  }

  const data: SwimCloudConferenceHome = {
    kind: 'conference-home',
    slug,
    ...(resource.urlForm === 'country-scoped' ? { country: resource.country, level: resource.level } : {}),
    ...(displayName === undefined ? {} : { displayName }),
    ...(teamsTabHref === undefined ? {} : { teamsTabUrl: absoluteUrl(teamsTabHref) }),
    complete: false,
    mentionedTeams,
  };
  return succeed(context, data, warnings, REAL_CAPTURE);
}
