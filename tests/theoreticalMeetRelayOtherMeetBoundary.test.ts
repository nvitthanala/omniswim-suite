/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Architect re-review 2026-10-13, finding 3: a history swim of another meet is
 * not a time trial because its event number is past the build's
 * `scoredEventNumberMax`.
 *
 * ## Why this test exists
 *
 * The theoretical meet builds relays from history swims. A history swim is
 * labelled with the event number of the meet it came from
 * (`Event 45 Men 50 Yard Freestyle` at a meet that scored through 60). The
 * build's `scoringSettings` carry the boundary of ANOTHER meet, here 42.
 * `legBestsOf`, `makeLeg` and the leg matchers read that boundary, so the swim
 * was held off the leg as a time trial, and a leg that took it was labelled one.
 *
 * `HistoricalSwim` records no boundary of its own meet, so such a swim is a
 * time trial by its `isTimeTrial` flag or a "Time Trial" in its label only.
 *
 * ## Fixtures
 *
 * CONSTRUCTED swims, the way `theoreticalMeetRelayTimeTrials.test.ts` builds
 * them. No competition standard is typed in.
 */
import { describe, expect, it } from 'vitest';

import { Gender } from '../packages/core/src/types';
import type { HistoricalSwim } from '../packages/core/src/types';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import {
  buildTheoreticalMeetSeeds,
  type TheoreticalMeetInput,
  type TheoreticalMeetSeeds,
  type TheoreticalMeetTeamInput,
  type TheoreticalProjectedRelay,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';

const ALPHA = 'Alpha University';
const RELAY = '200 Free Relay SCY';
/** The numbered label of another meet's 50 Free: event 45, past this build's boundary of 42. */
const NUMBERED_50_FREE = 'Event 45 Men 50 Yard Freestyle';

const swim = (name: string, event: string, time: string, extra: Partial<HistoricalSwim> = {}): HistoricalSwim => ({
  name,
  team: ALPHA,
  gender: Gender.MEN,
  event,
  time,
  timeType: 'SCY',
  source: 'swimcloud',
  ...extra,
});

const athlete = (name: string): SwimCloudAthlete => ({
  name,
  swimCloudSwimmerId: `${ALPHA}:${name}`,
  classYear: 'JR',
  gender: 'Men',
});

/** Five swimmers with a 50 Free each. A1 is the fastest and his is the numbered label of another meet. */
function alpha(a1: Partial<HistoricalSwim>): TheoreticalMeetTeamInput {
  const rows: Record<string, HistoricalSwim[]> = {
    A1: [swim('A1', NUMBERED_50_FREE, '20.00', a1)],
    A2: [swim('A2', '50 Free SCY', '20.50')],
    A3: [swim('A3', '50 Free SCY', '21.00')],
    A4: [swim('A4', '50 Free SCY', '21.50')],
    A5: [swim('A5', '50 Free SCY', '21.80')],
  };
  return {
    teamName: ALPHA,
    gender: Gender.MEN,
    rosterStatus: 'parsed',
    athletes: Object.entries(rows).map(([name, swims]) => ({ athlete: athlete(name), swims })),
  };
}

const BOUNDED = { ...NSISC_PRESET_SETTINGS, scoredEventNumberMax: 42 };
const BOUNDED_ON = { ...BOUNDED, relayLegsAllowTimeTrials: true };

function relayOf(team: TheoreticalMeetTeamInput, settings = BOUNDED): TheoreticalProjectedRelay | undefined {
  const input: TheoreticalMeetInput = {
    meetId: 'ws-relay-other-meet-boundary',
    course: 'SCY',
    scoringSettings: settings,
    conference: 'NSISC',
    includeRelays: true,
    teams: [team],
  };
  const seeds: TheoreticalMeetSeeds = buildTheoreticalMeetSeeds(input);
  return seeds.relayEntries.find(r => r.team === ALPHA && r.event === RELAY);
}

describe('a numbered history swim past the build boundary', () => {
  it('is a leg best, and its leg is not labelled a time trial', () => {
    const relay = relayOf(alpha({}));
    expect(relay).toBeDefined();
    const legs = (relay as TheoreticalProjectedRelay).legs;
    expect(legs.map(l => l.name).sort()).toStrictEqual(['A1', 'A2', 'A3', 'A4']);
    expect(legs.some(l => l.isTimeTrial === true)).toBe(false);
  });

  it('with time trials allowed, its leg still carries no time-trial label', () => {
    const legs = (relayOf(alpha({}), BOUNDED_ON) as TheoreticalProjectedRelay).legs;
    expect(legs.map(l => l.name).sort()).toStrictEqual(['A1', 'A2', 'A3', 'A4']);
    expect(legs.some(l => l.isTimeTrial === true)).toBe(false);
  });

  it('a swim its own flag marks a time trial is still held off the leg', () => {
    const legs = (relayOf(alpha({ isTimeTrial: true })) as TheoreticalProjectedRelay).legs;
    expect(legs.map(l => l.name).sort()).toStrictEqual(['A2', 'A3', 'A4', 'A5']);
  });

  it('a swim whose label says Time Trial is still held off the leg', () => {
    const labelled = { event: `${NUMBERED_50_FREE} Time Trial` };
    const legs = (relayOf(alpha(labelled)) as TheoreticalProjectedRelay).legs;
    expect(legs.map(l => l.name).sort()).toStrictEqual(['A2', 'A3', 'A4', 'A5']);
  });
});
