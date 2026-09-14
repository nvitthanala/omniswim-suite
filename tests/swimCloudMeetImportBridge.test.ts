/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `packages/matrix/src/lib/swimCloudMeetImportBridge.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import type { SwimmerResult, Workspace } from '@omniswim/core/types';
import {
  applySwimCloudRows,
  buildSwimCloudEventRoundIndex,
  mergeSwimCloudResults,
  swimCloudMeetResultsToSwimmerResults,
  swimCloudTeamMeetSwimsToSwimmerResults,
} from '@omniswim/matrix/lib/swimCloudMeetImportBridge';
import { parseMeetEventResultsHtml, parseTeamMeetSwimsHtml } from '@omniswim/swimcloud/parser';
import type {
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudMeetEventResultsParse,
  SwimCloudMeetResultsParse,
  SwimCloudParseContext,
  SwimCloudParsedEvent,
  SwimCloudRelay,
  SwimCloudResult,
  SwimCloudTeamMeetSwimsParse,
} from '@omniswim/swimcloud/parser';

let nextId = 0;
function resetIds() {
  nextId = 0;
}

function swimCloudEvent(overrides: Partial<SwimCloudEvent> = {}): SwimCloudEvent {
  return {
    eventId: `evt-${nextId++}`,
    swimCloudMeetId: '193735',
    label: 'Women 100 Yard Butterfly',
    kind: 'individual',
    course: 'SCY',
    gender: 'Women',
    distance: 100,
    stroke: 'Butterfly',
    ...overrides,
  };
}

function swimCloudEntry(overrides: Partial<SwimCloudEntry> = {}): SwimCloudEntry {
  return {
    entryId: `entry-${nextId++}`,
    eventId: 'evt-0',
    athleteName: 'Riley Adams',
    teamName: 'Henderson State',
    ...overrides,
  };
}

function swimCloudResult(entryId: string, overrides: Partial<SwimCloudResult> = {}): SwimCloudResult {
  return {
    resultId: `result-${nextId++}`,
    entryId,
    eventId: 'evt-0',
    place: 1,
    finalTime: '52.10',
    points: 20,
    ...overrides,
  };
}

function individualEvent(opts: {
  event?: Partial<SwimCloudEvent>;
  entry?: Partial<SwimCloudEntry>;
  result?: Partial<SwimCloudResult>;
}): SwimCloudParsedEvent {
  const event = swimCloudEvent(opts.event);
  const entry = swimCloudEntry({ eventId: event.eventId, ...opts.entry });
  const result = swimCloudResult(entry.entryId, { eventId: event.eventId, ...opts.result });
  return { event, entries: [entry], results: [result], relays: [] };
}

function relayEvent(opts: {
  event?: Partial<SwimCloudEvent>;
  relay?: Partial<SwimCloudRelay>;
  result?: Partial<SwimCloudResult>;
}): SwimCloudParsedEvent {
  const event = swimCloudEvent({ kind: 'relay', label: 'Women 200 Yard Freestyle Relay', stroke: 'Freestyle Relay', ...opts.event });
  const relayId = `relay-${nextId++}`;
  const entryId = `entry-${nextId++}`;
  // teamName is set on entry and relay from the same value, in the same
  // iteration, by the real parser (parser.ts) — never independently. This
  // fixture mirrors that: a caller-supplied relay.teamName override (even
  // an explicit `undefined`) also applies to the entry, keeping the two in
  // sync the way real output always is.
  const teamName = opts.relay && 'teamName' in opts.relay ? opts.relay.teamName : 'Henderson State';
  const entry: SwimCloudEntry = { entryId, eventId: event.eventId, relayId, ...(teamName === undefined ? {} : { teamName }) };
  const relay: SwimCloudRelay = {
    relayId,
    eventId: event.eventId,
    designator: 'A',
    legs: [],
    ...opts.relay,
    ...(teamName === undefined ? {} : { teamName }),
  };
  const result = swimCloudResult(entryId, { eventId: event.eventId, ...opts.result });
  return { event, entries: [entry], results: [result], relays: [relay] };
}

function meetParse(events: SwimCloudParsedEvent[]): SwimCloudMeetResultsParse {
  return {
    swimCloudMeetId: '193735',
    meetName: '2026 NSISC Championships',
    meet: { swimCloudMeetId: '193735', name: '2026 NSISC Championships', format: 'unknown', ruleset: 'unknown', course: 'unknown' },
    events,
    eventHeadingCount: events.length,
  };
}

/** Builds one row of a swims-list capture, for the `swimCloudTeamMeetSwimsToSwimmerResults` tests below. */
function teamMeetSwim(overrides: {
  event?: Partial<SwimCloudEvent>;
  entry?: Partial<SwimCloudEntry>;
  result?: Partial<SwimCloudResult>;
  swimCloudSwimId?: string;
  relayLeadoff?: boolean;
  meetScore?: number;
} = {}): SwimCloudTeamMeetSwim {
  const event = swimCloudEvent(overrides.event);
  const entry = swimCloudEntry({ eventId: event.eventId, ...overrides.entry });
  const result = swimCloudResult(entry.entryId, { eventId: event.eventId, ...overrides.result });
  const swimId = overrides.swimCloudSwimId ?? `swim-${nextId++}`;
  return {
    swimKey: `193735:swim:${swimId}`,
    swimCloudSwimId: swimId,
    event,
    entry,
    result,
    relayLeadoff: overrides.relayLeadoff ?? false,
    cutStandards: [],
    ...(overrides.meetScore === undefined ? {} : { meetScore: overrides.meetScore }),
  };
}

function teamMeetSwimsParse(swims: SwimCloudTeamMeetSwim[]): SwimCloudTeamMeetSwimsParse {
  const events: SwimCloudEvent[] = [];
  for (const swim of swims) {
    if (!events.some(e => e.eventId === swim.event.eventId)) events.push(swim.event);
  }
  return {
    swimCloudMeetId: '193735',
    meetName: '2026 NSISC Championships',
    meet: { swimCloudMeetId: '193735', name: '2026 NSISC Championships', format: 'unknown', ruleset: 'unknown', course: 'unknown' },
    gender: 'Men',
    swims,
    events,
    rowCount: swims.length,
  };
}

describe('swimCloudMeetResultsToSwimmerResults — individual events', () => {
  it('converts a clean individual result, trusting SwimCloud points via pdfPoints', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(meetParse([individualEvent({})]));

    expect(result.women).toHaveLength(1);
    expect(result.men).toHaveLength(0);
    expect(result.women[0]).toMatchObject({
      name: 'Riley Adams',
      team: 'Henderson State',
      gender: Gender.WOMEN,
      event: 'Women 100 Yard Butterfly',
      time: '52.10',
      rank: 1,
      points: 20,
      pdfPoints: 20, // the trust signal a caller turns on with usePdfPlacePoints
    });
    expect(result.skipped).toEqual([]);
  });

  it('sorts a Men event into men, a Women event into women', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(
      meetParse([individualEvent({ event: { gender: 'Men', label: 'Men 100 Yard Butterfly' } })]),
    );
    expect(result.men).toHaveLength(1);
    expect(result.women).toHaveLength(0);
  });

  it('skips an event whose gender is unknown, rather than guessing which bucket it belongs in', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(
      meetParse([individualEvent({ event: { gender: 'unknown', label: 'Mixed 100 Yard Butterfly' } })]),
    );
    expect(result.men).toEqual([]);
    expect(result.women).toEqual([]);
    expect(result.skipped).toEqual([{ reason: 'unknown-gender', eventLabel: 'Mixed 100 Yard Butterfly' }]);
  });

  it('uses the 9999 unranked sentinel for a DQ, matching packages/core\'s own parseRankInt(...) ?? 9999 fallback', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(
      meetParse([
        individualEvent({
          result: { place: undefined, finalTime: undefined, rawTimeToken: 'DQ', points: undefined, flags: { disqualified: true } },
        }),
      ]),
    );
    expect(result.women[0]).toMatchObject({ rank: 9999, time: 'DQ', points: 0 });
    expect(result.women[0]).not.toHaveProperty('pdfPoints'); // no points printed for a DQ row — never fabricated
  });

  it('marks an exhibition swim, which still has a real time and real points', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(
      meetParse([individualEvent({ result: { flags: { exhibition: true } } })]),
    );
    expect(result.women[0]).toMatchObject({ isExhibition: true, time: '52.10', points: 20 });
  });

  it('skips an individual entry with no athlete name', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(meetParse([individualEvent({ entry: { athleteName: undefined } })]));
    expect(result.women).toEqual([]);
    expect(result.skipped).toEqual([{ reason: 'no-athlete-name', eventLabel: 'Women 100 Yard Butterfly' }]);
  });

  it('skips an individual entry with no team name', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(meetParse([individualEvent({ entry: { teamName: undefined } })]));
    expect(result.women).toEqual([]);
    expect(result.skipped).toEqual([
      { reason: 'no-team-name', eventLabel: 'Women 100 Yard Butterfly', subject: 'Riley Adams' },
    ]);
  });
});

describe('swimCloudMeetResultsToSwimmerResults — relay events', () => {
  it('converts a relay to a team-level row, unlike the Manager-side bridge which excludes relays entirely', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(meetParse([relayEvent({})]));

    expect(result.women).toHaveLength(1);
    expect(result.women[0]).toMatchObject({
      name: 'Henderson State',
      team: 'Henderson State',
      isRelay: true,
      time: '52.10',
      points: 20,
      pdfPoints: 20,
    });
  });

  it('populates relayNames from the relay\'s own legs when SwimCloud published them', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(
      meetParse([
        relayEvent({
          relay: {
            legs: [
              { order: 1, athleteName: 'Landon Dehn', splitTime: '23.41' },
              { order: 2, athleteName: 'Sam Reyes', splitTime: '23.26' },
            ],
          },
        }),
      ]),
    );
    expect(result.women[0].relayNames).toEqual([
      { name: 'Landon Dehn', year: '' },
      { name: 'Sam Reyes', year: '' },
    ]);
  });

  it('omits relayNames entirely when no legs were published, rather than an empty array implying "we looked and found none"', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(meetParse([relayEvent({})]));
    expect(result.women[0]).not.toHaveProperty('relayNames');
  });

  it('skips a relay entry with no team name', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(
      meetParse([relayEvent({ relay: { teamName: undefined } })]),
    );
    expect(result.women).toEqual([]);
    expect(result.skipped).toEqual([{ reason: 'no-team-name', eventLabel: 'Women 200 Yard Freestyle Relay' }]);
  });
});

describe('swimCloudMeetResultsToSwimmerResults — an all-skipped meet is not an error', () => {
  it('returns empty men/women arrays with every row accounted for in skipped', () => {
    resetIds();
    const result = swimCloudMeetResultsToSwimmerResults(
      meetParse([individualEvent({ event: { gender: 'unknown' } })]),
    );
    expect(result.men).toEqual([]);
    expect(result.women).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });
});

/* ========================================================================== */
/* The real-capture path                                                       */
/* ========================================================================== */

/**
 * These drive the converter from the real fixture through the real parser
 * rather than from a hand-built parse object, so they prove the whole chain a
 * user's capture travels — classifier, parser, converter — against markup
 * SwimCloud served.
 */
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function realSwimsParse(
  file: string,
  sourceUrl: string,
): SwimCloudTeamMeetSwimsParse {
  const context: SwimCloudParseContext = {
    sourceUrl,
    retrievedAt: '2026-09-08T00:00:00Z',
    track: 'browser-extension',
  };
  const result = parseTeamMeetSwimsHtml(
    readFileSync(join(fixturesDir, file), 'utf8'),
    context,
  );
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.failure.code}`);
  return result.data;
}

