/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D9 follow-up (architect review 2026-10-13, finding 5): a leg whose named
 * swimmer has only a time-trial swim at the leg event reports one reason on
 * both override paths, and it is not "stroke mismatch".
 *
 * ## Why this test exists
 *
 * With `relayLegsAllowTimeTrials` off, an override that named a recruit by id
 * resolved onto the recruit's time-trial row and then failed the leg check, so
 * the leg read `stroke_mismatch`. An override that named the same swimmer by
 * name resolved onto nothing and read `vacant`. Both legs took the same +3.0 s
 * penalty. The coach could not tell "wrong stroke" from "the swim is a time
 * trial and the setting is off". The reason is now `time_trial_only` on both.
 *
 * Real rows: `tests/fixtures/nsisc-2026-relay-followups-r1.json`. Aiden
 * Killackey's only 100 Free is `Event 201 Men 100 Yard Freestyle Time Trial`
 * (50.82). Scott Doll swims the third leg of Henderson State's 4x100 Free Relay
 * A (1st, 3:02.81).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type RelayLegOverride,
  type ScoringSettings,
  type SwimmerResult,
} from '../packages/core/src/types';
import { simulateRoster } from '../packages/core/src/lib/utils';
import {
  isTimeTrialOnlyForRelayLeg,
  overrideNamesTimeTrialOnlySwimmer,
} from '../packages/core/src/lib/relayLegMatching';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[] };
const menResults = fixture.menResults;

const HSU = 'Henderson State University';
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';
const RELAY_A_KEY = `${HSU}|${M_400FR}|A Final|1|3:02.81`;
const LEG = 2;
const KILLACKEY = 'Aiden Killackey';
const ON: Pick<ScoringSettings, 'relayLegsAllowTimeTrials'> = { relayLegsAllowTimeTrials: true };

const ttRow = menResults.find(r => r.name === KILLACKEY && r.isTimeTrial === true) as SwimmerResult;

/** A recruit whose only 100 Free swim is Killackey's real time trial. */
const ttRecruit: SwimmerResult = {
  ...ttRow,
  id: 'recruit-tt-only',
  name: 'Tara Trial',
  isRecruit: true,
};

/** A recruit whose only swim is a 50 Free: the wrong event for a 100 Free leg. */
const wrongStrokeRecruit: SwimmerResult = {
  ...ttRow,
  id: 'recruit-wrong-event',
  name: 'Wes Wrong',
  isRecruit: true,
  isTimeTrial: false,
  event: 'Event 8 Men 50 Yard Freestyle',
  time: '22.00',
  finalsTime: '22.00',
};

const override = (over: Partial<RelayLegOverride>): RelayLegOverride => ({
  relayEntryKey: RELAY_A_KEY,
  legIndex: LEG,
  source: 'manual',
  ...over,
});

function legOf(overrides: RelayLegOverride[], settings?: ScoringSettings | typeof ON): SwimmerResult {
  const out = simulateRoster(
    menResults,
    [ttRecruit, wrongStrokeRecruit],
    false,
    new Set(['scott doll']),
    overrides,
    undefined,
    undefined,
    settings
  );
  return out.find(
    r =>
      r.isRelay === true &&
      r.team === HSU &&
      r.event === M_400FR &&
      r.roundSwam === 'A Final' &&
      r.rank === 1 &&
      r.relayLegIndex === LEG
  ) as SwimmerResult;
}

describe('a time-trial-only swimmer on a leg, setting off', () => {
  it('by name: the leg reads time_trial_only', () => {
    const leg = legOf([override({ assigneeName: KILLACKEY })]);
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('time_trial_only');
  });

  it('by recruit id: the leg reads time_trial_only, the same reason (it was stroke_mismatch)', () => {
    const leg = legOf([override({ recruitId: ttRecruit.id })]);
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('time_trial_only');
  });

  it('by recruit id and name together (what autofill writes): time_trial_only', () => {
    const leg = legOf([override({ recruitId: ttRecruit.id, assigneeName: ttRecruit.name })]);
    expect(leg.relayMissingLeg?.reason).toBe('time_trial_only');
  });

  it('keeps the vacancy penalty: the relay clock equals a leg nobody was named for', () => {
    const named = legOf([override({ assigneeName: KILLACKEY })]);
    const byId = legOf([override({ recruitId: ttRecruit.id })]);
    const unnamed = legOf([]);
    expect(unnamed.relayMissingLeg?.reason).toBe('vacant');
    expect(named.relayTeamTime).toBe(unnamed.relayTeamTime);
    expect(byId.relayTeamTime).toBe(unnamed.relayTeamTime);
  });

  it('a wrong-event swim is still a stroke mismatch, not a time trial', () => {
    const leg = legOf([override({ recruitId: wrongStrokeRecruit.id })]);
    expect(leg.relayMissingLeg?.reason).toBe('stroke_mismatch');
  });

  it('a time typed with no swimmer named still holds the clock, with no reason', () => {
    const leg = legOf([override({ manualLegTime: '50.00' })]);
    expect(leg.relayMissingLeg).toBeUndefined();
    expect(leg.relayLegVacant).toBe(false);
  });

  it('a named swimmer who does not resolve is vacant even with a time typed (relay swaps store both)', () => {
    const leg = legOf([override({ assigneeName: KILLACKEY, manualLegTime: '50.00' })]);
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('time_trial_only');
  });
});

describe('the setting on', () => {
  it('by name and by recruit id the leg is filled and labelled, with no reason', () => {
    for (const o of [override({ assigneeName: KILLACKEY }), override({ recruitId: ttRecruit.id })]) {
      const leg = legOf([o], ON as ScoringSettings);
      expect(leg.relayLegVacant).toBe(false);
      expect(leg.relayMissingLeg).toBeUndefined();
      expect(leg.relayLegTimeTrial).toBe(true);
    }
  });
});

describe('the helpers', () => {
  const pool = [...menResults.filter(r => !r.isRelay && r.team === HSU), ttRecruit, wrongStrokeRecruit];

  it('isTimeTrialOnlyForRelayLeg: a time trial of the leg event only, and only while the setting is off', () => {
    expect(isTimeTrialOnlyForRelayLeg(ttRow, M_400FR, LEG)).toBe(true);
    expect(isTimeTrialOnlyForRelayLeg(ttRow, M_400FR, LEG, ON)).toBe(false);
    expect(isTimeTrialOnlyForRelayLeg(wrongStrokeRecruit, M_400FR, LEG)).toBe(false);
    // A regular swim of the leg event already matches: nothing is "only" about it.
    const regular = menResults.find(r => !r.isRelay && r.team === HSU && r.event === 'Event 35 Men 100 Yard Freestyle') as
      | SwimmerResult
      | undefined;
    if (regular) expect(isTimeTrialOnlyForRelayLeg(regular, M_400FR, LEG)).toBe(false);
  });

  it('overrideNamesTimeTrialOnlySwimmer: true for a name that resolves only through a time trial', () => {
    expect(
      overrideNamesTimeTrialOnlySwimmer(override({ assigneeName: KILLACKEY }), pool, HSU, M_400FR, LEG, Gender.MEN)
    ).toBe(true);
    expect(
      overrideNamesTimeTrialOnlySwimmer(override({ assigneeName: 'Nobody Atall' }), pool, HSU, M_400FR, LEG, Gender.MEN)
    ).toBe(false);
    expect(
      overrideNamesTimeTrialOnlySwimmer(override({ assigneeName: KILLACKEY }), pool, HSU, M_400FR, LEG, Gender.MEN, ON)
    ).toBe(false);
  });
});
