/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `scoringRules.ts` (plan item T6). Each case kills
 * Stryker mutants that survived the suite as it stood on 2026-10-14 (see
 * docs/reference/MUTATION_RESULTS_2026-10-14.md). The functions are pure, so each
 * is called directly.
 *
 * Expected values come from the function contracts and the NCAA individual
 * 16-place table (Rule 7-1-1: 20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3,
 * 2, 1), with the A final scoring places 1-8 and the B final places 9-16. The
 * arithmetic is in the comment on each case.
 */
import { describe, expect, it } from 'vitest';
import type { ScoringSettings, SwimmerResult } from '../../packages/core/src/types';
import {
  athleteHasFinalsDiveInEvent,
  canScoreAthlete,
  classifyRoundTier,
  eventScoringStage,
  isChampionshipGenderEvent,
  isDivingEvent,
  isDivingForSettings,
  isFinalsRound,
  isOutsideScoredProgram,
  isPrelimsFinalsEvent,
  isRelayResult,
  isScoringSwimResult,
  isScoringSwimTime,
  isTimeTrialSwim,
  parseEventNumber,
  parseRankInt,
  placePointAt,
  pointsForPlacement,
  pointsForPlacementOrNull,
  relayPlaceValues,
  relayTeamPointsForIndex,
  roundTierSort,
  scoringRowIndex,
  scoringRowIndexForRelay,
  swimResultClock,
  tiedPlaceShare,
} from '../../packages/core/src/lib/scoringRules';

const NCAA_16 = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

function settings(extra: Partial<ScoringSettings> = {}): ScoringSettings {
  return {
    scoringPoints: NCAA_16,
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    ...extra,
  };
}

/** Settings whose unscored-round list names none of the usual labels, so only the round tier decides. */
function tierOnly(extra: Partial<ScoringSettings> = {}): ScoringSettings {
  return settings({ unscoredRounds: ['NO SUCH ROUND'], ...extra });
}

const FREE = 'Event 3 Men 100 Yard Freestyle';

describe('classifyRoundTier', () => {
  const cases: Array<[string | undefined, ReturnType<typeof classifyRoundTier>]> = [
    [undefined, 'UNK'],
    ['', 'UNK'],
    ['Extracted', 'UNK'],
    ['Time Trial', 'TT'],
    ['Time Trials', 'TT'],
    ['time trial', 'TT'],
    ['C Final', 'C'],
    ['C-Final', 'C'],
    ['Bonus Final', 'C'],
    ['D Final', 'D'],
    ['D-Final', 'D'],
    ['Preliminaries', 'PRE'],
    ['Prelims', 'PRE'],
    ['B Final', 'B'],
    ['B-Final', 'B'],
    ['Consolation', 'B'],
    ['A Final', 'A'],
    ['A-Final', 'A'],
    ['Championship', 'A'],
    ['Finals', 'FIN'],
    ['Final', 'FIN'],
    [' finals ', 'FIN'],
    // A label that names the word FINAL but no A/B/C/D bracket is a timed final.
    ['Heat Final', 'FIN'],
    ['E Final', 'FIN'],
    // The bracket letter may sit apart from FINAL by several spaces: that is still a bracket
    // label, and is not one of the labels read above, so it is unknown.
    ['A  Final', 'UNK'],
    // FINAL as the tail of a longer word is not the word FINAL.
    ['Semifinal', 'UNK'],
    ['Finalist', 'UNK'],
  ];
  it.each(cases)('reads %j as %s', (label, tier) => {
    expect(classifyRoundTier(label)).toBe(tier);
  });

  it('a TIME TRIAL label wins over the bracket letters in the same label', () => {
    expect(classifyRoundTier('A Final Time Trial')).toBe('TT');
  });

  // Found by mutation testing 2026-10-14, fixed with the normalizedRoundLabel change in scoringRules.ts.
  // "Timed Finals" is the round caption SwimCloud pages carry (tests/eventFirstImport.test.ts stores
  // it as `roundSwam`). It contains the text "D FINAL" (TIME-D FINAL-s), which read as an unscored
  // D final, so a timed-final swim never scored.
  it('reads "Timed Finals" as a timed final and scores it', () => {
    expect(classifyRoundTier('Timed Finals')).toBe('FIN');
    expect(classifyRoundTier('TIMED FINAL')).toBe('FIN');
    expect(classifyRoundTier('Timed-Finals')).toBe('FIN');
    expect(isFinalsRound('Timed Finals')).toBe(true);
    expect(canScoreAthlete('Timed Finals', '1650 Yard Freestyle', settings())).toBe(true);
    // The same text in the event label (HyTek prints it there) does not hide the swim either.
    expect(canScoreAthlete('Finals', 'Event 8 Women 400 Yard IM Timed Final', settings())).toBe(true);
    // A real D final still does not score, and a word that merely ends in D does not hide it.
    expect(classifyRoundTier('D Final')).toBe('D');
    expect(canScoreAthlete('D Final', '1650 Yard Freestyle', settings())).toBe(false);
  });
});

