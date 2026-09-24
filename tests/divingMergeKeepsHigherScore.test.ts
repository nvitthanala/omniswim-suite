/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The history merge keeps a diver's HIGHER score (plans/2026-09-22/01, P14
 * item c).
 *
 * `mergeHistoryIndex` keeps one row per swimmer, event and course, and it
 * kept the lower number. For a swim that is the faster time. A dive is a
 * judged score, higher is better, and the lower number is the worse dive.
 *
 * The real case is SwimCloud swimmer 2508045 (HSU diver,
 * `tests/fixtures/profile_fastest_times-2508045-diver.json`). Her two
 * `1 mtr Diving` rows are 318.05 (New South Championships) and 170.45 (a dual
 * meet); her two `3 mtr Diving` rows are 249.45 and 176.90. The merge kept
 * 170.45 and 176.90.
 *
 * Not settled here: SwimCloud codes those rows' course `B` and `6`, which may
 * mean an 11-dive and a 6-dive list (plan item P10, unconfirmed). The label
 * does not say, so both rows still share one merge key.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSwimmerFastestTimesJson } from '@omniswim/swimcloud';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import { Gender, type HistoricalSwim } from '../packages/core/src/types';
import { mergeHistoryIndex } from '../packages/core/src/lib/athleteHistory';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State';

function diverSwims(): HistoricalSwim[] {
  const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', 'profile_fastest_times-2508045-diver.json'), 'utf8');
  const parsed = parseSwimmerFastestTimesJson(raw, {
    sourceUrl: 'https://www.swimcloud.com/api/swimmers/2508045/profile_fastest_times/',
    retrievedAt: '2026-09-22T12:00:00.000Z',
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  const conversion = swimCloudSwimmerTimesToHistoricalSwims(
    { ...parsed.data, name: 'Test Diver' },
    { team: HSU, gender: Gender.WOMEN }
  );
  if (!conversion.ok) throw new Error(conversion.message);
  return [...conversion.swims];
}

const dives = (rows: HistoricalSwim[]) =>
  rows
    .filter(s => /diving/i.test(s.event))
    .map(s => [s.event, s.time])
    .sort((a, b) => a[0].localeCompare(b[0]));

describe('mergeHistoryIndex keeps the higher dive score', () => {
  const swims = diverSwims();

  it('imports all four dive scores (the fixture is what the header says)', () => {
    expect(dives(swims).map(d => d.join(' ')).sort()).toStrictEqual([
      '1 mtr Diving 170.45',
      '1 mtr Diving 318.05',
      '3 mtr Diving 176.90',
      '3 mtr Diving 249.45',
    ]);
  });

  it('keeps 318.05 on 1 m and 249.45 on 3 m, in either order', () => {
    expect(dives(mergeHistoryIndex([], swims))).toStrictEqual([
      ['1 mtr Diving', '318.05'],
      ['3 mtr Diving', '249.45'],
    ]);
    expect(dives(mergeHistoryIndex([...swims].reverse(), []))).toStrictEqual([
      ['1 mtr Diving', '318.05'],
      ['3 mtr Diving', '249.45'],
    ]);
    // Split across the existing and incoming halves, both ways round.
    const oneMetre = swims.filter(s => s.event === '1 mtr Diving');
    const high = oneMetre.filter(s => s.time === '318.05');
    const low = oneMetre.filter(s => s.time === '170.45');
    expect(dives(mergeHistoryIndex(high, low))).toStrictEqual([['1 mtr Diving', '318.05']]);
    expect(dives(mergeHistoryIndex(low, high))).toStrictEqual([['1 mtr Diving', '318.05']]);
  });

  it('keeps the higher score for a HyTek meet dive too', () => {
    const meetDive = (time: string): HistoricalSwim => ({
      name: 'Santiago Santodomingo',
      team: 'Delta State University',
      gender: Gender.MEN,
      event: 'Event 9 Men 1 mtr Diving',
      time,
      source: 'pdf',
    });
    // 503.95 is his 2026 NSISC 1 m final (tests/test_nsisc_output.json).
    expect(dives(mergeHistoryIndex([meetDive('503.95')], [meetDive('431.25')]))).toStrictEqual([
      ['Event 9 Men 1 mtr Diving', '503.95'],
    ]);
  });

  it('never lets a score that is not a number beat a real one', () => {
    const dive = (time: string): HistoricalSwim => ({
      name: 'Test Diver',
      team: HSU,
      gender: Gender.WOMEN,
      event: '1 mtr Diving',
      time,
      source: 'swimcloud',
    });
    expect(dives(mergeHistoryIndex([dive('DQ')], [dive('170.45')]))).toStrictEqual([['1 mtr Diving', '170.45']]);
    expect(dives(mergeHistoryIndex([dive('170.45')], [dive('NS')]))).toStrictEqual([['1 mtr Diving', '170.45']]);
  });

  it('still keeps the faster swim for a swim', () => {
    const free = swims.filter(s => !/diving/i.test(s.event));
    expect(free.length).toBeGreaterThan(0);
    const swim = (time: string): HistoricalSwim => ({ ...free[0], time });
    expect(mergeHistoryIndex([swim('1:00.00')], [swim('59.00')]).map(s => s.time)).toStrictEqual(['59.00']);
    expect(mergeHistoryIndex([swim('59.00')], [swim('1:00.00')]).map(s => s.time)).toStrictEqual(['59.00']);
  });
});
