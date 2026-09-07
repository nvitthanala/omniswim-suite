/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `packages/matrix/src/lib/swimCloudMeetImportBridge.ts`.
 */
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import { swimCloudMeetResultsToSwimmerResults } from '@omniswim/matrix/lib/swimCloudMeetImportBridge';
import type {
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudMeetResultsParse,
  SwimCloudParsedEvent,
  SwimCloudRelay,
  SwimCloudResult,
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
