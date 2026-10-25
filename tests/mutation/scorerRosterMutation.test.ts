/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `scorerRoster.ts` (plan item T6). Each case
 * kills Stryker mutants that survived the suite as it stood on 2026-10-14 (see
 * docs/reference/MUTATION_RESULTS_2026-10-14.md).
 *
 * Expected values are written by hand from the rules in the file header of
 * `scorerRoster.ts`: a swim in an A or B final marks an athlete a scorer, a
 * prelim-only swim does not, a recruit scores by default, and a manual
 * override always wins.
 */
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type AthleteAliasLink,
  type ScorerAutoRules,
  type ScorerRosterOverride,
  type ScoringSettings,
  type SwimmerResult,
} from '../../packages/core/src/types';
import { buildAliasResolver } from '../../packages/core/src/lib/athleteAliases';
import {
  aggregateSwimmerMeetPoints,
  buildScorerRosterLookup,
  getAthleteCreditedSwims,
  isAbFinalRelayLeg,
  isPlaceholderAthleteName,
  relayEntryRosterEligible,
  rowSuggestsScorer,
  scorerRosterKey,
  usesScorerRoster,
} from '../../packages/core/src/lib/scorerRoster';

const FREE50 = 'Event 8 Men 50 Yard Freestyle';
const BACK100 = 'Event 12 Men 100 Yard Backstroke';
const FREE1650 = 'Event 20 Men 1650 Yard Freestyle';
const DIVE = 'Event 15 Men 1 mtr Diving';
const RELAY = 'Event 2 Men 200 Yard Freestyle Relay';

function swim(partial: Partial<SwimmerResult> & { name: string }): SwimmerResult {
  return {
    id: `${partial.name}-${partial.event ?? FREE50}-${partial.roundSwam ?? 'A Final'}`,
    rank: 1,
    team: 'Alpha',
    classYear: 'JR',
    time: '20.00',
    finalsTime: '20.00',
    roundSwam: 'A Final',
    points: 0,
    event: FREE50,
    gender: Gender.MEN,
    ...partial,
  } as SwimmerResult;
}

function settings(extra: Partial<ScoringSettings> = {}): ScoringSettings {
  return {
    scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11],
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    aFinalBracketSize: 8,
    scorerCapScope: 'event',
    scorerEligibilityMode: 'roster',
    usePdfPlacePoints: false,
    ...extra,
  } as ScoringSettings;
}

function link(canonicalName: string, aliasName: string, team?: string): AthleteAliasLink {
  return {
    id: `${canonicalName}-${aliasName}`,
    gender: Gender.MEN,
    ...(team === undefined ? {} : { team }),
    canonicalName,
    aliasName,
    source: 'manual',
  };
}

describe('isPlaceholderAthleteName', () => {
  it('flags an empty, blank, dash or Unknown name and nothing else', () => {
    for (const n of [undefined, '', '   ', '—', '-', 'Unknown', '  Unknown  ', ' — ']) {
      expect(isPlaceholderAthleteName(n)).toBe(true);
    }
    for (const n of ['unknown', 'Unknown Smith', 'Ann', '--', '– ', 'A']) {
      expect(isPlaceholderAthleteName(n)).toBe(false);
    }
  });
});

describe('scorerRosterKey', () => {
  it('joins trimmed team, gender and canonical name with three bars', () => {
    const key = scorerRosterKey('  Alpha ', Gender.MEN, 'Ann Lee');
    expect(key.startsWith('Alpha|||Men|||')).toBe(true);
    expect(key.split('|||')).toHaveLength(3);
    expect(scorerRosterKey('Alpha', Gender.WOMEN, 'Ann Lee').startsWith('Alpha|||Women|||')).toBe(true);
    // An absent gender is an empty segment, never the word "undefined".
    expect(scorerRosterKey('Alpha', undefined, 'Ann Lee').startsWith('Alpha||||||')).toBe(true);
  });

  it('is the same key for "Last, First" and "First Last"', () => {
    expect(scorerRosterKey('Alpha', Gender.MEN, 'Lee, Ann')).toBe(scorerRosterKey('Alpha', Gender.MEN, 'Ann Lee'));
    expect(scorerRosterKey('Alpha', Gender.MEN, 'Ann Lee')).not.toBe(scorerRosterKey('Alpha', Gender.MEN, 'Bea Lee'));
  });
});

