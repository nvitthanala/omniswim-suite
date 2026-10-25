/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for the NCAA Rule 7 engine in `ncaaScoringRules.ts`
 * (functions from `ncaaRulesetForFormat` down; plan item T6). Each case kills
 * Stryker mutants that survived the suite as it stood on 2026-10-14 (see
 * docs/reference/MUTATION_RESULTS_2026-10-14.md).
 *
 * Tables used (NCAA Rule 7, as snapshotted in tests/ncaaScoringRules.test.ts):
 *   dual, six lanes or more (7-1-1): individual 9-4-3-2-1-0, best three per team.
 *   championship, 12 qualify (7-6-3): individual 16-13-12-11-10-9-7-5-4-3-2-1,
 *     championship final = places 1-6, consolation final = places 7-12.
 */
import { describe, expect, it } from 'vitest';
import {
  NCAA_FORMAT_RULESETS,
  NCAA_MEET_FORMATS,
  NcaaScoringInputError,
  NcaaUnsourcedRuleError,
  aggregateNcaaTeamTotals,
  computeNcaaEventScoring,
  ncaaRulesetForFormat,
  resolveNcaaDualMeetOutcome,
  resolveNcaaFinalPools,
  resolveNcaaPointTable,
  type NcaaMeetFormat,
  type NcaaPointTable,
  type NcaaScoringEntry,
} from '../../packages/core/src/lib/ncaaScoringRules';

const DUAL = 'dual-six-lanes-or-more' as const;

function entry(id: string, team: string, finishRank: number, extra: Partial<NcaaScoringEntry> = {}): NcaaScoringEntry {
  return { id, team, finishRank, ...extra };
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the call to throw');
}

function table(places: number[], maxScorersPerTeam: number | null = null): NcaaPointTable {
  return { places, maxScorersPerTeam, citation: 'Host meet information (test)', rule: 'Test table.' };
}

describe('ncaaRulesetForFormat', () => {
  it('names the formats it knows when asked for one it does not', () => {
    const err = thrown(() => ncaaRulesetForFormat('no-such-format' as NcaaMeetFormat));
    expect(err).toBeInstanceOf(NcaaScoringInputError);
    expect(err.message).toBe(
      `Unknown NCAA meet format "no-such-format". Known formats: ${NCAA_MEET_FORMATS.join(', ')}.`
    );
  });

  it('returns the ruleset of a known format', () => {
    expect(ncaaRulesetForFormat(DUAL)).toBe(NCAA_FORMAT_RULESETS[DUAL]);
  });
});

