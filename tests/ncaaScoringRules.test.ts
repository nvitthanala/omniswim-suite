import { describe, expect, it } from 'vitest';
import {
  NCAA_CHAMPIONSHIP_FIELD_SIZES,
  NCAA_FORMAT_RULESETS,
  NCAA_MEET_FORMATS,
  NcaaScoringInputError,
  NcaaUnsourcedRuleError,
  aggregateNcaaTeamTotals,
  computeNcaaEventScoring,
  ncaaChampionshipFormatForFieldSize,
  resolveNcaaDualMeetOutcome,
  resolveNcaaFinalPools,
  resolveNcaaPointTable,
  type NcaaEventScore,
  type NcaaPointTable,
  type NcaaScoringEntry,
} from '../packages/core/src/lib/ncaaScoringRules';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(
  id: string,
  team: string,
  finishRank: number,
  extra: Partial<NcaaScoringEntry> = {}
): NcaaScoringEntry {
  return { id, team, finishRank, ...extra };
}

function pointsById(result: NcaaEventScore): Record<string, number> {
  return Object.fromEntries(result.entries.map(e => [e.id, e.points]));
}

function placeById(result: NcaaEventScore): Record<string, number | null> {
  return Object.fromEntries(result.entries.map(e => [e.id, e.place]));
}

function totalsByTeam(result: NcaaEventScore): Record<string, number> {
  return Object.fromEntries(result.teamTotals.map(t => [t.team, t.points]));
}

function row(result: NcaaEventScore, id: string) {
  const found = result.entries.find(e => e.id === id);
  if (!found) throw new Error(`no scored entry "${id}"`);
  return found;
}

// ---------------------------------------------------------------------------
// 1. Published point tables — snapshots of the archived rulebook
// ---------------------------------------------------------------------------