describe('rowSuggestsScorer', () => {
  const rules: ScorerAutoRules = {
    abFinalTiers: ['A', 'B'],
    includeRelayLegsInFinals: true,
    distanceFinalRequired: true,
    distanceEventPattern: ['1000', '1650', '1500'],
  };

  it('is false with no rules at all', () => {
    expect(rowSuggestsScorer(swim({ name: 'Ann' }), undefined)).toBe(false);
  });

  it('is true for an A or B final and false for any other round', () => {
    expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: 'A Final' }), rules)).toBe(true);
    expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: 'B Final' }), rules)).toBe(true);
    for (const round of ['Preliminaries', 'C Final', 'D Final', 'Time Trial', 'Finals', undefined]) {
      expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: round }), rules)).toBe(false);
    }
  });

  it('reads the tiers from the rules, and A + B when the rules name none', () => {
    expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: 'B Final' }), { abFinalTiers: ['A'] })).toBe(false);
    expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: 'A Final' }), { abFinalTiers: ['A'] })).toBe(true);
    expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: 'A Final' }), {})).toBe(true);
    expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: 'B Final' }), {})).toBe(true);
    expect(rowSuggestsScorer(swim({ name: 'Ann', roundSwam: 'Preliminaries' }), {})).toBe(false);
  });

  it('a relay leg in a final counts unless the rules switch relay legs off', () => {
    const leg = swim({ name: 'Ann', event: RELAY, isRelay: true });
    expect(rowSuggestsScorer(leg, rules)).toBe(true);
    expect(rowSuggestsScorer(leg, { abFinalTiers: ['A', 'B'] })).toBe(true);
    expect(rowSuggestsScorer(leg, { ...rules, includeRelayLegsInFinals: false })).toBe(false);
    // The event name alone marks a relay when the flag is absent.
    const byName = swim({ name: 'Ann', event: RELAY });
    expect(rowSuggestsScorer(byName, { ...rules, includeRelayLegsInFinals: false })).toBe(false);
    // A prelim relay leg never counts.
    expect(rowSuggestsScorer(swim({ name: 'Ann', event: RELAY, roundSwam: 'Preliminaries' }), rules)).toBe(false);
  });

  it('a distance final with no distance pattern in the rules does not throw', () => {
    const open: ScorerAutoRules = { distanceFinalRequired: true };
    expect(rowSuggestsScorer(swim({ name: 'Ann', event: FREE1650 }), open)).toBe(true);
    expect(rowSuggestsScorer(swim({ name: 'Ann', event: FREE1650, roundSwam: 'Preliminaries' }), open)).toBe(false);
    expect(rowSuggestsScorer(swim({ name: 'Ann', event: FREE1650 }), rules)).toBe(true);
  });
});

describe('rowSuggestsScorer distance rule', () => {
  // The distance rule only runs for a tier the rules count. The type allows A and B alone, so a
  // prelim tier reaches it only through a stored setting that lists PRE (an out-of-type value).
  const withPre = (extra: ScorerAutoRules = {}): ScorerAutoRules => ({
    abFinalTiers: ['A', 'B', 'PRE'] as unknown as Array<'A' | 'B'>,
    distanceFinalRequired: true,
    ...extra,
  });
  const prelim = (event: string | undefined) => swim({ name: 'Ann', roundSwam: 'Preliminaries', event });

  it('a prelim distance swim does not mark a scorer when a final is required', () => {
    expect(rowSuggestsScorer(prelim(FREE1650), withPre())).toBe(false);
    expect(rowSuggestsScorer(prelim('Event 5 Men 1000 Yard Freestyle'), withPre())).toBe(false);
    expect(rowSuggestsScorer(prelim('Event 5 Men 1500 Meter Freestyle'), withPre())).toBe(false);
  });

  it('a prelim swim that is not a distance event still does, and so does a distance A final', () => {
    expect(rowSuggestsScorer(prelim(FREE50), withPre())).toBe(true);
    expect(rowSuggestsScorer(swim({ name: 'Ann', event: FREE1650 }), withPre())).toBe(true);
  });

  it('with no final required, a prelim distance swim counts', () => {
    expect(rowSuggestsScorer(prelim(FREE1650), withPre({ distanceFinalRequired: false }))).toBe(true);
  });

  it('reads the distance patterns from the rules, whatever the case', () => {
    const rules = withPre({ distanceEventPattern: ['mile'] });
    expect(rowSuggestsScorer(prelim('Event 20 Men Mile'), rules)).toBe(false);
    expect(rowSuggestsScorer(prelim('Event 20 Men MILE'), rules)).toBe(false);
    // The default patterns are not used when the rules name their own.
    expect(rowSuggestsScorer(prelim(FREE1650), rules)).toBe(true);
    expect(rowSuggestsScorer(prelim(FREE1650), withPre({ distanceEventPattern: [] }))).toBe(false);
  });

  it('a swim with no event is not a distance swim, and does not throw', () => {
    expect(rowSuggestsScorer(prelim(undefined), withPre())).toBe(true);
  });
});

describe('isAbFinalRelayLeg', () => {
  it('is true only for a relay leg in a tier the rules count', () => {
    const s = settings();
    expect(isAbFinalRelayLeg(swim({ name: 'Ann', event: RELAY, isRelay: true }), s)).toBe(true);
    expect(isAbFinalRelayLeg(swim({ name: 'Ann', event: RELAY, roundSwam: 'B Final' }), s)).toBe(true);
    expect(isAbFinalRelayLeg(swim({ name: 'Ann', event: RELAY, roundSwam: 'Preliminaries' }), s)).toBe(false);
    // An individual A final is not a relay leg.
    expect(isAbFinalRelayLeg(swim({ name: 'Ann' }), s)).toBe(false);
  });

  it('follows the settings own auto rules', () => {
    const leg = swim({ name: 'Ann', event: RELAY, roundSwam: 'B Final' });
    expect(isAbFinalRelayLeg(leg, settings({ scorerAutoRules: { abFinalTiers: ['A'] } }))).toBe(false);
    expect(
      isAbFinalRelayLeg(
        swim({ name: 'Ann', event: RELAY }),
        settings({ scorerAutoRules: { includeRelayLegsInFinals: false } })
      )
    ).toBe(false);
  });
});

describe('usesScorerRoster', () => {
  it('is true only in roster mode', () => {
    expect(usesScorerRoster(settings({ scorerEligibilityMode: 'roster' }))).toBe(true);
    expect(usesScorerRoster(settings({ scorerEligibilityMode: 'points_pool' }))).toBe(false);
  });
});

