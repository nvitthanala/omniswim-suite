/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An override that names a swimmer by recruit id and one that names them by
 * name choose the same swim for a leg (improvement plan 2026-10-10, advisor
 * follow-up of 2026-10-13).
 *
 * ## Why this test exists
 *
 * `resolveOverrideAssignee` returned the row the recruit id points at, whatever
 * the leg. When that row was a time trial (setting off) or a swim of another
 * event, the leg went vacant, while the same swimmer named by name was filled
 * from their program swim at the leg event. Both paths now pick the fastest of
 * the swimmer's swims that may fill the leg.
 *
 * Synthetic rows: `tests/fixtures/nsisc-2026-dq-relay-leg.json` (invented
 * swimmers and teams, not a published result). Test Swimmer A2
 * (Test Team A) swam the 100 Breast in Event 25 (1:04.27, A Final) and again in
 * Event 938 (1:06.02), a swim past the scored program (the meet's scored
 * events end at Event 42). Leg 1 of the 4x100 medley relay is the 100 Breast.
 * The id of her Event 938 row stands for "a swim of hers that is not the one to
 * use". A row with a name or event the fixture does not hold is derived from
 * a fixture row, and says so.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender, type RelayLegOverride, type SwimmerResult } from '../packages/core/src/types';
import { simulateRoster } from '../packages/core/src/lib/utils';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import { resolveOverrideAssignee } from '../packages/core/src/lib/relayLegMatching';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const womenResults = (
  JSON.parse(
    readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-dq-relay-leg.json'), 'utf8')
  ) as { womenResults: SwimmerResult[] }
).womenResults;

const DSU = 'Test Team A';
const W_400MR = 'Event 19 Women 4x100 Yard Medley Relay';
const LEG = 1;
const OFF = { relayLegsAllowTimeTrials: false, scoredEventNumberMax: 42 };
const ON = { relayLegsAllowTimeTrials: true, scoredEventNumberMax: 42 };

const programBreast = womenResults.find(
  r => r.name === 'Test Swimmer A2' && r.event === 'Event 25 Women 100 Yard Breaststroke'
) as SwimmerResult;
const postMeetBreast = womenResults.find(
  r => r.name === 'Test Swimmer A2' && r.event === 'Event 938 Women 100 Yard Breaststroke'
) as SwimmerResult;
const individuals = womenResults.filter(r => !r.isRelay);

/** Test Swimmer A2's fixture row, as a recruit entered for a 50 Free: the wrong event for the leg. */
const recruitAtFifty: SwimmerResult = {
  ...programBreast,
  id: 'recruit-a2-50free',
  isRecruit: true,
  event: 'Event 8 Women 50 Yard Freestyle',
  time: '24.00',
  finalsTime: '24.00',
  roundSwam: 'Preliminaries',
};

const override = (over: Partial<RelayLegOverride>): RelayLegOverride => ({
  relayEntryKey: 'unused',
  legIndex: LEG,
  source: 'manual',
  ...over,
});

const resolve = (o: RelayLegOverride, pool: SwimmerResult[], settings: typeof OFF) =>
  resolveOverrideAssignee(o, pool, DSU, W_400MR, LEG, Gender.WOMEN, settings);

describe('the fixture rows', () => {
  it('Test Swimmer A2 has a program swim and a post-meet swim at the leg event', () => {
    expect([programBreast.time, programBreast.isTimeTrial]).toStrictEqual(['1:04.27', false]);
    expect([postMeetBreast.time, postMeetBreast.isTimeTrial]).toStrictEqual(['1:06.02', false]);
  });
});

describe('the id of a swim that may not fill the leg stands for its swimmer', () => {
  it('setting off: the id of the post-meet swim fills the leg from her program swim', () => {
    const got = resolve(override({ recruitId: postMeetBreast.id }), individuals, OFF);
    expect(got?.id).toBe(programBreast.id);
    expect(got?.time).toBe('1:04.27');
  });

  it('by id and by name pick the same swim, setting off and on', () => {
    for (const settings of [OFF, ON]) {
      const byId = resolve(override({ recruitId: postMeetBreast.id }), individuals, settings);
      const byName = resolve(override({ assigneeName: 'Test Swimmer A2' }), individuals, settings);
      expect(byId?.id).toBe(byName?.id);
      expect(byId?.id).toBe(programBreast.id);
    }
  });

  it('by id and name together (what autofill writes) pick the same swim', () => {
    const got = resolve(
      override({ recruitId: postMeetBreast.id, assigneeName: 'Test Swimmer A2' }),
      individuals,
      OFF
    );
    expect(got?.id).toBe(programBreast.id);
  });

  it('a recruit row at another event does not shadow the swimmer program swim', () => {
    const pool = [...individuals, recruitAtFifty];
    const got = resolve(override({ recruitId: recruitAtFifty.id }), pool, OFF);
    expect(got?.id).toBe(programBreast.id);
  });

  it('the leg is filled end to end, and the relay clock equals the name path clock', () => {
    const medleyA = womenResults.find(
      r => r.isRelay && r.event === W_400MR && r.team === DSU && r.roundSwam === 'A Final'
    ) as SwimmerResult;
    const key = relayEntryKey(medleyA);
    const run = (o: Partial<RelayLegOverride>) =>
      simulateRoster(
        womenResults,
        [],
        false,
        new Set(['test swimmer a3']),
        [{ relayEntryKey: key, legIndex: LEG, source: 'manual', ...o }],
        undefined,
        undefined,
        OFF
      ).find(
        r => r.isRelay === true && r.team === DSU && r.event === W_400MR && r.roundSwam === 'A Final' && r.relayLegIndex === LEG
      ) as SwimmerResult;
    const byId = run({ recruitId: postMeetBreast.id });
    const byName = run({ assigneeName: 'Test Swimmer A2' });
    expect(byName.relayLegVacant).toBeFalsy();
    expect(byId.relayLegVacant).toBeFalsy();
    expect(byId.name).toBe('Test Swimmer A2');
    expect(byId.relayTeamTime).toBe(byName.relayTeamTime);
  });
});

describe('what stays as it was', () => {
  it('an id whose swimmer has no swim that fits returns its own row (the leg check says why)', () => {
    const lone: SwimmerResult = { ...recruitAtFifty, id: 'recruit-lone', name: 'Lone Recruit' };
    const got = resolve(override({ recruitId: lone.id }), [...individuals, lone], OFF);
    expect(got?.id).toBe(lone.id);
  });

  it('with no leg named, the id returns its own row', () => {
    const got = resolveOverrideAssignee(
      override({ recruitId: postMeetBreast.id }),
      individuals,
      DSU
    );
    expect(got?.id).toBe(postMeetBreast.id);
  });

  it('an id of another team resolves nothing', () => {
    const got = resolveOverrideAssignee(
      override({ recruitId: postMeetBreast.id }),
      individuals,
      'Test Team B',
      W_400MR,
      LEG,
      Gender.WOMEN,
      OFF
    );
    expect(got).toBeNull();
  });
});