const swimsPageOne = () =>
  realSwimsParse(
    'swimcloud-real-meet-team-swims-356467-team58-page1.html',
    'https://www.swimcloud.com/results/356467/team/58/swims/',
  );

describe('swimCloudTeamMeetSwimsToSwimmerResults — real capture', () => {
  it('converts 14 of 30 rows, excluding relay leadoffs and ambiguous round duplicates', () => {
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    // The page is the men's list, so nothing lands on the women's side.
    expect(result.men).toHaveLength(14);
    expect(result.women).toHaveLength(0);
    // 3 relay-leadoff splits + 13 swims caught in a same-swimmer/same-event
    // duplicate group (six groups: five pairs and one trio) = 16 of 30 rows.
    expect(result.skipped).toHaveLength(16);
    expect(result.skipped.filter(s => s.reason === 'relay-leadoff')).toHaveLength(3);
    expect(result.skipped.filter(s => s.reason === 'ambiguous-round-duplicate')).toHaveLength(13);
  });

  it('names the excluded leadoff splits rather than dropping them silently', () => {
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    expect(result.skipped.filter(s => s.reason === 'relay-leadoff')).toStrictEqual([
      { reason: 'relay-leadoff', eventLabel: '100 Y Free', subject: 'Colin Candebat' },
      { reason: 'relay-leadoff', eventLabel: '50 Y Back', subject: 'Avery Henke' },
      { reason: 'relay-leadoff', eventLabel: '200 Y Free', subject: 'Nojus Skirutis' },
    ]);
  });

  it('excludes every swim of a same-swimmer/same-event group, naming each one', () => {
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    const henke = result.skipped.filter(s => s.reason === 'ambiguous-round-duplicate' && s.subject === 'Avery Henke');
    // Both of Henke's "100 Y Breast" rows are excluded, not just the slower
    // (or faster, or better-placed) one — this bridge never guesses which
    // round a swim belongs to.
    expect(henke).toStrictEqual([
      { reason: 'ambiguous-round-duplicate', eventLabel: '100 Y Breast', subject: 'Avery Henke', detail: '54.09 (place 1, swim 171560736)' },
      { reason: 'ambiguous-round-duplicate', eventLabel: '100 Y Breast', subject: 'Avery Henke', detail: '54.27 (place 1, swim 171560737)' },
    ]);
    expect(result.men.some(row => row.name === 'Avery Henke' && row.event === '100 Y Breast')).toBe(false);
    // Oskar Cebula's "100 Y Breast" group has three swims, split across two
    // different SwimCloud event ids (event/26 and event/100) — grouping by
    // event id alone would have missed the third.
    const cebula = result.skipped.filter(s => s.reason === 'ambiguous-round-duplicate' && s.subject === 'Oskar Cebula');
    expect(cebula).toHaveLength(3);
  });

  it('the only "100 Y Free" and "200 Y Free" swims on the page are excluded, so neither event survives', () => {
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    // Three rows print "100 Y Free": one relay-leadoff split and a genuine
    // pair that is itself an ambiguous round duplicate (Olivér Pózvai, two
    // swims). Every one of the three is excluded, for two different reasons.
    expect(result.men.filter(row => row.event === '100 Y Free')).toHaveLength(0);
    // The only "200 Y Free" on the page IS the leadoff, so that event drops out
    // entirely — correctly, because no one swam it individually here.
    expect(result.men.filter(row => row.event === '200 Y Free')).toHaveLength(0);
  });

  it('does not put SwimCloud power points into a meet-score field', () => {
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    // The swims page has no Score column, so no row may claim meet points.
    // Leaving pdfPoints unset is what makes the app compute points from place
    // and the point table instead.
    expect(result.men.every(row => row.pdfPoints === undefined)).toBe(true);
    expect(result.men.every(row => row.points === 0)).toBe(true);
    // The guard that matters: had the Pts column been trusted, even these 14
    // surviving rows alone would out-total Henderson State's real score for
    // the *entire* meet (1056) by close to an order of magnitude.
    const asPoints = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne(), {
      pointsTrust: 'swimcloud-points',
    });
    const total = asPoints.men.reduce((sum, row) => sum + Number(row.points), 0);
    expect(total).toBeGreaterThan(9000);
  });

  it('uses a Score column when the page actually has one', () => {
    const landing = realSwimsParse(
      'swimcloud-real-meet-landing-356467.html',
      'https://www.swimcloud.com/results/356467/',
    );
    const result = swimCloudTeamMeetSwimsToSwimmerResults(landing);
    expect(result.men).toHaveLength(1);
    // 20 meet points, not the 846 in the same row's Pts column.
    expect(result.men[0].points).toBe(20);
    expect(result.men[0].pdfPoints).toBe(20);
  });

  it('carries place through as rank for a row with no duplicate', () => {
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    const first = result.men[0];
    expect(first).toMatchObject({
      name: 'Colton Bennett',
      team: 'Henderson State University',
      event: '1000 Y Free',
      time: '9:26.63',
      rank: 3,
      classYear: 'unknown',
      gender: Gender.MEN,
    });
    // Camden Mask's "100 Y Breast" pair (one placed 17th, one unplaced) is an
    // ambiguous round duplicate now, so neither row — placed or not — reaches
    // `men` to claim the sorts-last sentinel.
    expect(result.men.some(row => row.name === 'Camden Mask')).toBe(false);
  });

  it('ids every row by its SwimCloud swim id so repeat captures can merge', () => {
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    expect(new Set(result.men.map(row => row.id)).size).toBe(14);
    expect(result.men[0].id).toBe('356467:swim:171560650');
    expect(result.men.every(row => row.id.startsWith('356467:swim:'))).toBe(true);
  });
});

