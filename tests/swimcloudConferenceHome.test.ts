/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The NSISC conference HOME page (F-D), read offline.
 *
 * The page is not the member list: it links only the teams that happen to have
 * a top swim, a commitment or a top swimmer. These tests pin that the parser
 * says so (`complete: false` plus a warning) and never returns the three teams
 * it sees as the conference's members.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseConferenceHomeHtml } from '../packages/swimcloud/src/conferencePage';

const HTML = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'swimcloud-real-conference-nsisc.html'), 'utf-8');
const URL_HOME = 'https://www.swimcloud.com/country/usa/college/conference/nsisc/';
const ctx = (sourceUrl: string) =>
  ({ sourceUrl, retrievedAt: '2026-10-09T15:34:44.531Z', track: 'browser-extension' }) as never;

function ok(html: string = HTML, url: string = URL_HOME) {
  const r = parseConferenceHomeHtml(html, ctx(url));
  if (!r.ok) throw new Error(`expected ok: ${r.failure.code} ${r.failure.message}`);
  return r;
}

describe('conference home page (real capture)', () => {
  const { data, warnings } = ok();

  it('reads the slug, the display name and the Teams tab URL', () => {
    expect(data.kind).toBe('conference-home');
    expect(data.slug).toBe('nsisc');
    expect(data.country).toBe('usa');
    expect(data.level).toBe('college');
    expect(data.displayName).toBe('New South');
    expect(data.teamsTabUrl).toBe('https://www.swimcloud.com/country/usa/college/conference/nsisc/teams/');
  });

  it('is explicitly incomplete and says why', () => {
    expect(data.complete).toBe(false);
    const w = warnings.filter((x) => x.code === 'conference-teams-list-incomplete');
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('not the Teams tab');
    expect(w[0].message).toContain('conference/nsisc/teams/');
  });

  it('lists exactly the three teams the page links, each with names and where it was seen', () => {
    expect(data.mentionedTeams).toStrictEqual([
      {
        teamId: '58',
        names: ['Henderson State', 'Henderson State University'],
        sightings: [
          { section: 'Top swims', count: 10 },
          { section: 'Top swimmers', count: 4 },
        ],
        linkCount: 14,
      },
      {
        teamId: '48',
        names: ['Delta State University'],
        sightings: [
          { section: 'Commitments', count: 1 },
          { section: 'Top swimmers', count: 2 },
        ],
        linkCount: 3,
      },
      {
        teamId: '412',
        names: ['Ouachita Baptist University'],
        sightings: [{ section: 'Commitments', count: 1 }],
        linkCount: 1,
      },
    ]);
  });

  it('does not extract teams that only appear in meet titles', () => {
    const ids = data.mentionedTeams.map((t) => t.teamId);
    expect(ids).not.toContain('10009480');
    expect(JSON.stringify(data)).not.toContain('Oklahoma Christian');
    expect(JSON.stringify(data)).not.toContain('Alabama');
  });
});

describe('conference home page: loud failures and absent fields', () => {
  it('fails on empty input', () => {
    const r = parseConferenceHomeHtml('', ctx(URL_HOME));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('empty-input');
  });

  it('fails when the capture URL is not a conference home URL', () => {
    for (const url of ['https://www.swimcloud.com/team/58/', `${URL_HOME}teams/`]) {
      const r = parseConferenceHomeHtml(HTML, ctx(url));
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe('source-url-mismatch');
    }
  });

  it('fails when the canonical link names another conference', () => {
    const r = parseConferenceHomeHtml(HTML.replace(/(rel="canonical" href="[^"]*conference\/)nsisc/, '$1sec'), ctx(URL_HOME));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('source-url-mismatch');
  });

  it('fails on a challenge page instead of returning an empty team set', () => {
    const r = parseConferenceHomeHtml('<html><head><title>Just a moment...</title></head><body><h1>Checking</h1></body></html>', ctx(URL_HOME));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('expected-structure-missing');
  });

  it('leaves the Teams tab URL absent, with a warning, when the page has no such link', () => {
    const r = ok(HTML.replace(/href="[^"]*\/nsisc\/teams\/"/g, 'href="#"'));
    expect('teamsTabUrl' in r.data).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('conference-teams-tab-absent');
  });

  it('leaves the display name absent, with a warning, when the title has no brand suffix', () => {
    const r = ok(HTML.replace('<title>New South | Swimcloud</title>', '<title>Swimcloud</title>'));
    expect('displayName' in r.data).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('conference-name-absent');
  });

  it('warns, and does not claim an empty conference, when no team is linked', () => {
    const r = ok(HTML.replace(/href="\/team\/\d+"/g, 'href="#"'));
    expect(r.data.mentionedTeams).toStrictEqual([]);
    expect(r.data.complete).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('conference-no-team-mentions');
  });

  it('accepts the short URL form and leaves country and level absent', () => {
    const r = ok(HTML.replace(/(rel="canonical" href=")[^"]*"/, '$1https://www.swimcloud.com/conference/nsisc/"'), 'https://www.swimcloud.com/conference/nsisc/');
    expect(r.data.slug).toBe('nsisc');
    expect('country' in r.data).toBe(false);
    expect('level' in r.data).toBe(false);
  });
});
