/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D9 in the theoretical meet: a time-trial swim is not a relay-leg best unless
 * `ScoringSettings.relayLegsAllowTimeTrials` is on, and a leg that rests on one
 * is labelled (`TheoreticalProjectedRelayLeg.isTimeTrial`).
 *
 * ## Fixtures
 *
 * CONSTRUCTED swims (a name, a team, an event and a time), the way
 * `theoreticalMeetRelays.test.ts` builds its hand-computed cases. No
 * competition standard is typed in.
 */
import { describe, expect, it } from 'vitest';

import { Gender } from '../../packages/core/src/types';
import type { HistoricalSwim } from '../../packages/core/src/types';
import type { SwimCloudAthlete } from '../../packages/swimcloud/src/entities';
import { NSISC_PRESET_SETTINGS } from '../../packages/core/src/lib/scoringDefaults';
import {
  buildTheoreticalMeetSeeds,
  type TheoreticalMeetInput,
  type TheoreticalMeetSeeds,
  type TheoreticalMeetTeamInput,
  type TheoreticalProjectedRelay,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';

const ALPHA = 'Alpha University';
const RELAY = '200 Free Relay SCY';

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

/** Five swimmers, each with a 50 Free. A1 is the fastest and his 50 Free is a time trial. */
function alpha(timeTrial: Partial<HistoricalSwim>, withFifth: boolean): TheoreticalMeetTeamInput {
  const rows: Record<string, HistoricalSwim[]> = {
    A1: [swim('A1', '50 Free SCY', '20.00', timeTrial)],
    A2: [swim('A2', '50 Free SCY', '20.50')],
    A3: [swim('A3', '50 Free SCY', '21.00')],
    A4: [swim('A4', '50 Free SCY', '21.50')],
    ...(withFifth ? { A5: [swim('A5', '50 Free SCY', '21.80')] } : {}),
  };
  return {
    teamName: ALPHA,
    gender: Gender.MEN,
    rosterStatus: 'parsed',
    athletes: Object.entries(rows).map(([name, swims]) => ({ athlete: athlete(name), swims })),
  };
}

const ON = { ...NSISC_PRESET_SETTINGS, relayLegsAllowTimeTrials: true };

function build(team: TheoreticalMeetTeamInput, settings = NSISC_PRESET_SETTINGS): TheoreticalMeetSeeds {
  const input: TheoreticalMeetInput = {
    meetId: 'ws-relay-time-trial',
    course: 'SCY',
    scoringSettings: settings,
    conference: 'NSISC',
    includeRelays: true,
    teams: [team],
  };
  return buildTheoreticalMeetSeeds(input);
}

const relay = (seeds: TheoreticalMeetSeeds): TheoreticalProjectedRelay | undefined =>
  seeds.relayEntries.find(r => r.team === ALPHA && r.event === RELAY);

describe('a 50 Free swim flagged isTimeTrial', () => {
  const flag = { isTimeTrial: true as const };

  it('is not a leg best by default: the next swimmer takes the leg', () => {
    const r = relay(build(alpha(flag, true)));
    expect(r).toBeDefined();
    expect((r as TheoreticalProjectedRelay).legs.map(l => l.name).sort()).toStrictEqual(['A2', 'A3', 'A4', 'A5']);
    expect((r as TheoreticalProjectedRelay).legs.some(l => l.isTimeTrial === true)).toBe(false);
  });

  it('with no fifth swimmer the relay is absent, not built on the time trial', () => {
    const seeds = build(alpha(flag, false));
    expect(relay(seeds)).toBeUndefined();
    const absent = seeds.report.teams[0]!.relayReport?.absent.find(a => a.event === RELAY);
    expect(absent).toBeDefined();
    expect(absent?.missingLegs.length).toBeGreaterThan(0);
  });

  it('opted in, uses the time trial and labels that leg', () => {
    const r = relay(build(alpha(flag, true), ON)) as TheoreticalProjectedRelay;
    expect(r.legs.map(l => l.name).sort()).toStrictEqual(['A1', 'A2', 'A3', 'A4']);
    expect(r.legs.filter(l => l.isTimeTrial === true).map(l => l.name)).toStrictEqual(['A1']);
  });

  it('a settings object without the field builds the same relay as one that says false', () => {
    const legacy = relay(build(alpha(flag, true), { ...NSISC_PRESET_SETTINGS }));
    const explicit = relay(build(alpha(flag, true), { ...NSISC_PRESET_SETTINGS, relayLegsAllowTimeTrials: false }));
    expect(explicit).toStrictEqual(legacy);
  });
});

describe('a swim whose label says Time Trial', () => {
  const labelled = { event: '50 Free SCY Time Trial' };
  it('is held off the leg by default and labelled when allowed', () => {
    const off = relay(build(alpha(labelled, true))) as TheoreticalProjectedRelay;
    expect(off.legs.map(l => l.name).sort()).toStrictEqual(['A2', 'A3', 'A4', 'A5']);
    const on = relay(build(alpha(labelled, true), ON)) as TheoreticalProjectedRelay;
    expect(on.legs.filter(l => l.isTimeTrial === true).map(l => l.name)).toStrictEqual(['A1']);
  });
});