describe('NCAA Rule 7 point tables (provenance snapshots)', () => {
  // Every literal below is transcribed from
  // https://meets.swimdna.org/media/ncaascoring.pdf
  // sha256 5b98f8f69470606ea179b053b86d7fb4451f61a874c0fff5d8d18b369d6bb92e,
  // archived at data/scoring_rules/sources/. These assertions exist so that an
  // upstream rulebook edition change breaks CI instead of drifting silently.

  it('Rule 7-1-1 — dual meet, six lanes or more', () => {
    const ruleset = NCAA_FORMAT_RULESETS['dual-six-lanes-or-more'];
    expect(ruleset.individual).toMatchObject({ places: [9, 4, 3, 2, 1, 0], maxScorersPerTeam: 3 });
    expect(ruleset.relay).toMatchObject({ places: [11, 4, 2, 0], maxScorersPerTeam: 2 });
    expect(ruleset.finals.kind).toBe('single-pool');
  });

  it('Rule 7-1-2 — dual meet, five lanes or fewer', () => {
    const ruleset = NCAA_FORMAT_RULESETS['dual-five-lanes-or-fewer'];
    expect(ruleset.individual).toMatchObject({ places: [5, 3, 1, 0], maxScorersPerTeam: 2 });
    // The rule caps individual scorers at two and states no relay cap. Transcribed as
    // printed: an absent rule is null, not a value copied over from Rule 7-1-1.
    expect(ruleset.relay).toMatchObject({ places: [7, 0], maxScorersPerTeam: null });
  });

  it('Rule 7-1-4 — the three dual diving tables, and no relay table', () => {
    expect(NCAA_FORMAT_RULESETS['dual-diving-three-or-fewer'].individual).toMatchObject({
      places: [7, 5, 4, 3, 2, 1],
      maxScorersPerTeam: 3,
    });
    expect(NCAA_FORMAT_RULESETS['dual-diving-four-or-five'].individual).toMatchObject({
      places: [9, 7, 6, 5, 3, 2, 1],
      maxScorersPerTeam: 4,
    });
    expect(NCAA_FORMAT_RULESETS['dual-diving-six-or-more'].individual).toMatchObject({
      places: [16, 13, 12, 11, 10, 9, 7, 5, 4, 3, 2, 1],
      maxScorersPerTeam: 6,
    });
    for (const format of [
      'dual-diving-three-or-fewer',
      'dual-diving-four-or-five',
      'dual-diving-six-or-more',
    ] as const) {
      expect(NCAA_FORMAT_RULESETS[format].relay).toBeNull();
    }
  });

  it('Rule 7-2 — double-dual, triangular or quadrangular', () => {
    const ruleset = NCAA_FORMAT_RULESETS['double-dual-tri-quad'];
    expect(ruleset.individual).toMatchObject({ places: [9, 4, 3, 2, 1], maxScorersPerTeam: 3 });
    expect(ruleset.relay).toMatchObject({ places: [11, 4, 2], maxScorersPerTeam: 2 });
  });

  it('Rule 7-3 — relay meets use 14-10-8-6-4-2 for all events', () => {
    const ruleset = NCAA_FORMAT_RULESETS['relay-meet'];
    expect(ruleset.individual).toMatchObject({ places: [14, 10, 8, 6, 4, 2] });
    expect(ruleset.relay).toMatchObject({ places: [14, 10, 8, 6, 4, 2] });
  });

  it('Rule 7-6 — championship tables by qualifying field size', () => {
    expect(NCAA_FORMAT_RULESETS['championship-6'].individual).toMatchObject({
      places: [7, 5, 4, 3, 2, 1],
    });
    expect(NCAA_FORMAT_RULESETS['championship-6'].relay).toMatchObject({
      places: [14, 10, 8, 6, 4, 2],
    });

    expect(NCAA_FORMAT_RULESETS['championship-8'].individual).toMatchObject({
      places: [9, 7, 6, 5, 4, 3, 2, 1],
    });
    expect(NCAA_FORMAT_RULESETS['championship-8'].relay).toMatchObject({
      places: [18, 14, 12, 10, 8, 6, 4, 2],
    });

    expect(NCAA_FORMAT_RULESETS['championship-12'].individual).toMatchObject({
      places: [16, 13, 12, 11, 10, 9, 7, 5, 4, 3, 2, 1],
    });
    expect(NCAA_FORMAT_RULESETS['championship-12'].relay).toMatchObject({
      places: [32, 26, 24, 22, 20, 18, 14, 10, 8, 6, 4, 2],
    });

    expect(NCAA_FORMAT_RULESETS['championship-16'].individual).toMatchObject({
      places: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    });
    expect(NCAA_FORMAT_RULESETS['championship-16'].relay).toMatchObject({
      places: [40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2],
    });

    expect(NCAA_FORMAT_RULESETS['championship-18'].individual).toMatchObject({
      places: [22, 19, 18, 17, 16, 15, 14, 13, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1],
    });
    expect(NCAA_FORMAT_RULESETS['championship-18'].relay).toMatchObject({
      places: [44, 38, 36, 34, 32, 30, 28, 26, 24, 20, 16, 14, 12, 10, 8, 6, 4, 2],
    });

    expect(NCAA_FORMAT_RULESETS['championship-24'].individual).toMatchObject({
      places: [32, 28, 27, 26, 25, 24, 23, 22, 20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    });
    expect(NCAA_FORMAT_RULESETS['championship-24'].relay).toMatchObject({
      places: [64, 56, 54, 52, 50, 48, 46, 44, 40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2],
    });
  });

  it('every table is strictly ordered, non-negative, and carries a citation', () => {
    for (const format of NCAA_MEET_FORMATS) {
      const ruleset = NCAA_FORMAT_RULESETS[format];
      for (const slot of [ruleset.individual, ruleset.relay]) {
        if (slot === null || 'kind' in slot) continue;
        expect(slot.citation).toMatch(/^NCAA Rule 7/);
        expect(slot.rule.length).toBeGreaterThan(20);
        expect(slot.places.length).toBeGreaterThan(0);
        for (const [index, value] of slot.places.entries()) {
          expect(value).toBeGreaterThanOrEqual(0);
          if (index > 0) expect(value).toBeLessThanOrEqual(slot.places[index - 1]);
        }
      }
    }
  });

  it('championship field sizes match the articles that publish a table', () => {
    expect([...NCAA_CHAMPIONSHIP_FIELD_SIZES]).toEqual([6, 8, 12, 16, 18, 24]);
    expect(ncaaChampionshipFormatForFieldSize(12)).toBe('championship-12');
  });
});

// ---------------------------------------------------------------------------
// 2. Six-lane dual, clean field — the literal tables
// ---------------------------------------------------------------------------

describe('dual meet, six lanes or more (Rule 7-1-1)', () => {
  it('scores a clean individual field 9-4-3-2-1-0', () => {
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('opp-1', 'Opponent', 2),
      entry('hsu-2', 'HSU', 3),
      entry('opp-2', 'Opponent', 4),
      entry('hsu-3', 'HSU', 5),
      entry('opp-3', 'Opponent', 6),
    ]);

    expect(pointsById(result)).toEqual({
      'hsu-1': 9,
      'opp-1': 4,
      'hsu-2': 3,
      'opp-2': 2,
      'hsu-3': 1,
      'opp-3': 0,
    });
    expect(totalsByTeam(result)).toEqual({ HSU: 13, Opponent: 6 });
    expect(result.pointsAwarded).toBe(19);
    expect(result.pointsLost).toBe(0);
    expect(result.lostPlaces).toEqual([]);
  });

  it('distinguishes a genuine table zero from a suppressed zero', () => {
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('opp-1', 'Opponent', 2),
      entry('hsu-2', 'HSU', 3),
      entry('opp-2', 'Opponent', 4),
      entry('hsu-3', 'HSU', 5),
      entry('opp-3', 'Opponent', 6),
      entry('opp-scratch', 'Opponent', 7, { status: 'did-not-compete' }),
    ]);

    // Sixth place is worth 0 in the published table — a real place, a real zero.
    expect(row(result, 'opp-3')).toMatchObject({ place: 6, points: 0, reason: null });
    // A swimmer who never swam took no place at all. Same number, different fact.
    expect(row(result, 'opp-scratch')).toMatchObject({
      place: null,
      points: 0,
      reason: 'did-not-compete',
    });
  });

  it('scores a clean relay field 11-4-2-0 with the best two relays per team', () => {
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'relay', [
      entry('hsu-a', 'HSU', 1),
      entry('opp-a', 'Opponent', 2),
      entry('hsu-b', 'HSU', 3),
      entry('opp-b', 'Opponent', 4),
    ]);

    expect(pointsById(result)).toEqual({ 'hsu-a': 11, 'opp-a': 4, 'hsu-b': 2, 'opp-b': 0 });
    expect(totalsByTeam(result)).toEqual({ HSU: 13, Opponent: 4 });
  });
});