describe('resolveNcaaPointTable errors', () => {
  it('says a diving dual format has no relay table, even when a host table is supplied', () => {
    const f = 'dual-diving-six-or-more' as const;
    const expected =
      `Format "${f}" (${NCAA_FORMAT_RULESETS[f].label}) contests no relay events, so it has no relay ` +
      `point table. Rule 7-1-4 covers diving dual meets only.`;
    expect(thrown(() => resolveNcaaPointTable(f, 'relay')).message).toBe(expected);
    expect(thrown(() => resolveNcaaPointTable(f, 'relay', table([5, 3, 1]))).message).toBe(expected);
  });

  it('says an invitational has no table unless the host supplies one, and cites Rule 7-4', () => {
    const err = thrown(() => resolveNcaaPointTable('invitational-host-published', 'relay'));
    expect(err).toBeInstanceOf(NcaaUnsourcedRuleError);
    expect((err as NcaaUnsourcedRuleError).citation).toBe('NCAA Rule 7-4');
    expect(err.message).toBe(
      'NCAA Rule 7-4: "The scoring of place values in invitational meets shall be established and ' +
        'published in advance by the host institution." The NCAA publishes no invitational point ' +
        'table, so one must be supplied via the `hostPublishedTable` option. There is no default to ' +
        'fall back on.'
    );
  });

  it('returns a valid host table as given, and lets it override an NCAA table', () => {
    const host = table([5, 3, 1], 1);
    expect(resolveNcaaPointTable('invitational-host-published', 'individual', host)).toBe(host);
    expect(resolveNcaaPointTable(DUAL, 'individual', host)).toBe(host);
    expect(resolveNcaaPointTable(DUAL, 'individual')).toBe(NCAA_FORMAT_RULESETS[DUAL].individual);
  });

  it('refuses a host table with no places', () => {
    const msg = 'A point table must list at least one place value.';
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([]))).message).toBe(msg);
    const notArray = { ...table([1]), places: 'abc' } as unknown as NcaaPointTable;
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', notArray))).toBeInstanceOf(NcaaScoringInputError);
    const missing = { ...table([1]), places: undefined } as unknown as NcaaPointTable;
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', missing))).toBeInstanceOf(NcaaScoringInputError);
  });

  it('refuses a host table value that is negative, NaN or infinite, and names its place', () => {
    const suffix = '; place values must be finite and non-negative.';
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([5, 3, -1]))).message).toBe(
      `Point table value for place 3 is -1${suffix}`
    );
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([5, Number.NaN]))).message).toBe(
      `Point table value for place 2 is NaN${suffix}`
    );
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([Number.POSITIVE_INFINITY]))).message).toBe(
      `Point table value for place 1 is Infinity${suffix}`
    );
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([5, 3, -1]))).name).toBe(
      'NcaaScoringInputError'
    );
  });

  it('accepts a zero place value', () => {
    expect(() => resolveNcaaPointTable(DUAL, 'individual', table([5, 0]))).not.toThrow();
  });

  it('refuses a cap that is not a positive integer, and accepts 1 and null', () => {
    const prefix = 'maxScorersPerTeam must be a positive integer or null (no cap in the rule); got ';
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([5], 0))).message).toBe(`${prefix}0.`);
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([5], 2.5))).message).toBe(`${prefix}2.5.`);
    expect(thrown(() => resolveNcaaPointTable(DUAL, 'individual', table([5], -1))).message).toBe(`${prefix}-1.`);
    expect(() => resolveNcaaPointTable(DUAL, 'individual', table([5], 1))).not.toThrow();
    expect(() => resolveNcaaPointTable(DUAL, 'individual', table([5], null))).not.toThrow();
  });
});

describe('resolveNcaaFinalPools', () => {
  it('bounds a single pool by the place count, or leaves it open when none is given', () => {
    expect(resolveNcaaFinalPools('relay-meet', { placeCount: 6 })).toEqual([
      { final: 'championship', firstPlace: 1, lastPlace: 6 },
    ]);
    expect(resolveNcaaFinalPools('relay-meet')).toEqual([
      { final: 'championship', firstPlace: 1, lastPlace: Number.MAX_SAFE_INTEGER },
    ]);
  });

  it('a time final is one pool even in a format that splits finals', () => {
    expect(resolveNcaaFinalPools('championship-12', { timeFinal: true, placeCount: 12 })).toEqual([
      { final: 'championship', firstPlace: 1, lastPlace: 12 },
    ]);
    expect(resolveNcaaFinalPools('championship-12')).toEqual([
      { final: 'championship', firstPlace: 1, lastPlace: 6 },
      { final: 'consolation', firstPlace: 7, lastPlace: 12 },
    ]);
  });

  it('refuses the unsourced 24-competitor split with its citation', () => {
    const err = thrown(() => resolveNcaaFinalPools('championship-24'));
    expect(err).toBeInstanceOf(NcaaUnsourcedRuleError);
    expect((err as NcaaUnsourcedRuleError).citation).toBe('NCAA Rule 7-6-6');
    expect(err.message.startsWith('NCAA Rule 7-6-6: Rule 7-6-6 publishes the 24-competitor point tables')).toBe(true);
  });
});

