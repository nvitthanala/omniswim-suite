/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `relaySimulation.ts` (plan item T6). Each case
 * kills Stryker mutants that survived the suite as it stood on 2026-10-14 (see
 * docs/reference/MUTATION_RESULTS_2026-10-14.md).
 *
 * Fixture: HSU 4x50 free relay, 1:40.00 (100 s), four legs of 25.00 each, legs
 * held by Ann Lee (SR), Bea Fox (JR), Cy Ode (FR) and Dee Ray (SO). Sam Roe (FR)
 * swam the 50 free in 24.00. The expected clocks are hand-derived:
 *
 *   a filled leg moves the clock by (new leg time - departed leg time), where
 *   the departed leg time is the departed swimmer's own swim at the leg event
 *   when there is one, else the leg's recorded split;
 *   a vacant leg adds 3.00 s to the clock and shows (split + 3.00) as its time.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type RelayLegOverride, type SwimmerResult } from '../../packages/core/src/types';
import {
  findDepartedLegSwim,
  relaySplitQualificationCutEvent,
  simulateRoster,
} from '../../packages/core/src/lib/relaySimulation';
import { relayEntryKey } from '../../packages/core/src/lib/relaySplits';
import { canonicalSwimmerName, normalizeSwimmerName } from '../../packages/core/src/lib/swimmerNames';

const HSU = 'HSU';
const RELAY = 'Event 2 Men 4x50 Yard Freestyle Relay';
const FREE50 = 'Event 8 Men 50 Yard Freestyle';
const FREE100 = 'Event 9 Men 100 Yard Freestyle';
const NAMES = [
  { name: 'Ann Lee', year: 'SR' },
  { name: 'Bea Fox', year: 'JR' },
  { name: 'Cy Ode', year: 'FR' },
  { name: 'Dee Ray', year: 'SO' },
];

function leg(i: number | undefined, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  const n = NAMES[i ?? 0];
  return {
    id: `relay-${i ?? 'x'}`,
    rank: 1,
    name: n?.name ?? 'Nobody',
    classYear: n?.year ?? 'FR',
    team: HSU,
    time: '1:40.00',
    finalsTime: '1:40.00',
    relayTeamTime: '1:40.00',
    relayLegSplit: '25.00',
    relayLegIndex: i,
    roundSwam: 'A Final',
    points: 0,
    event: RELAY,
    isRelay: true,
    gender: Gender.MEN,
    relayNames: NAMES,
    ...extra,
  } as SwimmerResult;
}

function relayLegs(extra: (i: number) => Partial<SwimmerResult> = () => ({})): SwimmerResult[] {
  return [0, 1, 2, 3].map(i => leg(i, extra(i)));
}

function swim(id: string, name: string, event: string, time: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id,
    rank: 1,
    name,
    classYear: 'FR',
    team: HSU,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: Gender.MEN,
    ...extra,
  } as SwimmerResult;
}

const SAM = swim('sam', 'Sam Roe', FREE50, '24.00');

function fill(legIndex: number, extra: Partial<RelayLegOverride>): RelayLegOverride {
  return { relayEntryKey: relayEntryKey(leg(0)), legIndex, source: 'manual', ...extra };
}

function relayRows(out: SwimmerResult[]): SwimmerResult[] {
  return out.filter(r => r.isRelay).sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
}

