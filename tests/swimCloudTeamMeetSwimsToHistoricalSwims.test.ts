/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `swimCloudTeamMeetSwimsToHistoricalSwims`
 * (`packages/manager/src/lib/swimCloudImportBridge.ts`), added 2026-09-08 to
 * replace `swimCloudMeetResultsToHistoricalSwims` at
 * `RosterImportWizard.tsx`'s bulk meet-import call site. Against the real
 * fixture, not a synthetic one — the same one
 * `tests/swimCloudMeetImportBridge.test.ts` (Matrix's parallel bridge) and
 * `tests/swimcloudParser.test.ts` already trust for this exact page shape.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import { swimCloudTeamMeetSwimsToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import { parseTeamMeetSwimsHtml, type SwimCloudParseContext } from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const html = readFileSync(join(fixturesDir, 'swimcloud-real-meet-team-swims-356467-team58-page1.html'), 'utf8');
const context: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/results/356467/team/58/swims/',
  retrievedAt: '2026-09-08T00:00:00Z',
  track: 'browser-extension',
};

function parsedFixture() {
  const result = parseTeamMeetSwimsHtml(html, context);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.failure.message}`);
  return result.data;
}

describe('swimCloudTeamMeetSwimsToHistoricalSwims — real capture (356467, Henderson State, men, page 1/8)', () => {
  it('converts 27 of 30 real swims, excluding the 3 relay-leadoff splits', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: 'Henderson State',
      gender: Gender.MEN,
    });
    expect(conversion.swims).toHaveLength(27);
    expect(conversion.skipped.filter((s) => s.reason === 'relay-event')).toHaveLength(3);
  });

  it('matches team name case-insensitively and trims it', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: '  henderson state  ',
      gender: Gender.MEN,
    });
    expect(conversion.swims).toHaveLength(27);
  });

  it('rejects the whole page as other-team when the coach picked the wrong team', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: 'Ouachita Baptist',
      gender: Gender.MEN,
    });
    expect(conversion.swims).toHaveLength(0);
    expect(conversion.skipped.filter((s) => s.reason === 'other-team').length).toBeGreaterThan(0);
  });

  it('rejects the whole page as other-gender when the coach picked the wrong gender', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: 'Henderson State',
      gender: Gender.WOMEN,
    });
    expect(conversion.swims).toHaveLength(0);
    expect(conversion.skipped.filter((s) => s.reason === 'other-gender').length).toBeGreaterThan(0);
  });

  it('carries the real meet name through as meetLabel', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: 'Henderson State',
      gender: Gender.MEN,
    });
    expect(conversion.swims.every((s) => s.meetLabel === 'New South Championships')).toBe(true);
  });

  it('produces a real, spot-checkable row (Colin Candebat, 200 Y IM)', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: 'Henderson State',
      gender: Gender.MEN,
    });
    const row = conversion.swims.find((s) => s.name === 'Colin Candebat' && s.event === '200 Y IM');
    expect(row).toMatchObject({ time: '1:46.74', team: 'Henderson State', gender: Gender.MEN, source: 'swimcloud' });
  });
});
