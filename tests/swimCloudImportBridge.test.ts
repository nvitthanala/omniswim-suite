/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `packages/manager/src/lib/swimCloudImportBridge.ts`.
 */
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import {
  swimCloudMeetResultsToHistoricalSwims,
  swimCloudPersonalBestsToHistoricalSwims,
} from '@omniswim/manager/lib/swimCloudImportBridge';
import type {
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudMeetResultsParse,
  SwimCloudParsedEvent,
  SwimCloudPersonalBest,
  SwimCloudResult,
  SwimCloudSwimmerProfileParse,
} from '@omniswim/swimcloud/parser';

function personalBest(overrides: Partial<SwimCloudPersonalBest> = {}): SwimCloudPersonalBest {
  return {
    label: '100 Yard Butterfly',
    course: 'SCY',
    stroke: 'Butterfly',
    distance: 100,
    time: '49.87',
    date: '2026-02-19',
    meetName: '2026 NSISC Championships',
    ...overrides,
  };
}

function profile(overrides: Partial<SwimCloudSwimmerProfileParse> = {}): SwimCloudSwimmerProfileParse {
  return {
    swimCloudSwimmerId: '3646504',
    name: 'Landon Dehn',
    personalBests: [personalBest()],
    rowCount: 1,
    ...overrides,
  };
}

describe('swimCloudPersonalBestsToHistoricalSwims — the happy path', () => {
  it('converts a clean personal best into a HistoricalSwim tagged source: swimcloud', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(profile(), { team: 'Henderson State', gender: Gender.MEN });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);

    expect(result.swims).toEqual([
      {
        name: 'Landon Dehn',
        team: 'Henderson State',
        gender: Gender.MEN,
        event: '100 Yard Butterfly',
        time: '49.87',
        timeType: 'SCY',
        date: '2026-02-19',
        meetLabel: '2026 NSISC Championships',
        source: 'swimcloud',
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('converts every personal best in a multi-row profile, preserving order', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(
      profile({
        personalBests: [
          personalBest({ label: '100 Yard Butterfly' }),
          personalBest({ label: '200 Yard Freestyle', time: '1:41.02' }),
        ],
      }),
      { team: 'Henderson State', gender: Gender.MEN },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.swims.map((s) => s.event)).toEqual(['100 Yard Butterfly', '200 Yard Freestyle']);
  });
});

describe('swimCloudPersonalBestsToHistoricalSwims — never fabricates a required field', () => {
  it('skips (does not drop silently) a row with no time, and reports why', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(
      profile({ personalBests: [personalBest({ time: undefined, rawTimeToken: '21.4' })] }),
      { team: 'Henderson State', gender: Gender.MEN },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.swims).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('no-time');
    expect(result.skipped[0].personalBest.rawTimeToken).toBe('21.4');
  });

  it('converts a row with an unknown course by omitting timeType, not guessing one', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(
      profile({ personalBests: [personalBest({ course: 'unknown' })] }),
      { team: 'Henderson State', gender: Gender.MEN },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.swims[0]).not.toHaveProperty('timeType');
  });

  it('refuses to convert a profile with no swimmer name, rather than inventing a placeholder', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(profile({ name: undefined }), {
      team: 'Henderson State',
      gender: Gender.MEN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-swimmer-name');
  });

  it('treats a whitespace-only name the same as a missing one', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(profile({ name: '   ' }), {
      team: 'Henderson State',
      gender: Gender.MEN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-swimmer-name');
  });
});

describe('swimCloudPersonalBestsToHistoricalSwims — meet label fallback', () => {
  it('uses the row\'s own meetName when present', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(profile(), {
      team: 'Henderson State',
      gender: Gender.MEN,
      meetLabelFallback: 'Fallback Meet',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.swims[0].meetLabel).toBe('2026 NSISC Championships');
  });

  it('falls back to meetLabelFallback when the row has no meetName', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(
      profile({ personalBests: [personalBest({ meetName: undefined })] }),
      { team: 'Henderson State', gender: Gender.MEN, meetLabelFallback: 'Fallback Meet' },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.swims[0].meetLabel).toBe('Fallback Meet');
  });

  it('omits meetLabel entirely when neither the row nor the options supply one', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(
      profile({ personalBests: [personalBest({ meetName: undefined })] }),
      { team: 'Henderson State', gender: Gender.MEN },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.swims[0]).not.toHaveProperty('meetLabel');
  });
});