// ---------------------------------------------------------------------------
// 3. Disqualification
// ---------------------------------------------------------------------------

describe('disqualification (Rule 7-7)', () => {
  // Rule 7-7-1, verbatim: "If one or more disqualifications occur during an event in a
  // nonchampionships meet, the disqualified competitor(s) shall not score in that
  // event. All other competitors may ADVANCE IN POSITION and shall score according to
  // the places they achieve with the disqualified competitor(s) removed from
  // consideration. Any remaining places and points shall be lost from the meet."
  //
  // NOTE: plans/2026-09-06/02-data-model-and-scoring.md §3 summarised this as "places
  // below are *not* bumped up", which is the opposite of what the rulebook says. The
  // rulebook wins. What is lost is the trailing place nobody is left to fill, not the
  // disqualified swimmer's place.
  it('scores the DQ zero AND advances every swimmer behind it', () => {
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('opp-1', 'Opponent', 2),
      entry('hsu-2', 'HSU', 3, { status: 'disqualified' }),
      entry('opp-2', 'Opponent', 4),
      entry('hsu-3', 'HSU', 5),
      entry('opp-3', 'Opponent', 6),
    ]);

    expect(row(result, 'hsu-2')).toMatchObject({
      place: null,
      points: 0,
      reason: 'disqualified',
    });

    // opp-2 touched fourth but scores third-place points, because the DQ is removed
    // from consideration before places are awarded.
    expect(row(result, 'opp-2')).toMatchObject({ place: 3, points: 3 });
    expect(row(result, 'hsu-3')).toMatchObject({ place: 4, points: 2 });
    expect(row(result, 'opp-3')).toMatchObject({ place: 5, points: 1 });

    expect(totalsByTeam(result)).toEqual({ HSU: 11, Opponent: 8 });
  });

  it('loses the trailing place when nobody is left to fill it', () => {
    // Rule 7-2 table 9-4-3-2-1 has no trailing zero, so a five-entry field with one DQ
    // leaves fifth place — worth one point — genuinely unawarded.
    const result = computeNcaaEventScoring('double-dual-tri-quad', 'individual', [
      entry('a1', 'Alpha', 1),
      entry('b1', 'Bravo', 2),
      entry('c1', 'Charlie', 3, { status: 'disqualified' }),
      entry('a2', 'Alpha', 4),
      entry('b2', 'Bravo', 5),
    ]);

    expect(pointsById(result)).toEqual({ a1: 9, b1: 4, c1: 0, a2: 3, b2: 2 });
    expect(result.lostPlaces).toEqual([
      { place: 5, points: 1, final: null, cause: 'no-eligible-finisher' },
    ]);
    expect(result.pointsLost).toBe(1);
    expect(result.pointsAwarded).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// 4. Exhibition
// ---------------------------------------------------------------------------

describe('exhibition swims (Rule 7-10-1)', () => {
  it('does not let an exhibition second place consume a scoring slot', () => {
    // Rule 7-10-1: "Exhibition swims shall not be scored in any event. All competitors
    // who are not designated by their coaches to be exhibition swimmers shall score
    // according to the places they achieve with the exhibition swimmers removed from
    // consideration."
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('hsu-ex', 'HSU', 2, { status: 'exhibition' }),
      entry('opp-1', 'Opponent', 3),
      entry('hsu-2', 'HSU', 4),
      entry('opp-2', 'Opponent', 5),
      entry('opp-3', 'Opponent', 6),
    ]);

    expect(row(result, 'hsu-ex')).toMatchObject({
      place: null,
      points: 0,
      reason: 'exhibition',
    });
    // The real second-place finisher still receives second-place points.
    expect(row(result, 'opp-1')).toMatchObject({ place: 2, points: 4 });
    expect(row(result, 'hsu-2')).toMatchObject({ place: 3, points: 3 });
    expect(totalsByTeam(result)).toEqual({ HSU: 12, Opponent: 7 });
    expect(result.pointsAwarded).toBe(19);
  });

  it('does not count an exhibition swim against the team scorer cap', () => {
    // HSU places four swimmers but designates one exhibition, so only three of them
    // are ever under consideration — the cap is not reached.
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('hsu-ex', 'HSU', 2, { status: 'exhibition' }),
      entry('hsu-2', 'HSU', 3),
      entry('hsu-3', 'HSU', 4),
      entry('opp-1', 'Opponent', 5),
      entry('opp-2', 'Opponent', 6),
    ]);

    expect(result.entries.filter(e => e.reason === 'over-team-scorer-cap')).toEqual([]);
    expect(totalsByTeam(result)).toEqual({ HSU: 16, Opponent: 3 });
  });
});

