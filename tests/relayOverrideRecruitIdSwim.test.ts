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
 * Real rows: `tests/fixtures/nsisc-2026-dq-relay-leg.json`. Kiera Cloete
 * (Delta State) swam the 100 Breast in Event 25 (1:03.53, A Final) and again in
 * Event 938 (1:05.16), a swim past the scored program (the meet's scored
 * events end at Event 42). Leg 1 of the 4x100 medley relay is the 100 Breast.
 * The id of her Event 938 row stands for "a swim of hers that is not the one to
 * use". A row with a name or event the real data does not hold is derived from
 * a real row, and says so.
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

const DSU = 'Delta State University';
const W_400MR = 'Event 19 Women 4x100 Yard Medley Relay';
const LEG = 1;
const OFF = { relayLegsAllowTimeTrials: false, scoredEventNumberMax: 42 };
const ON = { relayLegsAllowTimeTrials: true, scoredEventNumberMax: 42 };

const kieraProgram = womenResults.find(
  r => r.name === 'Kiera Cloete' && r.event === 'Event 25 Women 100 Yard Breaststroke'
) as SwimmerResult;
const kieraPostMeet = womenResults.find(
  r => r.name === 'Kiera Cloete' && r.event === 'Event 938 Women 100 Yard Breaststroke'
) as SwimmerResult;
const individuals = womenResults.filter(r => !r.isRelay);

/** Kiera Cloete's real row, as a recruit entered for a 50 Free: the wrong event for the leg. */
const kieraRecruitAtFifty: SwimmerResult = {
  ...kieraProgram,
  id: 'recruit-kiera-50free',
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

describe('the real rows', () => {
  it('Kiera Cloete has a program swim and a post-meet swim at the leg event', () => {
    expect([kieraProgram.time, kieraProgram.isTimeTrial]).toStrictEqual(['1:03.53', false]);
    expect([kieraPostMeet.time, kieraPostMeet.isTimeTrial]).toStrictEqual(['1:05.16', false]);
  });
});

describe('the id of a swim that may not fill the leg stands for its swimmer', () => {
  it('setting off: the id of the post-meet swim fills the leg from her program swim', () => {
    const got = resolve(override({ recruitId: kieraPostMeet.id }), individuals, OFF);
    expect(got?.id).toBe(kieraProgram.id);
    expect(got?.time).toBe('1:03.53');
  });

  it('by id and by name pick the same swim, setting off and on', () => {
    for (const settings of [OFF, ON]) {
      const byId = resolve(override({ recruitId: kieraPostMeet.id }), individuals, settings);
      const byName = resolve(override({ assigneeName: 'Kiera Cloete' }), individuals, settings);
      expect(byId?.id).toBe(byName?.id);
      expect(byId?.id).toBe(kieraProgram.id);
    }
  });

  it('by id and name together (what autofill writes) pick the same swim', () => {
    const got = resolve(
      override({ recruitId: kieraPostMeet.id, assigneeName: 'Kiera Cloete' }),
      individuals,
      OFF
    );
    expect(got?.id).toBe(kieraProgram.id);
  });

  it('a recruit row at another event does not shadow the swimmer program swim', () => {
    const pool = [...individuals, kieraRecruitAtFifty];
    const got = resolve(override({ recruitId: kieraRecruitAtFifty.id }), pool, OFF);
    expect(got?.id).toBe(kieraProgram.id);
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
        new Set(['pia delkeskamp']),
        [{ relayEntryKey: key, legIndex: LEG, source: 'manual', ...o }],
        undefined,
        undefined,
        OFF
      ).find(
        r => r.isRelay === true && r.team === DSU && r.event === W_400MR && r.roundSwam === 'A Final' && r.relayLegIndex === LEG
      ) as SwimmerResult;
    const byId = run({ recruitId: kieraPostMeet.id });
    const byName = run({ assigneeName: 'Kiera Cloete' });
    expect(byName.relayLegVacant).toBeFalsy();
    expect(byId.relayLegVacant).toBeFalsy();
    expect(byId.name).toBe('Kiera Cloete');
    expect(byId.relayTeamTime).toBe(byName.relayTeamTime);
  });
});

describe('what stays as it was', () => {
  it('an id whose swimmer has no swim that fits returns its own row (the leg check says why)', () => {
    const lone: SwimmerResult = { ...kieraRecruitAtFifty, id: 'recruit-lone', name: 'Lone Recruit' };
    const got = resolve(override({ recruitId: lone.id }), [...individuals, lone], OFF);
    expect(got?.id).toBe(lone.id);
  });

  it('with no leg named, the id returns its own row', () => {
    const got = resolveOverrideAssignee(
      override({ recruitId: kieraPostMeet.id }),
      individuals,
      DSU
    );
    expect(got?.id).toBe(kieraPostMeet.id);
  });

  it('an id of another team resolves nothing', () => {
    const got = resolveOverrideAssignee(
      override({ recruitId: kieraPostMeet.id }),
      individuals,
      'Henderson State University',
      W_400MR,
      LEG,
      Gender.WOMEN,
      OFF
    );
    expect(got).toBeNull();
  });
});
