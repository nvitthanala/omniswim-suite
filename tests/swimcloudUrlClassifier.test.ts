/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * URL classifier tests.
 *
 * These assert the *classifier's* behaviour, not SwimCloud's. The patterns
 * under test are transcribed from `plans/2026-09-06/02-data-model-and-scoring.md`
 * §1, whose own sourcing is prior-art scraper code and search results — no
 * live fetch has ever confirmed them (open question 2 in
 * `plans/2026-09-06/04-phasing.md`). A green suite here means "we classify the
 * patterns we believe in, consistently and without guessing"; it does not mean
 * the patterns are right.
 */
import { describe, expect, it } from 'vitest';

import {
  SWIMCLOUD_ROBOTS_DISALLOW_RULES,
  canonicalPathForResource,
  classifySwimCloudUrl,
  isFetchableSwimCloudUrl,
  isForbiddenSwimCloudUrl,
  isSwimCloudHost,
  type SwimCloudResource,
  type SwimCloudUrlClassification,
} from '../packages/swimcloud/src/index';

const BASE = 'https://www.swimcloud.com';

function resourceOf(classification: SwimCloudUrlClassification): SwimCloudResource {
  if (classification.outcome !== 'fetchable') {
    throw new Error(
      `expected fetchable, got ${classification.outcome}: ${JSON.stringify(classification)}`,
    );
  }
  return classification.resource;
}

describe('classifySwimCloudUrl — the six documented patterns', () => {
  it('recognizes a team page', () => {
    const resource = resourceOf(classifySwimCloudUrl(`${BASE}/team/10028935/`));
    expect(resource).toStrictEqual({ kind: 'team', teamId: '10028935' });
  });

  it('recognizes a team roster with its documented query parameters', () => {
    const classification = classifySwimCloudUrl(
      `${BASE}/team/633/roster/?page=2&gender=F&season_id=27`,
    );
    expect(resourceOf(classification)).toStrictEqual({
      kind: 'teamRoster',
      teamId: '633',
      query: {
        page: '2',
        gender: 'F',
        seasonId: '27',
        raw: { page: '2', gender: 'F', season_id: '27' },
      },
    });
  });

  it('recognizes a team meet list', () => {
    const classification = classifySwimCloudUrl(`${BASE}/team/633/results/?page=&year=2026`);
    expect(resourceOf(classification)).toStrictEqual({
      kind: 'teamResults',
      teamId: '633',
      // `page=` is present-but-empty. It is reported as unset on the typed field
      // and still visible in `raw` — "present and blank" is not "absent".
      query: { year: '2026', raw: { page: '', year: '2026' } },
    });
  });

  it('recognizes a swimmer page', () => {
    expect(resourceOf(classifySwimCloudUrl(`${BASE}/swimmer/3646504/`))).toStrictEqual({
      kind: 'swimmer',
      swimmerId: '3646504',
    });
  });

  it('recognizes a meet results page', () => {
    expect(resourceOf(classifySwimCloudUrl(`${BASE}/results/193735/`))).toStrictEqual({
      kind: 'meet',
      meetId: '193735',
    });
  });

  it('recognizes a per-event meet results page', () => {
    expect(resourceOf(classifySwimCloudUrl(`${BASE}/results/193735/event/12/`))).toStrictEqual({
      kind: 'meetEvent',
      meetId: '193735',
      eventRef: '12',
    });
  });

  it('recognizes the country-scoped conference pattern', () => {
    expect(
      resourceOf(classifySwimCloudUrl(`${BASE}/country/usa/college/conference/nsisc/`)),
    ).toStrictEqual({
      kind: 'conference',
      urlForm: 'country-scoped',
      slug: 'nsisc',
      country: 'usa',
      level: 'college',
    });
  });

  it('recognizes the short conference form the plan gives as its example', () => {
    expect(resourceOf(classifySwimCloudUrl(`${BASE}/conference/nsisc/`))).toStrictEqual({
      kind: 'conference',
      urlForm: 'short',
      slug: 'nsisc',
    });
  });

  it('keeps ids as digit strings so a large id cannot lose precision', () => {
    const resource = resourceOf(classifySwimCloudUrl(`${BASE}/swimmer/9007199254740993/`));
    expect(resource).toStrictEqual({ kind: 'swimmer', swimmerId: '9007199254740993' });
    // The same value through Number() would round to 9007199254740992.
    expect(Number('9007199254740993').toString()).not.toBe('9007199254740993');
  });
});