// ---------------------------------------------------------------------------
// Failure to compete (Rule 7-9)
// ---------------------------------------------------------------------------

describe('failure to compete (Rule 7-9)', () => {
  // Regression test for a real bug found by code review (2026-09-07): a
  // `did-not-compete` entry was counting toward how many places a pool
  // "contested" when computing lostPlaces, fabricating lost points for
  // places nobody ever occupied. Rule 7-9's own text is unambiguous: "No
  // competitor may score points in an event in which the competitor does not
  // compete" — a scratch never took a lane, so it can't leave one empty
  // either. A disqualified or exhibition entry, by contrast, did occupy a
  // lane (Rule 7-7/7-10's "removed from consideration, others may advance"
  // presumes a real lane to advance into) and correctly still counts.
  it('does not fabricate lost places for scratched entries that never occupied a lane', () => {
    // 9-4-3-2-1 table (Rule 7-2), no trailing zero. Three real finishers, two
    // scratches. Before the fix, the two scratches inflated the pool's
    // "contested" size from 3 to 5, and places 4-5 (worth 2 and 1 points) were
    // reported as lost from the meet — points that were never in play, because
    // only three swimmers ever raced.
    const result = computeNcaaEventScoring('double-dual-tri-quad', 'individual', [
      entry('a1', 'Alpha', 1),
      entry('b1', 'Bravo', 2),
      entry('a2', 'Alpha', 3),
      entry('scratch-1', 'Charlie', 4, { status: 'did-not-compete' }),
      entry('scratch-2', 'Charlie', 5, { status: 'did-not-compete' }),
    ]);

    expect(pointsById(result)).toEqual({ a1: 9, b1: 4, a2: 3, 'scratch-1': 0, 'scratch-2': 0 });
    expect(result.lostPlaces).toEqual([]);
    expect(result.pointsLost).toBe(0);
  });

  it('still reports a genuinely lost place behind a scratch, when a real finisher vacated it', () => {
    // Same table, but this time a DQ (not a scratch) sits behind the three
    // real finishers, alongside one scratch. The DQ occupied a lane; the
    // scratch did not. Only the DQ's place should ever be eligible to be
    // "lost".
    const result = computeNcaaEventScoring('double-dual-tri-quad', 'individual', [
      entry('a1', 'Alpha', 1),
      entry('b1', 'Bravo', 2),
      entry('a2', 'Alpha', 3),
      entry('dq-1', 'Charlie', 4, { status: 'disqualified' }),
      entry('scratch-1', 'Delta', 5, { status: 'did-not-compete' }),
    ]);

    expect(result.lostPlaces).toEqual([{ place: 4, points: 2, final: null, cause: 'no-eligible-finisher' }]);
    expect(result.pointsLost).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Ties
// ---------------------------------------------------------------------------

describe('ties (Rule 7-8)', () => {
  it('splits the combined points of the places the tie occupies', () => {
    // Rule 7-8: "In the case of ties within an event, the points involved shall be
    // equally divided among the tied competitors." A tie for second occupies places
    // two and three: 4 + 3 = 7, halved.
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('opp-1', 'Opponent', 2),
      entry('hsu-2', 'HSU', 2),
      entry('opp-2', 'Opponent', 4),
      entry('hsu-3', 'HSU', 5),
      entry('opp-3', 'Opponent', 6),
    ]);

    expect(row(result, 'opp-1')).toMatchObject({ place: 2, points: 3.5, tiedPlaces: [2, 3] });
    expect(row(result, 'hsu-2')).toMatchObject({ place: 3, points: 3.5, tiedPlaces: [2, 3] });
    // The field behind the tie resumes at the next unoccupied place.
    expect(row(result, 'opp-2')).toMatchObject({ place: 4, points: 2, tiedPlaces: null });
    expect(totalsByTeam(result)).toEqual({ HSU: 13.5, Opponent: 5.5 });
    expect(result.pointsAwarded).toBe(19);
  });

  it('divides a three-way tie evenly and still totals a whole meet score', () => {
    // Places one through three: 9 + 4 + 3 = 16, split three ways — a repeating
    // fraction that must not leak float noise into the team total.
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('hsu-2', 'HSU', 1),
      entry('hsu-3', 'HSU', 1),
      entry('opp-1', 'Opponent', 4),
      entry('opp-2', 'Opponent', 5),
      entry('opp-3', 'Opponent', 6),
    ]);

    for (const id of ['hsu-1', 'hsu-2', 'hsu-3']) {
      expect(row(result, id).points).toBeCloseTo(16 / 3, 10);
      expect(row(result, id).tiedPlaces).toEqual([1, 2, 3]);
    }
    expect(totalsByTeam(result)).toEqual({ HSU: 16, Opponent: 3 });
    expect(result.pointsAwarded).toBe(19);
  });

  it('treats a tie that runs off the end of the table as worth only the table places', () => {
    // Rule 7-2's table stops at fifth place. A tie for fifth occupies places five and
    // six; six is not in the table, so the pair splits one point.
    const result = computeNcaaEventScoring('double-dual-tri-quad', 'individual', [
      entry('a1', 'Alpha', 1),
      entry('b1', 'Bravo', 2),
      entry('c1', 'Charlie', 3),
      entry('a2', 'Alpha', 4),
      entry('b2', 'Bravo', 5),
      entry('c2', 'Charlie', 5),
    ]);

    expect(row(result, 'b2')).toMatchObject({ place: 5, points: 0.5, tiedPlaces: [5, 6] });
    expect(row(result, 'c2')).toMatchObject({ place: 6, points: 0.5, tiedPlaces: [5, 6] });
  });
});

