/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D9 follow-up, individual seeds: a time-trial swim never seeds an INDIVIDUAL event of a theoretical meet,
 * flagged (`isTimeTrial`) or labelled ("Time Trial"). The seed builder holds no second selector (rule 3 of
 * `theoreticalMeetSeeds.ts`): it reads `categorizeBestEvents`, which skips a flagged swim
 * (`athleteHistory.ts`, "A time trial is not the program event") and refuses a labelled one through
 * `isEventOffered`. So the individual path already agrees with the relay-leg path, where a time trial is
 * held off unless `relayLegsAllowTimeTrials` is on. This file pins that agreement, so a change in the
 * selector cannot move it silently. The event has NO seed when the time trial is the only swim; no slower
 * time is invented.
 *
 * CONSTRUCTED swims. No competition standard is typed in.
 */
import { describe, expect, it } from 'vitest';

import { Gender } from '../packages/core/src/types';
import type { HistoricalSwim } from '../packages/core/src/types';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { buildTheoreticalMeetSeeds } from '../packages/manager/src/lib/theoreticalMeetSeeds';

const TEAM = 'Alpha University';

const swim = (event: string, time: string, extra: Partial<HistoricalSwim> = {}): HistoricalSwim => ({
  name: 'A1',
  team: TEAM,
  gender: Gender.MEN,
  event,
  time,
  timeType: 'SCY',
  source: 'swimcloud',
  ...extra,
});

const athlete: SwimCloudAthlete = { name: 'A1', swimCloudSwimmerId: `${TEAM}:A1`, classYear: 'JR', gender: 'Men' };

function seeds(swims: HistoricalSwim[], settings = NSISC_PRESET_SETTINGS): [string, string][] {
  const built = buildTheoreticalMeetSeeds({
    meetId: 'ws-individual-time-trial',
    course: 'SCY',
    scoringSettings: settings,
    conference: 'NSISC',
    teams: [{ teamName: TEAM, gender: Gender.MEN, rosterStatus: 'parsed', athletes: [{ athlete, swims }] }],
  });
  return built.rows.map(r => [r.event, r.time]);
}

describe('a time trial does not seed an individual event', () => {
  const official = swim('50 Free SCY', '21.00');

  it('an official swim seeds the event (control)', () => {
    expect(seeds([official])).toStrictEqual([['50 Free SCY', '21.00']]);
  });

  it('a faster flagged time trial does not displace the official seed', () => {
    expect(seeds([official, swim('50 Free SCY', '20.00', { isTimeTrial: true })])).toStrictEqual([['50 Free SCY', '21.00']]);
  });

  it('a flagged time trial alone leaves the event with no seed', () => {
    expect(seeds([swim('50 Free SCY', '20.00', { isTimeTrial: true })])).toStrictEqual([]);
  });

  it('a labelled time trial alone leaves the event with no seed', () => {
    expect(seeds([swim('Event 12 Men 50 Yard Freestyle Time Trial', '20.00')])).toStrictEqual([]);
  });

  it('relayLegsAllowTimeTrials does not reach an individual seed', () => {
    const on = { ...NSISC_PRESET_SETTINGS, relayLegsAllowTimeTrials: true };
    expect(seeds([swim('50 Free SCY', '20.00', { isTimeTrial: true })], on)).toStrictEqual([]);
  });
});