describe('simulateRoster with nothing to do', () => {
  const shuffled = [leg(3), SAM, leg(0), leg(2), leg(1)];
  const recruit = swim('rec', 'Rae New', FREE50, '25.00', { isRecruit: true });

  it('returns the results then the recruits, untouched and in order', () => {
    const out = simulateRoster(shuffled, [recruit], false);
    expect(out).toEqual([...shuffled, recruit]);
    expect(out.slice(0, shuffled.length).every((r, i) => r === shuffled[i])).toBe(true);
  });

  it('treats explicit null and empty inputs as nothing to do', () => {
    const out = simulateRoster(shuffled, [], false, new Set(), null as unknown as RelayLegOverride[]);
    expect(out).toEqual(shuffled);
    expect(out.map(r => r.id)).toEqual(['relay-3', 'sam', 'relay-0', 'relay-2', 'relay-1']);
  });

  it('runs on any one trigger alone', () => {
    // Each trigger rebuilds the list: relay legs come out grouped and in leg order.
    const ids = (out: SwimmerResult[]) => out.map(r => r.id);
    const senior = simulateRoster(shuffled, [], true);
    expect(ids(senior)).toEqual(['relay-0', 'relay-1', 'relay-2', 'relay-3', 'sam']);
    const excluded = simulateRoster(shuffled, [], false, new Set([canonicalSwimmerName('Zed Nobody')]));
    expect(ids(excluded)).toEqual(['relay-0', 'relay-1', 'relay-2', 'relay-3', 'sam']);
    const override = simulateRoster(shuffled, [], false, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    expect(ids(override).slice(0, 4)).toEqual(['relay-0', 'relay-1', 'relay-2', 'relay-3']);
    const vacate = simulateRoster(shuffled, [], false, undefined, [], new Set([normalizeSwimmerName('Zed Nobody')]));
    expect(ids(vacate)).toEqual(['relay-0', 'relay-1', 'relay-2', 'relay-3', 'sam']);
  });
});

describe('roster gates', () => {
  it('drops an excluded swimmer, a senior with drop-seniors on, and nobody else', () => {
    const rows = [
      swim('a', 'Ann Lee', FREE50, '25.00', { classYear: 'SR' }),
      swim('b', 'Bea Fox', FREE50, '25.50', { classYear: 'JR' }),
      swim('c', 'Cy Ode', FREE50, '26.00', { classYear: 'FR' }),
    ];
    const gone = simulateRoster(rows, [], false, new Set([canonicalSwimmerName('Cy Ode')]));
    expect(gone.map(r => r.id)).toEqual(['a', 'b']);
    const seniors = simulateRoster(rows, [], true);
    expect(seniors.map(r => r.id)).toEqual(['b', 'c']);
    const seniorsKept = simulateRoster(rows, [], false, new Set([canonicalSwimmerName('Zed Nobody')]));
    expect(seniorsKept.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('a leg-only swim fills a leg but is never emitted', () => {
    const legOnly = swim('hist', 'Sam Roe', FREE50, '24.00');
    const out = simulateRoster(relayLegs(), [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })], new Set(), [legOnly]);
    expect(out.map(r => r.id)).toEqual(['relay-0', 'relay-1', 'relay-2', 'relay-3']);
    expect(relayRows(out)[0]).toMatchObject({ name: 'Sam Roe', relayLegSplit: '24.00' });
  });

  it('a leg-only swim of an excluded swimmer does not fill a leg', () => {
    const legOnly = swim('hist', 'Sam Roe', FREE50, '24.00');
    const out = simulateRoster(
      relayLegs(),
      [],
      true,
      new Set([canonicalSwimmerName('Sam Roe')]),
      [fill(0, { assigneeName: 'Sam Roe' })],
      new Set(),
      [legOnly]
    );
    expect(relayRows(out)[0]).toMatchObject({ name: '—', relayLegVacant: true });
  });

  it('a leg-only swim of a senior does not fill a leg when seniors are dropped', () => {
    const legOnly = swim('hist', 'Sam Roe', FREE50, '24.00', { classYear: 'SR' });
    const out = simulateRoster(relayLegs(), [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })], new Set(), [legOnly]);
    expect(relayRows(out)[0]).toMatchObject({ name: '—', relayLegVacant: true });
    // Seniors kept (Ann is excluded instead): the same swim fills the leg.
    const kept = simulateRoster(
      relayLegs(),
      [],
      false,
      new Set([canonicalSwimmerName('Ann Lee')]),
      [fill(0, { assigneeName: 'Sam Roe' })],
      new Set(),
      [legOnly]
    );
    expect(relayRows(kept)[0]).toMatchObject({ name: 'Sam Roe' });
  });

  it('removes an excluded swimmer from a relay and vacates the leg', () => {
    const out = simulateRoster(relayLegs(), [], false, new Set([canonicalSwimmerName('Bea Fox')]));
    const rows = relayRows(out);
    expect(rows.map(r => r.name)).toEqual(['Ann Lee', '—', 'Cy Ode', 'Dee Ray']);
    expect(rows[1]).toMatchObject({ relayLegVacant: true, relayMissingLeg: { legIndex: 1, stroke: 'free', reason: 'vacant' } });
  });
});