describe('buildScorerRosterLookup', () => {
  it('marks A and B finalists as scorers and everyone else as not, source auto', () => {
    const results = [
      swim({ name: 'Ann Lee' }),
      swim({ name: 'Bea Fox', roundSwam: 'B Final' }),
      swim({ name: 'Cy Ode', roundSwam: 'Preliminaries' }),
    ];
    const lookup = buildScorerRosterLookup(results, settings());
    expect(lookup.rows.map(r => [r.name, r.isScorer, r.source])).toEqual([
      ['Ann Lee', true, 'auto'],
      ['Bea Fox', true, 'auto'],
      ['Cy Ode', false, 'auto'],
    ]);
    expect(lookup.isScorer('Ann Lee', 'Alpha', Gender.MEN)).toBe(true);
    expect(lookup.isScorer('Cy Ode', 'Alpha', Gender.MEN)).toBe(false);
    // A name the roster never saw is not a scorer.
    expect(lookup.isScorer('Dee Ray', 'Alpha', Gender.MEN)).toBe(false);
    // Same name, other team or gender: another athlete.
    expect(lookup.isScorer('Ann Lee', 'Bravo', Gender.MEN)).toBe(false);
    expect(lookup.isScorer('Ann Lee', 'Alpha', Gender.WOMEN)).toBe(false);
  });

  it('carries the canonical name, team, gender and class year on each row', () => {
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Ann Lee', classYear: 'SR', gender: Gender.WOMEN, team: ' Alpha ' })],
      settings()
    );
    expect(lookup.rows).toHaveLength(1);
    expect(lookup.rows[0]).toMatchObject({
      name: 'Ann Lee',
      team: 'Alpha',
      gender: Gender.WOMEN,
      classYear: 'SR',
      athleteRole: 'swimmer',
      isScorer: true,
      source: 'auto',
      isRecruit: false,
    });
    expect(lookup.rows[0]?.key).toBe(scorerRosterKey('Alpha', Gender.WOMEN, 'Ann Lee'));
  });

  it('a row with no class year shows an empty one', () => {
    const lookup = buildScorerRosterLookup([swim({ name: 'Ann Lee', classYear: undefined })], settings());
    expect(lookup.rows[0]?.classYear).toBe('');
  });

  it('sorts rows by team, then name', () => {
    const lookup = buildScorerRosterLookup(
      [
        swim({ name: 'Zed Ash', team: 'Alpha' }),
        swim({ name: 'Ann Lee', team: 'Bravo' }),
        swim({ name: 'Amy Fox', team: 'Alpha' }),
      ],
      settings()
    );
    expect(lookup.rows.map(r => `${r.team}/${r.name}`)).toEqual(['Alpha/Amy Fox', 'Alpha/Zed Ash', 'Bravo/Ann Lee']);
  });

  it('a manual override wins both ways and marks the row manual', () => {
    const overrides: ScorerRosterOverride[] = [
      { name: 'Ann Lee', team: 'Alpha', gender: Gender.MEN, isScorer: false },
      { name: 'Cy Ode', team: 'Alpha', gender: Gender.MEN, isScorer: true },
    ];
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Ann Lee' }), swim({ name: 'Cy Ode', roundSwam: 'Preliminaries' })],
      settings(),
      overrides
    );
    expect(lookup.rows.map(r => [r.name, r.isScorer, r.source])).toEqual([
      ['Ann Lee', false, 'manual'],
      ['Cy Ode', true, 'manual'],
    ]);
    expect(lookup.isScorer('Ann Lee', 'Alpha', Gender.MEN)).toBe(false);
    expect(lookup.isScorer('Cy Ode', 'Alpha', Gender.MEN)).toBe(true);
  });

  it('an override for another gender or team does not apply', () => {
    const lookup = buildScorerRosterLookup([swim({ name: 'Ann Lee' })], settings(), [
      { name: 'Ann Lee', team: 'Alpha', gender: Gender.WOMEN, isScorer: false },
      { name: 'Ann Lee', team: 'Bravo', gender: Gender.MEN, isScorer: false },
    ]);
    expect(lookup.rows[0]).toMatchObject({ isScorer: true, source: 'auto' });
  });

  it('the last of two overrides for one athlete wins', () => {
    const a = { name: 'Ann Lee', team: 'Alpha', gender: Gender.MEN };
    const results = [swim({ name: 'Ann Lee' })];
    const offThenOn = buildScorerRosterLookup(results, settings(), [
      { ...a, isScorer: false },
      { ...a, isScorer: true },
    ]);
    expect(offThenOn.isScorer('Ann Lee', 'Alpha', Gender.MEN)).toBe(true);
    const onThenOff = buildScorerRosterLookup(results, settings(), [
      { ...a, isScorer: true },
      { ...a, isScorer: false },
    ]);
    expect(onThenOff.isScorer('Ann Lee', 'Alpha', Gender.MEN)).toBe(false);
  });

  it('a recruit scores by default, and an override still beats that', () => {
    const results = [swim({ name: 'Rae New', isRecruit: true, roundSwam: 'Preliminaries' })];
    const plain = buildScorerRosterLookup(results, settings());
    expect(plain.rows[0]).toMatchObject({ isRecruit: true, isScorer: true, source: 'auto' });
    expect(plain.isScorer('Rae New', 'Alpha', Gender.MEN)).toBe(true);
    const off = buildScorerRosterLookup(results, settings(), [
      { name: 'Rae New', team: 'Alpha', gender: Gender.MEN, isScorer: false },
    ]);
    expect(off.rows[0]).toMatchObject({ isRecruit: true, isScorer: false, source: 'manual' });
    expect(off.isScorer('Rae New', 'Alpha', Gender.MEN)).toBe(false);
  });

  it('a recruit row for a known athlete turns the roster row into a recruit, in either order', () => {
    const meetRow = swim({ name: 'Ann Lee', roundSwam: 'Preliminaries' });
    const recruitRow = swim({ name: 'Ann Lee', isRecruit: true, id: 'rec-ann', roundSwam: 'Preliminaries' });
    const meetFirst = buildScorerRosterLookup([meetRow, recruitRow], settings());
    expect(meetFirst.rows).toHaveLength(1);
    expect(meetFirst.rows[0]).toMatchObject({ isRecruit: true, isScorer: true });
    const recruitFirst = buildScorerRosterLookup([recruitRow, meetRow], settings());
    expect(recruitFirst.rows).toHaveLength(1);
    expect(recruitFirst.rows[0]).toMatchObject({ isRecruit: true, isScorer: true });
    // Without the recruit row the same athlete is not a scorer.
    expect(buildScorerRosterLookup([meetRow], settings()).rows[0]).toMatchObject({ isRecruit: false, isScorer: false });
  });

  it('a recruit row never makes a row a scorer through its round', () => {
    // The recruit has no evidence of its own; only the default applies. A non-recruit
    // prelim row for another athlete stays out.
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Rae New', isRecruit: true }), swim({ name: 'Ann Lee', roundSwam: 'Preliminaries' })],
      settings(),
      undefined
    );
    expect(lookup.isScorer('Rae New', 'Alpha', Gender.MEN)).toBe(true);
    expect(lookup.isScorer('Ann Lee', 'Alpha', Gender.MEN)).toBe(false);
  });

  it('a diver row upgrades the role, and a later swim does not downgrade it', () => {
    const swimFirst = buildScorerRosterLookup(
      [swim({ name: 'Dee Ray', roundSwam: 'Preliminaries' }), swim({ name: 'Dee Ray', event: DIVE })],
      settings()
    );
    expect(swimFirst.rows).toHaveLength(1);
    expect(swimFirst.rows[0]?.athleteRole).toBe('diver');
    const diveFirst = buildScorerRosterLookup(
      [swim({ name: 'Dee Ray', event: DIVE }), swim({ name: 'Dee Ray', roundSwam: 'Preliminaries' })],
      settings()
    );
    expect(diveFirst.rows[0]?.athleteRole).toBe('diver');
    expect(buildScorerRosterLookup([swim({ name: 'Ann Lee' })], settings()).rows[0]?.athleteRole).toBe('swimmer');
  });

  it('a recruit dive is not a diver row, and a relay leg never is', () => {
    const lookup = buildScorerRosterLookup(
      [
        swim({ name: 'Rae New', event: DIVE, isRecruit: true }),
        swim({ name: 'Ann Lee', event: 'Event 3 Men 200 Yard Diving Relay', isRelay: true }),
      ],
      settings()
    );
    expect(lookup.rows.map(r => [r.name, r.athleteRole])).toEqual([
      ['Ann Lee', 'swimmer'],
      ['Rae New', 'swimmer'],
    ]);
  });

  it('uses the diver pattern from the settings', () => {
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Dee Ray', event: 'Event 15 Men Platform Springboard' })],
      settings({ diverEventPattern: ['SPRINGBOARD'] })
    );
    expect(lookup.rows[0]?.athleteRole).toBe('diver');
    const none = buildScorerRosterLookup([swim({ name: 'Dee Ray', event: 'Event 15 Men Platform Springboard' })], settings());
    expect(none.rows[0]?.athleteRole).toBe('swimmer');
  });

  it('drops team-name relay rows and placeholder relay legs, but keeps them for recruits', () => {
    const lookup = buildScorerRosterLookup(
      [
        swim({ name: 'Alpha', team: 'Alpha', event: RELAY, isRelay: true }),
        swim({ name: '—', event: RELAY, isRelay: true }),
        swim({ name: '', event: RELAY, isRelay: true }),
        swim({ name: 'Ann Lee', event: RELAY, isRelay: true }),
      ],
      settings()
    );
    expect(lookup.rows.map(r => r.name)).toEqual(['Ann Lee']);
    const recruits = buildScorerRosterLookup(
      [
        swim({ name: 'Alpha', team: 'Alpha', event: RELAY, isRelay: true, isRecruit: true }),
        swim({ name: '—', event: RELAY, isRelay: true, isRecruit: true }),
      ],
      settings()
    );
    expect(recruits.rows.map(r => r.name).sort()).toEqual(['Alpha', '—']);
  });

  it('an individual row is never dropped as a placeholder or team name', () => {
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Alpha', team: 'Alpha' }), swim({ name: 'Unknown', team: 'Bravo' })],
      settings()
    );
    expect(lookup.rows.map(r => r.name)).toEqual(['Alpha', 'Unknown']);
  });

  it('a blank or whitespace team is the Unknown team in the roster and the lookup', () => {
    const results = [
      swim({ name: 'Ann Lee', team: '   ' }),
      swim({ name: 'Bea Fox', team: undefined }),
      swim({ name: 'Rae New', team: '  ', isRecruit: true, roundSwam: 'Preliminaries' }),
      swim({ name: 'Cy Ode', team: '  ', roundSwam: 'Preliminaries' }),
    ];
    const lookup = buildScorerRosterLookup(results, settings());
    expect(lookup.rows.map(r => [r.name, r.team, r.isScorer])).toEqual([
      ['Ann Lee', 'Unknown', true],
      ['Bea Fox', 'Unknown', true],
      ['Cy Ode', 'Unknown', false],
      ['Rae New', 'Unknown', true],
    ]);
    expect(lookup.isScorer('Ann Lee', 'Unknown', Gender.MEN)).toBe(true);
    expect(lookup.isScorer('Rae New', 'Unknown', Gender.MEN)).toBe(true);
    expect(lookup.isScorer('Cy Ode', 'Unknown', Gender.MEN)).toBe(false);
  });

  it('the gender filter drops other-gender rows, keeps unlabelled ones under that gender', () => {
    const results = [
      swim({ name: 'Ann Lee', gender: Gender.WOMEN }),
      swim({ name: 'Bea Fox', gender: Gender.MEN }),
      swim({ name: 'Cy Ode', gender: undefined }),
    ];
    const women = buildScorerRosterLookup(results, settings(), undefined, Gender.WOMEN);
    expect(women.rows.map(r => [r.name, r.gender, r.isScorer])).toEqual([
      ['Ann Lee', Gender.WOMEN, true],
      ['Cy Ode', Gender.WOMEN, true],
    ]);
    // The unlabelled row's A-final evidence attaches under the filter's gender.
    expect(women.isScorer('Cy Ode', 'Alpha', Gender.WOMEN)).toBe(true);
    expect(women.isScorer('Cy Ode', 'Alpha', Gender.MEN)).toBe(false);

    const men = buildScorerRosterLookup(results, settings(), undefined, Gender.MEN);
    expect(men.rows.map(r => r.name)).toEqual(['Bea Fox', 'Cy Ode']);

    // No filter: unlabelled rows are men; every other row keeps its own gender.
    const all = buildScorerRosterLookup(results, settings());
    expect(all.rows.map(r => [r.name, r.gender])).toEqual([
      ['Ann Lee', Gender.WOMEN],
      ['Bea Fox', Gender.MEN],
      ['Cy Ode', Gender.MEN],
    ]);
  });

  it('a recruit of the other gender does not make that gender lookup say yes', () => {
    const results = [swim({ name: 'Rae New', gender: Gender.WOMEN, isRecruit: true })];
    const men = buildScorerRosterLookup(results, settings(), undefined, Gender.MEN);
    expect(men.rows).toEqual([]);
    expect(men.isScorer('Rae New', 'Alpha', Gender.WOMEN)).toBe(false);
    const women = buildScorerRosterLookup(results, settings(), undefined, Gender.WOMEN);
    expect(women.isScorer('Rae New', 'Alpha', Gender.WOMEN)).toBe(true);
  });

  it('a recruit with no gender is keyed under the filter gender', () => {
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Rae New', gender: undefined, isRecruit: true, roundSwam: 'Preliminaries' })],
      settings(),
      undefined,
      Gender.WOMEN
    );
    expect(lookup.isScorer('Rae New', 'Alpha', Gender.WOMEN)).toBe(true);
    expect(lookup.isScorer('Rae New', 'Alpha', Gender.MEN)).toBe(false);
  });

  it('uses the settings own auto rules when present', () => {
    const results = [swim({ name: 'Ann Lee', roundSwam: 'B Final' })];
    const aOnly = buildScorerRosterLookup(results, settings({ scorerAutoRules: { abFinalTiers: ['A'] } }));
    expect(aOnly.rows[0]?.isScorer).toBe(false);
    expect(buildScorerRosterLookup(results, settings()).rows[0]?.isScorer).toBe(true);
  });

  it('links two spellings into one row with the canonical name', () => {
    const resolver = buildAliasResolver([link('Cam Mask', 'Camden Mask', 'Alpha')]);
    const results = [
      swim({ name: 'Camden Mask', roundSwam: 'Preliminaries' }),
      swim({ name: 'Cam Mask', roundSwam: 'A Final', event: BACK100 }),
    ];
    const lookup = buildScorerRosterLookup(results, settings(), undefined, undefined, resolver);
    expect(lookup.rows).toHaveLength(1);
    expect(lookup.rows[0]).toMatchObject({ name: 'Cam Mask', isScorer: true });
    // Either spelling asks the same question.
    expect(lookup.isScorer('Camden Mask', 'Alpha', Gender.MEN)).toBe(true);
    expect(lookup.isScorer('Cam Mask', 'Alpha', Gender.MEN)).toBe(true);
    // Without the resolver they are two athletes, and only one scores.
    const split = buildScorerRosterLookup(results, settings());
    expect(split.rows).toHaveLength(2);
    expect(split.isScorer('Camden Mask', 'Alpha', Gender.MEN)).toBe(false);
  });

  it('an override recorded under one spelling applies to the linked athlete', () => {
    const resolver = buildAliasResolver([link('Cam Mask', 'Camden Mask', 'Alpha')]);
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Cam Mask' })],
      settings(),
      [{ name: 'Camden Mask', team: 'Alpha', gender: Gender.MEN, isScorer: false }],
      undefined,
      resolver
    );
    expect(lookup.rows[0]).toMatchObject({ name: 'Cam Mask', isScorer: false, source: 'manual' });
    expect(lookup.isScorer('Cam Mask', 'Alpha', Gender.MEN)).toBe(false);
  });

  it('a recruit under one spelling scores the athlete under the other', () => {
    const resolver = buildAliasResolver([link('Cam Mask', 'Camden Mask', 'Alpha')]);
    const lookup = buildScorerRosterLookup(
      [swim({ name: 'Camden Mask', isRecruit: true, roundSwam: 'Preliminaries' })],
      settings(),
      undefined,
      undefined,
      resolver
    );
    expect(lookup.isScorer('Cam Mask', 'Alpha', Gender.MEN)).toBe(true);
  });
});

