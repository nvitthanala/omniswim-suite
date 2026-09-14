/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `parseMeetTeamsHtml` / `parseMeetTopTeamsHtml` against real captures only —
 * both are `real-capture-verified`, so this file has no synthetic half.
 *
 * Three real fixtures, two meets:
 * - `swimcloud-real-meet-landing-356467.html` (4-team meet, no truncation —
 *   4 of 4 shown, including a zero-score team printed as an em dash).
 * - `swimcloud-real-meet-landing-379295-gender-{m,f}.html` (13-team meet,
 *   the Teams card truncates to 5 — the OQ-1 finding).
 * - `swimcloud-real-meet-topteams-379295-gender-{m,f}.html` (the same
 *   13-team meet's full team-standings page — the OQ-1b finding: every team
 *   present, including zero-scoring ones).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMeetTeamsHtml, parseMeetTopTeamsHtml, type SwimCloudParseContext } from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function contextFor(sourceUrl: string): SwimCloudParseContext {
  return { sourceUrl, retrievedAt: '2026-09-08T00:00:00Z', track: 'browser-extension' };
}

describe('parseMeetTeamsHtml — swimcloud-real-meet-landing-356467.html (4-team meet, no truncation)', () => {
  const html = fixture('swimcloud-real-meet-landing-356467.html');
  const context = contextFor('https://www.swimcloud.com/results/356467/');

  it('reports real-capture-verified confidence and unproven discoveryCompleteness', () => {
    const result = parseMeetTeamsHtml(html, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confidence).toBe('real-capture-verified');
    expect(result.data.discoveryCompleteness).toBe('unproven');
  });

  it('reads all 4 teams, including the zero-score team printed as an em dash', () => {
    const result = parseMeetTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.teams).toHaveLength(4);
    const [hsu, obu, dsu, uwf] = result.data.teams;
    expect(hsu).toMatchObject({ swimCloudTeamId: '58', teamName: 'Henderson State', rank: 1, score: 1056 });
    expect(obu.teamName).toBe('Ouachita Baptist');
    expect(dsu.teamName).toBe('Delta State');
    // West Florida: em-dash rank and score — a real zero-scoring team, not a parse gap.
    expect(uwf).toMatchObject({ swimCloudTeamId: '10002824', teamName: 'West Florida' });
    expect(uwf.rank).toBeUndefined();
    expect(uwf.score).toBeUndefined();
  });

  it('resolves the meet id from the source URL', () => {
    const result = parseMeetTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.swimCloudMeetId).toBe('356467');
  });
});

describe('parseMeetTeamsHtml — swimcloud-real-meet-landing-379295-gender-m.html (13-team meet, card truncates)', () => {
  const html = fixture('swimcloud-real-meet-landing-379295-gender-m.html');
  const context = contextFor('https://www.swimcloud.com/results/379295/?gender=M');

  it('reads only the 5 teams the card shows, and says so honestly', () => {
    const result = parseMeetTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.teams).toHaveLength(5);
    expect(result.data.discoveryCompleteness).toBe('unproven');
    expect(result.data.teams[0]).toMatchObject({ swimCloudTeamId: '337', teamName: 'Air Force', rank: 1, score: 819.5 });
  });
});

describe('parseMeetTeamsHtml — swimcloud-real-meet-landing-379295-gender-f.html', () => {
  const html = fixture('swimcloud-real-meet-landing-379295-gender-f.html');
  const context = contextFor('https://www.swimcloud.com/results/379295/?gender=F');

  it('reads the women\'s 5-team leaderboard, a different field than the men\'s', () => {
    const result = parseMeetTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.teams).toHaveLength(5);
    expect(result.data.teams[0]).toMatchObject({ swimCloudTeamId: '398', teamName: 'Northern Arizona', rank: 1, score: 1350 });
  });
});

describe('parseMeetTopTeamsHtml — swimcloud-real-meet-topteams-379295-gender-m.html (the full field)', () => {
  const html = fixture('swimcloud-real-meet-topteams-379295-gender-m.html');
  const context = contextFor('https://www.swimcloud.com/results/379295/topteams/?gender=M');

  it('reports real-capture-verified confidence and verified-complete-for-this-capture discoveryCompleteness', () => {
    const result = parseMeetTopTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.confidence).toBe('real-capture-verified');
    expect(result.data.discoveryCompleteness).toBe('verified-complete-for-this-capture');
  });

  it('reads all 13 teams — matching the meet-root card\'s truncation exactly', () => {
    const result = parseMeetTopTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.teams).toHaveLength(13);
  });

  it('keeps zero-scoring teams as real rows, not omitted ones', () => {
    const result = parseMeetTopTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    const zeroScoring = result.data.teams.filter((t) => t.rank === undefined && t.score === undefined);
    expect(zeroScoring).toHaveLength(7);
    expect(zeroScoring.map((t) => t.teamName)).toContain('Northern Arizona');
    expect(zeroScoring.map((t) => t.teamName)).toContain('UTRGV');
  });

  it('the union of both genders\' topteams rows recovers every team the meet-root card hid', () => {
    const menResult = parseMeetTopTeamsHtml(html, context);
    const womenHtml = fixture('swimcloud-real-meet-topteams-379295-gender-f.html');
    const womenResult = parseMeetTopTeamsHtml(
      womenHtml,
      contextFor('https://www.swimcloud.com/results/379295/topteams/?gender=F'),
    );
    if (!menResult.ok || !womenResult.ok) throw new Error('expected success');
    const ids = new Set([
      ...menResult.data.teams.map((t) => t.swimCloudTeamId),
      ...womenResult.data.teams.map((t) => t.swimCloudTeamId),
    ]);
    // Both genders' fields are the same 13-team conference roster.
    expect(ids.size).toBe(13);
  });
});

describe('parseMeetTopTeamsHtml — swimcloud-real-meet-topteams-379295-gender-f.html', () => {
  const html = fixture('swimcloud-real-meet-topteams-379295-gender-f.html');
  const context = contextFor('https://www.swimcloud.com/results/379295/topteams/?gender=F');

  it('reads all 13 teams, 10 scoring + 3 zero-scoring', () => {
    const result = parseMeetTopTeamsHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.teams).toHaveLength(13);
    const zeroScoring = result.data.teams.filter((t) => t.rank === undefined);
    expect(zeroScoring).toHaveLength(3);
  });
});

describe('parseMeetTeamsHtml / parseMeetTopTeamsHtml — failure modes', () => {
  it('fails loudly on empty input rather than returning an empty team list', () => {
    const result = parseMeetTeamsHtml('', contextFor('https://www.swimcloud.com/results/356467/'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('empty-input');
  });

  it('fails when no meet id can be resolved from the URL and none was supplied', () => {
    const result = parseMeetTeamsHtml('<html><body>x</body></html>', contextFor('https://www.swimcloud.com/team/58/'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('source-url-mismatch');
  });

  it('fails when no "Teams" card table is present on the page', () => {
    const html = '<html><body><h1 id="meet-name">Some Meet</h1><p>no teams card here</p></body></html>';
    const result = parseMeetTeamsHtml(html, contextFor('https://www.swimcloud.com/results/999999/'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('expected-table-missing');
  });
});