describe('isFinalsRound and roundTierSort', () => {
  it('A, B and timed finals are finals rounds; nothing else is', () => {
    expect(isFinalsRound('A Final')).toBe(true);
    expect(isFinalsRound('B Final')).toBe(true);
    expect(isFinalsRound('Finals')).toBe(true);
    expect(isFinalsRound('Preliminaries')).toBe(false);
    expect(isFinalsRound('C Final')).toBe(false);
    expect(isFinalsRound('D Final')).toBe(false);
    expect(isFinalsRound('Time Trial')).toBe(false);
    expect(isFinalsRound(undefined)).toBe(false);
  });

  it('orders A = FIN = UNK (1), B (2), prelims (3), C = D (8), time trial (9)', () => {
    expect(roundTierSort('A Final')).toBe(1);
    expect(roundTierSort('Finals')).toBe(1);
    expect(roundTierSort('Extracted')).toBe(1);
    expect(roundTierSort('B Final')).toBe(2);
    expect(roundTierSort('Preliminaries')).toBe(3);
    expect(roundTierSort('C Final')).toBe(8);
    expect(roundTierSort('D Final')).toBe(8);
    expect(roundTierSort('Time Trial')).toBe(9);
  });
});

describe('event number and scored-program boundary', () => {
  it('reads the number of a numbered label and nothing else', () => {
    expect(parseEventNumber('Event 13 Men 100 Yard Butterfly')).toBe(13);
    expect(parseEventNumber(' event 7 Women 50 Free')).toBe(7);
    expect(parseEventNumber('Event  21 Men 200 Free')).toBe(21);
    expect(parseEventNumber('Event13 Men')).toBeNull();
    expect(parseEventNumber('Men Event 5 100 Free')).toBeNull();
    expect(parseEventNumber('100 Yard Freestyle')).toBeNull();
    expect(parseEventNumber(undefined)).toBeNull();
  });

  it('excludes only an event numbered past the meet maximum', () => {
    expect(isOutsideScoredProgram('Event 43 Men 100 Free', 42)).toBe(true);
    // Event 42 of "Through Event 42" is inside the program.
    expect(isOutsideScoredProgram('Event 42 Men 100 Free', 42)).toBe(false);
    expect(isOutsideScoredProgram('Event 41 Men 100 Free', 42)).toBe(false);
    // No maximum, or one that is not a finite number: nothing is outside.
    expect(isOutsideScoredProgram('Event 900 Men 100 Free', undefined)).toBe(false);
    expect(isOutsideScoredProgram('Event 900 Men 100 Free', Number.NaN)).toBe(false);
    expect(isOutsideScoredProgram('Event 900 Men 100 Free', Number.POSITIVE_INFINITY)).toBe(false);
    // An unnumbered label is never positively outside, even against a maximum below zero.
    expect(isOutsideScoredProgram('100 Yard Freestyle', -1)).toBe(false);
    expect(isOutsideScoredProgram(undefined, 42)).toBe(false);
  });

  it('a Boys/Girls word marks a championship event, whole word only', () => {
    expect(isChampionshipGenderEvent('Event 9 Boys 100 Free')).toBe(true);
    expect(isChampionshipGenderEvent('Event 9 Girls 100 Free')).toBe(true);
    expect(isChampionshipGenderEvent('Event 9 Boy 100 Free')).toBe(true);
    expect(isChampionshipGenderEvent('Event 9 Girl 100 Free')).toBe(true);
    expect(isChampionshipGenderEvent('Event 9 Men 100 Free')).toBe(false);
    expect(isChampionshipGenderEvent('Event 9 Boyscout 100 Free')).toBe(false);
    expect(isChampionshipGenderEvent(undefined)).toBe(false);
    expect(isChampionshipGenderEvent('')).toBe(false);
  });
});

