/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins the readers that moved from unchecked indexes to `itemAt` / `regexGroup` /
 * `recordAt` (R11 step 4). Each expectation is the value the old code returned, so a
 * helper that quietly substitutes a default would fail here.
 */
import { describe, expect, it } from 'vitest';

import { Gender, type SwimmerResult } from '../packages/core/src/types';
import {
  detectSwimCloudPasteFormat,
  parseSwimCloudPersonalBestsDetailed,
  swimEventDistance,
} from '../packages/core/src/lib/athleteHistory';
import { classifyAliasNamePair, classifyNameToken } from '../packages/core/src/lib/athleteAliases';
import {
  eventLabelGender,
  eventMatchesStrokeDistance,
  individualEventDistanceStroke,
  listEligibleRelayLegCandidates,
  relayStrokeForIndex,
} from '../packages/core/src/lib/relayLegMatching';
import { computeRelayHalves } from '../packages/core/src/lib/relaySplits';
import { expandEventToken, resolveTheoryName } from '../packages/core/src/lib/scoringTheory';

describe('relayLegMatching readers', () => {
  it('reads a single-stroke event as distance and stroke', () => {
    expect(individualEventDistanceStroke('100 Butterfly')).toEqual({ distance: 100, stroke: 'fly' });
    expect(individualEventDistanceStroke('200 Breaststroke')).toEqual({ distance: 200, stroke: 'breast' });
    expect(individualEventDistanceStroke('100 Free')).toEqual({ distance: 100, stroke: 'free' });
  });

  it('keeps null for events that are not a single stroke', () => {
    expect(individualEventDistanceStroke('200 IM')).toBeNull();
    expect(individualEventDistanceStroke('200 Freestyle Relay')).toBeNull();
  });

  it('reads the gender word of a label, or null', () => {
    expect(eventLabelGender('Event 31 Men 4x50 Yard Freestyle Relay')).toBe(Gender.MEN);
    expect(eventLabelGender('Women 100 Free')).toBe(Gender.WOMEN);
    expect(eventLabelGender('Event 403 Mixed 50 Yard Freestyle Time Trial')).toBe('mixed');
    expect(eventLabelGender('50 Free SCY')).toBeNull();
  });

  it('matches a leg event by stroke keywords', () => {
    expect(eventMatchesStrokeDistance('100 Back', 100, ['backstroke', 'back'])).toBe(true);
    expect(eventMatchesStrokeDistance('100 Back', 100, ['butterfly', 'fly'])).toBe(false);
    expect(eventMatchesStrokeDistance('100 Back', 100, ['nonsense'])).toBe(false);
  });

  it('orders leg candidates by time, reading minutes and seconds', () => {
    const swim = (name: string, time: string): SwimmerResult =>
      ({
        id: name,
        name,
        team: 'Henderson State',
        gender: Gender.MEN,
        event: '100 Free',
        time,
      }) as SwimmerResult;
    const out = listEligibleRelayLegCandidates(
      [swim('Slow', '1:02.50'), swim('Fast', '48.20'), swim('Mid', '1:00.10')],
      '400 Free Relay',
      0,
      new Set<string>(),
      'Henderson State',
      Gender.MEN
    );
    expect(out.map(s => s.name)).toEqual(['Fast', 'Mid', 'Slow']);
  });

  it('keeps the medley leg order', () => {
    const order = [0, 1, 2, 3].map(i => relayStrokeForIndex('200 medley relay', i));
    expect(order).toEqual(['back', 'breast', 'fly', 'free']);
    expect(relayStrokeForIndex('200 free relay', 2)).toBe('free');
    expect(relayStrokeForIndex('200 medley relay', 4)).toBe('free');
  });
});

describe('relaySplits.computeRelayHalves', () => {
  it('sums legs 1+2 and 3+4', () => {
    expect(computeRelayHalves(['22.00', '23.00', '24.00', '25.00'])).toEqual({
      firstHalf: '45.00',
      secondHalf: '49.00',
    });
  });

  it('returns nothing when fewer than four legs, or one is unreadable', () => {
    expect(computeRelayHalves(['22.00', '23.00', '24.00'])).toEqual({});
    expect(computeRelayHalves(['22.00', null, '24.00', '25.00'])).toEqual({});
    expect(computeRelayHalves(['22.00', 'NT', '24.00', '25.00'])).toEqual({});
  });
});

describe('scoringTheory readers', () => {
  it('expands event tokens', () => {
    expect(expandEventToken('1fly')).toBe('100 Butterfly');
    expect(expandEventToken('50')).toBe('50 Freestyle');
    expect(expandEventToken('100 br')).toBe('100 Breaststroke');
    expect(expandEventToken('500 free')).toBe('500 Freestyle');
    expect(expandEventToken('200 im')).toBe('200 Individual Medley');
    expect(expandEventToken('1fr/2br?')).toBe('100 Freestyle');
    expect(expandEventToken('?')).toBeNull();
    expect(expandEventToken('sprint')).toBeNull();
  });

  it('resolves names by token shape and rejects the unrelated', () => {
    const roster = ['Benedek Kovacs', 'Camden Reed', 'Tristin Fox'];
    expect(resolveTheoryName('Beni', roster).match).toBe('Benedek Kovacs');
    expect(resolveTheoryName('Cam R', roster).match).toBe('Camden Reed');
    expect(resolveTheoryName('Tristen Fox', roster).match).toBe('Tristin Fox');
    expect(resolveTheoryName('Zzzzz Qqqqq', roster)).toEqual({ match: null, confidence: expect.any(Number) });
  });
});

describe('athleteAliases readers', () => {
  it('keeps the vowel-swap and indel verdicts', () => {
    expect(classifyNameToken('Tristen', 'Tristin')).toBe('vowel_swap');
    expect(classifyNameToken('Afonso', 'Alfonso')).toBe('indel');
    expect(classifyNameToken('Tom', 'Tim')).not.toBe('vowel_swap');
    expect(classifyNameToken('Dan', 'Don')).not.toBe('vowel_swap');
  });

  it('classifies a pair and returns null for a one-token name', () => {
    expect(classifyAliasNamePair('Tristen Fox', 'Tristin Fox')).not.toBeNull();
    expect(classifyAliasNamePair('Tristen', 'Tristin Fox')).toBeNull();
    expect(classifyAliasNamePair('Ann Lee', 'Zed Quill')).toBeNull();
  });
});

describe('athleteHistory readers', () => {
  it('reads the leading distance of an event label', () => {
    expect(swimEventDistance('100 Free')).toBe(100);
    expect(swimEventDistance('  1650 Free')).toBe(1650);
    expect(swimEventDistance('Free')).toBeNull();
  });

  it('detects a personal-bests paste and parses its rows in column order', () => {
    const paste = [
      '50 Free\t21.50\tD2 B\tConference Champs\tFeb 18, 2026',
      '100 Free\t47.10\t\tDual Meet\tNov 2, 2025',
    ].join('\n');
    expect(detectSwimCloudPasteFormat(paste)).toBe('personal_bests');
    const { swims } = parseSwimCloudPersonalBestsDetailed(paste, 'Jane Doe', 'Henderson State', Gender.WOMEN);
    expect(swims.map(s => [s.event, s.time, s.meetLabel, s.date])).toEqual([
      ['50 Freestyle', '21.50', 'Conference Champs', 'Feb 18, 2026'],
      ['100 Freestyle', '47.10', 'Dual Meet', 'Nov 2, 2025'],
    ]);
  });
});
