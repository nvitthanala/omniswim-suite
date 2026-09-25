/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A4 (production-readiness, 2026-09-24): unit tests for the pure
 * cut-table-freshness logic. See `apps/shell/lib/cutTableFreshness.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  findStaleDivisions,
  formatStaleDivisionLine,
  loadCutTableSources,
  seasonForDate,
  seasonStartYear,
  staleCutTableLines,
  type CutTableSource,
} from '../apps/shell/lib/cutTableFreshness';

describe('seasonForDate', () => {
  it('reports the season that started the previous August for a spring date', () => {
    expect(seasonForDate(new Date(2026, 2, 15))).toBe('2025-2026'); // March 2026
  });

  it('reports the season starting this August for a date in August', () => {
    expect(seasonForDate(new Date(2026, 7, 1))).toBe('2026-2027'); // 1 Aug 2026
  });

  it('boundary: 31 July is still last season, 1 August is the new one', () => {
    expect(seasonForDate(new Date(2026, 6, 31))).toBe('2025-2026');
    expect(seasonForDate(new Date(2026, 7, 1))).toBe('2026-2027');
  });

  it('matches the plan\'s worked example for 2026-09-24', () => {
    expect(seasonForDate(new Date(2026, 8, 24))).toBe('2026-2027');
  });
});

describe('seasonStartYear', () => {
  it('parses a well-formed label', () => {
    expect(seasonStartYear('2025-2026')).toBe(2025);
  });

  it('throws on a non-consecutive pair', () => {
    expect(() => seasonStartYear('2025-2027')).toThrow();
  });

  it('throws on a malformed label', () => {
    expect(() => seasonStartYear('2025/2026')).toThrow();
    expect(() => seasonStartYear('not-a-season')).toThrow();
  });
});

describe('loadCutTableSources', () => {
  it('parses a well-formed manifest', () => {
    const json = JSON.stringify({
      sources: [
        { id: 'a', division: 'D1', season: '2025-2026' },
        { id: 'b', division: 'NAIA', season: '2020-2021', evidenceOnly: true },
      ],
    });
    const sources = loadCutTableSources(json);
    expect(sources).toEqual([
      { id: 'a', division: 'D1', season: '2025-2026', evidenceOnly: false },
      { id: 'b', division: 'NAIA', season: '2020-2021', evidenceOnly: true },
    ]);
  });

  it('throws on invalid JSON', () => {
    expect(() => loadCutTableSources('{not json')).toThrow();
  });

  it('throws when "sources" is missing', () => {
    expect(() => loadCutTableSources('{}')).toThrow();
  });

  it('throws when "sources" is not an array', () => {
    expect(() => loadCutTableSources('{"sources": "nope"}')).toThrow();
  });

  it('throws when an entry is missing a required field', () => {
    expect(() => loadCutTableSources(JSON.stringify({ sources: [{ id: 'a', division: 'D1' }] }))).toThrow();
  });
});

describe('findStaleDivisions', () => {
  const sources: CutTableSource[] = [
    { id: 'ncaa-d1-2025-26', division: 'D1', season: '2025-2026' },
    { id: 'ncaa-d2-2026-27', division: 'D2', season: '2026-2027' },
    { id: 'naia-2026-27', division: 'NAIA', season: '2026-2027' },
    // Evidence-only entry: older season, must never count as NAIA's "latest".
    { id: 'naia-2020-21-course-evidence', division: 'NAIA', season: '2020-2021', evidenceOnly: true },
  ];

  it('flags a division whose newest non-evidence table is behind the current season', () => {
    const stale = findStaleDivisions(sources, '2026-2027');
    expect(stale).toEqual([{ division: 'D1', latestSeason: '2025-2026', currentSeason: '2026-2027' }]);
  });

  it('flags nothing when every division is current', () => {
    expect(findStaleDivisions(sources, '2025-2026')).toEqual([]);
  });

  it('ignores an evidenceOnly-only division entirely if it has no other source', () => {
    const evidenceOnly: CutTableSource[] = [
      { id: 'x', division: 'GHOST', season: '2020-2021', evidenceOnly: true },
    ];
    expect(findStaleDivisions(evidenceOnly, '2026-2027')).toEqual([]);
  });

  it('takes the newest season per division when more than one is on file', () => {
    const multi: CutTableSource[] = [
      { id: 'a', division: 'D2', season: '2024-2025' },
      { id: 'b', division: 'D2', season: '2026-2027' },
    ];
    expect(findStaleDivisions(multi, '2026-2027')).toEqual([]);
  });
});

describe('formatStaleDivisionLine', () => {
  it('matches the agreed wording', () => {
    const line = formatStaleDivisionLine({
      division: 'D1',
      latestSeason: '2025-2026',
      currentSeason: '2026-2027',
    });
    expect(line).toBe(
      'Cut tables: D1 is 2025-2026, current season is 2026-2027 — re-run scripts/fetch-cutlines.py when the NCAA publishes.'
    );
  });
});

describe('staleCutTableLines (end-to-end over the real manifest shape)', () => {
  it('produces the plan\'s worked example for the current manifest on 2026-09-24', () => {
    const json = JSON.stringify({
      sources: [
        { id: 'ncaa-d1-2025-26', division: 'D1', season: '2025-2026' },
        { id: 'ncaa-d2-men-2026-27', division: 'D2', season: '2026-2027' },
        { id: 'ncaa-d2-women-2026-27', division: 'D2', season: '2026-2027' },
        { id: 'ncaa-d3-2026-27', division: 'D3', season: '2026-2027' },
        { id: 'naia-2026-27', division: 'NAIA', season: '2026-2027' },
        { id: 'naia-2020-21-course-evidence', division: 'NAIA', season: '2020-2021', evidenceOnly: true },
      ],
    });
    const lines = staleCutTableLines(json, new Date(2026, 8, 24));
    expect(lines).toEqual([
      'Cut tables: D1 is 2025-2026, current season is 2026-2027 — re-run scripts/fetch-cutlines.py when the NCAA publishes.',
    ]);
  });

  it('propagates a malformed manifest as a thrown error, for the caller to catch', () => {
    expect(() => staleCutTableLines('not json', new Date(2026, 8, 24))).toThrow();
  });
});
