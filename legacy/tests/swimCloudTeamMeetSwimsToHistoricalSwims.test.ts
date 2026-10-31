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
import { aliasIndividualEventKey } from '../../packages/core/src/lib/athleteAliases';
import { swimEventIdentity } from '../../packages/core/src/lib/bestTimeEligibility';
import { buildCutlineTag } from '../../packages/core/src/lib/cutlineTags';
import { canonicalMeetEventLabel } from '../../packages/core/src/lib/athleteHistory';
import { canonicalProgramEvent } from '../../packages/core/src/lib/eventIdentity';
import { convertTimeToSeconds } from '../../packages/core/src/lib/timeFormat';
import { parseTeamMeetSwimsHtml, type SwimCloudParseContext } from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
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
  it('converts all 30 real swims, the 3 relay leadoffs included', () => {
    // **Changed 2026-09-22 on the coach's ruling.** This used to convert 27
    // and skip the 3 leadoff rows as 'relay-event'. A leadoff starts from the
    // blocks, not a flying takeover, and finishes to the hand, so it is the
    // individual event swum inside a relay.
    //
    // The page agrees: its leadoff rows are labelled with the INDIVIDUAL event
    // ("50 Y Back 22.53" for Avery Henke), not the relay, and that same swim
    // appears on his times page under "50 Back SCY".
    //
    // Whether a leadoff SCORES as an individual entry at this meet is a
    // different question with the opposite answer -- swimCloudMeetImportBridge
    // still excludes it there.
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: 'Henderson State',
      gender: Gender.MEN,
    });
    expect(conversion.swims).toHaveLength(30);
    expect(conversion.skipped.filter((s) => s.reason === 'relay-event')).toHaveLength(0);

    // The three are really there, and really leadoffs on the page.
    const leadoffEvents = parsedFixture()
      .swims.filter((s) => s.relayLeadoff)
      .map((s) => s.event.label);
    expect(leadoffEvents).toStrictEqual(['100 Y Free', '50 Y Back', '200 Y Free']);
    // Written as the canonical individual event; the course letter becomes timeType.
    for (const label of ['100 Freestyle', '50 Backstroke', '200 Freestyle']) {
      expect(conversion.swims.some((s) => s.event === label && s.timeType === 'SCY')).toBe(true);
    }
  });

  it('matches team name case-insensitively and trims it', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: '  henderson state  ',
      gender: Gender.MEN,
    });
    expect(conversion.swims).toHaveLength(30);
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
    const row = conversion.swims.find((s) => s.name === 'Colin Candebat' && s.event === '200 Individual Medley');
    expect(row).toMatchObject({
      time: '1:46.74',
      team: 'Henderson State',
      gender: Gender.MEN,
      source: 'swimcloud',
      timeType: 'SCY',
    });
  });

  it('every swim lands on an event the readers and the cut tables know (R3 follow-up: "100 Y Breast" matched nothing)', () => {
    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parsedFixture(), {
      team: 'Henderson State',
      gender: Gender.MEN,
    });
    expect(conversion.swims).toHaveLength(30);
    const labels = [...new Set(conversion.swims.map((s) => s.event))].sort();
    expect(labels).toStrictEqual([
      '100 Breaststroke',
      '100 Butterfly',
      '100 Freestyle',
      '1000 Freestyle',
      '1650 Freestyle',
      '200 Breaststroke',
      '200 Butterfly',
      '200 Freestyle',
      '200 Individual Medley',
      '400 Individual Medley',
      '50 Backstroke',
      '500 Freestyle',
    ]);
    for (const swim of conversion.swims) {
      // The readers agree. 50 Backstroke is read, but it is not on the SCY program.
      expect(canonicalMeetEventLabel(swim.event), swim.event).toBe(swim.event);
      expect(canonicalProgramEvent(swim.event), swim.event).toBe(swim.event === '50 Backstroke' ? null : swim.event);
      expect(aliasIndividualEventKey(swim.event), swim.event).toBe(swim.event.toLowerCase());
      expect(swimEventIdentity(swim.event), swim.event).toBe(swim.event.toLowerCase());
      // The cutline table has a row for it: before the fix this was event_not_in_table.
      const tag = buildCutlineTag({
        gender: Gender.MEN,
        event: swim.event,
        timeSec: convertTimeToSeconds(swim.time),
        division: 'D2',
        swimCourse: 'SCY',
      });
      // NCAA D2 publishes no 50 Backstroke standard, so that one is honestly absent.
      if (swim.event === '50 Backstroke') expect(tag.state).toBe('event_not_in_table');
      else expect(['tagged', 'no_cut'], `${swim.event} ${swim.time}`).toContain(tag.state);
    }
  });
});