describe('isTimeTrialSwim', () => {
  it('reads the flag and the label', () => {
    expect(isTimeTrialSwim({ event: FREE, isTimeTrial: true })).toBe(true);
    expect(isTimeTrialSwim({ event: `${FREE} Time Trial` })).toBe(true);
    expect(isTimeTrialSwim({ event: `${FREE} Time Trials` })).toBe(true);
    expect(isTimeTrialSwim({ event: `${FREE} Time  Trial` })).toBe(true);
    expect(isTimeTrialSwim({ event: FREE })).toBe(false);
    expect(isTimeTrialSwim({ event: FREE, isTimeTrial: false })).toBe(false);
    expect(isTimeTrialSwim({})).toBe(false);
  });

  it('a Boys/Girls championship event scores like a final, flag or not', () => {
    expect(isTimeTrialSwim({ event: 'Event 9 Boys 100 Yard Freestyle', isTimeTrial: true })).toBe(false);
    expect(isTimeTrialSwim({ event: 'Event 9 Girls 100 Free Time Trial' })).toBe(false);
  });

  it('an event past the scored program is a time trial, Boys/Girls word or not', () => {
    expect(isTimeTrialSwim({ event: 'Event 938 Women 100 Yard Breaststroke' }, 42)).toBe(true);
    expect(isTimeTrialSwim({ event: 'Event 938 Boys 100 Yard Breaststroke' }, 42)).toBe(true);
    expect(isTimeTrialSwim({ event: 'Event 38 Women 100 Yard Breaststroke' }, 42)).toBe(false);
    expect(isTimeTrialSwim({ event: 'Event 938 Women 100 Yard Breaststroke' })).toBe(false);
  });
});

describe('canScoreAthlete', () => {
  it('A, B and timed finals score, and an unrecognised round does too', () => {
    expect(canScoreAthlete('A Final', FREE, tierOnly())).toBe(true);
    expect(canScoreAthlete('B Final', FREE, tierOnly())).toBe(true);
    expect(canScoreAthlete('Finals', FREE, tierOnly())).toBe(true);
    expect(canScoreAthlete('Extracted', FREE, tierOnly())).toBe(true);
    expect(canScoreAthlete(undefined, FREE, tierOnly())).toBe(true);
  });

  it('time trial, C final and D final never score, by tier', () => {
    expect(canScoreAthlete('Time Trial', FREE, tierOnly())).toBe(false);
    expect(canScoreAthlete('C Final', FREE, tierOnly())).toBe(false);
    expect(canScoreAthlete('Bonus Final', FREE, tierOnly())).toBe(false);
    expect(canScoreAthlete('D Final', FREE, tierOnly())).toBe(false);
  });

  it('prelims score only in a distance event or a diving event', () => {
    expect(canScoreAthlete('Preliminaries', 'Event 12 Women 1650 Yard Freestyle', tierOnly())).toBe(true);
    expect(canScoreAthlete('Preliminaries', 'Event 12 Women 1000 Yard Freestyle', tierOnly())).toBe(true);
    expect(canScoreAthlete('Preliminaries', 'Event 12 Women 1500 Meter Freestyle', tierOnly())).toBe(true);
    expect(canScoreAthlete('Preliminaries', 'Event 12 Women 800 Meter Freestyle', tierOnly())).toBe(true);
    expect(canScoreAthlete('Preliminaries', 'Event 12 Women 10000 Meter Freestyle', tierOnly())).toBe(true);
    expect(canScoreAthlete('Preliminaries', 'Event 12 Women Timed Final 400 Free', tierOnly())).toBe(true);
    // A diving event in prelims scores, and it is not a distance event.
    expect(canScoreAthlete('Preliminaries', 'Event 15 Women 1m Diving', tierOnly())).toBe(true);
    expect(canScoreAthlete('Preliminaries', FREE, tierOnly())).toBe(false);
    expect(canScoreAthlete('Preliminaries', 'Event 5 Men 500 Yard Freestyle', tierOnly())).toBe(false);
    expect(canScoreAthlete('Preliminaries', undefined, tierOnly())).toBe(false);
  });

  it('a diving pattern a preset names decides which prelim events are diving', () => {
    const platform = tierOnly({ diverEventPattern: ['PLATFORM'] });
    expect(canScoreAthlete('Preliminaries', 'Event 16 Men Platform', platform)).toBe(true);
    expect(canScoreAthlete('Preliminaries', 'Event 15 Men 1m Diving', platform)).toBe(false);
  });

  it('an event numbered past scoredEventNumberMax does not score, whatever the round', () => {
    const through42 = tierOnly({ scoredEventNumberMax: 42 });
    expect(canScoreAthlete('A Final', 'Event 43 Men 100 Free', through42)).toBe(false);
    expect(canScoreAthlete('A Final', 'Event 42 Men 100 Free', through42)).toBe(true);
  });

  it('with no unscoredRounds list, a C final or time trial named in the event label is unscored', () => {
    // Round says A final; the default list reads the event label too.
    expect(canScoreAthlete('A Final', 'Event 5 Men 100 Free C Final', settings())).toBe(false);
    expect(canScoreAthlete('A Final', 'Event 5 Men 100 Free Bonus Final', settings())).toBe(false);
    expect(canScoreAthlete('A Final', 'Event 5 Men 100 Free D-Final', settings())).toBe(false);
    expect(canScoreAthlete('A Final', 'Event 5 Men 100 Free Time Trial', settings())).toBe(false);
    expect(canScoreAthlete('A Final', 'Event 5 Men 100 Free', settings())).toBe(true);
  });

  it('an unscoredRounds list replaces the default list and matches the round or the event, any case', () => {
    const custom = settings({ unscoredRounds: ['para'] });
    expect(canScoreAthlete('Para A Final', FREE, custom)).toBe(false);
    expect(canScoreAthlete('A Final', 'Event 5 Men Para 100 Free', custom)).toBe(false);
    expect(canScoreAthlete('A Final', FREE, custom)).toBe(true);
    // The default list is gone: a C-final label in the event no longer excludes it.
    expect(canScoreAthlete('A Final', 'Event 5 Men 100 Free C Final', custom)).toBe(true);
  });

  it('an empty unscoredRounds list falls back to the default list', () => {
    expect(canScoreAthlete('A Final', 'Event 5 Men 100 Free C Final', settings({ unscoredRounds: [] }))).toBe(
      false
    );
  });

  it('a time trial named in the event is unscored, except in a Boys/Girls championship event', () => {
    const custom = settings({ unscoredRounds: ['SWIM-OFF'] });
    expect(canScoreAthlete('A Final', 'Event 9 Men 100 Free Time Trial', custom)).toBe(false);
    expect(canScoreAthlete('A Final', 'Event 9 Boys 100 Free Time Trial', custom)).toBe(true);
  });
});

