/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A swim with no time fills no relay leg (improvement plan 2026-10-10,
 * follow-up from the advisor review of 2026-10-13).
 *
 * ## Why this test exists
 *
 * `swimmerMatchesRelayLeg` read only the swim's event and its time-trial flag.
 * A disqualified swim (`time: 'DQ'`) of the leg's event matched, so the leg
 * candidate list offered it. Real case: Chloe Skelt (Delta State) is `DQ` in
 * the Event 25 100 Breast prelims, and she was listed for leg 1 (the 100
 * Breast) of the 4x100 medley relay, ranked last because `DQ` sorts as
 * `Infinity`. A name override on a swimmer with `DFS` resolved onto the swim
 * and put `NaN` in the relay clock.
 *
 * Real rows: `tests/fixtures/nsisc-2026-dq-relay-leg.json`, copied verbatim
 * from `data/meets.json` (see its `_provenance`). A test that needs a shape
 * the real data does not hold says so and names the real rows it varies.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type RelayLegOverride,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { simulateRoster } from '../packages/core/src/lib/utils';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import {
  hasRelayLegTime,
  listEligibleRelayLegCandidates,
  resolveOverrideAssignee,
  swimmerMatchesRelayLeg,
} from '../packages/core/src/lib/relayLegMatching';
import { relayLegHistoryCandidates } from '../packages/core/src/lib/relayLegHistoryCandidates';
import { historicalSwimFromResult } from '../packages/core/src/lib/athleteHistory';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-dq-relay-leg.json'), 'utf8')
) as { womenResults: SwimmerResult[] };
const womenResults = fixture.womenResults;

const DSU = 'Delta State University';
const HSU = 'Henderson State University';
const W_400MR = 'Event 19 Women 4x100 Yard Medley Relay';
const W_400FR = 'Event 41 Women 4x100 Yard Freestyle Relay';
const BREAST_LEG = 1;
const FREE_LEG = 2;
const OFF = { relayLegsAllowTimeTrials: false, scoredEventNumberMax: 42 };
const ON = { relayLegsAllowTimeTrials: true, scoredEventNumberMax: 42 };

const row = (name: string, event: string, round?: string): SwimmerResult =>
  womenResults.find(
    r => !r.isRelay && r.name === name && r.event === event && (!round || r.roundSwam === round)
  ) as SwimmerResult;

const skeltDq = row('Chloe Skelt', 'Event 25 Women 100 Yard Breaststroke');
const skeltTimeTrial = row('Chloe Skelt', 'Event 400 Women 100 Yard Breaststroke Time Trial');
const cloete = row('Kiera Cloete', 'Event 25 Women 100 Yard Breaststroke');
const rhodesDq = row('Allie Grace Rhodes', 'Event 34 Women 100 Yard Freestyle');
const handDfs = row('Emily Hand', 'Event 34 Women 100 Yard Freestyle');

const individuals = womenResults.filter(r => !r.isRelay);

describe('the real rows say what the fixture is for', () => {
  it('Chloe Skelt is DQ with no other 100 Breast but a time trial', () => {
    expect(skeltDq.time).toBe('DQ');
    expect(skeltTimeTrial.time).toBe('1:02.63R');
    expect(skeltTimeTrial.isTimeTrial).toBe(true);
  });

  it('Allie Grace Rhodes has a legal prelims time under a DQ clock; Emily Hand is DFS', () => {
    expect([rhodesDq.time, rhodesDq.prelimsTime]).toStrictEqual(['DQ', '56.76']);
    expect(handDfs.time).toBe('DFS');
  });
});

