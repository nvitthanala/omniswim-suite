/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/manager/src/lib/swimCloudImprovementDiff.ts` — P8: after a
 * re-crawl, which of a swimmer's events got faster.
 *
 * Every "old" set below is a real SwimCloud response (`tests/fixtures/
 * profile_fastest_times-*.json`) with one row edited or removed — never a
 * hand-typed HistoricalSwim. Both the "old" and "new" side go through the
 * exact same parser (`parseSwimmerFastestTimesJson`) and converter
 * (`swimCloudSwimmerTimesToHistoricalSwims`) the real import path uses, so
 * these tests exercise the real conversion, not a stand-in for it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import type { HistoricalSwim } from '@omniswim/core/types';
import { parseSwimmerFastestTimesJson, type SwimCloudParseContext } from '@omniswim/swimcloud';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import {
  diffSwimCloudPersonalBests,
  existingSwimCloudHistoryFor,
} from '@omniswim/manager/lib/swimCloudImprovementDiff';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureRaw = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');
const fixtureRows = (name: string): Record<string, unknown>[] =>
  Object.values(JSON.parse(fixtureRaw(name)) as Record<string, Record<string, unknown>>);

const TEAM = 'Henderson State';

function context(id: string): SwimCloudParseContext {
  return {
    sourceUrl: `https://www.swimcloud.com/api/swimmers/${id}/profile_fastest_times/`,
    retrievedAt: '2026-09-24T00:00:00.000Z',
    track: 'browser-extension',
  };
}

/** Parse a (possibly edited) row set into this swimmer's importable HistoricalSwim[]. */
function convert(rows: Record<string, unknown>[], id: string, name: string, gender: Gender): HistoricalSwim[] {
  const parsed = parseSwimmerFastestTimesJson(JSON.stringify(rows), context(id));
  if (!parsed.ok) throw new Error(parsed.failure.message);
  const conversion = swimCloudSwimmerTimesToHistoricalSwims({ ...parsed.data, name }, { team: TEAM, gender });
  if (!conversion.ok) throw new Error(conversion.message);
  return [...conversion.swims];
}

describe('diffSwimCloudPersonalBests — a faster time', () => {
  const id = '1330318';
  const rows = fixtureRows('profile_fastest_times-1330318.json');
  const newSwims = convert(rows, id, 'River Paulk', Gender.MEN);

  it('reports the event as faster with a positive delta, old → new', () => {
    // Row 3 (200 Free SCY, "1:41.29" per swimmerFastestTimes.test.ts) — slow
    // it down by exactly one second in the "old" copy.
    const target = newSwims.find((s) => s.event === '200 Free SCY');
    expect(target).toBeDefined();

    const oldRows = rows.map((r) =>
      r.eventdistance === 200 && r.eventstroke === '1' && r.eventcourse === 'Y' ? { ...r, eventtime: '102.29' } : r
    );
    const oldSwims = convert(oldRows, id, 'River Paulk', Gender.MEN);

    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    const found = diff.find((d) => d.eventLabel === '200 Free SCY');
    expect(found).toMatchObject({
      kind: 'faster',
      isDiving: false,
      oldTime: '1:42.29',
      newTime: '1:41.29',
    });
    expect(found?.deltaSeconds).toBeCloseTo(1.0, 5);
  });

  it('reports a slower time as nothing at all — bests only improve', () => {
    const oldRows = rows.map((r) =>
      r.eventdistance === 200 && r.eventstroke === '1' && r.eventcourse === 'Y' ? { ...r, eventtime: '90.00' } : r
    );
    const oldSwims = convert(oldRows, id, 'River Paulk', Gender.MEN);
    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    expect(diff.find((d) => d.eventLabel === '200 Free SCY')).toBeUndefined();
  });

  it('reports an event the old capture never held as new_event, never as a fabricated 0', () => {
    const oldRows = rows.filter((r) => !(r.eventdistance === 1650 && r.eventstroke === '1' && r.eventcourse === 'Y'));
    const oldSwims = convert(oldRows, id, 'River Paulk', Gender.MEN);
    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    const found = diff.find((d) => d.eventLabel === '1650 Free SCY');
    expect(found).toMatchObject({ kind: 'new_event', newTime: '18:15.50' });
    expect(found?.oldTime).toBeUndefined();
  });

  it('reports nothing for an event whose time is unchanged', () => {
    const oldSwims = convert(rows, id, 'River Paulk', Gender.MEN);
    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    expect(diff).toStrictEqual([]);
  });
});