describe('swim clocks and finish codes', () => {
  it('a prelims row reads its prelims time, then time, then blank', () => {
    expect(swimResultClock({ roundSwam: 'Preliminaries', prelimsTime: ' 25.00 ', time: '99.99' })).toBe('25.00');
    expect(swimResultClock({ roundSwam: 'Preliminaries', time: ' 26.00 ' })).toBe('26.00');
    expect(swimResultClock({ roundSwam: 'Preliminaries', time: undefined as unknown as string })).toBe('');
  });

  it('a finals row reads the relay team time, then the finals time, then time, then blank', () => {
    expect(
      swimResultClock({ roundSwam: 'A Final', relayTeamTime: ' 1:20.00 ', finalsTime: '1:21.00', time: '1:22.00' })
    ).toBe('1:20.00');
    expect(swimResultClock({ roundSwam: 'A Final', finalsTime: ' 1:21.00 ', time: '1:22.00' })).toBe('1:21.00');
    expect(swimResultClock({ roundSwam: 'A Final', time: ' 1:22.00 ' })).toBe('1:22.00');
    expect(swimResultClock({ roundSwam: 'A Final', time: undefined as unknown as string })).toBe('');
  });

  it('a clock with no finish is not a scoring time; a finish is', () => {
    for (const code of ['DQ', 'dq', 'DFS', 'SCR', 'NS', 'NP', 'NC', 'NT', 'N/A', '---', ' DQ ', 'DQ - false start']) {
      expect(isScoringSwimTime(code)).toBe(false);
    }
    for (const t of ['25.10', ' 1:20.00 ', '9:59.99']) {
      expect(isScoringSwimTime(t)).toBe(true);
    }
    expect(isScoringSwimTime('')).toBe(false);
    expect(isScoringSwimTime('   ')).toBe(false);
    expect(isScoringSwimTime(null)).toBe(false);
    expect(isScoringSwimTime(undefined)).toBe(false);
    // A code that is not at the start of the clock is not read as a code.
    expect(isScoringSwimTime('1:20.00 DQ')).toBe(true);
    // A code that is only a prefix of a longer token is not a code.
    expect(isScoringSwimTime('NTX')).toBe(true);
  });

  it('a non-finish code blocks a finals row; prelims and other rounds are not blocked by it', () => {
    const row = (roundSwam: string, finalsTime: string, time = '25.00'): SwimmerResult =>
      ({ roundSwam, finalsTime, time, prelimsTime: 'DQ' }) as SwimmerResult;
    expect(isScoringSwimResult(row('A Final', 'DQ'))).toBe(false);
    expect(isScoringSwimResult(row('B Final', 'SCR'))).toBe(false);
    expect(isScoringSwimResult(row('Finals', 'DFS'))).toBe(false);
    expect(isScoringSwimResult(row('A Final', '25.00'))).toBe(true);
    // Prelims, C final, time trial: the clock is not examined here.
    expect(isScoringSwimResult(row('Preliminaries', 'DQ'))).toBe(true);
    expect(isScoringSwimResult(row('C Final', 'DQ'))).toBe(true);
    expect(isScoringSwimResult(row('Time Trial', 'DQ'))).toBe(true);
  });
});

