import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ParsedRowError,
  mapAthleteRows,
  mapPsychRows,
  parsePdfPointsValue,
  parseRank,
} from '../apps/shell/lib/routes/parsingPipeline';
import { Gender } from '../packages/core/src/types';

const root = path.resolve(__dirname, '..');

/** A row shaped like `backend/parse_meet.py` output for a normal placed individual swim. */
function goodRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Alan Gonzalez',
    team: 'Henderson State University',
    event: 'Event 5 Men 200 Yard Freestyle',
    gender: 'Men',
    year: 'SR',
    rank: '3',
    finals_time: '1:40.12',
    round_swam: 'A Final',
    calculated_points: 16,
    pdf_points: null,
    ...over,
  };
}

describe('mapAthleteRows: no plausible zero, no default gender', () => {
  it('maps a clean row unchanged', () => {
    const [r] = mapAthleteRows([goodRow()]);
    expect(r.rank).toBe(3);
    expect(r.points).toBe(16);
    expect(r.gender).toBe(Gender.MEN);
    expect(r.pdfPoints).toBeUndefined();
  });

  it('keeps Women as Women and "N/A" points as "N/A"', () => {
    const [r] = mapAthleteRows([goodRow({ gender: 'Women', calculated_points: 'N/A' })]);
    expect(r.gender).toBe(Gender.WOMEN);
    expect(r.points).toBe('N/A');
  });

  it('treats an absent rank as the unplaced sentinel 0 (real: exhibition and timed finals)', () => {
    for (const rank of [null, undefined, '']) {
      const [r] = mapAthleteRows([goodRow({ rank })]);
      expect(r.rank).toBe(0);
    }
  });

  it.each([
    ['rank "DQ"', { rank: 'DQ' }, /rank "DQ"/],
    ['rank "0"', { rank: '0' }, /rank "0"/],
    ['rank "-3"', { rank: '-3' }, /rank "-3"/],
    ['rank 2.5', { rank: 2.5 }, /rank 2\.5/],
    ['calculated_points "bad"', { calculated_points: 'bad' }, /calculated_points "bad"/],
    ['calculated_points missing', { calculated_points: undefined }, /calculated_points undefined/],
    ['calculated_points null', { calculated_points: null }, /calculated_points null/],
    ['calculated_points NaN-like string', { calculated_points: 'NaN' }, /calculated_points "NaN"/],
    ['gender missing', { gender: undefined }, /gender undefined/],
    ['gender null', { gender: null }, /gender null/],
    ['gender "Mixed"', { gender: 'Mixed' }, /gender "Mixed"/],
    ['name missing', { name: undefined }, /missing name/],
    ['team empty', { team: '  ' }, /missing team/],
    ['event missing', { event: undefined }, /missing event/],
    ['pdf_points "12pts"', { pdf_points: '12pts' }, /pdf_points "12pts"/],
    ['pdf_points whitespace-wrapped', { pdf_points: ' 12 ' }, /pdf_points " 12 "/],
    ['pdf_points negative', { pdf_points: -1 }, /pdf_points -1/],
  ])('throws ParsedRowError for %s and names the row', (_label, over, message) => {
    let caught: unknown;
    try {
      mapAthleteRows([goodRow(), goodRow(over)]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParsedRowError);
    const err = caught as ParsedRowError;
    expect(err.message).toMatch(message);
    expect(err.message).toContain('row 1');
    expect(err.message).not.toContain('row 0');
    expect(err.totalProblems).toBe(1);
  });

  it('reports every bad row (bounded list) instead of stopping at the first', () => {
    const rows = Array.from({ length: 15 }, () => goodRow({ gender: undefined }));
    let caught: unknown;
    try {
      mapAthleteRows(rows);
    } catch (e) {
      caught = e;
    }
    const err = caught as ParsedRowError;
    expect(err.totalProblems).toBe(15);
    expect(err.problems).toHaveLength(10);
    expect(err.message).toContain('(+5 more)');
  });
});

describe('mapPsychRows', () => {
  it('maps a clean psych row and expands nothing it cannot', () => {
    const [r] = mapPsychRows([{ ...goodRow(), time: '1:40.12' }]);
    expect(r.gender).toBe(Gender.MEN);
    expect(r.isPsychSheet).toBe(true);
  });

  it('throws on a missing gender instead of defaulting to Men', () => {
    expect(() => mapPsychRows([{ ...goodRow({ gender: undefined }), time: '1:40.12' }])).toThrow(ParsedRowError);
  });
});

describe('parseRank', () => {
  it('accepts a leading-star digit rank and rejects text', () => {
    expect(parseRank('*4')).toEqual({ ok: true, rank: 4 });
    expect(parseRank(7)).toEqual({ ok: true, rank: 7 });
    expect(parseRank('1st').ok).toBe(false);
  });
});

/**
 * Python and TypeScript must agree on what a printed PDF points value is.
 * `backend/point_calculator.py parse_pdf_points` and `parsePdfPointsValue` are
 * run over the same JSON cases; `accepted` is the expected shared verdict.
 */
describe('pdf_points: Python and TypeScript parse the same way', () => {
  const CASES: { json: string; verdict: 'absent' | 'bad' | number }[] = [
    { json: 'null', verdict: 'absent' },
    { json: '""', verdict: 'absent' },
    { json: '0', verdict: 0 },
    { json: '8.5', verdict: 8.5 },
    { json: '20', verdict: 20 },
    { json: '"12"', verdict: 'bad' },
    { json: '" 12 "', verdict: 'bad' },
    { json: '"12pts"', verdict: 'bad' },
    { json: '"abc"', verdict: 'bad' },
    { json: '" "', verdict: 'bad' },
    { json: 'true', verdict: 'bad' },
    { json: 'false', verdict: 'bad' },
    { json: '-1', verdict: 'bad' },
    { json: '1e999', verdict: 'bad' },
    { json: '[]', verdict: 'bad' },
    { json: '{}', verdict: 'bad' },
  ];

  it('TypeScript verdicts match the table', () => {
    for (const c of CASES) {
      const r = parsePdfPointsValue(JSON.parse(c.json));
      const verdict = !r.ok ? 'bad' : r.value === undefined ? 'absent' : r.value;
      expect(verdict, c.json).toBe(c.verdict);
    }
  });

  it('Python verdicts match the same table', () => {
    const py = String.raw`
import json, sys
sys.path.insert(0, 'backend')
import point_calculator as pc
out = []
for text in json.loads(sys.stdin.read()):
    value = json.loads(text)
    try:
        v = pc.parse_pdf_points(value)
    except ValueError:
        out.append('bad')
    else:
        out.append('absent' if v is None else v)
print(json.dumps(out))
`;
    const result = spawnSync('python', ['-c', py], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify(CASES.map(c => c.json)),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(CASES.map(c => c.verdict));
  });
});