describe('diffSwimCloudPersonalBests — extracted splits and self-reported times are never a before or an after', () => {
  const id = '2352628';
  const rows = fixtureRows('profile_fastest_times-2352628-user-inputted.json');
  const newSwims = convert(rows, id, 'Test Swimmer', Gender.WOMEN);

  it('never reports the extracted-split row, even when its own time improves', () => {
    // "50 Fly LCM", tagged Extracted (X).
    const extracted = rows.find(
      (r) => r.eventdistance === 50 && r.eventstroke === '4' && r.eventcourse === 'L'
    );
    expect(extracted).toBeDefined();
    expect((extracted?.flags as { title?: string }[]).some((f) => f.title === 'Extracted')).toBe(true);

    const oldRows = rows.map((r) => (r === extracted ? { ...r, eventtime: '99.99' } : r));
    const oldSwims = convert(oldRows, id, 'Test Swimmer', Gender.WOMEN);
    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    expect(diff.find((d) => d.eventLabel === '50 Fly LCM')).toBeUndefined();
  });

  it('never reports the user-inputted row, even when its own time improves', () => {
    // "100 Free SCM", tagged User Inputted (U).
    const userInputted = rows.find(
      (r) => r.eventdistance === 100 && r.eventstroke === '1' && r.eventcourse === 'S'
    );
    expect(userInputted).toBeDefined();
    expect((userInputted?.flags as { title?: string }[]).some((f) => f.title === 'User Inputted')).toBe(true);

    const oldRows = rows.map((r) => (r === userInputted ? { ...r, eventtime: '99.99' } : r));
    const oldSwims = convert(oldRows, id, 'Test Swimmer', Gender.WOMEN);
    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    expect(diff.find((d) => d.eventLabel === '100 Free SCM')).toBeUndefined();
  });
});

describe('diffSwimCloudPersonalBests — diving compares by higher score', () => {
  const id = '2508045';
  const rows = fixtureRows('profile_fastest_times-2508045-diver.json');
  const newSwims = convert(rows, id, 'Test Diver', Gender.WOMEN);

  it('reports a higher score as faster, with a positive point delta', () => {
    // "1 mtr Diving" 318.05 (row: eventdistance 1, eventstroke 'H' [diving], eventcourse 'B').
    const target = rows.find((r) => r.eventdistance === 1 && r.eventstroke === 'H' && r.eventcourse === 'B');
    expect(target).toBeDefined();
    const oldRows = rows.map((r) => (r === target ? { ...r, eventtime: '300.00' } : r));
    const oldSwims = convert(oldRows, id, 'Test Diver', Gender.WOMEN);

    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    const found = diff.find((d) => d.eventLabel === '1 mtr Diving' && d.oldTime === '300.00');
    expect(found).toMatchObject({ kind: 'faster', isDiving: true, newTime: '318.05' });
    expect(found?.deltaScore).toBeCloseTo(18.05, 5);
  });

  it('never reports a lower score as an improvement', () => {
    const target = rows.find((r) => r.eventdistance === 1 && r.eventstroke === 'H' && r.eventcourse === 'B');
    const oldRows = rows.map((r) => (r === target ? { ...r, eventtime: '400.00' } : r));
    const oldSwims = convert(oldRows, id, 'Test Diver', Gender.WOMEN);
    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    expect(diff.find((d) => d.eventLabel === '1 mtr Diving' && d.newTime === '318.05')).toBeUndefined();
  });
});

describe('diffSwimCloudPersonalBests — an altitude-adjusted time is still a best', () => {
  const id = '1401610';
  const rows = fixtureRows('profile_fastest_times-1401610-altitude.json');
  const newSwims = convert(rows, id, 'Test Swimmer', Gender.MEN);

  it('reports the altitude-adjusted 400 Free LCM as an improvement, marked as altitude-adjusted', () => {
    const target = rows.find((r) => r.eventdistance === 400 && r.eventstroke === '1' && r.eventcourse === 'L');
    expect(target).toBeDefined();
    expect((target?.flags as { title?: string }[]).some((f) => f.title === 'Altitude Adjusted')).toBe(true);

    const oldRows = rows.map((r) => (r === target ? { ...r, eventtime: '250.00' } : r));
    const oldSwims = convert(oldRows, id, 'Test Swimmer', Gender.MEN);
    const diff = diffSwimCloudPersonalBests(oldSwims, newSwims);
    const found = diff.find((d) => d.eventLabel === '400 Free LCM');
    expect(found).toMatchObject({ kind: 'faster', isAltitudeAdjusted: true, newTime: '4:07.11' });
  });
});

describe('existingSwimCloudHistoryFor', () => {
  it('matches a stored row regardless of name order, and only the same team/gender/source', () => {
    const history: HistoricalSwim[] = [
      { name: 'Paulk, River', team: 'Henderson State', gender: Gender.MEN, event: '50 Free SCY', time: '20.99', source: 'swimcloud' },
      { name: 'River Paulk', team: 'Other Team', gender: Gender.MEN, event: '50 Free SCY', time: '19.00', source: 'swimcloud' },
      { name: 'River Paulk', team: 'Henderson State', gender: Gender.WOMEN, event: '50 Free SCY', time: '18.00', source: 'swimcloud' },
      { name: 'River Paulk', team: 'Henderson State', gender: Gender.MEN, event: '50 Free SCY', time: '21.50', source: 'paste' },
    ];
    const found = existingSwimCloudHistoryFor(history, 'River Paulk', 'Henderson State', Gender.MEN);
    expect(found).toHaveLength(1);
    expect(found[0].time).toBe('20.99');
  });
});