describe('filling a departed leg', () => {
  it('moves the clock by the new leg time minus the recorded split', () => {
    // 100.00 - 25.00 + 24.00 = 99.00.
    const out = simulateRoster([...relayLegs(), SAM], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    const rows = relayRows(out);
    expect(rows.map(r => r.name)).toEqual(['Sam Roe', 'Bea Fox', 'Cy Ode', 'Dee Ray']);
    expect(rows.map(r => r.classYear)).toEqual(['FR', 'JR', 'FR', 'SO']);
    for (const r of rows) {
      expect(r.time).toBe('1:39.00');
      expect(r.finalsTime).toBe('1:39.00');
      expect(r.relayTeamTime).toBe('1:39.00');
      expect(r.relayNames).toEqual([
        { name: 'Sam Roe', year: 'FR' },
        { name: 'Bea Fox', year: 'JR' },
        { name: 'Cy Ode', year: 'FR' },
        { name: 'Dee Ray', year: 'SO' },
      ]);
      expect(r.relayLegVacant).toBe(false);
      expect(r.relayMissingLeg).toBeUndefined();
      expect('relayLegTimeTrial' in r).toBe(false);
      expect(r.relayTeamSplits).toEqual({
        legTotals: ['24.00', '25.00', '25.00', '25.00'],
        firstHalf: '49.00',
        secondHalf: '50.00',
        teamTotal: '1:39.00',
      });
    }
    expect(rows.map(r => r.relayLegSplit)).toEqual(['24.00', '25.00', '25.00', '25.00']);
    expect(rows[0]?.relayLegSplitDetail).toEqual({
      legIndex: 0,
      stroke: 'free',
      legDistanceYards: 50,
      segments: [{ yards: 50, segmentTime: '24.00', cumulativeLeg: '24.00' }],
      legTotal: '24.00',
    });
    expect(rows[1]?.relayLegSplitDetail).toBeUndefined();
    // The swimmer who took the leg is not emitted twice, and Ann is gone from the list.
    expect(out.filter(r => !r.isRelay).map(r => r.id)).toEqual(['sam']);
  });

  it('measures the departed swimmer against their own 50 free when they have one', () => {
    // Ann swam the 50 free in 25.50: 100.00 - 25.50 + 24.00 = 98.50.
    const ann = swim('ann50', 'Ann Lee', FREE50, '25.50', { classYear: 'SR' });
    const out = simulateRoster([...relayLegs(), SAM, ann], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    expect(relayRows(out)[0]?.time).toBe('1:38.50');
  });

  it('ignores a departed swimmer swim at another distance', () => {
    const ann = swim('ann100', 'Ann Lee', FREE100, '55.00', { classYear: 'SR' });
    const out = simulateRoster([...relayLegs(), SAM, ann], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    expect(relayRows(out)[0]?.time).toBe('1:39.00');
  });

  it('takes the class year from the override first, then from the swimmer', () => {
    const out = simulateRoster([...relayLegs(), SAM], [], true, undefined, [
      fill(0, { assigneeName: 'Sam Roe', classYear: 'SR' }),
    ]);
    expect(relayRows(out)[0]).toMatchObject({ classYear: 'SR' });
    expect(relayRows(out)[0]?.relayNames?.[0]).toEqual({ name: 'Sam Roe', year: 'SR' });
  });

  it('uses a manual leg time for the fill when the override carries one', () => {
    // Sam is 24.00 on paper; the coach typed 23.00 (padded). 100 - 25 + 23 = 98.00.
    const out = simulateRoster([...relayLegs(), SAM], [], true, undefined, [
      fill(0, { assigneeName: 'Sam Roe', manualLegTime: ' 23.00 ' }),
    ]);
    // The leg split shown stays Sam's own 24.00; the report notes that, it is not pinned here.
    const rows = relayRows(out);
    expect(rows[0]?.time).toBe('1:38.00');
    expect(rows[0]?.name).toBe('Sam Roe');
  });

  it('refuses to put a swimmer on a second leg', () => {
    // Ann is removed. Bea already swims leg 1 and stays, so she cannot take leg 0.
    const bea50 = swim('bea50', 'Bea Fox', FREE50, '24.50', { classYear: 'JR' });
    const out = simulateRoster([...relayLegs(), bea50], [], true, undefined, [fill(0, { assigneeName: 'Bea Fox' })]);
    const rows = relayRows(out);
    expect(rows[0]).toMatchObject({
      name: '—',
      relayLegVacant: true,
      relayMissingLeg: { legIndex: 0, stroke: 'free', reason: 'stroke_mismatch' },
    });
    expect(rows[1]?.name).toBe('Bea Fox');
    // Vacant leg: +3.00 s. 100.00 + 3.00 = 1:43.00.
    expect(rows[0]?.time).toBe('1:43.00');
  });

  it('a second override naming the swimmer who already took a leg is vacant', () => {
    // Ann (SR) and Dee (SO)... drop seniors removes Ann only, so exclude Bea too.
    const out = simulateRoster(
      [...relayLegs(), SAM],
      [],
      true,
      new Set([canonicalSwimmerName('Bea Fox')]),
      [fill(0, { assigneeName: 'Sam Roe' }), fill(1, { assigneeName: 'Sam Roe' })]
    );
    const rows = relayRows(out);
    expect(rows[0]?.name).toBe('Sam Roe');
    expect(rows[1]).toMatchObject({ name: '—', relayMissingLeg: { legIndex: 1, reason: 'stroke_mismatch' } });
  });

  it('a leg whose override names its own departed holder is vacant', () => {
    // Bea is vacated as a non-scorer yet named again for her own leg.
    const bea50 = swim('bea50', 'Bea Fox', FREE50, '24.50', { classYear: 'JR' });
    const out = simulateRoster(
      [...relayLegs(), bea50],
      [],
      false,
      undefined,
      [fill(1, { assigneeName: 'Bea Fox' })],
      new Set([normalizeSwimmerName('Bea Fox')])
    );
    const rows = relayRows(out);
    expect(rows[1]).toMatchObject({
      name: '—',
      relayLegVacant: true,
      relayMissingLeg: { legIndex: 1, stroke: 'free', reason: 'vacant' },
    });
  });

  it('labels a time-trial fill only on its own leg', () => {
    const tt = swim('tt', 'Tia Ng', FREE50, '23.50', { isTimeTrial: true });
    const out = simulateRoster(
      [...relayLegs(), tt, SAM],
      [],
      false,
      new Set([canonicalSwimmerName('Ann Lee'), canonicalSwimmerName('Bea Fox')]),
      [fill(0, { assigneeName: 'Tia Ng' }), fill(1, { assigneeName: 'Sam Roe' })],
      new Set(),
      [],
      { relayLegsAllowTimeTrials: true }
    );
    const rows = relayRows(out);
    expect(rows.map(r => r.name)).toEqual(['Tia Ng', 'Sam Roe', 'Cy Ode', 'Dee Ray']);
    expect(rows[0]?.relayLegTimeTrial).toBe(true);
    expect('relayLegTimeTrial' in (rows[1] as object)).toBe(false);
    expect('relayLegTimeTrial' in (rows[2] as object)).toBe(false);
  });

  it('does not fill a leg from a time trial unless the setting allows it', () => {
    const tt = swim('tt', 'Tia Ng', FREE50, '23.50', { isTimeTrial: true });
    const out = simulateRoster([...relayLegs(), tt], [], true, undefined, [fill(0, { assigneeName: 'Tia Ng' })]);
    expect(relayRows(out)[0]).toMatchObject({
      name: '—',
      relayMissingLeg: { legIndex: 0, stroke: 'free', reason: 'time_trial_only' },
    });
  });

  it('a recruit named by id fills the leg; a swim of another stroke is a stroke mismatch', () => {
    const rec = swim('rec-free', 'Rae New', FREE50, '24.20', { isRecruit: true });
    const ok = simulateRoster([...relayLegs()], [rec], true, undefined, [fill(0, { recruitId: 'rec-free' })]);
    expect(relayRows(ok)[0]).toMatchObject({ name: 'Rae New', relayLegSplit: '24.20' });

    const breast = swim('rec-breast', 'Rob Bay', 'Event 11 Men 100 Yard Breaststroke', '1:00.00', { isRecruit: true });
    const bad = simulateRoster([...relayLegs()], [breast], true, undefined, [fill(0, { recruitId: 'rec-breast' })]);
    expect(relayRows(bad)[0]).toMatchObject({
      name: '—',
      relayMissingLeg: { legIndex: 0, stroke: 'free', reason: 'stroke_mismatch' },
    });
  });
});

describe('clock hold and vacancy', () => {
  it('a manual time with no swimmer holds the leg: dash name, no vacancy flag', () => {
    // 100.00 - 25.00 + 24.00 = 99.00.
    const out = simulateRoster(relayLegs(), [], true, undefined, [fill(0, { manualLegTime: '24.00' })]);
    const rows = relayRows(out);
    expect(rows[0]).toMatchObject({
      name: '—',
      classYear: '',
      time: '1:39.00',
      relayLegVacant: false,
      relayLegSplit: '24.00',
    });
    expect(rows[0]?.relayMissingLeg).toBeUndefined();
    expect(rows[0]?.relayTeamSplits?.legTotals).toEqual(['24.00', '25.00', '25.00', '25.00']);
  });

  it('a blank swimmer name does not stop a clock hold, and the time is trimmed', () => {
    const out = simulateRoster(relayLegs(), [], true, undefined, [
      fill(0, { assigneeName: '   ', manualLegTime: '  24.00 ' }),
    ]);
    const rows = relayRows(out);
    expect(rows[0]).toMatchObject({ name: '—', time: '1:39.00', relayLegVacant: false });
  });

  it('a named swimmer who does not resolve is vacant, never a clock hold', () => {
    const out = simulateRoster(relayLegs(), [], true, undefined, [
      fill(0, { assigneeName: 'Nobody Here', manualLegTime: '24.00' }),
    ]);
    const rows = relayRows(out);
    expect(rows[0]).toMatchObject({
      name: '—',
      relayLegVacant: true,
      relayMissingLeg: { legIndex: 0, stroke: 'free', reason: 'vacant' },
    });
    // Vacant: 100 + 3 = 1:43.00, shown leg time 25.00 + 3.00.
    expect(rows[0]?.time).toBe('1:43.00');
    expect(rows[0]?.relayLegSplit).toBe('28.00');
  });

  it('an override with no swimmer and no time leaves the leg vacant', () => {
    const out = simulateRoster(relayLegs(), [], true, undefined, [fill(0, {})]);
    expect(relayRows(out)[0]).toMatchObject({
      name: '—',
      relayLegVacant: true,
      relayMissingLeg: { legIndex: 0, stroke: 'free', reason: 'vacant' },
    });
  });

  it('a departed leg with no override is vacant: +3.00 s on the clock and the split', () => {
    const out = simulateRoster(relayLegs(), [], true);
    const rows = relayRows(out);
    expect(rows.map(r => r.name)).toEqual(['—', 'Bea Fox', 'Cy Ode', 'Dee Ray']);
    expect(rows[0]).toMatchObject({
      classYear: '',
      time: '1:43.00',
      relayLegVacant: true,
      relayMissingLeg: { legIndex: 0, stroke: 'free', reason: 'vacant' },
      relayLegSplit: '28.00',
    });
    expect(rows[0]?.relayTeamSplits).toEqual({
      legTotals: ['28.00', '25.00', '25.00', '25.00'],
      firstHalf: '53.00',
      secondHalf: '50.00',
      teamTotal: '1:43.00',
    });
    expect(rows[1]?.relayLegVacant).toBe(false);
  });

  it('a vacated non-scorer leg is reported as no_replacement', () => {
    const out = simulateRoster(relayLegs(), [], false, undefined, [], new Set([normalizeSwimmerName('Cy Ode')]));
    const rows = relayRows(out);
    expect(rows[2]).toMatchObject({
      name: '—',
      relayLegVacant: true,
      relayMissingLeg: { legIndex: 2, stroke: 'free', reason: 'no_replacement' },
    });
  });

  it('a leg with no recorded split is shown at 30.00 + 3.00 and holds the clock otherwise', () => {
    const out = simulateRoster(
      relayLegs(i => (i === 0 ? { relayLegSplit: undefined } : {})),
      [],
      true
    );
    const rows = relayRows(out);
    // The clock still gains 3.00 s; the leg time shown is the 30.00 default plus 3.00.
    expect(rows[0]).toMatchObject({ time: '1:43.00', relayLegSplit: '33.00' });
  });

  it('an NT split is treated as no recorded split', () => {
    // Fill: no departed time to measure against, so the clock does not move.
    const out = simulateRoster(
      [...relayLegs(i => (i === 0 ? { relayLegSplit: 'NT' } : {})), SAM],
      [],
      true,
      undefined,
      [fill(0, { assigneeName: 'Sam Roe' })]
    );
    expect(relayRows(out)[0]).toMatchObject({ name: 'Sam Roe', time: '1:40.00' });
  });

  it('a fill with neither a recorded split nor an individual swim leaves the clock where it was', () => {
    const out = simulateRoster(
      [...relayLegs(i => (i === 0 ? { relayLegSplit: undefined } : {})), SAM],
      [],
      true,
      undefined,
      [fill(0, { assigneeName: 'Sam Roe' })]
    );
    const rows = relayRows(out);
    expect(rows[0]).toMatchObject({ name: 'Sam Roe', time: '1:40.00', relayLegSplit: '24.00' });
  });

  it('measures a theoretical meet leg against its estimate', () => {
    // A theoretical leg row has no split; its estimate (25.00 s) stands in. 100 - 25 + 24 = 99.
    const out = simulateRoster(
      [
        ...relayLegs(i => ({
          id: `tmresrelay|ws|HSU|leg${i}`,
          relayLegSplit: undefined,
          relayLegEstimate: { time: 25, basis: 'best time' },
        })),
        SAM,
      ],
      [],
      true,
      undefined,
      [fill(0, { assigneeName: 'Sam Roe' })]
    );
    const rows = relayRows(out);
    expect(rows[0]).toMatchObject({ name: 'Sam Roe', time: '1:39.00' });
    // The replaced leg drops the departed swimmer's estimate; the others keep theirs.
    expect('relayLegEstimate' in (rows[0] as object)).toBe(false);
    expect(rows[1]?.relayLegEstimate).toEqual({ time: 25, basis: 'best time' });
    // A theoretical meet's relay has no team split summary.
    expect(rows.every(r => r.relayTeamSplits === undefined)).toBe(true);
  });
});

describe('split bookkeeping', () => {
  it('leaves every row of an untouched relay as it came', () => {
    // No senior on this relay: nothing is replaced, so the very same rows return.
    const legs = relayLegs(i => ({ classYear: i === 0 ? 'JR' : 'FR' }));
    const named = legs.map(r => ({ ...r, relayNames: NAMES.map(n => ({ ...n, year: 'JR' })) }));
    const out = simulateRoster(named, [], true);
    expect(out).toHaveLength(4);
    out.forEach((r, i) => {
      expect(r).toBe(named[i]);
      expect('relayLegVacant' in r).toBe(false);
    });
  });

  it('keeps a detail-bearing split for a leg that stays, and rescales a replaced one', () => {
    const detail = (total: string, a: [string, string], b: [string, string]) => ({
      legIndex: 0,
      stroke: 'free' as const,
      legDistanceYards: 50,
      legTotal: total,
      segments: [
        { yards: 25, segmentTime: a[0], cumulativeLeg: a[1] },
        { yards: 50, segmentTime: b[0], cumulativeLeg: b[1] },
      ],
    });
    const legs = relayLegs(i =>
      i === 0
        ? { relayLegSplitDetail: detail('25.00', ['12.00', '12.00'], ['13.00', '25.00']) }
        : i === 1
          ? {
              relayLegSplit: '25.00',
              relayLegSplitDetail: detail('25.10', ['12.10', '12.10'], ['13.00', '25.10']),
            }
          : {}
    );
    const out = simulateRoster([...legs, SAM], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    const rows = relayRows(out);
    // Leg 0 rescaled by 24.00 / 25.00 = 0.96: segments 11.52 and 12.48, cumulative 11.52 and 24.00.
    expect(rows[0]?.relayLegSplitDetail).toEqual({
      legIndex: 0,
      stroke: 'free',
      legDistanceYards: 50,
      segments: [
        { yards: 25, segmentTime: '11.52', cumulativeLeg: '11.52' },
        { yards: 50, segmentTime: '12.48', cumulativeLeg: '24.00' },
      ],
      legTotal: '24.00',
    });
    // Leg 1 stays: its detail total (25.10) wins over its top-level split (25.00).
    expect(rows[1]?.relayLegSplit).toBe('25.10');
    expect(rows[1]?.relayLegSplitDetail?.legTotal).toBe('25.10');
    expect(rows[0]?.relayTeamSplits?.legTotals).toEqual(['24.00', '25.10', '25.00', '25.00']);
    expect(rows[0]?.relayTeamSplits?.firstHalf).toBe('49.10');
  });

  it('a stay-put leg with a detail but no detail total falls back to its split', () => {
    const legs = relayLegs(i =>
      i === 1
        ? {
            relayLegSplit: '25.20',
            relayLegSplitDetail: { legIndex: 1, stroke: 'free' as const, legDistanceYards: 50, segments: [] },
          }
        : {}
    );
    const out = simulateRoster([...legs, SAM], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    const rows = relayRows(out);
    expect(rows[0]?.relayTeamSplits?.legTotals).toEqual(['24.00', '25.20', '25.00', '25.00']);
    expect(rows[1]?.relayLegSplit).toBe('25.20');
  });

  it('takes the leg stroke from the row when the row records one', () => {
    const out = simulateRoster(
      [...relayLegs(i => (i === 0 ? { relayLegStroke: 'back' as const } : {})), SAM],
      [],
      true,
      undefined,
      [fill(0, { assigneeName: 'Sam Roe' })]
    );
    expect(relayRows(out)[0]?.relayLegSplitDetail?.stroke).toBe('back');
  });

  it('reads a leg by position when its rows carry no leg index', () => {
    // Different recorded splits per leg, no relayLegIndex: Bea (leg 1) is replaced.
    const legs = [0, 1, 2, 3].map(i =>
      leg(undefined, {
        id: `relay-${i}`,
        name: NAMES[i]?.name ?? '',
        classYear: NAMES[i]?.year ?? '',
        relayLegSplit: ['25.00', '26.00', '27.00', '22.00'][i],
      })
    );
    // Bea (JR) leaves by exclusion; Sam fills leg 1 at 24.00. 100 - 26 + 24 = 98.00.
    const out = simulateRoster(
      [...legs, SAM],
      [],
      false,
      new Set([canonicalSwimmerName('Bea Fox')]),
      [fill(1, { assigneeName: 'Sam Roe' })]
    );
    const rows = out.filter(r => r.isRelay);
    expect(rows.map(r => r.name)).toEqual(['Ann Lee', 'Sam Roe', 'Cy Ode', 'Dee Ray']);
    expect(rows.map(r => r.time)).toEqual(['1:38.00', '1:38.00', '1:38.00', '1:38.00']);
    expect(rows[0]?.relayTeamSplits?.legTotals).toEqual(['25.00', '24.00', '27.00', '22.00']);
    expect(rows.map(r => r.relayLegSplit)).toEqual(['25.00', '24.00', '27.00', '22.00']);
  });

  it('a relay with a missing leg row still resolves that leg', () => {
    // Four names, rows for legs 0-2 only. Leg 3 (Dee, SO) is excluded and filled by Sam.
    const legs = [leg(0), leg(1), leg(2)];
    const out = simulateRoster(
      [...legs, SAM],
      [],
      false,
      new Set([canonicalSwimmerName('Dee Ray')]),
      [fill(3, { assigneeName: 'Sam Roe' })]
    );
    const rows = relayRows(out);
    expect(rows).toHaveLength(3);
    // No row holds leg 3, so there is no recorded split: the clock stays 1:40.00.
    expect(rows.map(r => r.time)).toEqual(['1:40.00', '1:40.00', '1:40.00']);
    expect(rows[0]?.relayNames?.[3]).toEqual({ name: 'Sam Roe', year: 'FR' });
    expect(rows[0]?.relayTeamSplits?.legTotals).toEqual(['25.00', '25.00', '25.00', '24.00']);
  });

  it('a missing leg row that is not replaced leaves a null leg total', () => {
    const legs = [leg(0), leg(1), leg(2)];
    const out = simulateRoster([...legs, SAM], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    const rows = relayRows(out);
    expect(rows[0]?.relayTeamSplits?.legTotals).toEqual(['24.00', '25.00', '25.00', null]);
    // Without all four totals there are no halves.
    expect(rows[0]?.relayTeamSplits?.firstHalf).toBeUndefined();
    expect(rows[0]?.relayTeamSplits?.secondHalf).toBeUndefined();
  });

  it('finds a leg by its index when a row between is missing', () => {
    // Rows for legs 0, 1 and 3: leg 3 is found by its own index, not by position 3.
    const legs = [leg(0), leg(1), leg(3, { relayLegSplit: '22.00' })];
    const out = simulateRoster(
      [...legs, SAM],
      [],
      false,
      new Set([canonicalSwimmerName('Dee Ray')]),
      [fill(3, { assigneeName: 'Sam Roe' })]
    );
    // 100 - 22 + 24 = 102.00.
    expect(relayRows(out).map(r => r.time)).toEqual(['1:42.00', '1:42.00', '1:42.00']);
  });

  it('builds the legs from the rows when the relay records no names', () => {
    const legs = relayLegs(() => ({ relayNames: undefined }));
    const out = simulateRoster([...legs, SAM], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    // Without names the entry key has no swimmers either; build the override from that row.
    const keyed = simulateRoster([...legs, SAM], [], true, undefined, [
      { relayEntryKey: relayEntryKey(legs[0]!), legIndex: 0, assigneeName: 'Sam Roe', source: 'manual' },
    ]);
    expect(relayRows(keyed).map(r => r.name)).toEqual(['Sam Roe', 'Bea Fox', 'Cy Ode', 'Dee Ray']);
    expect(relayRows(keyed)[0]?.relayNames).toEqual([
      { name: 'Sam Roe', year: 'FR' },
      { name: 'Bea Fox', year: 'JR' },
      { name: 'Cy Ode', year: 'FR' },
      { name: 'Dee Ray', year: 'SO' },
    ]);
    expect(out.filter(r => r.isRelay)).toHaveLength(4);
  });

  it('an empty names list falls back to the rows too', () => {
    const legs = relayLegs(() => ({ relayNames: [] }));
    const out = simulateRoster([...legs, SAM], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    expect(relayRows(out).map(r => r.name)).toEqual(['Sam Roe', 'Bea Fox', 'Cy Ode', 'Dee Ray']);
  });

  it('a relay with no readable distance takes a held leg time with no split detail', () => {
    const noDist = 'Event 2 Men Freestyle Relay';
    const legs = relayLegs(() => ({ event: noDist }));
    const override: RelayLegOverride = {
      relayEntryKey: relayEntryKey(legs[0]!),
      legIndex: 0,
      manualLegTime: '24.00',
      source: 'manual',
    };
    const out = simulateRoster(legs, [], true, undefined, [override]);
    const rows = relayRows(out);
    expect(rows[0]).toMatchObject({ name: '—', relayLegSplit: '24.00', time: '1:39.00' });
    expect(rows[0]?.relayLegSplitDetail).toBeUndefined();
    expect(rows[0]?.relayTeamSplits?.legTotals).toEqual(['24.00', '25.00', '25.00', '25.00']);
  });

  it('keeps the leg split detail off every untouched row', () => {
    const out = simulateRoster([...relayLegs(), SAM], [], true, undefined, [fill(0, { assigneeName: 'Sam Roe' })]);
    const rows = relayRows(out);
    for (const r of rows.slice(1)) {
      expect(r.relayLegSplitDetail).toBeUndefined();
    }
  });
});

describe('findDepartedLegSwim', () => {
  const rows = [
    swim('other-team', 'Ann Lee', FREE50, '20.00', { team: 'Rival' }),
    swim('ann-100', 'Ann Lee', FREE100, '50.00'),
    swim('ann-50', 'Ann Lee', FREE50, '25.50'),
    swim('ann-50-later', 'Ann Lee', FREE50, '25.00'),
    swim('relay-row', 'Ann Lee', FREE50, '19.00', { isRelay: true }),
  ];

  it('finds the first swim of that swimmer, on that team, at the leg event', () => {
    expect(findDepartedLegSwim(rows, 'Ann Lee', RELAY, 0, HSU)?.id).toBe('ann-50');
  });

  it('matches the team trimmed on both sides', () => {
    expect(findDepartedLegSwim(rows, 'Ann Lee', RELAY, 0, '  HSU  ')?.id).toBe('ann-50');
    const padded = [swim('p', 'Ann Lee', FREE50, '25.00', { team: 'HSU ' })];
    expect(findDepartedLegSwim(padded, 'Ann Lee', RELAY, 0, HSU)?.id).toBe('p');
  });

  it('matches the name in either order', () => {
    expect(findDepartedLegSwim(rows, 'Lee, Ann', RELAY, 0, HSU)?.id).toBe('ann-50');
  });

  it('is undefined for another team, a relay row, another distance or an unknown swimmer', () => {
    expect(findDepartedLegSwim(rows, 'Ann Lee', RELAY, 0, 'Rival')?.id).toBe('other-team');
    expect(findDepartedLegSwim(rows, 'Ann Lee', RELAY, 0, 'Nowhere')).toBeUndefined();
    expect(findDepartedLegSwim([rows[1]!], 'Ann Lee', RELAY, 0, HSU)).toBeUndefined();
    expect(findDepartedLegSwim([rows[4]!], 'Ann Lee', RELAY, 0, HSU)).toBeUndefined();
    expect(findDepartedLegSwim(rows, 'Zed Nobody', RELAY, 0, HSU)).toBeUndefined();
  });

  it('is undefined for a leg index with no stroke', () => {
    // A medley relay has a stroke for legs 0-3 only; -1 has none.
    const medley = 'Event 20 Men 4x50 Yard Medley Relay';
    const back = [swim('back50', 'Ann Lee', 'Event 7 Men 50 Yard Backstroke', '28.00')];
    expect(findDepartedLegSwim(back, 'Ann Lee', medley, 0, HSU)?.id).toBe('back50');
    expect(findDepartedLegSwim(back, 'Ann Lee', medley, -1, HSU)).toBeUndefined();
  });
});

describe('relaySplitQualificationCutEvent', () => {
  const backLeg = (event: string, extra: Partial<SwimmerResult> = {}) =>
    leg(0, { event, relayLegStroke: 'back', ...extra });

  it('maps the backstroke leadoff of a 400 medley relay to the 100 Backstroke', () => {
    expect(relaySplitQualificationCutEvent(backLeg('Event 20 Men 4x100 Yard Medley Relay'))).toBe('100 Backstroke');
    expect(relaySplitQualificationCutEvent(backLeg('Event 20 Men 400 Yard Medley Relay'))).toBe('100 Backstroke');
  });

  it('is null for anything else', () => {
    expect(relaySplitQualificationCutEvent(backLeg('Event 20 Men 4x50 Yard Medley Relay'))).toBeNull();
    expect(relaySplitQualificationCutEvent(backLeg('Event 20 Men 4x100 Yard Freestyle Relay'))).toBeNull();
    expect(relaySplitQualificationCutEvent(leg(0, { event: 'Event 20 Men 4x100 Yard Medley Relay', relayLegStroke: 'fly' }))).toBeNull();
    expect(relaySplitQualificationCutEvent(leg(0, { event: 'Event 20 Men 4x100 Yard Medley Relay', relayLegStroke: undefined }))).toBeNull();
    expect(
      relaySplitQualificationCutEvent(
        backLeg('Event 20 Men 4x100 Yard Medley Relay', { isRelay: false })
      )
    ).toBeNull();
  });
});

describe('second pass: survivors of the first mutation run', () => {
  const clock = (rows: SwimmerResult[]) => rows.map(r => r.time);

  it('legs whose row time holds the leg split still form one relay with one clock', () => {
    // The team clock is in `relayTeamTime` (1:40.00); `time` carries each leg's own split. The rows
    // are one entry, so every row ends with the same clock. Ann (SR) leaves with drop-seniors on.
    const rows = [0, 1, 2, 3].map(i => leg(i, { time: ['25.00', '26.00', '27.00', '28.00'][i] }));
    const out = relayRows(simulateRoster(rows, [], true));
    expect(out).toHaveLength(4);
    expect(new Set(clock(out)).size).toBe(1);
  });

  it('entries that differ only by place, round or team are separate relays', () => {
    // Four HSU/ZZU entries, no swimmer names on the rows, one clock (1:40.00). Only entry A holds
    // a senior (Ann). Dropping her vacates leg 0 of A alone: 1:40.00 + 3.00 = 1:43.00. Every other
    // entry is untouched, even though each shares team, event, round, place or clock with A.
    const entry = (tag: string, names: string[], extra: Partial<SwimmerResult>) =>
      names.map((n, i) =>
        leg(i, {
          id: `${tag}-${i}`,
          name: n,
          classYear: tag === 'A' && i === 0 ? 'SR' : 'JR',
          relayNames: undefined,
          ...extra,
        })
      );
    const a = entry('A', ['Ann Lee', 'Bea Fox', 'Cy Ode', 'Dee Ray'], { rank: 1 });
    const b = entry('B', ['Eli Wu', 'Fay Zed', 'Gus Ito', 'Hal Poe'], { rank: 2 });
    const c = entry('C', ['Ian Ng', 'Jo Kay', 'Kit Lo', 'Lee Mo'], { rank: 1, roundSwam: 'Preliminaries' });
    const d = entry('D', ['Max Ny', 'Ned Oz', 'Oli Pa', 'Pat Qu'], { rank: 1, team: 'ZZU' });
    // E shares team, event, round and place with A but has its own clock (1:41.00).
    const e = entry('E', ['Quin Ra', 'Rex Su', 'Sal Tu', 'Tom Uv'], { rank: 1, time: '1:41.00', finalsTime: '1:41.00', relayTeamTime: '1:41.00' });
    const out = simulateRoster([...a, ...b, ...c, ...d, ...e], [], true).filter(r => r.isRelay);
    expect(out).toHaveLength(20);
    const byTag = (tag: string) => out.filter(r => r.id.startsWith(`${tag}-`));
    expect(clock(byTag('A'))).toEqual(['1:43.00', '1:43.00', '1:43.00', '1:43.00']);
    for (const tag of ['B', 'C', 'D']) {
      expect(clock(byTag(tag))).toEqual(['1:40.00', '1:40.00', '1:40.00', '1:40.00']);
    }
    expect(clock(byTag('E'))).toEqual(['1:41.00', '1:41.00', '1:41.00', '1:41.00']);
    expect(byTag('B').map(r => r.name)).toEqual(['Eli Wu', 'Fay Zed', 'Gus Ito', 'Hal Poe']);
  });

  it('a team or round label with trailing whitespace is the same relay entry', () => {
    // Legs 1-3 carry "HSU " and "A Final "; leg 0 carries "HSU" and "A Final". One entry: all four
    // rows are rebuilt together, so all four show the 1:43.00 clock after Ann (SR) is dropped.
    const rows = [0, 1, 2, 3].map(i =>
      leg(i, { id: `t-${i}`, relayNames: undefined, ...(i > 0 ? { team: 'HSU ', roundSwam: 'A Final ' } : {}) })
    );
    const out = relayRows(simulateRoster(rows, [], true));
    expect(clock(out)).toEqual(['1:43.00', '1:43.00', '1:43.00', '1:43.00']);
  });

  it('a leg with no row still reads its own split, and its row keeps its swimmer', () => {
    // Rows for legs 0, 1 and 3 only (leg 2 has no row). Dee's leg-3 split is 25.40. Ann (SR) leaves.
    const rows = [0, 1, 3].map(i => leg(i, i === 3 ? { relayLegSplit: '25.40' } : {}));
    const out = relayRows(simulateRoster(rows, [], true));
    const dee = out.find(r => r.id === 'relay-3');
    expect(dee?.name).toBe('Dee Ray');
    expect(dee?.relayTeamSplits?.legTotals[3]).toBe('25.40');
  });

  it('rows with no leg index are read in order for their splits', () => {
    // Splits 25.00, 26.00, 27.00, 28.00 in row order, no relayLegIndex on any row. Ann (SR) leaves
    // and leg 0 is vacant (25.00 + 3.00 = 28.00); legs 1-3 keep their own splits.
    const rows = [0, 1, 2, 3].map(i =>
      leg(undefined, {
        id: `n-${i}`,
        name: NAMES[i]?.name,
        classYear: NAMES[i]?.year,
        relayLegSplit: ['25.00', '26.00', '27.00', '28.00'][i],
      })
    );
    const out = simulateRoster(rows, [], true).filter(r => r.isRelay);
    expect(out[0]?.relayTeamSplits?.legTotals).toEqual(['28.00', '26.00', '27.00', '28.00']);
  });

  it('a row indexed past the last leg is shown as the last leg, not read off the end', () => {
    const indexed = [...relayLegs(), leg(0, { id: 'extra', name: 'Extra X', relayLegIndex: 7 })];
    const a = simulateRoster(indexed, [], true).find(r => r.id === 'extra');
    expect(a?.name).toBe('Dee Ray');
    // The same with no leg index anywhere: a fifth row is leg index 4, shown as the last leg.
    const five = [0, 1, 2, 3]
      .map(i => leg(undefined, { id: `n-${i}`, name: NAMES[i]?.name, classYear: NAMES[i]?.year }))
      .concat([leg(undefined, { id: 'n-4', name: 'Extra X', classYear: 'FR' })]);
    const b = simulateRoster(five, [], true).find(r => r.id === 'n-4');
    expect(b?.name).toBe('Dee Ray');
  });

  it('a blank manual time is no time: the swimmer time is used, and with no swimmer the leg is vacant', () => {
    const excluded = new Set([canonicalSwimmerName('Dee Ray')]);
    // Sam's 24.00 replaces Dee's 25.00 split: 1:40.00 - 1.00 = 1:39.00. The blank manual time is ignored.
    const filled = simulateRoster([...relayLegs(), SAM], [], false, excluded, [
      fill(3, { assigneeName: 'Sam Roe', manualLegTime: '   ' }),
    ]);
    expect(clock(relayRows(filled))).toEqual(['1:39.00', '1:39.00', '1:39.00', '1:39.00']);
    expect(relayRows(filled)[3]?.name).toBe('Sam Roe');
    // No swimmer and a blank time: not a clock hold. The leg is vacant: 1:40.00 + 3.00 = 1:43.00.
    const vacant = relayRows(simulateRoster(relayLegs(), [], false, excluded, [fill(3, { manualLegTime: '   ' })]));
    expect(clock(vacant)).toEqual(['1:43.00', '1:43.00', '1:43.00', '1:43.00']);
    expect(vacant[3]?.relayMissingLeg).toEqual({ legIndex: 3, stroke: 'free', reason: 'vacant' });
  });

  it('a medley relay names the stroke of each vacant leg: back, breast, fly, free', () => {
    const medley = relayLegs(() => ({ event: 'Event 4 Men 4x50 Yard Medley Relay' }));
    const all = new Set(NAMES.map(n => canonicalSwimmerName(n.name)));
    const out = relayRows(simulateRoster(medley, [], false, all));
    expect(out.map(r => r.relayMissingLeg?.stroke)).toEqual(['back', 'breast', 'fly', 'free']);
  });

  it('an explicit null leg-only pool is no pool', () => {
    const shuffled = [leg(3), SAM, leg(0), leg(2), leg(1)];
    const out = simulateRoster(shuffled, [], true, undefined, [], new Set(), null as unknown as SwimmerResult[]);
    expect(out.map(r => r.id)).toEqual(['relay-0', 'relay-1', 'relay-2', 'relay-3', 'sam']);
  });

  it('an explicit null leg-only pool is no pool when an override has to search for its swimmer', () => {
    const out = simulateRoster(
      relayLegs(),
      [],
      false,
      new Set([canonicalSwimmerName('Dee Ray')]),
      [fill(3, { assigneeName: 'Nobody Here' })],
      new Set(),
      null as unknown as SwimmerResult[]
    );
    // Nobody resolves: the leg is vacant, 1:40.00 + 3.00 = 1:43.00.
    expect(clock(relayRows(out))).toEqual(['1:43.00', '1:43.00', '1:43.00', '1:43.00']);
  });

  it('a leg detail that cannot be read falls back to the recorded leg split', () => {
    // Ann (SR) leaves; leg 1 keeps its row, whose stored detail is not an object.
    const rows = relayLegs(i => (i === 1 ? { relayLegSplit: '26.00', relayLegSplitDetail: 'bad' as never } : {}));
    const out = relayRows(simulateRoster(rows, [], true));
    expect(out[0]?.relayTeamSplits?.legTotals[1]).toBe('26.00');
  });

  it('a 400 relay that is not a medley has no backstroke leadoff cut event', () => {
    const row = leg(0, { event: 'Event 5 Men 400 Yard Freestyle Relay', relayLegStroke: 'back' });
    expect(relaySplitQualificationCutEvent(row)).toBeNull();
  });
});