describe('hasRelayLegTime', () => {
  it('is false for every code that is not a time', () => {
    for (const time of ['DQ', 'DFS', 'SCR', 'NS', 'NT', 'DNF', 'DNS', 'DSQ', '', '   ', 'N/A', '---', '0.00']) {
      expect(hasRelayLegTime({ time }), JSON.stringify(time)).toBe(false);
    }
  });

  it('is true for a finished swim, with or without a record flag', () => {
    for (const time of ['22.04', '1:02.63R', '1:40.07', '16:12.50']) {
      expect(hasRelayLegTime({ time }), time).toBe(true);
    }
  });

  it('reads the row clock, not the prelims clock', () => {
    expect(hasRelayLegTime(rhodesDq)).toBe(false);
  });
});

describe('a swim with no time matches no leg', () => {
  it('the DQ row is the leg event and still matches no leg, with the time-trial setting on or off', () => {
    expect(swimmerMatchesRelayLeg(skeltDq, W_400MR, BREAST_LEG, OFF)).toBe(false);
    expect(swimmerMatchesRelayLeg(skeltDq, W_400MR, BREAST_LEG, ON)).toBe(false);
    expect(swimmerMatchesRelayLeg(cloete, W_400MR, BREAST_LEG, OFF)).toBe(true);
  });

  it('the candidate list for the breast leg leaves out the DQ, setting off', () => {
    const list = listEligibleRelayLegCandidates(individuals, W_400MR, BREAST_LEG, new Set(), DSU, undefined, OFF);
    expect(list.map(s => `${s.name} ${s.time}`)).toStrictEqual([
      'Kiera Cloete 1:03.53',
      'Pia Delkeskamp 1:04.72',
      'Hannah Jones 1:05.46',
    ]);
  });

  it('with the setting on, Chloe Skelt is offered by her time trial, never by the DQ', () => {
    const list = listEligibleRelayLegCandidates(individuals, W_400MR, BREAST_LEG, new Set(), DSU, undefined, ON);
    expect(list.map(s => `${s.name} ${s.time}`)).toStrictEqual([
      'Chloe Skelt 1:02.63R',
      'Kiera Cloete 1:03.53',
      'Pia Delkeskamp 1:04.72',
      'Kiera Cloete 1:05.16',
      'Hannah Jones 1:05.46',
    ]);
    expect(list[0].relayLegTimeTrial).toBe(true);
    expect(list.some(s => s.time === 'DQ')).toBe(false);
  });

  it('a DQ clock over a legal prelims time is a DQ, and a DFS is not a candidate (Henderson State 100 Free)', () => {
    for (const settings of [OFF, ON]) {
      const list = listEligibleRelayLegCandidates(individuals, W_400FR, FREE_LEG, new Set(), HSU, undefined, settings);
      expect(list).toStrictEqual([]);
    }
  });
});