describe('entry validation messages', () => {
  const run = (format: NcaaMeetFormat, entries: NcaaScoringEntry[], opts = {}) =>
    thrown(() => computeNcaaEventScoring(format, 'individual', entries, opts));

  it('names the duplicate id', () => {
    expect(run(DUAL, [entry('dup', 'A', 1), entry('dup', 'B', 2)]).message).toBe(
      'Duplicate entry id "dup" in one event; entry ids must be unique.'
    );
  });

  it('names an entry whose finish rank is not a positive integer', () => {
    const tail = '; it must be a positive integer (1 = first to touch within its final).';
    expect(run(DUAL, [entry('a', 'A', 0)]).message).toBe(`Entry "a" has finishRank 0${tail}`);
    expect(run(DUAL, [entry('a', 'A', 1.5)]).message).toBe(`Entry "a" has finishRank 1.5${tail}`);
    expect(run(DUAL, [entry('a', 'A', Number.NaN)]).message).toBe(`Entry "a" has finishRank NaN${tail}`);
    // Rank 1 is the lowest accepted.
    expect(() => computeNcaaEventScoring(DUAL, 'individual', [entry('a', 'A', 1)])).not.toThrow();
  });

  it('asks a splitting format for the final, listing the pools', () => {
    const label = NCAA_FORMAT_RULESETS['championship-12'].label;
    expect(run('championship-12', [entry('a', 'A', 1)]).message).toBe(
      `Format "championship-12" (${label}) awards places from separate finals ` +
        `(championship 1-6, consolation 7-12), so entry "a" must declare which final it swam in. ` +
        `It is never inferred from the finish rank. Pass \`timeFinal: true\` for a time-final event ` +
        `(Rule 5-7-4-a).`
    );
  });

  it('refuses a final the format does not contest', () => {
    const err = run('championship-12', [entry('a', 'A', 1, { final: 'championship' }), entry('b', 'B', 2, { final: 'bronze' as never })]);
    expect(err).toBeInstanceOf(NcaaScoringInputError);
    expect(err.message).toBe(
      'Entry "b" declares final "bronze", which format "championship-12" does not contest. ' +
        'Contested finals: championship, consolation.'
    );
  });

  it('refuses a declared final in a single-pool format, and says why', () => {
    const label = NCAA_FORMAT_RULESETS[DUAL].label;
    expect(run(DUAL, [entry('a', 'A', 1, { final: 'consolation' })]).message).toBe(
      `Entry "a" declares final "consolation", but format "${DUAL}" (${label}) contests a single pool of places.`
    );
    expect(
      run('championship-12', [entry('a', 'A', 1, { final: 'consolation' })], { timeFinal: true }).message
    ).toBe(
      'Entry "a" declares final "consolation", but this event was scored as a time final ' +
        '(Rule 5-7-4-a), which has one pool.'
    );
    // The championship tier is allowed in a single-pool event.
    expect(() =>
      computeNcaaEventScoring(DUAL, 'individual', [entry('a', 'A', 1, { final: 'championship' })])
    ).not.toThrow();
  });
});