describe('swimCloudTeamMeetSwimsToSwimmerResults — ambiguous-round-duplicate', () => {
  it('leaves a swimmer with exactly one swim of an event alone', () => {
    const swim = teamMeetSwim({ event: { gender: 'Men' }, entry: { athleteName: 'Riley Adams' } });
    const result = swimCloudTeamMeetSwimsToSwimmerResults(teamMeetSwimsParse([swim]));
    expect(result.men).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it('excludes both swims — and only those — when one swimmer has two of the same event', () => {
    const event = { label: '100 Y Breast', gender: 'Men' as const };
    const dup1 = teamMeetSwim({ event, entry: { athleteName: 'Riley Adams' }, result: { place: 1 } });
    const dup2 = teamMeetSwim({ event, entry: { athleteName: 'Riley Adams' }, result: { place: 1 } });
    const other = teamMeetSwim({ event: { label: '200 Y Free', gender: 'Men' }, entry: { athleteName: 'Riley Adams' } });
    const result = swimCloudTeamMeetSwimsToSwimmerResults(teamMeetSwimsParse([dup1, dup2, other]));
    expect(result.men).toStrictEqual([expect.objectContaining({ event: '200 Y Free' })]);
    expect(result.skipped).toStrictEqual([
      { reason: 'ambiguous-round-duplicate', eventLabel: '100 Y Breast', subject: 'Riley Adams', detail: expect.any(String) },
      { reason: 'ambiguous-round-duplicate', eventLabel: '100 Y Breast', subject: 'Riley Adams', detail: expect.any(String) },
    ]);
  });

  it('does not flag two different swimmers who each swam the event once', () => {
    const event = { label: '100 Y Breast', gender: 'Men' as const };
    const a = teamMeetSwim({ event, entry: { athleteName: 'Riley Adams' } });
    const b = teamMeetSwim({ event, entry: { athleteName: 'Jordan Lee' } });
    const result = swimCloudTeamMeetSwimsToSwimmerResults(teamMeetSwimsParse([a, b]));
    expect(result.men).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });

  it('groups by event label across different SwimCloud event ids, not by event id', () => {
    // Mirrors the real Oskar Cebula case: the same labeled event split across
    // two different `event/{n}/` pages, three swims total.
    const label = '100 Y Breast';
    const a = teamMeetSwim({ event: { label, gender: 'Men', eventId: 'evt-a' }, entry: { athleteName: 'Riley Adams' } });
    const b = teamMeetSwim({ event: { label, gender: 'Men', eventId: 'evt-b' }, entry: { athleteName: 'Riley Adams' } });
    const c = teamMeetSwim({ event: { label, gender: 'Men', eventId: 'evt-b' }, entry: { athleteName: 'Riley Adams' } });
    const result = swimCloudTeamMeetSwimsToSwimmerResults(teamMeetSwimsParse([a, b, c]));
    expect(result.men).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.every(s => s.reason === 'ambiguous-round-duplicate')).toBe(true);
  });

  it('names the excluded swims in `detail` so a coach can find them on SwimCloud', () => {
    const event = { label: '100 Y Breast', gender: 'Men' as const };
    const dup1 = teamMeetSwim({
      event,
      entry: { athleteName: 'Riley Adams' },
      result: { place: 1, finalTime: '54.09' },
      swimCloudSwimId: '171560736',
    });
    const dup2 = teamMeetSwim({
      event,
      entry: { athleteName: 'Riley Adams' },
      result: { place: 1, finalTime: '54.27' },
      swimCloudSwimId: '171560737',
    });
    const result = swimCloudTeamMeetSwimsToSwimmerResults(teamMeetSwimsParse([dup1, dup2]));
    expect(result.skipped[0].detail).toBe('54.09 (place 1, swim 171560736)');
    expect(result.skipped[1].detail).toBe('54.27 (place 1, swim 171560737)');
  });

  it('a relay leadoff is never counted toward the duplicate group', () => {
    const event = { label: '100 Y Free', gender: 'Men' as const };
    const real = teamMeetSwim({ event, entry: { athleteName: 'Riley Adams' } });
    const leadoff = teamMeetSwim({ event, entry: { athleteName: 'Riley Adams' }, relayLeadoff: true });
    const result = swimCloudTeamMeetSwimsToSwimmerResults(teamMeetSwimsParse([real, leadoff]));
    // One real swim of the event, one leadoff — not a same-event duplicate.
    expect(result.men).toStrictEqual([expect.objectContaining({ event: '100 Y Free' })]);
    expect(result.skipped).toStrictEqual([{ reason: 'relay-leadoff', eventLabel: '100 Y Free', subject: 'Riley Adams' }]);
  });
});

describe('mergeSwimCloudResults', () => {
  const row = (id: string, over: Partial<SwimmerResult> = {}): SwimmerResult => ({
    id,
    rank: 1,
    name: 'A',
    classYear: 'unknown',
    team: 'HSU',
    time: '54.09',
    points: 0,
    event: '100 Y Breast',
    ...over,
  });

  it('appends genuinely new rows and keeps existing order', () => {
    const merged = mergeSwimCloudResults([row('a'), row('b')], [row('c')]);
    expect(merged.map(r => r.id)).toStrictEqual(['a', 'b', 'c']);
  });

  it('replaces a row rather than duplicating it when the same swim is recaptured', () => {
    const merged = mergeSwimCloudResults([row('a', { time: '55.00' })], [row('a', { time: '54.09' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].time).toBe('54.09');
  });

  it('leaves rows from other sources untouched', () => {
    const fromPdf = row('pdf-row-7', { name: 'From a PDF' });
    const merged = mergeSwimCloudResults([fromPdf], [row('356467:swim:1')]);
    expect(merged.map(r => r.id)).toStrictEqual(['pdf-row-7', '356467:swim:1']);
    expect(merged[0]).toBe(fromPdf);
  });

  it('merges the team-landing summary into the full list without doubling a swim', () => {
    // Avery Henke's 54.09 is on both pages. A user who captures the summary
    // and then the full list must end up with one of it. It is the summary's
    // copy that survives here: the top-10 landing page has no round column
    // either, but it only lists one of Henke's two "100 Y Breast" swims, so it
    // never triggers the ambiguous-round-duplicate exclusion the full list
    // does for the same swim.
    const summary = swimCloudTeamMeetSwimsToSwimmerResults(
      realSwimsParse(
        'swimcloud-real-meet-team-landing-356467-team58.html',
        'https://www.swimcloud.com/results/356467/team/58/',
      ),
    );
    const full = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    const merged = mergeSwimCloudResults(summary.men, full.men);
    expect(summary.men).toHaveLength(1);
    // 1 (the summary's Henke row) + 14 (the full list, which excludes both of
    // its own Henke "100 Y Breast" rows as an ambiguous duplicate) = 15.
    expect(merged).toHaveLength(15);
    expect(merged.filter(r => r.id === '356467:swim:171560736')).toHaveLength(1);
  });
});

/* ========================================================================== */
/* applySwimCloudRows — the shared core behind the clipboard path and the      */
/* capture picker (Phase 4, plans/2026-09-08/05-matrix-import-ui.md)          */
/* ========================================================================== */

describe('applySwimCloudRows', () => {
  function testWorkspace(overrides: Partial<Workspace> = {}): Workspace {
    return {
      id: 'ws-1',
      name: 'Test workspace',
      menResults: [],
      womenResults: [],
      recruits: [],
      createdAt: Date.now(),
      ...overrides,
    };
  }

  /** Captures the single `onUpdate` patch a call produced, failing loudly if it was called more than once. */
  function capturingOnUpdate(): { onUpdate: (patch: Partial<Workspace>) => void; calls: Partial<Workspace>[] } {
    const calls: Partial<Workspace>[] = [];
    return { onUpdate: patch => calls.push(patch), calls };
  }

  const landingParse = () =>
    realSwimsParse(
      'swimcloud-real-meet-team-landing-356467-team58.html',
      'https://www.swimcloud.com/results/356467/team/58/',
    );

  it('single parse: produces the same onUpdate patch shape the clipboard path always has', async () => {
    const workspace = testWorkspace();
    const { onUpdate, calls } = capturingOnUpdate();
    const parsed = swimsPageOne();
    const converted = swimCloudTeamMeetSwimsToSwimmerResults(parsed);

    const result = await applySwimCloudRows([parsed], workspace, onUpdate);

    expect(calls).toHaveLength(1);
    const patch = calls[0];
    expect(patch.menResults).toHaveLength(14);
    expect(patch.womenResults).toEqual([]);
    // meetCopyFromParsed clones into both the working and source copies.
    expect(patch.sourceMenResults).toEqual(patch.menResults);
    expect(patch.sourceWomenResults).toEqual(patch.womenResults);
    // A fresh meet (not the same as anything loaded) resets the workspace's own edits.
    expect(patch.deletedSwimmers).toEqual([]);
    expect(patch.scorerRosterOverrides).toEqual([]);
    expect(patch.relayLegOverrides).toEqual([]);
    expect(patch.recruits).toEqual([]);
    expect(patch.loadedMeet).toMatchObject({
      pdfFilename: `${parsed.meetName} (via SwimCloud)`,
      meetLabel: parsed.meetName,
    });
    expect(typeof patch.loadedMeet?.uploadedAt).toBe('number');
    // No conference on this workspace, and this fixture has no Score column
    // (see the "does not put SwimCloud power points into a meet-score field"
    // test above), so neither key is ever set on the patch — never a guessed
    // conference, never a fabricated scoring patch.
    expect(patch).not.toHaveProperty('conference');
    expect(patch).not.toHaveProperty('scoringSettings');

    expect(result.appliedRowCount).toBe(14);
    expect(result.totalRowCount).toBe(14);
    expect(result.skipped).toStrictEqual(converted.skipped);
    expect(result.meetName).toBe(parsed.meetName);
    expect(result.presetHint).toBeNull();
    expect(result.isSameMeet).toBe(false);
  });

  it('multi-parse: folds every page into one onUpdate call, deduping a swim seen on two pages', async () => {
    const workspace = testWorkspace();
    const { onUpdate, calls } = capturingOnUpdate();
    const landing = landingParse();
    const full = swimsPageOne();
    const landingSkipCount = swimCloudTeamMeetSwimsToSwimmerResults(landing).skipped.length;
    const fullSkipCount = swimCloudTeamMeetSwimsToSwimmerResults(full).skipped.length;

    const result = await applySwimCloudRows([landing, full], workspace, onUpdate);

    // Exactly one workspace update for two pages — a 66-page capture must not
    // fire 66 updates.
    expect(calls).toHaveLength(1);
    // The landing page's one Henke row (1) plus the full list's 14 surviving
    // rows, which no longer include a duplicate of that same swim (see
    // `mergeSwimCloudResults`'s "without doubling a swim" test above) = 15.
    expect(calls[0].menResults).toHaveLength(15);
    expect(result.appliedRowCount).toBe(15);
    expect(result.totalRowCount).toBe(15);
    expect(result.skipped).toHaveLength(landingSkipCount + fullSkipCount);
    expect(result.isSameMeet).toBe(false);
  });

  it('folds a second page into a meet already loaded instead of replacing it', async () => {
    const parsed = swimsPageOne();
    const converted = swimCloudTeamMeetSwimsToSwimmerResults(parsed);
    // Pretend one row of this exact meet is already loaded (e.g. from a
    // previous page), under the same `${meetId}:` id prefix.
    const alreadyLoaded: SwimmerResult = {
      id: `${parsed.swimCloudMeetId}:swim:already-loaded`,
      rank: 5,
      name: 'Already Loaded',
      classYear: 'unknown',
      team: 'Henderson State University',
      time: '1:00.00',
      points: 0,
      event: '200 Y Free',
      gender: Gender.MEN,
    };
    const workspace = testWorkspace({ menResults: [alreadyLoaded], recruits: [{ name: 'A Recruit' } as never] });
    const { onUpdate, calls } = capturingOnUpdate();

    const result = await applySwimCloudRows([parsed], workspace, onUpdate);

    expect(result.isSameMeet).toBe(true);
    // Same-meet reset patch is empty — no key present at all, so existing
    // deletions/overrides/recruits survive untouched.
    const patch = calls[0];
    expect(patch).not.toHaveProperty('deletedSwimmers');
    expect(patch).not.toHaveProperty('scorerRosterOverrides');
    expect(patch).not.toHaveProperty('relayLegOverrides');
    expect(patch).not.toHaveProperty('recruits');
    // The pre-existing row plus the 14 newly converted rows.
    expect(patch.menResults).toHaveLength(15);
    expect(result.totalRowCount).toBe(15);
    expect(result.appliedRowCount).toBe(converted.men.length + converted.women.length);
  });

  it('asks resolveKeepRecruits only for a genuinely different meet with saved recruits, and honors its answer', async () => {
    const parsed = swimsPageOne();
    const existingRecruits = [{ name: 'A Recruit' } as never];
    const workspace = testWorkspace({ recruits: existingRecruits });
    const { onUpdate, calls } = capturingOnUpdate();
    let askedWith: readonly unknown[] | undefined;

    await applySwimCloudRows([parsed], workspace, onUpdate, {
      resolveKeepRecruits: existing => {
        askedWith = existing;
        return false; // discard
      },
    });

    expect(askedWith).toBe(existingRecruits);
    expect(calls[0].recruits).toEqual([]);
  });

  it('the default resolveKeepRecruits never touches window.confirm when there are no recruits to lose', async () => {
    // No `resolveKeepRecruits` override — this exercises the real default,
    // which must short-circuit before touching `window` (undefined in this
    // Node test environment) for an empty recruits list, exactly like
    // `OpsModule.tsx`'s original `resolveKeepRecruits`.
    const parsed = swimsPageOne();
    const workspace = testWorkspace({ recruits: [] });
    const { onUpdate, calls } = capturingOnUpdate();

    await expect(applySwimCloudRows([parsed], workspace, onUpdate)).resolves.toBeDefined();
    expect(calls[0].recruits).toEqual([]);
  });

  it('an all-skipped capture calls onUpdate zero times and reports zero applied rows', async () => {
    const emptyParse: SwimCloudTeamMeetSwimsParse = {
      swimCloudMeetId: '999999',
      meet: { swimCloudMeetId: '999999', name: 'Empty Meet', format: 'unknown', ruleset: 'unknown', course: 'unknown' },
      gender: 'unknown',
      swims: [],
      events: [],
      rowCount: 0,
    };
    const workspace = testWorkspace();
    const { onUpdate, calls } = capturingOnUpdate();

    const result = await applySwimCloudRows([emptyParse], workspace, onUpdate);

    expect(calls).toHaveLength(0);
    expect(result.appliedRowCount).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it('an empty parses array is a no-op, not an error', async () => {
    const workspace = testWorkspace();
    const { onUpdate, calls } = capturingOnUpdate();

    const result = await applySwimCloudRows([], workspace, onUpdate);

    expect(calls).toHaveLength(0);
    expect(result.appliedRowCount).toBe(0);
    expect(result.totalRowCount).toBe(0);
  });
});

/* ========================================================================== */
/* Round resolution from the per-event results page (fixture F9)               */
/* ========================================================================== */

/**
 * The other half of the real chain: the swims list says *what* was swum, the
 * event page says *which round*, and this is what happens when both are
 * present. Every assertion here runs the real fixtures through the real
 * parsers, so a change to either page's reader shows up as a failure here.
 *
 * The exclusion tests above stay exactly as they are, on purpose. They are the
 * no-event-page case, which is still the honest answer whenever the data is
 * genuinely absent, and it must not quietly stop being reachable.
 */
const eventTwentySix = () => {
  const result = parseMeetEventResultsHtml(
    readFileSync(join(fixturesDir, 'swimcloud-real-meet-event-356467-event26.html'), 'utf8'),
    {
      sourceUrl: 'https://www.swimcloud.com/results/356467/event/26/',
      retrievedAt: '2026-09-10T00:00:00Z',
      track: 'browser-extension',
    },
  );
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.failure.code}`);
  return result.data;
};

describe('buildSwimCloudEventRoundIndex', () => {
  it('keys every swim by the same swimKey the swims list builds', () => {
    const index = buildSwimCloudEventRoundIndex([eventTwentySix()]);
    expect(index.size).toBe(40);
    // Avery Henke's two swims, from the two pages, under one id each.
    expect(index.get('356467:swim:171560737')).toStrictEqual({
      roundSwam: 'A Final',
      meetScore: 20,
      place: 1,
      exhibition: false,
      eventRef: '26',
    });
    expect(index.get('356467:swim:171560736')).toStrictEqual({
      roundSwam: 'Preliminaries',
      place: 1,
      exhibition: false,
      eventRef: '26',
    });
  });

  it('carries no meetScore for a round whose table published none', () => {
    const index = buildSwimCloudEventRoundIndex([eventTwentySix()]);
    // Camden Mask's C Final: the table carries `Pts`, the power index, not a
    // meet Score. Absent means "this round published no meet points", never
    // "it scored zero".
    expect(index.get('356467:swim:171560743')).toStrictEqual({
      roundSwam: 'C Final',
      exhibition: true,
      eventRef: '26',
    });
  });

  it('is empty for no parses, which is what makes the option safe to omit', () => {
    expect(buildSwimCloudEventRoundIndex([]).size).toBe(0);
  });

  it('never indexes a round with no caption — an unknown round must not resolve', () => {
    // `classifyRoundTier(undefined)` is 'UNK', which `packages/core` scores
    // exactly like a real final. Resolving a swim to an unknown round would
    // therefore be worse than not resolving it at all.
    const real = eventTwentySix();
    const captionless: SwimCloudMeetEventResultsParse = {
      ...real,
      rounds: real.rounds.map(({ round: _round, ...rest }) => rest),
    };
    expect(buildSwimCloudEventRoundIndex([captionless]).size).toBe(0);
  });
});

describe('swimCloudTeamMeetSwimsToSwimmerResults — round resolution against F9', () => {
  const resolved = () =>
    swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne(), { eventResults: [eventTwentySix()] });

  it('converts 20 of 30 rows instead of 14, all of the gain from event 26', () => {
    const before = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    const after = resolved();
    // Before: 14 converted, 3 leadoffs + 13 ambiguous duplicates excluded.
    expect(before.men).toHaveLength(14);
    expect(before.skipped).toHaveLength(16);
    expect(before.skipped.filter(s => s.reason === 'ambiguous-round-duplicate')).toHaveLength(13);

    // After: the six previously-excluded "100 Y Breast" swims that event 26
    // holds come back — Avery Henke ×2, Oskar Cebula ×2 (of his three; the
    // third is on event/100/, which this capture does not hold), Camden Mask
    // ×2 — so 14 + 6 = 20, and 13 - 6 = 7 duplicates still excluded.
    expect(after.men).toHaveLength(20);
    expect(after.skipped).toHaveLength(10);
    expect(after.skipped.filter(s => s.reason === 'ambiguous-round-duplicate')).toHaveLength(7);
    // The relay leadoffs are untouched by any of this.
    expect(after.skipped.filter(s => s.reason === 'relay-leadoff')).toHaveLength(3);
    // Eight rows carry a round: the six above plus the two that were already
    // converting round-less — see the lone-swim test below.
    expect(after.men.filter(row => row.roundSwam !== undefined)).toHaveLength(8);
  });

  it('gives Avery Henke both rows, correctly labelled, with the real A Final score', () => {
    const henke = resolved().men.filter(row => row.name === 'Avery Henke' && row.event === '100 Y Breast');
    expect(henke).toHaveLength(2);
    const byRound = new Map(henke.map(row => [row.roundSwam, row]));
    expect([...byRound.keys()].sort()).toStrictEqual(['A Final', 'Preliminaries']);

    const aFinal = byRound.get('A Final');
    expect(aFinal).toMatchObject({ time: '54.27', rank: 1, points: 20, pdfPoints: 20 });
    // The faster swim is the prelim — the fact the swims list's Place column
    // could never express, and the reason both rows read "1st" there.
    const prelim = byRound.get('Preliminaries');
    expect(prelim).toMatchObject({ time: '54.09', rank: 1, points: 0 });
    expect(prelim?.pdfPoints).toBeUndefined();
  });

  it('splits Oskar Cebula into two resolved rows and leaves the third unresolved', () => {
    const result = resolved();
    const cebula = result.men.filter(row => row.name === 'Oskar Cebula' && row.event === '100 Y Breast');
    expect(cebula.map(row => [row.roundSwam, row.time, row.points]).sort()).toStrictEqual([
      ['A Final', '55.45', 13],
      ['Preliminaries', '55.48', 0],
    ]);
    // His third swims-list row (54.86) links `event/100/`, a separate,
    // suffix-less event id this capture does not hold. It is not a third round
    // and it is not guessed at: it stays excluded, named.
    const stillSkipped = result.skipped.filter(
      s => s.reason === 'ambiguous-round-duplicate' && s.subject === 'Oskar Cebula',
    );
    expect(stillSkipped).toHaveLength(1);
    expect(stillSkipped[0].detail).toContain('54.86');
  });

  it('marks Camden Mask exhibition, which the swims list could not say at all', () => {
    const mask = resolved().men.filter(row => row.name === 'Camden Mask');
    expect(mask).toHaveLength(2);
    expect(mask.every(row => row.isExhibition === true)).toBe(true);
    expect(mask.map(row => row.roundSwam).sort()).toStrictEqual(['C Final', 'Preliminaries']);
    // An exhibition row places nowhere, so it takes the sorts-last sentinel
    // rather than the swims list's per-round "17th".
    expect(mask.every(row => row.rank === 9999)).toBe(true);
    // And it scores nothing: C Final published no meet Score here.
    expect(mask.every(row => row.pdfPoints === undefined)).toBe(true);
  });

  it('resolves a lone swim too — the case the duplicate detector never sees', () => {
    // This is the second, quieter half of the same bug, and the fixture proves
    // it is real. Gavin Kock and Mark Eberhard each have exactly ONE 100 Y
    // Breast row on this page (their other swim is on a later page of the
    // list), so neither was ever an "ambiguous duplicate" and both were already
    // converting — with no `roundSwam` at all, which `classifyRoundTier` reads
    // as 'UNK' and `packages/core` scores exactly like a real final.
    //
    // Kock's single row is his PRELIM. It was being scored as a final.
    const before = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    const kockBefore = before.men.find(row => row.name === 'Gavin Kock' && row.event === '100 Y Breast');
    expect(kockBefore).toBeDefined();
    expect(kockBefore?.roundSwam).toBeUndefined();

    const after = resolved();
    expect(after.men.find(row => row.name === 'Gavin Kock' && row.event === '100 Y Breast')).toMatchObject({
      time: '55.69',
      roundSwam: 'Preliminaries',
      points: 0,
    });
    // Eberhard's single row is his A Final, and it now carries its real 12
    // meet points instead of leaving the app to derive them from a per-round
    // place it could not interpret.
    expect(after.men.find(row => row.name === 'Mark Eberhard' && row.event === '100 Y Breast')).toMatchObject({
      time: '55.54',
      roundSwam: 'A Final',
      rank: 7,
      points: 12,
      pdfPoints: 12,
    });
    // Nothing in the converted set carries a round it did not come from.
    for (const row of after.men) {
      if (row.roundSwam === undefined) continue;
      expect(['A Final', 'B Final', 'C Final', 'Preliminaries']).toContain(row.roundSwam);
    }
  });

  it('leaves every swim whose event page is absent exactly as it was', () => {
    const before = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    const after = resolved();
    // Nojus Skirutis's 200 Y Fly pair is on event 15-or-whatever, not 26. No
    // event page for it in this capture, so the exclusion stands, unchanged.
    const skirutis = after.skipped.filter(s => s.subject === 'Nojus Skirutis' && s.reason === 'ambiguous-round-duplicate');
    expect(skirutis).toHaveLength(2);
    // And rows that were converted with no round before are still round-less,
    // not invented.
    const bennettBefore = before.men.find(row => row.name === 'Colton Bennett');
    const bennettAfter = after.men.find(row => row.name === 'Colton Bennett');
    expect(bennettAfter).toStrictEqual(bennettBefore);
    expect(bennettAfter?.roundSwam).toBeUndefined();
  });

  it('an empty eventResults list behaves identically to passing none', () => {
    const none = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne());
    const empty = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne(), { eventResults: [] });
    expect(empty).toStrictEqual(none);
  });

  it('does not let the event page override an explicit swimcloud-points choice', () => {
    // `'swimcloud-points'` is a caller saying "put the power index in the
    // points field". Substituting the meet Score for it would answer a
    // question the caller did not ask.
    const result = swimCloudTeamMeetSwimsToSwimmerResults(swimsPageOne(), {
      eventResults: [eventTwentySix()],
      pointsTrust: 'swimcloud-points',
    });
    const henkeA = result.men.find(row => row.name === 'Avery Henke' && row.roundSwam === 'A Final');
    expect(henkeA?.points).not.toBe(20);
    expect(Number(henkeA?.points)).toBeGreaterThan(100);
  });

  it('threads eventResults through applySwimCloudRows to the workspace', async () => {
    const patches: Partial<Workspace>[] = [];
    const workspace = { id: 'w1', name: 'HSU' } as unknown as Workspace;
    const result = await applySwimCloudRows(
      [swimsPageOne()],
      workspace,
      patch => {
        patches.push(patch);
      },
      { eventResults: [eventTwentySix()], resolveKeepRecruits: () => true },
    );
    expect(result.appliedRowCount).toBe(20);
    const men = patches[0].menResults ?? [];
    const henkeA = men.find(row => row.name === 'Avery Henke' && row.roundSwam === 'A Final');
    expect(henkeA).toMatchObject({ pdfPoints: 20, time: '54.27' });
  });
});
