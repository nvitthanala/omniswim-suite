/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/swimcloud/src/targetUrls.ts`: pasted text to crawl targets.
 *
 * The four links in `USER_LINKS` are the exact links the user named on
 * 2026-10-03. No test here touches the network.
 */
import { describe, expect, it } from 'vitest';

import {
  SWIMCLOUD_ROBOTS_DISALLOW_RULES,
  parseCrawlTargetInput,
  type CrawlTargetRejectionReason,
} from '../packages/swimcloud/src/index';

const USER_LINKS = [
  'https://www.swimcloud.com/team/58/',
  'https://www.swimcloud.com/team/412/',
  'https://www.swimcloud.com/team/48/',
  'https://www.swimcloud.com/country/usa/college/conference/nsisc/',
];

const EXPECTED_USER_TARGETS = [
  { kind: 'team', teamId: '58' },
  { kind: 'team', teamId: '412' },
  { kind: 'team', teamId: '48' },
  { kind: 'conference', slug: 'nsisc', country: 'usa' },
];

function reasonFor(text: string): CrawlTargetRejectionReason | 'accepted' {
  const parsed = parseCrawlTargetInput(text);
  if (parsed.targets.length > 0) return 'accepted';
  expect(parsed.rejected).toHaveLength(1);
  expect(parsed.rejected[0].text).toBe(text);
  return parsed.rejected[0].reason;
}

describe('parseCrawlTargetInput with the user\'s four links', () => {
  it('parses them separated by newlines', () => {
    expect(parseCrawlTargetInput(USER_LINKS.join('\n'))).toStrictEqual({
      targets: EXPECTED_USER_TARGETS,
      rejected: [],
    });
  });

  it('parses them separated by spaces, commas, or a mix, with stray blanks', () => {
    for (const text of [
      USER_LINKS.join(' '),
      USER_LINKS.join(','),
      USER_LINKS.join(', '),
      `  ${USER_LINKS[0]},\n\n${USER_LINKS[1]} \t ${USER_LINKS[2]}\r\n${USER_LINKS[3]},  `,
    ]) {
      expect(parseCrawlTargetInput(text)).toStrictEqual({ targets: EXPECTED_USER_TARGETS, rejected: [] });
    }
  });

  it('returns nothing, and no rejection, for empty text', () => {
    expect(parseCrawlTargetInput('')).toStrictEqual({ targets: [], rejected: [] });
    expect(parseCrawlTargetInput(' \n , ,\t')).toStrictEqual({ targets: [], rejected: [] });
  });
});

describe('team links', () => {
  it('normalises sub-pages and queries to the team id', () => {
    for (const link of [
      'https://www.swimcloud.com/team/412',
      'https://www.swimcloud.com/team/412/roster/',
      'https://www.swimcloud.com/team/412/roster/?gender=F',
      'https://www.swimcloud.com/team/412/roster/?page=1&gender=F&season_id=29&sort=name',
      'https://www.swimcloud.com/team/412/results/',
      'https://www.swimcloud.com/team/412/results/?year=2025#top',
      'https://www.swimcloud.com/Team/412/Roster/',
      'https://swimcloud.com/team/412/',
    ]) {
      expect(parseCrawlTargetInput(link)).toStrictEqual({ targets: [{ kind: 'team', teamId: '412' }], rejected: [] });
    }
  });

  it('accepts http and normalises it, but only on the exact SwimCloud hosts', () => {
    expect(parseCrawlTargetInput('http://www.swimcloud.com/team/58/').targets).toStrictEqual([{ kind: 'team', teamId: '58' }]);
    expect(parseCrawlTargetInput('http://swimcloud.com/team/58/').targets).toStrictEqual([{ kind: 'team', teamId: '58' }]);
    expect(reasonFor('http://m.swimcloud.com/team/58/')).toBe('wrong-host');
    expect(reasonFor('http://evil.example/team/58/')).toBe('wrong-host');
  });

  it('rejects other hosts, look-alike hosts, logins and ports', () => {
    for (const link of [
      'https://example.com/team/58/',
      'https://swimcloud.com.evil.example/team/58/',
      'https://evil.example/www.swimcloud.com/team/58/',
      'https://www.swimcloud.com@evil.example/team/58/',
      'https://user:pw@www.swimcloud.com/team/58/',
      'https://www.swimcloud.com:8443/team/58/',
      'https://www.swimcloud.org/team/58/',
      'https://fakeswimcloud.com/team/58/',
    ]) {
      expect(reasonFor(link)).toBe('wrong-host');
    }
  });

  it('rejects non-numeric, zero-led, signed and missing team ids', () => {
    for (const link of [
      'https://www.swimcloud.com/team/abc/',
      'https://www.swimcloud.com/team/58a/',
      'https://www.swimcloud.com/team/058/',
      'https://www.swimcloud.com/team/0/',
      'https://www.swimcloud.com/team/-5/',
      'https://www.swimcloud.com/team/',
      'https://www.swimcloud.com/team',
    ]) {
      expect(reasonFor(link)).toBe('invalid-team-id');
    }
  });

  it('keeps long numeric ids as strings without loss', () => {
    expect(parseCrawlTargetInput('https://www.swimcloud.com/team/10002824/').targets).toStrictEqual([
      { kind: 'team', teamId: '10002824' },
    ]);
  });
});

describe('conference links', () => {
  it('records the slug exactly as the link wrote it and the country segment', () => {
    expect(parseCrawlTargetInput('https://www.swimcloud.com/country/usa/college/conference/nsisc/').targets).toStrictEqual([
      { kind: 'conference', slug: 'nsisc', country: 'usa' },
    ]);
    expect(parseCrawlTargetInput('https://www.swimcloud.com/country/can/college/conference/OUA').targets).toStrictEqual([
      { kind: 'conference', slug: 'OUA', country: 'can' },
    ]);
    expect(parseCrawlTargetInput('https://www.swimcloud.com/country/usa/college/conference/pac-12/?x=1').targets).toStrictEqual([
      { kind: 'conference', slug: 'pac-12', country: 'usa' },
    ]);
  });

  it('does not default a country for the short /conference/{slug}/ form', () => {
    expect(reasonFor('https://www.swimcloud.com/conference/nsisc/')).toBe('unsupported');
  });

  it('rejects a conference link with no slug, a bad slug, a different level or extra path', () => {
    expect(reasonFor('https://www.swimcloud.com/country/usa/college/conference/')).toBe('unsupported');
    expect(reasonFor('https://www.swimcloud.com/country/usa/college/conference/ns%20isc/')).toBe('invalid-conference-slug');
    expect(reasonFor('https://www.swimcloud.com/country/usa/club/conference/nsisc/')).toBe('unsupported');
    expect(reasonFor('https://www.swimcloud.com/country/usa/college/conference/nsisc/teams/')).toBe('unsupported');
    expect(reasonFor('https://www.swimcloud.com/country/usa/')).toBe('unsupported');
  });
});

describe('the robots denylist', () => {
  it('rejects every denylisted path as denylisted, for every rule the classifier carries', () => {
    expect(SWIMCLOUD_ROBOTS_DISALLOW_RULES).toStrictEqual(['/api/', '/jsonapi/', '/team/*/facilities/', '/tz_detect/']);
    for (const link of [
      'https://www.swimcloud.com/api/',
      'https://www.swimcloud.com/api/teams/58/',
      'https://www.swimcloud.com/jsonapi/team/58/',
      'https://www.swimcloud.com/team/58/facilities/',
      'https://www.swimcloud.com/team/58/facilities/?x=1',
      'https://www.swimcloud.com/tz_detect/',
      'https://www.swimcloud.com/API/teams/',
    ]) {
      expect(reasonFor(link)).toBe('denylisted');
    }
  });

  it('rejects a denylisted path even when its team id is not numeric', () => {
    expect(reasonFor('https://www.swimcloud.com/team/abc/facilities/')).toBe('denylisted');
  });

  it('rejects the one /api/ path the app fetches by decision: it is not a crawl target', () => {
    expect(reasonFor('https://www.swimcloud.com/api/swimmers/1472365/profile_fastest_times/')).toBe('denylisted');
  });
});

describe('other paths', () => {
  it('rejects SwimCloud pages that are neither a team nor a conference as unsupported', () => {
    for (const link of [
      'https://www.swimcloud.com/',
      'https://www.swimcloud.com/results/356467/',
      'https://www.swimcloud.com/swimmer/1472365/',
      'https://www.swimcloud.com/swimmer/1472365/times/',
      'https://www.swimcloud.com/feed/',
    ]) {
      expect(reasonFor(link)).toBe('unsupported');
    }
  });

  it('rejects text that is not an http(s) URL', () => {
    for (const text of ['hello', 'www.swimcloud.com/team/58/', '/team/58/', 'ftp://www.swimcloud.com/team/58/', 'javascript:alert(1)', 'team58']) {
      expect(reasonFor(text)).toBe('not-a-url');
    }
  });
});

describe('dedupe and mixed input', () => {
  it('keeps one target per team id and one per conference slug, first occurrence first', () => {
    const text = [
      'https://www.swimcloud.com/team/412/roster/',
      'https://www.swimcloud.com/team/58/',
      'https://www.swimcloud.com/team/412/',
      'https://www.swimcloud.com/country/usa/college/conference/nsisc/',
      'https://www.swimcloud.com/team/58/results/',
      'https://www.swimcloud.com/country/usa/college/conference/nsisc/',
    ].join('\n');
    expect(parseCrawlTargetInput(text)).toStrictEqual({
      targets: [
        { kind: 'team', teamId: '412' },
        { kind: 'team', teamId: '58' },
        { kind: 'conference', slug: 'nsisc', country: 'usa' },
      ],
      rejected: [],
    });
  });

  it('does not treat a team id equal to a conference slug as the same target', () => {
    const parsed = parseCrawlTargetInput(
      'https://www.swimcloud.com/team/58/ https://www.swimcloud.com/country/usa/college/conference/58/',
    );
    expect(parsed.targets).toHaveLength(2);
  });

  it('reports each rejected token verbatim, in order, beside the targets that did parse', () => {
    const parsed = parseCrawlTargetInput(
      'https://www.swimcloud.com/team/58/ nonsense https://evil.example/team/1/ https://www.swimcloud.com/team/412/ https://www.swimcloud.com/api/x/',
    );
    expect(parsed.targets).toStrictEqual([
      { kind: 'team', teamId: '58' },
      { kind: 'team', teamId: '412' },
    ]);
    expect(parsed.rejected).toStrictEqual([
      { text: 'nonsense', reason: 'not-a-url' },
      { text: 'https://evil.example/team/1/', reason: 'wrong-host' },
      { text: 'https://www.swimcloud.com/api/x/', reason: 'denylisted' },
    ]);
  });
});