describe('ties', () => {
  it('a three-way tie shares one third of places 1-3 each and assigns places in input order', () => {
    // Places 1, 2, 3 of 9-4-3-2-1-0 combine to 16; each of three shares 16/3.
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('x', 'A', 1),
      entry('y', 'B', 1),
      entry('z', 'C', 1),
      entry('w', 'D', 4),
    ]);
    expect(r.entries.map(e => [e.id, e.place])).toEqual([
      ['x', 1],
      ['y', 2],
      ['z', 3],
      ['w', 4],
    ]);
    for (const id of ['x', 'y', 'z']) {
      const e = r.entries.find(row => row.id === id);
      expect(e?.points).toBeCloseTo(16 / 3, 9);
      expect(e?.tiedPlaces).toEqual([1, 2, 3]);
    }
    const w = r.entries.find(row => row.id === 'w');
    expect(w).toMatchObject({ points: 2, tiedPlaces: null, reason: null });
  });

  it('a tie that crosses the pool boundary is worth only the places inside the pool', () => {
    // Championship final of 12-competitor format holds places 1-6. A tie for 6th occupies
    // places 6 and 7; place 7 belongs to the consolation final, so it adds 0.
    // 6th = 9, so each of the two takes 9 / 2 = 4.5.
    const entries = [
      entry('c1', 'T1', 1, { final: 'championship' }),
      entry('c2', 'T2', 2, { final: 'championship' }),
      entry('c3', 'T3', 3, { final: 'championship' }),
      entry('c4', 'T4', 4, { final: 'championship' }),
      entry('c5', 'T5', 5, { final: 'championship' }),
      entry('c6', 'T6', 6, { final: 'championship' }),
      entry('c7', 'T7', 6, { final: 'championship' }),
    ];
    const r = computeNcaaEventScoring('championship-12', 'individual', entries);
    expect(r.entries.map(e => e.points)).toEqual([16, 13, 12, 11, 10, 4.5, 4.5]);
  });
});

describe('places beyond the table', () => {
  it('a place past the table scores 0 with its own reason; the last table place does not', () => {
    // Table 9-4-3-2-1-0 has six places. Seven teams: places 6 and 7.
    const teams = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const r = computeNcaaEventScoring(
      DUAL,
      'individual',
      teams.map((t, i) => entry(`e${i + 1}`, t, i + 1))
    );
    expect(r.entries.map(e => [e.points, e.reason])).toEqual([
      [9, null],
      [4, null],
      [3, null],
      [2, null],
      [1, null],
      [0, null],
      [0, 'place-outside-point-table'],
    ]);
    expect(r.lostPlaces).toEqual([]);
    expect(r.pointsLost).toBe(0);
  });

  it('a tie that straddles the end of the table shares the points, and is not flagged as outside it', () => {
    // 9-4-3-2-1-0 has six places. Seven teams; ranks 1-4, then a three-way tie for 5th that
    // spans places 5, 6 and 7: (1 + 0 + 0) / 3 each. The third tied row sits at place 7, past the
    // table, but it earned a third of a point, so it is not "outside the point table".
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('e1', 'T1', 1),
      entry('e2', 'T2', 2),
      entry('e3', 'T3', 3),
      entry('e4', 'T4', 4),
      entry('t1', 'T5', 5),
      entry('t2', 'T6', 5),
      entry('t3', 'T7', 5),
    ]);
    for (const id of ['t1', 't2', 't3']) {
      const e = r.entries.find(row => row.id === id);
      expect(e?.points).toBeCloseTo(1 / 3, 9);
      expect(e?.reason).toBeNull();
      expect(e?.tiedPlaces).toEqual([5, 6, 7]);
    }
    expect(r.entries.find(row => row.id === 't3')?.place).toBe(7);
  });

  it('a host table shorter than the finals pool scores the places it lacks as 0', () => {
    // 12-competitor format, championship final = places 1-6, host table 5-3-1 only.
    const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
      entry(id, `T${i + 1}`, i + 1, { final: 'championship' })
    );
    const r = computeNcaaEventScoring('championship-12', 'individual', entries, {
      hostPublishedTable: table([5, 3, 1]),
    });
    expect(r.entries.map(e => [e.points, e.reason])).toEqual([
      [5, null],
      [3, null],
      [1, null],
      [0, 'place-outside-point-table'],
      [0, 'place-outside-point-table'],
      [0, 'place-outside-point-table'],
    ]);
    expect(r.pointsAwarded).toBe(9);
  });
});

