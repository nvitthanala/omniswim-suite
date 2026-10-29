import { describe, expect, it } from 'vitest';
import { BUILTIN_SESSION_PRESETS, relayRepeatsForSchedule } from '@omniswim/engine';
import type { Violation } from '@omniswim/engine';

const repeat = (eventKey: string, gender: 'Men' | 'Women' = 'Men'): Violation => ({ kind: 'relay_swimmer_repeated', teamId: 't1', swimmerId: 's1', eventKey, gender, entryKeys: ['a', 'b'] });
const base = BUILTIN_SESSION_PRESETS[0]!.preset;

describe('relayRepeatsForSchedule', () => {
  it('filters only the matching gender for prelims-finals, expanding both', () => {
    const schedule = { ...base, events: [{ eventKey: '400 Freestyle Relay', gender: 'both' as const, format: { kind: 'prelims-finals' as const, prelims: { day: 1, slot: 'morning' as const }, finals: { day: 1, slot: 'evening' as const } } }] };
    const input: Violation[] = [repeat('400 Freestyle Relay', 'Men'), repeat('400 Freestyle Relay', 'Women'), { kind: 'relay_entries_over_limit', teamId: 't1', eventKey: '400 Freestyle Relay', gender: 'Men', entryKeys: ['a', 'b'], count: 2, limit: 1 }];
    expect(relayRepeatsForSchedule(input, schedule)).toEqual([input[2]]);
  });

  it('keeps timed-final, timed-final-split, mismatched gender, and unscheduled events', () => {
    const schedule = { ...base, events: [
      { eventKey: 'timed', gender: 'both' as const, format: { kind: 'timed-final' as const, session: { day: 1, slot: 'evening' as const } } },
      { eventKey: 'split', gender: 'both' as const, format: { kind: 'timed-final-split' as const, slowHeats: { day: 1, slot: 'morning' as const }, fastHeat: { day: 1, slot: 'evening' as const }, fastHeatSize: { state: 'set' as const, value: 8, provenance: base.provenance }, smallFieldSession: { state: 'pending' as const, question: 'pending', blocks: ['sessionLoad'] } } },
      { eventKey: 'prelims', gender: 'Men' as const, format: { kind: 'prelims-finals' as const, prelims: { day: 1, slot: 'morning' as const }, finals: { day: 1, slot: 'evening' as const } } },
    ] };
    const input = [repeat('timed'), repeat('split'), repeat('prelims', 'Women'), repeat('unknown')];
    expect(relayRepeatsForSchedule(input, schedule)).toEqual(input);
  });
});