describe('classifySwimCloudUrl — robots.txt denylist', () => {
  it('exports exactly the four Disallow lines from the recorded robots.txt fetch', () => {
    expect(SWIMCLOUD_ROBOTS_DISALLOW_RULES).toStrictEqual([
      '/api/',
      '/jsonapi/',
      '/team/*/facilities/',
      '/tz_detect/',
    ]);
  });

  it.each([
    [`${BASE}/api/`, '/api/'],
    [`${BASE}/api/v1/teams/633/`, '/api/'],
    [`${BASE}/jsonapi/swimmer/3646504/`, '/jsonapi/'],
    [`${BASE}/team/633/facilities/`, '/team/*/facilities/'],
    [`${BASE}/tz_detect/`, '/tz_detect/'],
  ])('flags %s as forbidden by %s', (url, rule) => {
    const classification = classifySwimCloudUrl(url);
    expect(classification.outcome).toBe('forbidden');
    if (classification.outcome !== 'forbidden') {
      throw new Error('unreachable');
    }
    expect(classification.rule).toBe(rule);
    expect(classification.source).toBe('robots.txt');
    expect(isForbiddenSwimCloudUrl(classification)).toBe(true);
    expect(isFetchableSwimCloudUrl(classification)).toBe(false);
  });

  it('blocks a denylisted prefix that is missing its trailing slash', () => {
    // Deliberately stricter than literal robots.txt prefix matching: erring
    // toward "forbidden" can only cost a manual check, while erring the other
    // way crosses the one line in this project's access posture that is
    // unambiguous.
    expect(classifySwimCloudUrl(`${BASE}/api`).outcome).toBe('forbidden');
    expect(classifySwimCloudUrl(`${BASE}/tz_detect`).outcome).toBe('forbidden');
  });

  it('does not over-block a path that merely starts with the same letters', () => {
    const classification = classifySwimCloudUrl(`${BASE}/apiary/`);
    expect(classification.outcome).toBe('unrecognized');
  });

  it('still forbids a facilities path whose team id is malformed', () => {
    // The denylist is checked before any id validation: a bad id must not
    // downgrade a forbidden path to a softer outcome.
    const classification = classifySwimCloudUrl(`${BASE}/team/not-an-id/facilities/`);
    expect(classification.outcome).toBe('forbidden');
  });

  it('treats the wildcard as matching any depth under /team/', () => {
    expect(classifySwimCloudUrl(`${BASE}/team/633/pool/facilities/`).outcome).toBe('forbidden');
  });

  it('never reports a denylisted path as fetchable, whatever the casing', () => {
    for (const url of [`${BASE}/API/v1/`, `${BASE}/TZ_Detect/`, `${BASE}/team/633/FACILITIES/`]) {
      expect(classifySwimCloudUrl(url).outcome).toBe('forbidden');
    }
  });
});