describe('entries with no status default to scoring', () => {
  it('reports status scoring on every row that gave none', () => {
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('a', 'A', 1),
      entry('b', 'B', 2, { status: 'exhibition' }),
      entry('c', 'C', 3, { status: 'disqualified' }),
      entry('d', 'D', 4, { status: 'did-not-compete' }),
    ]);
    expect(r.entries.map(e => [e.status, e.place, e.points, e.reason])).toEqual([
      ['scoring', 1, 9, null],
      ['exhibition', null, 0, 'exhibition'],
      ['disqualified', null, 0, 'disqualified'],
      ['did-not-compete', null, 0, 'did-not-compete'],
    ]);
  });
});

describe('lost places', () => {
  it('a scratch behind the scoring entries never creates a lost place', () => {
    // One finisher, two did-not-compete entries: nothing was contested past place 1.
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('a', 'A', 1),
      entry('b', 'B', 2, { status: 'did-not-compete' }),
      entry('c', 'C', 3, { status: 'did-not-compete' }),
    ]);
    expect(r.lostPlaces).toEqual([]);
    expect(r.pointsLost).toBe(0);
  });

  it('a vacated place worth 0 is not a lost place', () => {
    // Six entries; the sixth is disqualified. Place 6 is worth 0 in 9-4-3-2-1-0.
    const r = computeNcaaEventScoring(
      DUAL,
      'individual',
      ['a', 'b', 'c', 'd', 'e'].map((id, i) => entry(id, `T${i + 1}`, i + 1)).concat(
        entry('f', 'T6', 6, { status: 'disqualified' })
      )
    );
    expect(r.lostPlaces).toEqual([]);
  });

  it('a clean field with no cap breach loses nothing', () => {
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('a', 'A', 1),
      entry('b', 'B', 2),
      entry('c', 'C', 3),
    ]);
    expect(r.lostPlaces).toEqual([]);
    expect(r.pointsAwarded).toBe(16);
    expect(r.pointsLost).toBe(0);
  });

  it('a place lost to the cap that is worth 0 is not reported', () => {
    // Team A has four finishers (1st, 3rd, 4th, 6th); its fourth is capped at 6th, worth 0.
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('a1', 'A', 1),
      entry('b1', 'B', 2),
      entry('a2', 'A', 3),
      entry('a3', 'A', 4),
      entry('b2', 'B', 5),
      entry('a4', 'A', 6),
    ]);
    expect(r.entries.find(e => e.id === 'a4')).toMatchObject({ place: 6, points: 0, reason: 'over-team-scorer-cap' });
    // A: 9 + 3 + 2 = 14. B: 4 + 1 = 5.
    expect(r.teamTotals).toEqual([
      { team: 'A', points: 14 },
      { team: 'B', points: 5 },
    ]);
    expect(r.lostPlaces).toEqual([]);
    expect(r.pointsLost).toBe(0);
  });

  it('lists lost places in place order, whichever cause found them first', () => {
    // A1-A4 take places 1-4; B1 (5th) is disqualified. A4 is over the cap of three: place 4 = 2
    // lost to the cap. Place 5 = 1 was vacated by the DQ: lost, no eligible finisher.
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('a1', 'A', 1),
      entry('a2', 'A', 2),
      entry('a3', 'A', 3),
      entry('a4', 'A', 4),
      entry('b1', 'B', 5, { status: 'disqualified' }),
    ]);
    expect(r.lostPlaces).toEqual([
      { place: 4, points: 2, final: null, cause: 'over-team-scorer-cap' },
      { place: 5, points: 1, final: null, cause: 'no-eligible-finisher' },
    ]);
    expect(r.pointsLost).toBe(3);
    // A: 9 + 4 + 3 = 16.
    expect(r.pointsAwarded).toBe(16);
  });

  it('labels a lost place with the final it was contested in', () => {
    // 12-competitor format: championship final holds places 1-6; five entries swam, one is DQ'd
    // at 5th. Four score places 1-4; place 5 = 10 vacated; place 6 is not contested by anyone.
    const r = computeNcaaEventScoring('championship-12', 'individual', [
      entry('a', 'T1', 1, { final: 'championship' }),
      entry('b', 'T2', 2, { final: 'championship' }),
      entry('c', 'T3', 3, { final: 'championship' }),
      entry('d', 'T4', 4, { final: 'championship' }),
      entry('e', 'T5', 5, { final: 'championship', status: 'disqualified' }),
    ]);
    expect(r.lostPlaces).toEqual([{ place: 5, points: 10, final: 'championship', cause: 'no-eligible-finisher' }]);
  });
});