describe('relayEntryRosterEligible', () => {
  const legs = (round: string, names = ['L1', 'L2', 'L3', 'L4'], extra: Partial<SwimmerResult> = {}) =>
    names.map(n => swim({ name: n, event: RELAY, isRelay: true, roundSwam: round, ...extra }));

  it('is true outside roster mode, with no lookup', () => {
    expect(relayEntryRosterEligible(legs('Preliminaries'), settings({ scorerEligibilityMode: 'points_pool' }))).toBe(true);
  });

  it('an A or B final relay is eligible without a lookup', () => {
    expect(relayEntryRosterEligible(legs('A Final'), settings())).toBe(true);
    expect(relayEntryRosterEligible(legs('B Final'), settings())).toBe(true);
  });

  it('a prelim relay needs a lookup that holds every leg as a scorer', () => {
    const group = legs('Preliminaries');
    expect(relayEntryRosterEligible(group, settings())).toBe(false);
    const all = buildScorerRosterLookup(
      group,
      settings(),
      group.map(r => ({ name: r.name, team: 'Alpha', gender: Gender.MEN, isScorer: true }))
    );
    expect(relayEntryRosterEligible(group, settings(), all)).toBe(true);
    const oneOut = buildScorerRosterLookup(
      group,
      settings(),
      group.map(r => ({ name: r.name, team: 'Alpha', gender: Gender.MEN, isScorer: r.name !== 'L3' }))
    );
    expect(relayEntryRosterEligible(group, settings(), oneOut)).toBe(false);
    const none = buildScorerRosterLookup(group, settings());
    expect(relayEntryRosterEligible(group, settings(), none)).toBe(false);
  });

  it('with relay legs switched off a final relay is judged leg by leg', () => {
    const s = settings({ scorerAutoRules: { includeRelayLegsInFinals: false } });
    const group = legs('A Final');
    expect(relayEntryRosterEligible(group, s)).toBe(false);
    const all = buildScorerRosterLookup(
      group,
      s,
      group.map(r => ({ name: r.name, team: 'Alpha', gender: Gender.MEN, isScorer: true }))
    );
    expect(relayEntryRosterEligible(group, s, all)).toBe(true);
  });

  it('rules that name no tiers default to A and B', () => {
    const s = settings({ scorerAutoRules: { includeRelayLegsInFinals: true } });
    expect(relayEntryRosterEligible(legs('A Final'), s)).toBe(true);
    expect(relayEntryRosterEligible(legs('B Final'), s)).toBe(true);
    expect(relayEntryRosterEligible(legs('Preliminaries'), s)).toBe(false);
  });

  it('a tier outside the rules is judged leg by leg', () => {
    const s = settings({ scorerAutoRules: { abFinalTiers: ['A'] } });
    const group = legs('B Final');
    expect(relayEntryRosterEligible(group, s)).toBe(false);
    expect(relayEntryRosterEligible(legs('A Final'), s)).toBe(true);
  });

  it('looks legs up under the Unknown team and the entry gender', () => {
    const blank = legs('Preliminaries', ['L1', 'L2'], { team: '  ' });
    const lookup = buildScorerRosterLookup(
      blank,
      settings(),
      blank.map(r => ({ name: r.name, team: 'Unknown', gender: Gender.MEN, isScorer: true }))
    );
    expect(relayEntryRosterEligible(blank, settings(), lookup)).toBe(true);

    const women = legs('Preliminaries', ['L1', 'L2'], { gender: Gender.WOMEN });
    const menOnly = buildScorerRosterLookup(
      women,
      settings(),
      women.map(r => ({ name: r.name, team: 'Alpha', gender: Gender.MEN, isScorer: true }))
    );
    expect(relayEntryRosterEligible(women, settings(), menOnly)).toBe(false);
  });
});