describe('classifySwimCloudUrl — malformed ids and slugs', () => {
  it.each([
    [`${BASE}/team/abc/`, 'team', 'invalid-id'],
    [`${BASE}/team/0633/`, 'team', 'invalid-id'],
    [`${BASE}/team/0/`, 'team', 'invalid-id'],
    [`${BASE}/team/633x/`, 'team', 'invalid-id'],
    [`${BASE}/team/-1/`, 'team', 'invalid-id'],
    [`${BASE}/team/`, 'team', 'missing-id'],
    [`${BASE}/swimmer/abc/`, 'swimmer', 'invalid-id'],
    [`${BASE}/swimmer/`, 'swimmer', 'missing-id'],
    [`${BASE}/results/nope/`, 'meet', 'invalid-id'],
    [`${BASE}/results/`, 'meet', 'missing-id'],
    [`${BASE}/results/193735/event/abc/`, 'meetEvent', 'invalid-event-ref'],
    [`${BASE}/results/193735/event/`, 'meetEvent', 'missing-event-ref'],
    [`${BASE}/conference/`, 'conference', 'missing-slug'],
    [`${BASE}/country/usa/college/conference/`, 'conference', 'missing-slug'],
  ])('reports %s as malformed (%s / %s)', (url, kind, reason) => {
    const classification = classifySwimCloudUrl(url);
    expect(classification.outcome).toBe('malformed');
    if (classification.outcome !== 'malformed') {
      throw new Error('unreachable');
    }
    expect(classification.kind).toBe(kind);
    expect(classification.reason).toBe(reason);
    expect(classification.detail.length).toBeGreaterThan(0);
  });

  it('never coerces a partly-numeric id into a number', () => {
    const classification = classifySwimCloudUrl(`${BASE}/team/633abc/`);
    expect(classification.outcome).toBe('malformed');
    expect(JSON.stringify(classification)).not.toContain('"teamId"');
  });
});

describe('classifySwimCloudUrl — not a SwimCloud resource', () => {
  it.each([
    ['https://example.com/team/633/', 'not-swimcloud-host'],
    ['https://swimcloud.com.evil.example/team/633/', 'not-swimcloud-host'],
    // Userinfo trick: the string starts with the right characters but the host
    // is evil.example. Parsed hostnames, not prefixes, are what is checked.
    ['https://www.swimcloud.com@evil.example/team/633/', 'not-swimcloud-host'],
    ['//evil.example/team/633/', 'not-swimcloud-host'],
    ['mailto:support@swimcloud.com', 'unsupported-scheme'],
    ['javascript:alert(1)', 'unsupported-scheme'],
    ['file:///C:/team/633/', 'unsupported-scheme'],
    ['', 'unparseable-url'],
    ['   ', 'unparseable-url'],
    ['not a url at all', 'unparseable-url'],
    [`${BASE}/`, 'unknown-path'],
    [`${BASE}/about/`, 'unknown-path'],
    [`${BASE}/team/633/roster/extra/`, 'unknown-path'],
    [`${BASE}/swimmer/3646504/results/`, 'unknown-path'],
    [`${BASE}/results/193735/heat/2/`, 'unknown-path'],
    [`${BASE}/country/usa/college/`, 'unknown-path'],
  ])('reports %s as unrecognized (%s)', (url, reason) => {
    const classification = classifySwimCloudUrl(url);
    expect(classification.outcome).toBe('unrecognized');
    if (classification.outcome !== 'unrecognized') {
      throw new Error('unreachable');
    }
    expect(classification.reason).toBe(reason);
  });

  it('accepts real subdomains of swimcloud.com', () => {
    expect(isSwimCloudHost('www.swimcloud.com')).toBe(true);
    expect(isSwimCloudHost('swimcloud.com')).toBe(true);
    expect(isSwimCloudHost('SWIMCLOUD.COM')).toBe(true);
    expect(isSwimCloudHost('evil-swimcloud.com')).toBe(false);
    expect(isSwimCloudHost('swimcloud.com.evil.example')).toBe(false);
  });
});