describe('over-cap entries removed from consideration', () => {
  it('keeps each over-cap entry own status and does not borrow another entry status', () => {
    // The exhibition swim comes first in the list. Exhibition is removed; A1-A3 take places 1-3,
    // and A4 (4th) is over the cap and removed from consideration.
    const r = computeNcaaEventScoring(
      DUAL,
      'individual',
      [
        entry('x', 'Z', 1, { status: 'exhibition' }),
        entry('a1', 'A', 2),
        entry('a2', 'A', 3),
        entry('a3', 'A', 4),
        entry('a4', 'A', 5),
        entry('b1', 'B', 6),
      ],
      { overCapBehavior: 'removed-from-consideration' }
    );
    expect(r.entries.find(e => e.id === 'x')).toMatchObject({ status: 'exhibition', reason: 'exhibition' });
    expect(r.entries.find(e => e.id === 'a4')).toMatchObject({
      status: 'scoring',
      place: null,
      points: 0,
      reason: 'over-team-scorer-cap',
    });
    // B1 advances to 4th: 2 points. A: 9 + 4 + 3 = 16.
    expect(r.entries.find(e => e.id === 'b1')).toMatchObject({ place: 4, points: 2 });
    expect(r.teamTotals).toEqual([
      { team: 'A', points: 16 },
      { team: 'B', points: 2 },
      { team: 'Z', points: 0 },
    ]);
    // Five entries held a lane (the exhibition swim included; the over-cap A4 is set aside), four
    // took places 1-4, so place 5 (worth 1) went unfilled. The over-cap entry adds no lost place.
    expect(r.lostPlaces).toEqual([{ place: 5, points: 1, final: null, cause: 'no-eligible-finisher' }]);
  });

  it('keeps a host table and the time-final flag through the second pass', () => {
    // Host table 10-5-3, one scorer per team. A1 1st, A2 2nd (over cap), B1 3rd, B2 4th (over cap).
    // Removed from consideration: A1 1st = 10, B1 2nd = 5.
    const r = computeNcaaEventScoring(
      'invitational-host-published',
      'individual',
      [entry('a1', 'A', 1), entry('a2', 'A', 2), entry('b1', 'B', 3), entry('b2', 'B', 4)],
      { hostPublishedTable: table([10, 5, 3], 1), overCapBehavior: 'removed-from-consideration' }
    );
    expect(r.teamTotals).toEqual([
      { team: 'A', points: 10 },
      { team: 'B', points: 5 },
    ]);
    expect(r.entries.map(e => [e.id, e.place, e.points, e.reason])).toEqual([
      ['a1', 1, 10, null],
      ['a2', null, 0, 'over-team-scorer-cap'],
      ['b1', 2, 5, null],
      ['b2', null, 0, 'over-team-scorer-cap'],
    ]);
  });

  it('with no entry over the cap the default result is unchanged', () => {
    const entries = [entry('a1', 'A', 1), entry('b1', 'B', 2)];
    const held = computeNcaaEventScoring(DUAL, 'individual', entries);
    const removed = computeNcaaEventScoring(DUAL, 'individual', entries, {
      overCapBehavior: 'removed-from-consideration',
    });
    expect(removed).toEqual(held);
  });
});

