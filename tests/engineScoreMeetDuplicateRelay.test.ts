/** Public API regression for relays whose sorted leg signature is identical. */
import { describe, expect, it } from 'vitest';
import { builtinRulePreset, requireComplete, scoreMeet } from '@omniswim/engine';
import type { CompleteRulePreset, ConversionSettings, Lineup, LineupEntry, MeetEvent, MeetModel, MeetSwim, RelaySplit, RulePreset, ScorerTag } from '@omniswim/engine';
import { set } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const FREE = '100 Freestyle';
const RELAY = '400 Freestyle Relay';
const EVENTS: MeetEvent[] = [
  { eventKey: FREE, gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null },
  { eventKey: RELAY, gender: 'Men', kind: 'relay', distanceYards: 400, relayKind: 'freestyle' },
];

function build(ids: readonly string[]): MeetModel {
  const swims: MeetSwim[] = ids.map((id) => ({ swimId: `${id}:free`, swimmerId: id, eventKey: FREE, recordedCourse: 'SCY', recordedTime: { text: '50.00', hundredths: 5000 }, date: null, seasonId: null, flags: {}, scy: { kind: 'recorded-scy' }, origin: ORIGIN }));
  const relaySplits: RelaySplit[] = ids.map((id) => ({ splitId: `split-${id}`, swimmerId: id, relayEventKey: null, legPosition: null, start: 'flying', legEventKey: FREE, split: { text: '49.00', hundredths: 4900 }, course: 'SCY', date: null, origin: ORIGIN }));
  return { payloadVersion: 1, meetKey: 'synthetic', teams: [{ teamId: 'T1', division: { state: 'unknown', reason: 'unmapped_team' } }], swimmers: ids.map((swimmerId) => ({ swimmerId, teamId: 'T1', gender: 'Men', classYear: null, roster: 'member' })), events: EVENTS, swims, relaySplits, recordRange: { kind: 'seasons', seasonIds: ['2025-26'] }, extendedWindow: false, observedScores: null };
}

function relay(letter: string, ids: readonly [string, string, string, string]): LineupEntry {
  const legs = ids.map((swimmerId, i) => {
    const basis = i === 0
      ? { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:free` }
      : { kind: 'split' as const, splitId: `split-${swimmerId}` };
    return { swimmerId, basis };
  }) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'];
  return { kind: 'relay', teamId: 'T1', eventKey: RELAY, gender: 'Men', letter, legs };
}
const tagAll = (ids: readonly string[]): ScorerTag[] => ids.map((swimmerId) => ({ teamId: 'T1', swimmerId, role: 'scorer' }));
function rules(): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 3) as RulePreset;
  return requireComplete({ ...base, scoring: { ...base.scoring, ties: set('split') }, scorers: { ...base.scorers, scoringRelaysPerTeamPerEvent: set(2) } });
}

describe('scoreMeet duplicate relays', () => {
  it('scores identical swimmer sets as separate relay entries under split ties', () => {
    const ids = ['a', 'b', 'c', 'd'] as const;
    const result = scoreMeet(build(ids), { payloadVersion: 1, meetKey: 'synthetic', entries: [relay('A', ids), relay('B', ['d', 'c', 'b', 'a'])] } satisfies Lineup, tagAll(ids), rules(), SOURCING);
    const rows = result.events.find((event) => event.eventKey === RELAY)?.rows ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.points)).toEqual([37, 37]);
    expect(result.violations.filter((v) => v.kind === 'relay_leg' && v.reason === 'duplicate_swimmer')).toEqual([]);
  });
});