describe('classifySwimCloudUrl — input shapes and normalization', () => {
  it('treats a missing trailing slash as the same resource', () => {
    // `input` is deliberately preserved verbatim per call (see "preserves the
    // caller input verbatim on every outcome" below), so it's excluded here —
    // this test is about canonicalization/resource identity, not the echo field.
    const { input: _a, ...withoutSlash } = classifySwimCloudUrl(`${BASE}/team/633`);
    const { input: _b, ...withSlash } = classifySwimCloudUrl(`${BASE}/team/633/`);
    expect(withoutSlash).toStrictEqual(withSlash);
  });

  it('collapses duplicated slashes in the path', () => {
    expect(resourceOf(classifySwimCloudUrl(`${BASE}/team//633///`))).toStrictEqual({
      kind: 'team',
      teamId: '633',
    });
  });

  it('accepts a site-relative path, which is what a content script has', () => {
    expect(resourceOf(classifySwimCloudUrl('/swimmer/3646504/'))).toStrictEqual({
      kind: 'swimmer',
      swimmerId: '3646504',
    });
  });

  it('accepts a scheme-less host form, which is what some address bars copy', () => {
    expect(resourceOf(classifySwimCloudUrl('www.swimcloud.com/results/193735/'))).toStrictEqual({
      kind: 'meet',
      meetId: '193735',
    });
  });

  it('accepts http as well as https', () => {
    expect(classifySwimCloudUrl('http://www.swimcloud.com/team/633/').outcome).toBe('fetchable');
  });

  it('matches keyword segments case-insensitively and canonicalizes them', () => {
    const classification = classifySwimCloudUrl('https://WWW.SWIMCLOUD.COM/TEAM/633/ROSTER/');
    expect(classification.outcome).toBe('fetchable');
    if (classification.outcome !== 'fetchable') {
      throw new Error('unreachable');
    }
    expect(classification.canonicalPath).toBe('/team/633/roster/');
    expect(classification.canonicalUrl).toBe('https://www.swimcloud.com/team/633/roster/');
  });

  it('builds a canonical URL that keeps the query, since roster page 2 is a different resource', () => {
    const one = classifySwimCloudUrl(`${BASE}/team/633/roster/?page=1`);
    const two = classifySwimCloudUrl(`${BASE}/team/633/roster/?page=2`);
    if (one.outcome !== 'fetchable' || two.outcome !== 'fetchable') {
      throw new Error('unreachable');
    }
    expect(one.canonicalUrl).toBe('https://www.swimcloud.com/team/633/roster/?page=1');
    expect(two.canonicalUrl).not.toBe(one.canonicalUrl);
  });

  it('keeps the last value when a query key repeats', () => {
    const classification = classifySwimCloudUrl(`${BASE}/team/633/roster/?page=1&page=2`);
    const resource = resourceOf(classification);
    if (resource.kind !== 'teamRoster') {
      throw new Error('unreachable');
    }
    expect(resource.query.page).toBe('2');
  });

  it('preserves the caller input verbatim on every outcome', () => {
    const input = '  https://www.swimcloud.com/team/633/  ';
    expect(classifySwimCloudUrl(input).input).toBe(input);
  });

  it('round-trips every fetchable resource through canonicalPathForResource', () => {
    const urls = [
      `${BASE}/team/633/`,
      `${BASE}/team/633/roster/`,
      `${BASE}/team/633/results/`,
      `${BASE}/swimmer/3646504/`,
      `${BASE}/results/193735/`,
      `${BASE}/results/193735/event/12/`,
      `${BASE}/country/usa/college/conference/nsisc/`,
      `${BASE}/conference/nsisc/`,
    ];
    for (const url of urls) {
      const classification = classifySwimCloudUrl(url);
      if (classification.outcome !== 'fetchable') {
        throw new Error(`expected fetchable for ${url}`);
      }
      expect(canonicalPathForResource(classification.resource)).toBe(classification.canonicalPath);
      expect(`${BASE}${classification.canonicalPath}`).toBe(url);
    }
  });
});

describe('classifySwimCloudUrl — the guard cannot be bypassed by accident', () => {
  it('exposes an id only on the fetchable outcome', () => {
    const samples = [
      `${BASE}/team/633/facilities/`,
      `${BASE}/team/abc/`,
      'https://example.com/team/633/',
    ];
    for (const url of samples) {
      const classification = classifySwimCloudUrl(url);
      expect(isFetchableSwimCloudUrl(classification)).toBe(false);
      expect(classification).not.toHaveProperty('resource');
    }
  });
});