// ---------------------------------------------------------------------------
// 6. Championship finals
// ---------------------------------------------------------------------------

describe('championship finals (Rule 7-6)', () => {
  // The brief suggested an eight-competitor final for this scenario, but Rule 7-6-2
  // describes no consolation final for a field of eight — the championship/consolation
  // split first appears at 12 competitors (Rule 7-6-3), which is what is used here.

  const championshipField: NcaaScoringEntry[] = [
    entry('c1', 'Alpha', 1, { final: 'championship' }),
    entry('c2', 'Bravo', 2, { final: 'championship' }),
    entry('c3', 'Charlie', 3, { final: 'championship' }),
    entry('c4', 'Alpha', 4, { final: 'championship' }),
    entry('c5', 'Bravo', 5, { final: 'championship' }),
    entry('c6', 'Charlie', 6, { final: 'championship' }),
  ];
  const consolationField: NcaaScoringEntry[] = [
    entry('s1', 'Alpha', 1, { final: 'consolation' }),
    entry('s2', 'Bravo', 2, { final: 'consolation' }),
    entry('s3', 'Charlie', 3, { final: 'consolation' }),
    entry('s4', 'Alpha', 4, { final: 'consolation' }),
    entry('s5', 'Bravo', 5, { final: 'consolation' }),
    entry('s6', 'Charlie', 6, { final: 'consolation' }),
  ];

  it('awards 1-6 from the championship final and 7-12 from the consolation final', () => {
    const result = computeNcaaEventScoring('championship-12', 'individual', [
      ...championshipField,
      ...consolationField,
    ]);

    expect(placeById(result)).toEqual({
      c1: 1, c2: 2, c3: 3, c4: 4, c5: 5, c6: 6,
      s1: 7, s2: 8, s3: 9, s4: 10, s5: 11, s6: 12,
    });
    expect(pointsById(result)).toEqual({
      c1: 16, c2: 13, c3: 12, c4: 11, c5: 10, c6: 9,
      s1: 7, s2: 5, s3: 4, s4: 3, s5: 2, s6: 1,
    });

    // No consolation swimmer can outscore the lowest-scoring place of the
    // championship final. Rule 7-6-8's cap, stated as an invariant.
    const lowestChampionshipPoints = Math.min(
      ...result.entries.filter(e => e.final === 'championship').map(e => e.points)
    );
    const highestConsolationPoints = Math.max(
      ...result.entries.filter(e => e.final === 'consolation').map(e => e.points)
    );
    expect(highestConsolationPoints).toBeLessThan(lowestChampionshipPoints);
  });

  it('caps a consolation swimmer at seventh even when the championship final has a DQ', () => {
    // Rule 7-6-8: "A competitor in a consolation final cannot advance, either by time
    // or by disqualification in the championships final, to any place higher than the
    // highest place being contested in the consolation final."
    const withDq = championshipField.map(e =>
      e.id === 'c3' ? { ...e, status: 'disqualified' as const } : e
    );
    const result = computeNcaaEventScoring('championship-12', 'individual', [
      ...withDq,
      ...consolationField,
    ]);

    // Inside the championship final, the field behind the DQ advances (Rule 7-7-2).
    expect(row(result, 'c3')).toMatchObject({ place: null, points: 0, reason: 'disqualified' });
    expect(row(result, 'c4')).toMatchObject({ place: 3, points: 12 });
    expect(row(result, 'c6')).toMatchObject({ place: 5, points: 10 });

    // Sixth place is contested by the championship final only. The consolation winner
    // may NOT advance into it, so its nine points are lost from the meet.
    expect(row(result, 's1')).toMatchObject({ place: 7, points: 7, final: 'consolation' });
    expect(result.lostPlaces).toEqual([
      { place: 6, points: 9, final: 'championship', cause: 'no-eligible-finisher' },
    ]);
    expect(result.pointsLost).toBe(9);
    // The 12-place individual table sums to 93. Sixth place is unawarded, so 84 of
    // those points reach a team and 9 leave the meet.
    expect(result.pointsAwarded).toBe(84);
    expect(result.pointsAwarded + result.pointsLost).toBe(
      result.table.places.reduce((sum, value) => sum + value, 0)
    );
  });

  it('never merges the two finals by raw time', () => {
    // A consolation swimmer faster than the championship final's sixth place still
    // scores from the consolation pool. The engine is given ranks per final and has no
    // way to merge them, which is the point — this asserts the contract holds.
    const result = computeNcaaEventScoring('championship-12', 'individual', [
      ...championshipField,
      ...consolationField,
    ]);
    expect(row(result, 's1').place).toBe(7);
    expect(result.pools).toEqual([
      { final: 'championship', firstPlace: 1, lastPlace: 6 },
      { final: 'consolation', firstPlace: 7, lastPlace: 12 },
    ]);
  });

  it('requires every entry to declare its final — never infers it from the rank', () => {
    expect(() =>
      computeNcaaEventScoring('championship-12', 'individual', [
        entry('c1', 'Alpha', 1, { final: 'championship' }),
        entry('c2', 'Bravo', 2),
      ])
    ).toThrow(NcaaScoringInputError);
  });

  it('scores a 16-competitor field 1-8 championship, 9-16 consolation', () => {
    const entries: NcaaScoringEntry[] = [];
    for (let rank = 1; rank <= 8; rank += 1) {
      entries.push(entry(`c${rank}`, `Team${rank}`, rank, { final: 'championship' }));
      entries.push(entry(`s${rank}`, `Team${rank}`, rank, { final: 'consolation' }));
    }
    const result = computeNcaaEventScoring('championship-16', 'individual', entries);

    expect(row(result, 'c8')).toMatchObject({ place: 8, points: 11 });
    expect(row(result, 's1')).toMatchObject({ place: 9, points: 9 });
    expect(row(result, 's8')).toMatchObject({ place: 16, points: 1 });
  });

  it('marks the 18-competitor split as derived from the published heat size', () => {
    const finals = NCAA_FORMAT_RULESETS['championship-18'].finals;
    expect(finals.kind).toBe('split');
    if (finals.kind !== 'split') throw new Error('expected a split');
    expect(finals.provenance).toBe('derived-from-heat-size');
    expect(finals.pools).toEqual([
      { final: 'championship', firstPlace: 1, lastPlace: 9 },
      { final: 'consolation', firstPlace: 10, lastPlace: 18 },
    ]);
  });

  it('has no consolation final for six- or eight-competitor fields', () => {
    expect(NCAA_FORMAT_RULESETS['championship-6'].finals.kind).toBe('single-pool');
    expect(NCAA_FORMAT_RULESETS['championship-8'].finals.kind).toBe('single-pool');

    const result = computeNcaaEventScoring('championship-8', 'individual', [
      entry('a', 'Alpha', 1),
      entry('b', 'Bravo', 2),
      entry('c', 'Charlie', 3),
    ]);
    expect(pointsById(result)).toEqual({ a: 9, b: 7, c: 6 });
    expect(result.entries.every(e => e.final === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Per-team scorer cap
// ---------------------------------------------------------------------------

describe('per-team scorer caps (Rules 7-1-1, 7-1-2, 7-2)', () => {
  it('scores a fourth individual finisher zero once the team has its best three', () => {
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('hsu-2', 'HSU', 2),
      entry('hsu-3', 'HSU', 3),
      entry('hsu-4', 'HSU', 4),
      entry('opp-1', 'Opponent', 5),
      entry('opp-2', 'Opponent', 6),
    ]);

    // Zero, not the next table value down.
    expect(row(result, 'hsu-4')).toMatchObject({
      place: 4,
      points: 0,
      reason: 'over-team-scorer-cap',
    });
    // And the default reading does not move the opponents up into fourth.
    expect(row(result, 'opp-1')).toMatchObject({ place: 5, points: 1 });
    expect(row(result, 'opp-2')).toMatchObject({ place: 6, points: 0 });

    expect(totalsByTeam(result)).toEqual({ HSU: 16, Opponent: 1 });
    expect(result.lostPlaces).toEqual([
      { place: 4, points: 2, final: null, cause: 'over-team-scorer-cap' },
    ]);
  });

  it('offers the alternative reading, in which the over-cap finisher is removed', () => {
    const result = computeNcaaEventScoring(
      'dual-six-lanes-or-more',
      'individual',
      [
        entry('hsu-1', 'HSU', 1),
        entry('hsu-2', 'HSU', 2),
        entry('hsu-3', 'HSU', 3),
        entry('hsu-4', 'HSU', 4),
        entry('opp-1', 'Opponent', 5),
        entry('opp-2', 'Opponent', 6),
      ],
      { overCapBehavior: 'removed-from-consideration' }
    );

    expect(row(result, 'hsu-4')).toMatchObject({
      place: null,
      points: 0,
      reason: 'over-team-scorer-cap',
      status: 'scoring',
    });
    expect(row(result, 'opp-1')).toMatchObject({ place: 4, points: 2 });
    expect(row(result, 'opp-2')).toMatchObject({ place: 5, points: 1 });
    expect(totalsByTeam(result)).toEqual({ HSU: 16, Opponent: 3 });
    expect(result.pointsLost).toBe(0);
  });

  it('caps relays at the best two per team', () => {
    const result = computeNcaaEventScoring('dual-six-lanes-or-more', 'relay', [
      entry('hsu-a', 'HSU', 1),
      entry('hsu-b', 'HSU', 2),
      entry('hsu-c', 'HSU', 3),
      entry('opp-a', 'Opponent', 4),
    ]);

    expect(pointsById(result)).toEqual({ 'hsu-a': 11, 'hsu-b': 4, 'hsu-c': 0, 'opp-a': 0 });
    expect(row(result, 'hsu-c').reason).toBe('over-team-scorer-cap');
    expect(totalsByTeam(result)).toEqual({ HSU: 15, Opponent: 0 });
  });

  it('applies the cap by place, not by input order', () => {
    const result = computeNcaaEventScoring('dual-five-lanes-or-fewer', 'individual', [
      entry('hsu-slow', 'HSU', 4),
      entry('hsu-fast', 'HSU', 1),
      entry('hsu-mid', 'HSU', 2),
      entry('opp-1', 'Opponent', 3),
    ]);

    // Rule 7-1-2 caps individual scorers at two: the fastest two HSU swimmers score.
    expect(row(result, 'hsu-fast')).toMatchObject({ place: 1, points: 5 });
    expect(row(result, 'hsu-mid')).toMatchObject({ place: 2, points: 3 });
    expect(row(result, 'hsu-slow')).toMatchObject({ points: 0, reason: 'over-team-scorer-cap' });
    expect(row(result, 'opp-1')).toMatchObject({ place: 3, points: 1 });
  });

  it('applies no relay cap where Rule 7-1-2 states none', () => {
    const result = computeNcaaEventScoring('dual-five-lanes-or-fewer', 'relay', [
      entry('hsu-a', 'HSU', 1),
      entry('hsu-b', 'HSU', 2),
      entry('hsu-c', 'HSU', 3),
    ]);
    expect(result.entries.some(e => e.reason === 'over-team-scorer-cap')).toBe(false);
    expect(pointsById(result)).toEqual({ 'hsu-a': 7, 'hsu-b': 0, 'hsu-c': 0 });
  });
});

// ---------------------------------------------------------------------------
// 8. Absent, not guessed
// ---------------------------------------------------------------------------

describe('unsourced values are absent, never invented', () => {
  it('refuses a championship field size the rulebook publishes no table for', () => {
    expect(() => ncaaChampionshipFormatForFieldSize(20)).toThrow(NcaaUnsourcedRuleError);
    expect(() => ncaaChampionshipFormatForFieldSize(32)).toThrow(/7-6-7/);
  });

  it('refuses to split a 24-competitor field, whose finals structure is unpublished', () => {
    expect(() => resolveNcaaFinalPools('championship-24')).toThrow(NcaaUnsourcedRuleError);
    expect(() =>
      computeNcaaEventScoring('championship-24', 'individual', [entry('a', 'Alpha', 1)])
    ).toThrow(/does not state which place range each final contests/);
  });

  it('still scores a 24-competitor time final, because that table IS published', () => {
    // Rules 7-6-3 and 7-6-4 both begin "Except in time final events (see Rule
    // 5-7-4-a)" — a time final is one pool, so no split is needed.
    const result = computeNcaaEventScoring(
      'championship-24',
      'individual',
      [entry('a', 'Alpha', 1), entry('b', 'Bravo', 2), entry('c', 'Charlie', 3)],
      { timeFinal: true }
    );
    expect(pointsById(result)).toEqual({ a: 32, b: 28, c: 27 });
  });

  it('has no NCAA invitational table to fall back on (Rule 7-4)', () => {
    expect(() => resolveNcaaPointTable('invitational-host-published', 'individual')).toThrow(
      NcaaUnsourcedRuleError
    );

    const hostTable: NcaaPointTable = {
      places: [20, 17, 16, 15, 14, 13],
      maxScorersPerTeam: null,
      citation: 'Host meet information, 2026 Example Invitational',
      rule: 'Published by the host institution in advance, per NCAA Rule 7-4.',
    };
    const result = computeNcaaEventScoring(
      'invitational-host-published',
      'individual',
      [entry('a', 'Alpha', 1), entry('b', 'Bravo', 2)],
      { hostPublishedTable: hostTable }
    );
    expect(pointsById(result)).toEqual({ a: 20, b: 17 });
    expect(result.table.citation).toContain('Example Invitational');
  });

  it('refuses a relay event in a diving dual format', () => {
    expect(() => resolveNcaaPointTable('dual-diving-six-or-more', 'relay')).toThrow(
      NcaaScoringInputError
    );
  });

  it('rejects malformed entry lists rather than repairing them', () => {
    expect(() =>
      computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
        entry('dup', 'Alpha', 1),
        entry('dup', 'Bravo', 2),
      ])
    ).toThrow(/Duplicate entry id/);

    expect(() =>
      computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [entry('a', 'Alpha', 0)])
    ).toThrow(/positive integer/);

    expect(() =>
      computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
        entry('a', 'Alpha', 1, { final: 'consolation' }),
      ])
    ).toThrow(/single pool/);
  });
});