describe('event scoring stage', () => {
  const row = (roundSwam: string, extra: Partial<SwimmerResult> = {}): SwimmerResult =>
    ({ roundSwam, ...extra }) as SwimmerResult;

  it('prelims or an A/B final make a prelims-and-finals event', () => {
    expect(eventScoringStage([row('Preliminaries'), row('A Final')])).toBe('prelims_finals');
    expect(eventScoringStage([row('Preliminaries')])).toBe('prelims_finals');
    expect(eventScoringStage([row('A Final')])).toBe('prelims_finals');
    expect(eventScoringStage([row('B Final')])).toBe('prelims_finals');
    expect(eventScoringStage([row('Finals'), row('Preliminaries')])).toBe('prelims_finals');
    expect(isPrelimsFinalsEvent([row('A Final')])).toBe(true);
  });

  it('a timed-final label alone is timed finals', () => {
    expect(eventScoringStage([row('Finals')])).toBe('timed_finals');
    expect(isPrelimsFinalsEvent([row('Finals')])).toBe(false);
  });

  it('anything else, or no rows, is unknown', () => {
    expect(eventScoringStage([])).toBe('unknown');
    expect(eventScoringStage([row('C Final')])).toBe('unknown');
    expect(eventScoringStage([row('Extracted')])).toBe('unknown');
    expect(isPrelimsFinalsEvent([])).toBe(false);
  });

  it('exhibition and time-trial rows are not read', () => {
    expect(eventScoringStage([row('A Final', { isExhibition: true })])).toBe('unknown');
    expect(eventScoringStage([row('A Final', { isTimeTrial: true })])).toBe('unknown');
    expect(eventScoringStage([row('Preliminaries', { isExhibition: true }), row('Finals')])).toBe('timed_finals');
    expect(eventScoringStage([row('Preliminaries', { isTimeTrial: true }), row('Finals')])).toBe('timed_finals');
  });
});