describe('swimCloudPersonalBestsToHistoricalSwims — an all-skipped profile is still ok:true', () => {
  it('reports zero swims and every row skipped, not a failure — a real, honest answer', () => {
    const result = swimCloudPersonalBestsToHistoricalSwims(
      profile({ personalBests: [personalBest({ time: undefined }), personalBest({ time: undefined })] }),
      { team: 'Henderson State', gender: Gender.MEN },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.swims).toEqual([]);
    expect(result.skipped).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// swimCloudMeetResultsToHistoricalSwims
// ---------------------------------------------------------------------------

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
    ...overrides,
  };
}

/** One event, one entry, one result — the common case, individually overridable. */
function oneEntryEvent(opts: {
  event?: Partial<SwimCloudEvent>;
  entry?: Partial<SwimCloudEntry>;
  result?: Partial<SwimCloudResult>;
}): SwimCloudParsedEvent {
  const event = swimCloudEvent(opts.event);
  const entry = swimCloudEntry({ eventId: event.eventId, ...opts.entry });
  const result = swimCloudResult(entry.entryId, { eventId: event.eventId, ...opts.result });
  return { event, entries: [entry], results: [result], relays: [] };
}

function meetParse(events: SwimCloudParsedEvent[], overrides: Partial<SwimCloudMeetResultsParse> = {}): SwimCloudMeetResultsParse {
  return {
    swimCloudMeetId: '193735',
    meetName: '2026 NSISC Championships',
    meet: { swimCloudMeetId: '193735', name: '2026 NSISC Championships', format: 'unknown', ruleset: 'unknown', course: 'unknown' },
    events,
    eventHeadingCount: events.length,
    ...overrides,
  };
}

describe('swimCloudMeetResultsToHistoricalSwims — the happy path', () => {
  it('converts a clean individual result into a HistoricalSwim tagged source: swimcloud', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({})]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.swims).toEqual([
      {
        name: 'Riley Adams',
        team: 'Henderson State',
        gender: Gender.WOMEN,
        event: 'Women 100 Yard Butterfly',
        time: '52.10',
        timeType: 'SCY',
        meetLabel: '2026 NSISC Championships',
        source: 'swimcloud',
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('imports every matching swimmer across multiple events — this is the actual point of bulk import', () => {
    resetIds();
    const parse = meetParse([
      oneEntryEvent({ event: { label: 'Women 100 Yard Butterfly' }, entry: { athleteName: 'Riley Adams' } }),
      oneEntryEvent({ event: { label: 'Women 200 Yard Freestyle' }, entry: { athleteName: 'Sam Reyes' }, result: { finalTime: '1:52.30' } }),
      oneEntryEvent({ event: { label: 'Women 50 Yard Freestyle' }, entry: { athleteName: 'Riley Adams' }, result: { finalTime: '23.10' } }),
    ]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.swims.map((s) => `${s.name}: ${s.event}`)).toEqual([
      'Riley Adams: Women 100 Yard Butterfly',
      'Sam Reyes: Women 200 Yard Freestyle',
      'Riley Adams: Women 50 Yard Freestyle',
    ]);
  });

  it('omits timeType when the event course is unknown, rather than guessing', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({ event: { course: 'unknown' } })]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });
    expect(result.swims[0]).not.toHaveProperty('timeType');
  });

  it('falls back to meetLabelFallback when the capture has no meetName', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({})], { meetName: undefined });
    const result = swimCloudMeetResultsToHistoricalSwims(parse, {
      team: 'Henderson State',
      gender: Gender.WOMEN,
      meetLabelFallback: 'Fallback Meet',
    });
    expect(result.swims[0].meetLabel).toBe('Fallback Meet');
  });
});

