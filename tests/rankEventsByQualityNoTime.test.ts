/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `rankEventsByQuality`: an event with no usable time takes no part in the
 * ranking, and no part in choosing the cut tier.
 *
 * ## Why this test exists
 *
 * The ranking read a missing time as 0 and asked `compareTimeToCutline` about
 * it. That call still reports the event's published standard (`status: 'ok'`),
 * so a profile of events that were never swum got a division tier (`'B'` for
 * D2) and looked "ranked against a cut". A swim with no time must not rank or
 * count; the profile has no tier, which is absent, not a tier of nothing.
 *
 * Real data: the event names and times come from three Henderson State men's
 * SwimCloud rows in `tests/fixtures/hsu-2026-27-event-strength.json`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import { rankEventsByQuality } from '../packages/core/src/lib/eventStrength';
import { convertTimeToSeconds } from '../packages/core/src/lib/timeFormat';

const HSU = 'Henderson State University';

type FixtureRow = { name: string; event: string; time: string; timeType: string };
const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hsu-2026-27-event-strength.json'), 'utf8')
) as { athleteHistory: FixtureRow[] };

/** Real SCY best per event for one swimmer. */
function realBest(name: string): Record<string, { timeSec: number }> {
  const best: Record<string, { timeSec: number }> = {};
  for (const row of fixture.athleteHistory) {
    if (row.name !== name || row.timeType !== 'SCY') continue;
    const sec = convertTimeToSeconds(row.time);
    if (!Number.isFinite(sec) || sec <= 0) continue;
    const cur = best[row.event];
    if (!cur || sec < cur.timeSec) best[row.event] = { timeSec: sec };
  }
  return best;
}

const NO_TIME_VALUES: [string, number][] = [
  ['NaN', Number.NaN],
  ['0', 0],
  ['negative', -1],
  ['Infinity', Number.POSITIVE_INFINITY],
];

describe('rankEventsByQuality: a swim with no time does not rank or count', () => {
  const best = realBest('Colton Bennett');

  it('the real profile ranks against the D2 B tier', () => {
    expect(Object.keys(best).length).toBeGreaterThan(3);
    const q = rankEventsByQuality(best, Gender.MEN, HSU);
    expect(q.division).toBe('D2');
    expect(q.tier).toBe('B');
    expect(q.ranked.length).toBeGreaterThan(0);
  });

  for (const [label, value] of NO_TIME_VALUES) {
    it(`a profile whose only events have no time (${label}) has no tier, no ranking, and keeps them unranked`, () => {
      const events = Object.keys(best);
      const empty = Object.fromEntries(events.map(e => [e, { timeSec: value }]));
      const q = rankEventsByQuality(empty, Gender.MEN, HSU);
      // The team is D2, so the division is known; nothing was swum, so there is no tier.
      expect(q.division).toBe('D2');
      expect(q.tier).toBeNull();
      expect(q.ranked).toEqual([]);
      expect(q.ratioByEvent).toEqual({});
      expect([...q.unranked].sort()).toEqual([...events].sort());
    });

    it(`one no-time event (${label}) added to a real profile changes nothing else`, () => {
      const real = rankEventsByQuality(best, Gender.MEN, HSU);
      const extraEvent = '1650 Freestyle';
      const base = { ...best };
      delete base[extraEvent];
      const without = rankEventsByQuality(base, Gender.MEN, HSU);
      const withEmpty = rankEventsByQuality({ ...base, [extraEvent]: { timeSec: value } }, Gender.MEN, HSU);
      expect(withEmpty.tier).toBe(without.tier);
      expect(withEmpty.ranked).toEqual(without.ranked);
      expect(withEmpty.ratioByEvent).toEqual(without.ratioByEvent);
      expect(withEmpty.unranked).toContain(extraEvent);
      expect(withEmpty.ranked).not.toContain(extraEvent);
      expect(Object.keys(real.ratioByEvent).length).toBeGreaterThan(0);
    });
  }
});