describe('team totals', () => {
  it('orders teams by points, highest first, then by name', () => {
    // Zulu 1st = 9. Alpha 2nd, 3rd, 4th = 4 + 3 + 2 = 9. Bravo 5th = 1.
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('z', 'Zulu', 1),
      entry('a1', 'Alpha', 2),
      entry('a2', 'Alpha', 3),
      entry('a3', 'Alpha', 4),
      entry('b', 'Bravo', 5),
    ]);
    expect(r.teamTotals).toEqual([
      { team: 'Alpha', points: 9 },
      { team: 'Zulu', points: 9 },
      { team: 'Bravo', points: 1 },
    ]);
  });

  it('rounds a total to six decimals', () => {
    // A three-way tie for 1st: 16 / 3 each = 5.333333 rounded.
    const r = computeNcaaEventScoring(DUAL, 'individual', [
      entry('x', 'A', 1),
      entry('y', 'B', 1),
      entry('z', 'C', 1),
    ]);
    expect(r.teamTotals.map(t => t.points)).toEqual([5.333333, 5.333333, 5.333333]);
    expect(r.pointsAwarded).toBe(16);
  });
});

describe('aggregateNcaaTeamTotals', () => {
  it('sums across events and orders by points then name', () => {
    // Event 1: Zulu 1st (9), Alpha 2nd (4), Bravo 3rd (3). Event 2: Alpha 1st (9), Zulu 2nd (4).
    // Alpha 13, Zulu 13, Bravo 3. Zulu is first in insertion order; the name breaks the tie.
    const e1 = computeNcaaEventScoring(DUAL, 'individual', [entry('z', 'Zulu', 1), entry('a', 'Alpha', 2), entry('b', 'Bravo', 3)]);
    const e2 = computeNcaaEventScoring(DUAL, 'individual', [entry('a', 'Alpha', 1), entry('z', 'Zulu', 2)]);
    expect(aggregateNcaaTeamTotals([e1, e2])).toEqual([
      { team: 'Alpha', points: 13 },
      { team: 'Zulu', points: 13 },
      { team: 'Bravo', points: 3 },
    ]);
    expect(aggregateNcaaTeamTotals([])).toEqual([]);
  });
});

describe('resolveNcaaDualMeetOutcome', () => {
  const RULE =
    'No contest is recorded if a team fails to contact the host institution or arrive at the ' +
    'site within 30 minutes after the scheduled start time of the meet. There is no resulting ' +
    'score. If a coach removes his or her team from competition for any reason, a forfeit shall ' +
    'be declared. The numerical score to be recorded for a dual meet that is forfeited is 11-0.';

  it('a contested meet records no score here; the events are scored', () => {
    expect(resolveNcaaDualMeetOutcome({ kind: 'contested' })).toEqual({
      kind: 'contested',
      scoreRecorded: false,
      score: null,
      citation: 'NCAA Rule 7-1-3',
      rule: RULE,
    });
  });

  it('a no contest records no score and cites Rule 7-1-3', () => {
    expect(resolveNcaaDualMeetOutcome({ kind: 'no-contest', absentTeam: 'Opp', hostTeam: 'HSU' })).toEqual({
      kind: 'no-contest',
      scoreRecorded: false,
      score: null,
      citation: 'NCAA Rule 7-1-3',
      rule: RULE,
    });
  });

  it('a forfeit records 11-0 for the opposing team and cites Rule 7-1-3', () => {
    expect(
      resolveNcaaDualMeetOutcome({ kind: 'forfeit', forfeitingTeam: 'Opp', opposingTeam: 'HSU' })
    ).toEqual({
      kind: 'forfeit',
      scoreRecorded: true,
      score: [
        { team: 'HSU', points: 11 },
        { team: 'Opp', points: 0 },
      ],
      citation: 'NCAA Rule 7-1-3',
      rule: RULE,
    });
  });

  it('refuses an outcome kind it does not know', () => {
    const err = thrown(() => resolveNcaaDualMeetOutcome({ kind: 'bogus' } as never));
    expect(err).toBeInstanceOf(NcaaScoringInputError);
    expect(err.message).toBe('Unknown dual meet outcome {"kind":"bogus"}.');
  });
});