// ---------------------------------------------------------------------------
// 9. Meet-level no contest and forfeit
// ---------------------------------------------------------------------------

describe('no contest vs. forfeit (Rule 7-1-3)', () => {
  it('records no score at all for a team that fails to appear', () => {
    const outcome = resolveNcaaDualMeetOutcome({
      kind: 'no-contest',
      absentTeam: 'Opponent',
      hostTeam: 'HSU',
    });
    expect(outcome.scoreRecorded).toBe(false);
    // Absent, not 0-0. A zero-zero score would be a fabricated result.
    expect(outcome.score).toBeNull();
  });

  it('records 11-0 for a coach-initiated forfeit', () => {
    const outcome = resolveNcaaDualMeetOutcome({
      kind: 'forfeit',
      forfeitingTeam: 'Opponent',
      opposingTeam: 'HSU',
    });
    expect(outcome.scoreRecorded).toBe(true);
    expect(outcome.score).toEqual([
      { team: 'HSU', points: 11 },
      { team: 'Opponent', points: 0 },
    ]);
  });

  it('keeps the two states distinguishable', () => {
    const noContest = resolveNcaaDualMeetOutcome({
      kind: 'no-contest',
      absentTeam: 'Opponent',
      hostTeam: 'HSU',
    });
    const forfeit = resolveNcaaDualMeetOutcome({
      kind: 'forfeit',
      forfeitingTeam: 'Opponent',
      opposingTeam: 'HSU',
    });
    expect(noContest.kind).not.toBe(forfeit.kind);
    expect(noContest.scoreRecorded).not.toBe(forfeit.scoreRecorded);
  });
});