describe('aggregateSwimmerMeetPoints', () => {
  it('sums individual and relay points per athlete key', () => {
    const rows = [
      swim({ name: 'Ann Lee', points: 20 }),
      swim({ name: 'Ann Lee', event: BACK100, points: 13 }),
      swim({ name: 'Ann Lee', event: RELAY, isRelay: true, points: 8.5 }),
      swim({ name: 'Bea Fox', points: 17 }),
    ];
    const totals = aggregateSwimmerMeetPoints(rows);
    expect(totals.get(scorerRosterKey('Alpha', Gender.MEN, 'Ann Lee'))).toBe(41.5);
    expect(totals.get(scorerRosterKey('Alpha', Gender.MEN, 'Bea Fox'))).toBe(17);
    expect(totals.size).toBe(2);
  });

  it('a row with no numeric points adds nothing, and does not make the total NaN', () => {
    const rows = [
      swim({ name: 'Ann Lee', points: 20 }),
      swim({ name: 'Ann Lee', event: BACK100, points: undefined as unknown as number }),
      swim({ name: 'Bea Fox', points: undefined as unknown as number }),
    ];
    const totals = aggregateSwimmerMeetPoints(rows);
    expect(totals.get(scorerRosterKey('Alpha', Gender.MEN, 'Ann Lee'))).toBe(20);
    expect(totals.get(scorerRosterKey('Alpha', Gender.MEN, 'Bea Fox'))).toBe(0);
  });

  it('skips team-name relay rows, but not a recruit one', () => {
    const rows = [
      swim({ name: 'Alpha', team: 'Alpha', event: RELAY, isRelay: true, points: 40 }),
      swim({ name: 'Alpha', team: 'Alpha', event: RELAY, isRelay: true, points: 7, isRecruit: true }),
    ];
    const totals = aggregateSwimmerMeetPoints(rows);
    expect(totals.get(scorerRosterKey('Alpha', Gender.MEN, 'Alpha'))).toBe(7);
    // An individual row named like its team is kept.
    const solo = aggregateSwimmerMeetPoints([swim({ name: 'Alpha', team: 'Alpha', points: 5 })]);
    expect(solo.get(scorerRosterKey('Alpha', Gender.MEN, 'Alpha'))).toBe(5);
  });

  it('applies the gender filter, keeping unlabelled rows under it', () => {
    const rows = [
      swim({ name: 'Ann Lee', gender: Gender.WOMEN, points: 20 }),
      swim({ name: 'Bea Fox', gender: Gender.MEN, points: 17 }),
      swim({ name: 'Cy Ode', gender: undefined, points: 16 }),
    ];
    const women = aggregateSwimmerMeetPoints(rows, Gender.WOMEN);
    expect(women.get(scorerRosterKey('Alpha', Gender.WOMEN, 'Ann Lee'))).toBe(20);
    expect(women.get(scorerRosterKey('Alpha', Gender.WOMEN, 'Cy Ode'))).toBe(16);
    expect(women.has(scorerRosterKey('Alpha', Gender.MEN, 'Bea Fox'))).toBe(false);
    expect(women.size).toBe(2);
    // No filter: unlabelled rows are men.
    const all = aggregateSwimmerMeetPoints(rows);
    expect(all.get(scorerRosterKey('Alpha', Gender.MEN, 'Cy Ode'))).toBe(16);
    expect(all.size).toBe(3);
  });

  it('keys a blank or whitespace team as Unknown', () => {
    const totals = aggregateSwimmerMeetPoints([
      swim({ name: 'Ann Lee', team: '   ', points: 20 }),
      swim({ name: 'Ann Lee', team: undefined, event: BACK100, points: 3 }),
    ]);
    expect(totals.get(scorerRosterKey('Unknown', Gender.MEN, 'Ann Lee'))).toBe(23);
    expect(totals.size).toBe(1);
  });

  it('merges linked spellings when given the resolver', () => {
    const resolver = buildAliasResolver([link('Cam Mask', 'Camden Mask', 'Alpha')]);
    const rows = [swim({ name: 'Camden Mask', points: 20 }), swim({ name: 'Cam Mask', event: BACK100, points: 13 })];
    const merged = aggregateSwimmerMeetPoints(rows, undefined, resolver);
    expect(merged.get(scorerRosterKey('Alpha', Gender.MEN, 'Cam Mask'))).toBe(33);
    expect(merged.size).toBe(1);
    expect(aggregateSwimmerMeetPoints(rows).size).toBe(2);
  });
});