describe('parseRankInt', () => {
  it('reads a positive number, flooring a fraction', () => {
    expect(parseRankInt(3)).toBe(3);
    expect(parseRankInt(3.7)).toBe(3);
  });

  it('is null for a number that is not a place', () => {
    expect(parseRankInt(0)).toBeNull();
    expect(parseRankInt(-2)).toBeNull();
    expect(parseRankInt(Number.NaN)).toBeNull();
    expect(parseRankInt(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('reads the first run of digits in a string', () => {
    expect(parseRankInt('3')).toBe(3);
    expect(parseRankInt(' 12th ')).toBe(12);
    expect(parseRankInt('T-4')).toBe(4);
    expect(parseRankInt('1-2')).toBe(1);
  });

  it('is null for a string with no positive number, and for other types', () => {
    expect(parseRankInt('0')).toBeNull();
    expect(parseRankInt('abc')).toBeNull();
    expect(parseRankInt('')).toBeNull();
    expect(parseRankInt(undefined)).toBeNull();
    expect(parseRankInt(null)).toBeNull();
    expect(parseRankInt(true)).toBeNull();
  });
});

describe('isRelayResult', () => {
  it('reads the relay flag or the word relay in the event', () => {
    expect(isRelayResult({ isRelay: true, event: FREE } as SwimmerResult)).toBe(true);
    expect(isRelayResult({ event: 'Event 2 Men 200 Yard Freestyle Relay' } as SwimmerResult)).toBe(true);
    expect(isRelayResult({ event: '200 free RELAY' } as SwimmerResult)).toBe(true);
    expect(isRelayResult({ event: FREE } as SwimmerResult)).toBe(false);
    expect(isRelayResult({ event: 'Event 2 Men Relays' } as SwimmerResult)).toBe(false);
    expect(isRelayResult({} as SwimmerResult)).toBe(false);
  });
});

describe('diving events', () => {
  it('uses DIVING and DIVE (whole word) by default', () => {
    expect(isDivingEvent('Event 15 Women 1m Diving')).toBe(true);
    expect(isDivingEvent('Event 15 Women 3m Springboard Dive')).toBe(true);
    expect(isDivingEvent('Event 15 Women Divers Relay')).toBe(false);
    expect(isDivingEvent(FREE)).toBe(false);
    expect(isDivingEvent(undefined)).toBe(false);
    expect(isDivingEvent('')).toBe(false);
  });

  it('uses the patterns a preset gives, any case, and the default when the list is empty', () => {
    expect(isDivingEvent('Event 16 Men Platform', ['platform'])).toBe(true);
    expect(isDivingEvent('Event 15 Men 1m Diving', ['platform'])).toBe(false);
    expect(isDivingEvent('Event 15 Men 1m Diving', [])).toBe(true);
    expect(isDivingForSettings('Event 16 Men Platform', settings({ diverEventPattern: ['PLATFORM'] }))).toBe(true);
    expect(isDivingForSettings(undefined, settings())).toBe(false);
  });

  it('a finals dive by the same diver, on the same team, in a diving event, blocks the prelim', () => {
    const DIVE = 'Event 15 Women 1m Diving';
    const s = settings();
    const final = (over: Partial<SwimmerResult>): SwimmerResult =>
      ({ name: 'Pat Diver', team: 'Alpha', event: DIVE, roundSwam: 'A Final', ...over }) as SwimmerResult;

    expect(athleteHasFinalsDiveInEvent([final({})], 'Pat Diver', 'Alpha', s)).toBe(true);
    expect(athleteHasFinalsDiveInEvent([final({ roundSwam: 'B Final' })], 'Pat Diver', 'Alpha', s)).toBe(true);
    // Name and team arguments are trimmed; team on the row is trimmed too.
    expect(athleteHasFinalsDiveInEvent([final({ team: ' Alpha ' })], ' Pat Diver ', ' Alpha ', s)).toBe(true);
    // One matching row among others is enough.
    expect(
      athleteHasFinalsDiveInEvent(
        [final({ name: 'Other' }), final({ team: 'Bravo' }), final({})],
        'Pat Diver',
        'Alpha',
        s
      )
    ).toBe(true);

    expect(athleteHasFinalsDiveInEvent([final({ name: 'Other Diver' })], 'Pat Diver', 'Alpha', s)).toBe(false);
    expect(athleteHasFinalsDiveInEvent([final({ team: 'Bravo' })], 'Pat Diver', 'Alpha', s)).toBe(false);
    expect(athleteHasFinalsDiveInEvent([final({ event: FREE })], 'Pat Diver', 'Alpha', s)).toBe(false);
    expect(athleteHasFinalsDiveInEvent([final({ roundSwam: 'Preliminaries' })], 'Pat Diver', 'Alpha', s)).toBe(
      false
    );
    expect(athleteHasFinalsDiveInEvent([final({ roundSwam: 'C Final' })], 'Pat Diver', 'Alpha', s)).toBe(false);
    expect(athleteHasFinalsDiveInEvent([final({ roundSwam: 'Finals' })], 'Pat Diver', 'Alpha', s)).toBe(false);
    expect(athleteHasFinalsDiveInEvent([], 'Pat Diver', 'Alpha', s)).toBe(false);
  });
});

describe('place table row and points', () => {
  const s = tierOnly();

  it('an A final rank is a 0-based row; past the table is null', () => {
    // 16-place table: rank 1 is row 0 (20), rank 16 is row 15 (1), rank 17 has no row.
    expect(scoringRowIndex('A Final', 1, FREE, s)).toBe(0);
    expect(scoringRowIndex('A Final', 16, FREE, s)).toBe(15);
    expect(scoringRowIndex('A Final', 17, FREE, s)).toBeNull();
    expect(scoringRowIndex('A Final', 0, FREE, s)).toBeNull();
    expect(scoringRowIndex('A Final', -1, FREE, s)).toBeNull();
  });

  it('a round that does not score has no row', () => {
    expect(scoringRowIndex('C Final', 1, FREE, s)).toBeNull();
    expect(scoringRowIndex('Time Trial', 1, FREE, s)).toBeNull();
    expect(scoringRowIndex('Preliminaries', 1, FREE, s)).toBeNull();
  });

  it('a B final rank is read as the in-heat place (1-8) or the overall place (9-16)', () => {
    // Bracket = floor(16 / 2) = 8. In-heat 1 -> 9th place, row 8 (9 points). In-heat 8 -> row 15.
    expect(scoringRowIndex('B Final', 1, FREE, s)).toBe(8);
    expect(scoringRowIndex('B Final', 8, FREE, s)).toBe(15);
    // Overall 9..16 -> rows 8..15.
    expect(scoringRowIndex('B Final', 9, FREE, s)).toBe(8);
    expect(scoringRowIndex('B Final', 16, FREE, s)).toBe(15);
    expect(scoringRowIndex('B Final', 17, FREE, s)).toBeNull();
  });

  it('an explicit A-final bracket size moves where the B final starts', () => {
    // Bracket 6 on a 12-place table: B in-heat 1 is 7th place, row 6.
    const six = tierOnly({ scoringPoints: NCAA_16.slice(0, 12), aFinalBracketSize: 6 });
    expect(scoringRowIndex('B Final', 1, FREE, six)).toBe(6);
    expect(scoringRowIndex('B Final', 6, FREE, six)).toBe(11);
    expect(scoringRowIndex('B Final', 7, FREE, six)).toBe(6);
    expect(scoringRowIndex('B Final', 12, FREE, six)).toBe(11);
    expect(scoringRowIndex('B Final', 13, FREE, six)).toBeNull();
  });

  it('a B final stops at the end of a table shorter than twice the bracket', () => {
    // 12 rows, bracket 8: overall places 9-12 have rows, 13 and above do not.
    const short = tierOnly({ scoringPoints: NCAA_16.slice(0, 12), aFinalBracketSize: 8 });
    expect(scoringRowIndex('B Final', 12, FREE, short)).toBe(11);
    expect(scoringRowIndex('B Final', 13, FREE, short)).toBeNull();
    // In-heat 4 would be overall 12 -> row 11. In-heat 5 would be row 12, past the table.
    expect(scoringRowIndex('B Final', 4, FREE, short)).toBe(11);
    expect(scoringRowIndex('B Final', 5, FREE, short)).toBeNull();
  });

  it('points for a place: the table value, 0 for no place, null past the table', () => {
    expect(pointsForPlacementOrNull('A Final', 1, FREE, s)).toBe(20);
    expect(pointsForPlacementOrNull('A Final', 8, FREE, s)).toBe(11);
    expect(pointsForPlacementOrNull('B Final', 1, FREE, s)).toBe(9);
    // Rounds that do not score and ranks that are not places are 0, not null.
    expect(pointsForPlacementOrNull('C Final', 1, FREE, s)).toBe(0);
    expect(pointsForPlacementOrNull('A Final', 0, FREE, s)).toBe(0);
    expect(pointsForPlacementOrNull('A Final', -1, FREE, s)).toBe(0);
    // A place the table does not reach is null; the plain form reads it as 0.
    expect(pointsForPlacementOrNull('A Final', 17, FREE, s)).toBeNull();
    expect(pointsForPlacement('A Final', 17, FREE, s)).toBe(0);
    expect(pointsForPlacement('A Final', 2, FREE, s)).toBe(17);
  });

  it('a diving event scores from divingPoints when the preset has one', () => {
    const withDiving = tierOnly({ divingPoints: [9, 4, 3] });
    const DIVE = 'Event 15 Women 1m Diving';
    expect(pointsForPlacementOrNull('A Final', 1, DIVE, withDiving)).toBe(9);
    expect(pointsForPlacementOrNull('A Final', 3, DIVE, withDiving)).toBe(3);
    expect(pointsForPlacementOrNull('A Final', 4, DIVE, withDiving)).toBeNull();
    // A swimming event still reads scoringPoints.
    expect(pointsForPlacementOrNull('A Final', 1, FREE, withDiving)).toBe(20);
    // An empty diving table is no table.
    expect(pointsForPlacementOrNull('A Final', 1, DIVE, tierOnly({ divingPoints: [] }))).toBe(20);
  });
});

describe('placePointAt', () => {
  it('returns the number at the index, null for a blank, missing or non-finite cell', () => {
    const table = [10, null, undefined, 0, Number.NaN, 3];
    expect(placePointAt(table, 0)).toBe(10);
    expect(placePointAt(table, 1)).toBeNull();
    expect(placePointAt(table, 2)).toBeNull();
    // A table that says 0 is a 0, not an absence.
    expect(placePointAt(table, 3)).toBe(0);
    expect(placePointAt(table, 4)).toBeNull();
    expect(placePointAt(table, 5)).toBe(3);
    expect(placePointAt(table, 6)).toBeNull();
    expect(placePointAt(table, -1)).toBeNull();
  });
});

describe('tiedPlaceShare', () => {
  const table = [20, 17, 16, 15];

  it('a lone entry takes its place value', () => {
    expect(tiedPlaceShare(table, 0, 1)).toBe(20);
    expect(tiedPlaceShare(table, 3, 1)).toBe(15);
  });

  it('tied entries split the points of every place the tie spans', () => {
    // 1st and 2nd: (20 + 17) / 2 = 18.5.
    expect(tiedPlaceShare(table, 0, 2)).toBe(18.5);
    // 2nd and 3rd: (17 + 16) / 2 = 16.5.
    expect(tiedPlaceShare(table, 1, 2)).toBe(16.5);
    // Three-way for 1st: (20 + 17 + 16) / 3 = 53 / 3.
    expect(tiedPlaceShare(table, 0, 3)).toBeCloseTo(53 / 3, 10);
    // Four-way: (20 + 17 + 16 + 15) / 4 = 68 / 4 = 17.
    expect(tiedPlaceShare(table, 0, 4)).toBe(17);
  });

  it('a spanned place past the table adds nothing and the divisor stays the tie size', () => {
    // 4th and 5th of a 4-place table: (15 + nothing) / 2 = 7.5, never 15.
    expect(tiedPlaceShare(table, 3, 2)).toBe(7.5);
    // 3rd, 4th, 5th: (16 + 15) / 3.
    expect(tiedPlaceShare(table, 2, 3)).toBeCloseTo(31 / 3, 10);
  });

  it('a tie wholly past the table is null, not 0', () => {
    expect(tiedPlaceShare(table, 4, 2)).toBeNull();
    expect(tiedPlaceShare(table, 9, 1)).toBeNull();
  });

  it('a blank cell adds nothing; a table of zeros pays 0, not null', () => {
    // [20, blank, 16]: three tied for 1st: (20 + 16) / 3 = 12.
    expect(tiedPlaceShare([20, null, 16], 0, 3)).toBe(12);
    expect(tiedPlaceShare([20, null, 16], 1, 1)).toBeNull();
    expect(tiedPlaceShare([0, 0], 0, 2)).toBe(0);
  });

  it('a tie size that is not a whole number of at least 1 is null', () => {
    expect(tiedPlaceShare(table, 0, 0)).toBeNull();
    expect(tiedPlaceShare(table, 0, -1)).toBeNull();
    expect(tiedPlaceShare(table, 0, 1.5)).toBeNull();
    expect(tiedPlaceShare(table, 0, Number.NaN)).toBeNull();
  });
});

describe('relay place values', () => {
  it('without a relay table it is the individual table times the multiplier, blanks kept blank', () => {
    // [9, 4, 3, 2, 1] x 2 = [18, 8, 6, 4, 2].
    const s = settings({ scoringPoints: [9, 4, 3, 2, 1], relayMultiplier: 2 });
    expect(relayPlaceValues(s)).toEqual([18, 8, 6, 4, 2]);
    expect(relayTeamPointsForIndex(s, 0)).toBe(18);
    expect(relayTeamPointsForIndex(s, 4)).toBe(2);
    expect(relayTeamPointsForIndex(s, 5)).toBeNull();

    const blank = settings({ scoringPoints: [9, null as unknown as number, 3], relayMultiplier: 2 });
    expect(relayPlaceValues(blank)).toEqual([18, null, 6]);
    expect(relayTeamPointsForIndex(blank, 1)).toBeNull();
  });

  it('an explicit relay table wins, and an empty one does not', () => {
    // NCAA dual-meet relay table 11, 4, 2 (Rule 7-1-1): not a multiple of 9, 4, 3, 2, 1.
    const dual = settings({ scoringPoints: [9, 4, 3, 2, 1], relayPoints: [11, 4, 2] });
    expect(relayPlaceValues(dual)).toEqual([11, 4, 2]);
    expect(relayTeamPointsForIndex(dual, 0)).toBe(11);
    expect(relayTeamPointsForIndex(dual, 2)).toBe(2);
    expect(relayTeamPointsForIndex(dual, 3)).toBeNull();

    const empty = settings({ scoringPoints: [9, 4, 3, 2, 1], relayPoints: [], relayMultiplier: 2 });
    expect(relayPlaceValues(empty)).toEqual([18, 8, 6, 4, 2]);
  });

  it('the relay row index reads the relay table length when there is one', () => {
    // Individual table has 5 rows, relay table 3: rank 4 has a row only without the relay table.
    const base = tierOnly({ scoringPoints: [9, 4, 3, 2, 1] });
    const dual = tierOnly({ scoringPoints: [9, 4, 3, 2, 1], relayPoints: [11, 4, 2] });
    expect(scoringRowIndexForRelay('A Final', 4, 'Event 2 Men 200 Yard Freestyle Relay', base)).toBe(3);
    expect(scoringRowIndexForRelay('A Final', 4, 'Event 2 Men 200 Yard Freestyle Relay', dual)).toBeNull();
    expect(scoringRowIndexForRelay('A Final', 3, 'Event 2 Men 200 Yard Freestyle Relay', dual)).toBe(2);
    expect(scoringRowIndexForRelay('C Final', 1, 'Event 2 Men 200 Yard Freestyle Relay', dual)).toBeNull();
  });
});