describe('swimCloudMeetResultsToHistoricalSwims — relays are never converted, ever', () => {
  it('excludes a relay event entirely, even with a perfectly clean finalTime', () => {
    resetIds();
    const parse = meetParse([
      oneEntryEvent({
        event: { kind: 'relay', label: 'Women 200 Yard Freestyle Relay' },
        entry: { athleteName: undefined, relayId: 'relay-1' },
      }),
    ]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.swims).toEqual([]);
    expect(result.skipped).toEqual([{ reason: 'relay-event', eventLabel: 'Women 200 Yard Freestyle Relay' }]);
  });
});

describe('swimCloudMeetResultsToHistoricalSwims — gender and team filtering', () => {
  it('skips an event whose gender does not match the request, with every entry accounted for', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({ event: { gender: 'Men', label: 'Men 100 Yard Butterfly' } })]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.swims).toEqual([]);
    expect(result.skipped).toEqual([
      { reason: 'other-gender', eventLabel: 'Men 100 Yard Butterfly', athleteName: 'Riley Adams' },
    ]);
  });

  it('skips an event whose gender could not be determined at all, rather than guessing which side it belongs to', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({ event: { gender: 'unknown', label: 'Mixed 100 Yard Butterfly' } })]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.skipped).toEqual([
      { reason: 'unknown-gender', eventLabel: 'Mixed 100 Yard Butterfly', athleteName: 'Riley Adams' },
    ]);
  });

  it('skips an entry from a different team, case- and whitespace-insensitively matched for the ones that DO match', () => {
    resetIds();
    const parse = meetParse([
      oneEntryEvent({ entry: { athleteName: 'Riley Adams', teamName: 'Henderson State' } }),
      oneEntryEvent({ entry: { athleteName: 'Marcus Bell', teamName: 'Ouachita Baptist' } }),
    ]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: '  henderson state  ', gender: Gender.WOMEN });

    expect(result.swims.map((s) => s.name)).toEqual(['Riley Adams']);
    expect(result.skipped).toEqual([
      { reason: 'other-team', eventLabel: 'Women 100 Yard Butterfly', athleteName: 'Marcus Bell' },
    ]);
  });

  it('skips an entry with no team name captured at all, distinctly from a wrong-team skip', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({ entry: { teamName: undefined } })]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.skipped).toEqual([
      { reason: 'no-team-name', eventLabel: 'Women 100 Yard Butterfly', athleteName: 'Riley Adams' },
    ]);
  });
});

describe('swimCloudMeetResultsToHistoricalSwims — never fabricates a required field', () => {
  it('skips (does not drop silently) an entry with no finalTime — DQ, no-show, or an unrecognized time token', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({ result: { finalTime: undefined, rawTimeToken: 'DQ', flags: { disqualified: true } } })]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.swims).toEqual([]);
    expect(result.skipped).toEqual([
      { reason: 'no-time', eventLabel: 'Women 100 Yard Butterfly', athleteName: 'Riley Adams' },
    ]);
  });

  it('still imports an exhibition swim, since it has a real finalTime and is genuine swim history', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({ result: { finalTime: '52.10', flags: { exhibition: true } } })]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });

    expect(result.swims).toHaveLength(1);
    expect(result.swims[0].time).toBe('52.10');
  });
});

describe('swimCloudMeetResultsToHistoricalSwims — an all-skipped meet is not a failure', () => {
  it('returns an empty swims array with every row accounted for in skipped, not a thrown error', () => {
    resetIds();
    const parse = meetParse([oneEntryEvent({ event: { gender: 'Men' } })]);
    const result = swimCloudMeetResultsToHistoricalSwims(parse, { team: 'Henderson State', gender: Gender.WOMEN });
    expect(result.swims).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });
});