describe('getAthleteCreditedSwims', () => {
  it('returns the swims of one athlete, in meet order, highest points first within an event', () => {
    const rows = [
      swim({ id: 'e5-low', name: 'Ann Lee', event: 'Event 5 Men 100 Yard Butterfly', points: 5 }),
      swim({ id: 'e3-a', name: 'Ann Lee', event: 'Event 3 Men 200 Yard IM', points: 9 }),
      swim({ id: 'e1', name: 'Ann Lee', event: 'Event 1 Men 50 Yard Freestyle', points: 3 }),
      swim({ id: 'e5-high', name: 'Ann Lee', event: 'Event 5 Men 100 Yard Butterfly', points: 20, roundSwam: 'B Final' }),
      swim({ id: 'e3-b', name: 'Ann Lee', event: 'Event 3 Men 200 Yard IM', points: 11, roundSwam: 'Preliminaries' }),
      swim({ id: 'other', name: 'Bea Fox', points: 99 }),
    ];
    const out = getAthleteCreditedSwims(rows, 'Alpha', 'Ann Lee', Gender.MEN);
    expect(out.map(s => s.id)).toEqual(['e1', 'e3-b', 'e3-a', 'e5-high', 'e5-low']);
  });

  it('copies the row fields and marks kind by event', () => {
    const row = swim({
      id: 'r1',
      name: 'Ann Lee',
      event: BACK100,
      time: '55.10',
      rank: 3,
      points: 16,
      roundSwam: 'A Final',
      isRecruit: true,
    });
    const [s] = getAthleteCreditedSwims([row], 'Alpha', 'Ann Lee', Gender.MEN);
    expect(s).toMatchObject({
      id: 'r1',
      event: BACK100,
      time: '55.10',
      displayTime: '55.10',
      roundSwam: 'A Final',
      rank: 3,
      points: 16,
      kind: 'individual',
      isRecruit: true,
    });
    expect(s !== undefined && 'convertedFrom' in s).toBe(false);
    expect(s !== undefined && 'legEstimate' in s).toBe(false);
  });

  it('carries convertedFrom only when the row has it', () => {
    const convertedFrom = { course: 'LCM', factor: 1.11 } as unknown as SwimmerResult['convertedFrom'];
    const [s] = getAthleteCreditedSwims(
      [swim({ id: 'c1', name: 'Ann Lee', convertedFrom })],
      'Alpha',
      'Ann Lee',
      Gender.MEN
    );
    expect(s?.convertedFrom).toEqual(convertedFrom);
  });

  it('a row with no numeric points reads as 0', () => {
    const [s] = getAthleteCreditedSwims(
      [swim({ name: 'Ann Lee', points: undefined as unknown as number })],
      'Alpha',
      'Ann Lee',
      Gender.MEN
    );
    expect(s?.points).toBe(0);
  });

  it('shows a measured relay leg split, never the team clock', () => {
    const leg = swim({
      id: 'relay-leg',
      name: 'Ann Lee',
      event: RELAY,
      isRelay: true,
      time: '1:25.00',
      relayTeamTime: '1:25.00',
      relayLegSplit: '21.50',
      relayLegIndex: 2,
      points: 10,
    });
    const [s] = getAthleteCreditedSwims([leg], 'Alpha', 'Ann Lee', Gender.MEN);
    expect(s).toMatchObject({ kind: 'relay', time: '1:25.00', displayTime: '21.50', relayLegIndex: 2 });
    expect(s !== undefined && 'legEstimate' in s).toBe(false);
  });

  it('shows an estimated leg of a theoretical meet as a dash plus a labelled estimate', () => {
    const leg = swim({
      id: 'tmresrelay|ws|Alpha|leg1',
      name: 'Ann Lee',
      event: RELAY,
      isRelay: true,
      time: '1:25.00',
      relayTeamTime: '1:25.00',
      relayLegEstimate: { time: 21.5, basis: 'start-adjusted best time' },
    });
    const [s] = getAthleteCreditedSwims([leg], 'Alpha', 'Ann Lee', Gender.MEN);
    expect(s).toMatchObject({
      kind: 'relay',
      displayTime: '—',
      legEstimate: { time: '21.50', basis: 'start-adjusted best time' },
    });
  });

  it('an estimate without a basis carries no basis key', () => {
    const leg = swim({
      id: 'tmresrelay|ws|Alpha|leg2',
      name: 'Ann Lee',
      event: RELAY,
      isRelay: true,
      time: '1:25.00',
      relayTeamTime: '1:25.00',
      relayLegEstimate: { time: 21.5 } as unknown as SwimmerResult['relayLegEstimate'],
    });
    const [s] = getAthleteCreditedSwims([leg], 'Alpha', 'Ann Lee', Gender.MEN);
    expect(s?.legEstimate).toBeDefined();
    expect(s?.legEstimate?.time).toBe('21.50');
    expect('basis' in (s?.legEstimate ?? {})).toBe(false);
  });

  it('skips other-gender rows, keeps unlabelled ones, and skips team-name relay rows', () => {
    const rows = [
      swim({ id: 'w', name: 'Ann Lee', gender: Gender.WOMEN }),
      swim({ id: 'u', name: 'Ann Lee', gender: undefined, event: BACK100 }),
      swim({ id: 'team', name: 'Alpha', team: 'Alpha', event: RELAY, isRelay: true }),
    ];
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Ann Lee', Gender.MEN).map(s => s.id)).toEqual(['u']);
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Ann Lee', Gender.WOMEN).map(s => s.id)).toEqual(['w', 'u']);
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Alpha', Gender.MEN)).toEqual([]);
    const recruitTeamRow = swim({ id: 'rt', name: 'Alpha', team: 'Alpha', event: RELAY, isRelay: true, isRecruit: true });
    expect(getAthleteCreditedSwims([recruitTeamRow], 'Alpha', 'Alpha', Gender.MEN).map(s => s.id)).toEqual(['rt']);
  });

  it('matches a blank team as Unknown, by trimmed name key', () => {
    const rows = [swim({ id: 'b1', name: 'Ann Lee', team: '  ' }), swim({ id: 'b2', name: 'Lee, Ann', team: undefined, event: BACK100 })];
    expect(getAthleteCreditedSwims(rows, 'Unknown', 'Ann Lee', Gender.MEN).map(s => s.id)).toEqual(['b1', 'b2']);
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Ann Lee', Gender.MEN)).toEqual([]);
  });

  it('returns either spelling of a linked athlete the full list', () => {
    const resolver = buildAliasResolver([link('Cam Mask', 'Camden Mask', 'Alpha')]);
    const rows = [
      swim({ id: 'a', name: 'Camden Mask' }),
      swim({ id: 'b', name: 'Cam Mask', event: BACK100 }),
    ];
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Cam Mask', Gender.MEN, resolver).map(s => s.id)).toEqual(['a', 'b']);
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Camden Mask', Gender.MEN, resolver).map(s => s.id)).toEqual(['a', 'b']);
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Cam Mask', Gender.MEN).map(s => s.id)).toEqual(['b']);
  });

  it('puts events in meet order whatever order they arrive in, three events deep', () => {
    // The last event has the most points; only the meet order can keep it last.
    const rows = [
      swim({ id: 'e5', name: 'Ann Lee', event: 'Event 5 Men 100 Yard Butterfly', points: 20 }),
      swim({ id: 'e3', name: 'Ann Lee', event: 'Event 3 Men 200 Yard IM', points: 4 }),
      swim({ id: 'e1', name: 'Ann Lee', event: 'Event 1 Men 50 Yard Freestyle', points: 1 }),
    ];
    expect(getAthleteCreditedSwims(rows, 'Alpha', 'Ann Lee', Gender.MEN).map(s => s.id)).toEqual(['e1', 'e3', 'e5']);
  });
});