describe('an override cannot fill a leg with a swim that has no time', () => {
  const entryKeyOf = (event: string, team: string, round: string): string => {
    const leg = womenResults.find(r => r.isRelay && r.event === event && r.team === team && r.roundSwam === round)!;
    return relayEntryKey(leg);
  };
  const FREE_A_KEY = entryKeyOf(W_400FR, HSU, 'A Final');
  const MEDLEY_A_KEY = entryKeyOf(W_400MR, DSU, 'A Final');

  const legOf = (
    event: string,
    team: string,
    round: string,
    legIndex: number,
    overrides: RelayLegOverride[],
    leaving: string
  ): SwimmerResult =>
    simulateRoster(womenResults, [], false, new Set([leaving]), overrides, undefined, undefined, OFF).find(
      r => r.isRelay === true && r.team === team && r.event === event && r.roundSwam === round && r.relayLegIndex === legIndex
    ) as SwimmerResult;

  const freeLeg = (o: Partial<RelayLegOverride>): SwimmerResult =>
    legOf(W_400FR, HSU, 'A Final', FREE_LEG, [
      { relayEntryKey: FREE_A_KEY, legIndex: FREE_LEG, source: 'manual', ...o },
    ], 'raven roberts');

  it('by name: a DFS swimmer leaves the leg vacant, and the relay clock stays a time', () => {
    const leg = freeLeg({ assigneeName: 'Emily Hand' });
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('vacant');
    expect(leg.relayTeamTime).toMatch(/^\d+:\d\d\.\d\d$/);
  });

  it('by name: a swimmer DQ at the leg event leaves the leg vacant', () => {
    const leg = freeLeg({ assigneeName: 'Allie Grace Rhodes' });
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('vacant');
  });

  it('by recruit id: the DQ row itself is not a swimmer for the leg', () => {
    const leg = freeLeg({ recruitId: rhodesDq.id });
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.relayMissingLeg?.reason).toBe('vacant');
    expect(
      resolveOverrideAssignee(
        { relayEntryKey: FREE_A_KEY, legIndex: FREE_LEG, source: 'manual', recruitId: rhodesDq.id },
        individuals,
        HSU,
        W_400FR,
        FREE_LEG,
        Gender.WOMEN,
        OFF
      )
    ).toBeNull();
  });

  it('a swimmer with a time at the leg event still fills it (Kiera Cloete, 1:03.53)', () => {
    const leg = legOf(
      W_400MR,
      DSU,
      'A Final',
      BREAST_LEG,
      [{ relayEntryKey: MEDLEY_A_KEY, legIndex: BREAST_LEG, source: 'manual', assigneeName: 'Kiera Cloete' }],
      'pia delkeskamp'
    );
    expect(leg.relayLegVacant).toBeFalsy();
    expect(leg.name).toBe('Kiera Cloete');
  });

  it('Chloe Skelt by name resolves onto her time trial only when the setting is on', () => {
    const named: RelayLegOverride = {
      relayEntryKey: MEDLEY_A_KEY,
      legIndex: BREAST_LEG,
      source: 'manual',
      assigneeName: 'Chloe Skelt',
    };
    const off = resolveOverrideAssignee(named, individuals, DSU, W_400MR, BREAST_LEG, Gender.WOMEN, OFF);
    expect(off).toBeNull();
    const on = resolveOverrideAssignee(named, individuals, DSU, W_400MR, BREAST_LEG, Gender.WOMEN, ON);
    expect(on?.time).toBe('1:02.63R');
    expect(on?.relayLegTimeTrial).toBe(true);
  });
});

describe('a row with no time hides no history swim (history rule 3)', () => {
  // Allie Grace Rhodes's real prelims 100 Free (56.76), as a loaded meet stores
  // it in history: `historicalSwimFromResult`, the Vitor Sa precedent of R1.
  const prelim = historicalSwimFromResult(
    { ...rhodesDq, time: rhodesDq.prelimsTime as string },
    'NSISC 2026 prelims'
  )!;
  const workspace = { womenResults, athleteHistory: [prelim] } as unknown as Workspace;
  const hsuPool = individuals.filter(r => r.team === HSU);

  it('the DQ row at the 100 Free does not count as her swim there', () => {
    const out = relayLegHistoryCandidates(workspace, hsuPool, Gender.WOMEN);
    const fills = out.filter(r => r.name === 'Allie Grace Rhodes');
    expect(fills.map(r => [r.event, r.time])).toStrictEqual([['100 Freestyle', '56.76']]);
  });

  it('a row with a time still hides it: her meet 100 Fly is not replaced by her faster prelims swim', () => {
    const fly = row('Allie Grace Rhodes', 'Event 12 Women 100 Yard Butterfly');
    expect([fly.time, fly.prelimsTime]).toStrictEqual(['1:02.13', '1:01.71']);
    const prelimFly = historicalSwimFromResult({ ...fly, time: fly.prelimsTime as string }, 'NSISC 2026 prelims')!;
    const ws = { womenResults, athleteHistory: [prelimFly] } as unknown as Workspace;
    const out = relayLegHistoryCandidates(ws, hsuPool, Gender.WOMEN);
    expect(out.filter(r => r.name === 'Allie Grace Rhodes')).toStrictEqual([]);
  });
});