// ---------------------------------------------------------------------------
// 10. Meet aggregation and package-root exports
// ---------------------------------------------------------------------------

describe('meet aggregation', () => {
  it('sums team points across events without float drift', () => {
    const event1 = computeNcaaEventScoring('dual-six-lanes-or-more', 'individual', [
      entry('hsu-1', 'HSU', 1),
      entry('hsu-2', 'HSU', 1),
      entry('hsu-3', 'HSU', 1),
      entry('opp-1', 'Opponent', 4),
      entry('opp-2', 'Opponent', 5),
      entry('opp-3', 'Opponent', 6),
    ]);
    const event2 = computeNcaaEventScoring('dual-six-lanes-or-more', 'relay', [
      entry('opp-a', 'Opponent', 1),
      entry('hsu-a', 'HSU', 2),
      entry('opp-b', 'Opponent', 3),
      entry('hsu-b', 'HSU', 4),
    ]);

    expect(aggregateNcaaTeamTotals([event1, event2])).toEqual([
      { team: 'HSU', points: 20 },
      { team: 'Opponent', points: 16 },
    ]);
  });
});

describe('package root re-exports', () => {
  it('exposes the Rule 7 engine from @omniswim/core', async () => {
    const core = await import('@omniswim/core');
    expect(typeof core.computeNcaaEventScoring).toBe('function');
    expect(typeof core.resolveNcaaDualMeetOutcome).toBe('function');
    expect(core.NCAA_FORMAT_RULESETS['dual-six-lanes-or-more'].individual).toMatchObject({
      places: [9, 4, 3, 2, 1, 0],
    });
    // The pre-existing ScoringSettings pipeline is untouched and still exported.
    expect(typeof core.parseScoringTheory).toBe('function');
  });
});
