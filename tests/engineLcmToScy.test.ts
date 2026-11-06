/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LCM to SCY conversion (plans/2026-10-25/D2-ENGINE-API.md, 3.13; README R58 to R60).
 *
 * The built-in `lcm-scy-swimswam` v1 is pinned to the archive `data/conversions/swimswam/`. Every
 * capture is replayed through the engine function and compared with the captured output string, not
 * with a recomputation. If the converter, the archive or a built-in value drifts, a test here fails.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_LCM_TO_SCY,
  BUILTIN_TABLE_D,
  LCM_SCY_DIVISOR_SCALE,
  RulePresetError,
  builtinLcmToScy,
  convertLcmToScy,
  formatHundredths,
  parseProvenance,
  parseTimeText,
  scyEventKeyFor,
  scyStatementFor,
  scyStatementForSplit,
} from '@omniswim/engine';
import type { ConversionSettings, DivisionRef, LcmToScyPreset, Provenance, ScyStatement, TimeValue } from '@omniswim/engine';
import { normalizeEventForCutline } from '@omniswim/engine/lib/cutlineEventNames';

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_PATH = 'data/conversions/swimswam/lcm-to-scy-2026-10-26.json';

type Capture = {
  request: { fields: { event: string; course_from: string; course_to: string } };
  input: string;
  output: string;
};
const archiveBytes = readFileSync(path.join(ROOT, ARCHIVE_PATH));
const archive = JSON.parse(archiveBytes.toString('utf8')) as { captures: Capture[] };

const preset = (): LcmToScyPreset => {
  const p = builtinLcmToScy('lcm-scy-swimswam', 1);
  if (!p) throw new Error('lcm-scy-swimswam v1 missing');
  return p;
};

const tv = (h: number): TimeValue => ({ text: formatHundredths(h), hundredths: h });
const time = (text: string): TimeValue => {
  const t = parseTimeText(text);
  if (!t) throw new Error(`bad time ${text}`);
  return t;
};

const STROKE: Record<string, string> = { Fly: 'Butterfly', Back: 'Backstroke', Breast: 'Breaststroke', Free: 'Freestyle', IM: 'Individual Medley' };

/** The archive's `50_Fly` or `400/500_Free` as the LCM and SCY canonical event keys. */
function eventKeys(archiveEvent: string): { lcm: string; scy: string } {
  const [dist, stroke] = archiveEvent.split('_') as [string, string];
  const [lcmDist, scyDist] = dist.split('/') as [string, string | undefined];
  const name = STROKE[stroke];
  if (!name) throw new Error(`unmapped archive event ${archiveEvent}`);
  return { lcm: `${lcmDist} ${name}`, scy: `${scyDist ?? lcmDist} ${name}` };
}

const KNOWN_D2: DivisionRef = { state: 'known', division: 'D2', season: '2026-2027' };
const SETTINGS: ConversionSettings = { includeConvertedSwims: true, lcmToScy: null };
const withPreset = (): ConversionSettings => ({ includeConvertedSwims: true, lcmToScy: preset() });

describe('the archive and the built-in', () => {
  it('the archive on disk has the sha256 the built-in cites, and holds 53 captures', () => {
    const sha = createHash('sha256').update(archiveBytes).digest('hex');
    expect(archive.captures.length).toBe(53);
    const prov = preset().rows[0]!.divisorScaled;
    expect(prov.state === 'set' && prov.provenance).toMatchObject({
      kind: 'tool-derived',
      archive: { path: ARCHIVE_PATH, sha256: sha },
    });
  });

  it('every setting is tool-derived and none is published (R58)', () => {
    const all: Provenance[] = [];
    for (const row of preset().rows) {
      for (const s of [row.divisorScaled, row.turnHundredths]) if (s.state === 'set') all.push(s.provenance);
    }
    const rounding = preset().rounding;
    if (rounding.state === 'set') all.push(rounding.provenance);
    expect(all.length).toBe(17 * 2 + 1);
    for (const p of all) {
      expect(p.kind).toBe('tool-derived');
      expect(parseProvenance(JSON.parse(JSON.stringify(p)), 'p')).toStrictEqual(p);
    }
    expect(all[0]).toMatchObject({
      tool: { url: 'https://swimswam.com/swimming-times-conversion-tool/' },
      basis: 'inferred-from-tool-outputs',
    });
  });

  it('holds the 17 rows of the archive README table, each event once, and no 800 Freestyle Relay row', () => {
    // The README table, by hand: events, divisor, turns per 50, 100 and 200.
    const expected: Record<string, [number, number]> = {
      '50 Freestyle': [111000, 80], '100 Freestyle': [111000, 160], '200 Freestyle': [111000, 320],
      '50 Butterfly': [111000, 70], '100 Butterfly': [111000, 140], '200 Butterfly': [111000, 280],
      '50 Breaststroke': [111000, 100], '100 Breaststroke': [111000, 200], '200 Breaststroke': [111000, 400],
      '50 Backstroke': [109361, 250], '100 Backstroke': [109361, 500], '200 Backstroke': [109361, 1000],
      '200 Individual Medley': [111000, 320], '400 Individual Medley': [111000, 640],
      '400 Freestyle': [89250, 0], '800 Freestyle': [89250, 0], '1500 Freestyle': [102000, 0],
    };
    const rows = preset().rows;
    expect(rows.map(r => r.lcmEventKey).sort()).toStrictEqual(Object.keys(expected).sort());
    for (const r of rows) {
      const [divisor, turn] = expected[r.lcmEventKey] as [number, number];
      expect(r.divisorScaled, r.lcmEventKey).toMatchObject({ state: 'set', value: divisor });
      expect(r.turnHundredths, r.lcmEventKey).toMatchObject({ state: 'set', value: turn });
      expect(normalizeEventForCutline(r.lcmEventKey)).toBe(r.lcmEventKey);
      expect(normalizeEventForCutline(r.scyEventKey)).toBe(r.scyEventKey);
    }
    expect(rows.find(r => r.lcmEventKey.includes('Relay'))).toBeUndefined();
    const readme = readFileSync(path.join(ROOT, 'data/conversions/swimswam/README.md'), 'utf8');
    expect(readme).toContain('| 50, 100, 200 Back | 1.09361 | 2.5, 5.0, 10.0 |');
    expect(readme).toContain('| 400 to 500 Free, 800 to 1000 Free | 0.8925 | 0 |');
    expect(readme).toContain('| 1500 to 1650 Free | 1.02 | 0 |');
    expect(LCM_SCY_DIVISOR_SCALE).toBe(100000);
  });

  it('table-d-user v1 is retired, still resolvable, and unchanged in content (R58)', () => {
    const d = BUILTIN_TABLE_D.find(b => b.id === 'table-d-user' && b.version === 1);
    expect(d?.retired).toMatchObject({ on: '2026-10-26', supersededBy: 'lcm-scy-swimswam' });
    expect(BUILTIN_LCM_TO_SCY.every(b => b.retired === undefined)).toBe(true);
  });

  it('no engine source outside the Table D files and the export list reads Table D (R58)', () => {
    const allowed = new Set(['sourcing/builtins.ts', 'sourcing/tableD.ts', 'index.ts']);
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) {
          const rel = path.relative(path.join(ROOT, 'packages/engine/src'), full).split(path.sep).join('/');
          if (!allowed.has(rel) && /table-d-user|BUILTIN_TABLE_D|TableDPreset|TableDRow/.test(readFileSync(full, 'utf8'))) hits.push(rel);
        }
      }
    };
    walk(path.join(ROOT, 'packages/engine/src'));
    expect(hits).toStrictEqual([]);
  });

  it('builtinLcmToScy never falls back', () => {
    expect(builtinLcmToScy('lcm-scy-swimswam', 1)).toBe(BUILTIN_LCM_TO_SCY[0]!.preset);
    expect(builtinLcmToScy('lcm-scy-swimswam', 2)).toBeUndefined();
    expect(builtinLcmToScy('table-d-user', 1)).toBeUndefined();
    expect(builtinLcmToScy('', 1)).toBeUndefined();
  });
});

describe('replay of the SwimSwam captures', () => {
  const individual = archive.captures.filter(c => c.request.fields.event !== '800_Free Relay');
  const relay = archive.captures.filter(c => c.request.fields.event === '800_Free Relay');

  it('51 individual captures and 2 relay captures, all LCM to SCY', () => {
    expect(individual.length).toBe(51);
    expect(relay.length).toBe(2);
    for (const c of archive.captures) expect([c.request.fields.course_from, c.request.fields.course_to]).toStrictEqual(['LCM', 'SCY']);
  });

  it('every individual capture converts to exactly the captured output', () => {
    let replayed = 0;
    for (const c of individual) {
      const { lcm, scy } = eventKeys(c.request.fields.event);
      const input = time(c.input);
      const captured = time(c.output);
      const result = convertLcmToScy(preset(), lcm, input.hundredths);
      expect(result.kind, `${c.request.fields.event} ${c.input}`).toBe('converted');
      if (result.kind !== 'converted') continue;
      expect(formatHundredths(result.hundredths), `${c.request.fields.event} ${c.input}`).toBe(formatHundredths(captured.hundredths));
      expect(result.hundredths, `${c.request.fields.event} ${c.input}`).toBe(captured.hundredths);
      expect(result.basis.scyEventKey).toBe(scy);
      replayed++;
    }
    expect(replayed).toBe(51);
  });

  it('every individual capture also converts to its output through scyStatementFor, flagged estimated', () => {
    for (const c of individual) {
      const { lcm } = eventKeys(c.request.fields.event);
      const statement = scyStatementFor(
        { eventKey: lcm, recordedCourse: 'LCM', recordedTime: time(c.input) },
        null,
        KNOWN_D2, 'Men',
        withPreset()
      );
      expect(statement).toMatchObject({ kind: 'converted', hundredths: time(c.output).hundredths, estimated: true });
    }
  });

  it('the 800 free relay has no conversion: absent, never factor 1.0', () => {
    for (const c of relay) {
      const input = time(c.input);
      expect(time(c.output).hundredths).toBe(input.hundredths); // the converter echoes the input
      expect(convertLcmToScy(preset(), '800 Freestyle Relay', input.hundredths)).toStrictEqual({ kind: 'absent', reason: 'no_row_for_event' });
      expect(
        scyStatementFor({ eventKey: '800 Freestyle Relay', recordedCourse: 'LCM', recordedTime: input }, null, KNOWN_D2, 'Men', withPreset())
      ).toStrictEqual({ kind: 'not-convertible', reason: 'no_conversion_available' });
    }
  });

  it('keeps the truncated hundredth where rounding would differ: 50 Fly 10:00.00 is 8:59.90, not 8:59.91', () => {
    const r = convertLcmToScy(preset(), '50 Butterfly', 60000);
    expect(r.kind === 'converted' && r.hundredths).toBe(53990);
  });
});

describe('convertLcmToScy', () => {
  it('is integer arithmetic: 100 Backstroke 1:00.00 is 50.29', () => {
    const r = convertLcmToScy(preset(), '100 Backstroke', 6000);
    expect(r.kind === 'converted' && r.hundredths).toBe(5029);
  });

  it('no row is absent: an LCM 500, an LCM 100 IM, a dive, a relay', () => {
    for (const key of ['500 Freestyle', '1000 Freestyle', '1650 Freestyle', '100 Individual Medley', '1-Meter Diving', '400 Medley Relay', '']) {
      expect(convertLcmToScy(preset(), key, 6000), key).toStrictEqual({ kind: 'absent', reason: 'no_row_for_event' });
    }
  });

  it('a turn that leaves no time is absent, never 0', () => {
    expect(convertLcmToScy(preset(), '50 Freestyle', 80)).toStrictEqual({ kind: 'absent', reason: 'result_not_positive' });
    expect(convertLcmToScy(preset(), '50 Freestyle', 50)).toStrictEqual({ kind: 'absent', reason: 'result_not_positive' });
  });

  it('throws on a time that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => convertLcmToScy(preset(), '50 Freestyle', bad), String(bad)).toThrow(RangeError);
    }
  });

  it('a pending row refuses; it never guesses', () => {
    const base = preset();
    const pendingPreset: LcmToScyPreset = {
      ...base,
      rows: base.rows.map(r => (r.lcmEventKey === '50 Freestyle' ? { ...r, divisorScaled: { state: 'pending', question: 'q', blocks: [] } } : r)),
    };
    expect(convertLcmToScy(pendingPreset, '50 Freestyle', 6000)).toStrictEqual({ kind: 'absent', reason: 'setting_pending' });
    expect(convertLcmToScy(pendingPreset, '100 Freestyle', 6000).kind).toBe('converted');
  });

  it('records where the divisor came from and how it was applied', () => {
    const swim = convertLcmToScy(preset(), '200 Backstroke', 12000);
    const split = convertLcmToScy(preset(), '200 Backstroke', 12000, 'relay-split');
    expect(swim.kind === 'converted' && swim.basis).toMatchObject({
      method: 'lcm_scy_tool_derived', divisorScaled: 109361, turnHundredths: 1000, appliedTo: 'individual-swim',
      provenance: { kind: 'tool-derived' },
    });
    expect(split.kind === 'converted' && split.basis.appliedTo).toBe('relay-split');
  });
});

describe('scyStatementFor: the order of sources (R10, R60)', () => {
  const lcm100Free = { eventKey: '100 Freestyle', recordedCourse: 'LCM' as const, recordedTime: time('1:00.00') };

  it('SwimCloud first: its displayed conversion wins over the preset and over Table A', () => {
    const swimcloud = time('52.99');
    for (const course of ['LCM', 'SCM'] as const) {
      const s = scyStatementFor({ ...lcm100Free, recordedCourse: course }, swimcloud, KNOWN_D2, 'Men', withPreset());
      expect(s).toStrictEqual({ kind: 'converted', hundredths: 5299, basis: { method: 'swimcloud', displayedText: '52.99' }, estimated: true });
    }
  });

  it('SCM uses the NCAA Table A (published): the table factor, truncated', () => {
    const s = scyStatementFor(
      { eventKey: '400 Freestyle', recordedCourse: 'SCM', recordedTime: time('4:00.00') },
      null,
      KNOWN_D2, 'Men',
      withPreset()
    );
    expect(s.kind).toBe('converted');
    if (s.kind !== 'converted') return;
    expect(s.basis.method).toBe('ncaa_scm_table');
    expect(s.estimated).toBe(true);
    // 240.00 s times the table factor, truncated. Not the LCM result (4:28.90, R59).
    expect(s.hundredths).not.toBe(time('4:28.90').hundredths);
    if (s.basis.method === 'ncaa_scm_table') expect(Math.trunc(24000 * s.basis.factor)).toBe(s.hundredths);
  });

  it('LCM uses the preset: 4:00.00 LCM 400 free is 4:28.90 as a 500 (R59)', () => {
    const s = scyStatementFor({ eventKey: '400 Freestyle', recordedCourse: 'LCM', recordedTime: time('4:00.00') }, null, KNOWN_D2, 'Men', withPreset());
    expect(s).toMatchObject({ kind: 'converted', hundredths: time('4:28.90').hundredths, estimated: true });
    expect(s.kind === 'converted' && s.basis).toMatchObject({ method: 'lcm_scy_tool_derived', scyEventKey: '500 Freestyle' });
  });

  it('no preset means no LCM conversion (null), and an unknown division does not change SCM into D1', () => {
    expect(scyStatementFor(lcm100Free, null, KNOWN_D2, 'Men', SETTINGS)).toStrictEqual({ kind: 'not-convertible', reason: 'no_conversion_available' });
    const unknown: DivisionRef = { state: 'unknown', reason: 'unmapped_team' };
    const s = scyStatementFor({ ...lcm100Free, recordedCourse: 'SCM' }, null, unknown, 'Men', withPreset());
    expect(s.kind === 'converted' && s.basis).toMatchObject({ method: 'ncaa_scm_table', division: null });
  });

  it('a recorded SCY swim is not converted; an excluded meet converts nothing', () => {
    expect(scyStatementFor({ ...lcm100Free, recordedCourse: 'SCY' }, null, KNOWN_D2, 'Men', withPreset())).toStrictEqual({ kind: 'recorded-scy' });
    const off: ConversionSettings = { includeConvertedSwims: false, lcmToScy: preset() };
    expect(scyStatementFor(lcm100Free, time('52.99'), KNOWN_D2, 'Men', off)).toStrictEqual({ kind: 'not-convertible', reason: 'conversions_excluded' });
  });

  it('an event the course does not swim comes first', () => {
    const off: ConversionSettings = { includeConvertedSwims: false, lcmToScy: preset() };
    const s = scyStatementFor({ eventKey: '1000 Freestyle', recordedCourse: 'SCM', recordedTime: time('10:00.00') }, null, KNOWN_D2, 'Men', off);
    expect(s).toStrictEqual({ kind: 'not-convertible', reason: 'event_not_swum_in_course' });
    const scy = scyStatementFor({ eventKey: '400 Freestyle', recordedCourse: 'SCY', recordedTime: time('4:00.00') }, null, KNOWN_D2, 'Men', withPreset());
    expect(scy).toStrictEqual({ kind: 'not-convertible', reason: 'event_not_swum_in_course' });
  });

  it('NT never becomes a time, and a relay is not converted in either metric course', () => {
    expect(scyStatementFor({ ...lcm100Free, recordedTime: null }, null, KNOWN_D2, 'Men', withPreset())).toStrictEqual({ kind: 'not-convertible', reason: 'no_conversion_available' });
    for (const course of ['LCM', 'SCM'] as const) {
      const s = scyStatementFor({ eventKey: '400 Freestyle Relay', recordedCourse: course, recordedTime: time('3:30.00') }, null, KNOWN_D2, 'Men', withPreset());
      expect(s, course).toStrictEqual({ kind: 'not-convertible', reason: 'no_conversion_available' });
    }
  });

  it('never produces the retired Table D basis, and every statement is typed to carry no tableD', () => {
    const seen: ScyStatement[] = [];
    for (const row of preset().rows) {
      seen.push(scyStatementFor({ eventKey: row.lcmEventKey, recordedCourse: 'LCM', recordedTime: time('2:00.00') }, null, KNOWN_D2, 'Men', withPreset()));
    }
    expect(seen.length).toBe(17);
    for (const s of seen) expect(s.kind === 'converted' && s.basis.method).toBe('lcm_scy_tool_derived');
    expect(Object.keys(withPreset()).sort()).toStrictEqual(['includeConvertedSwims', 'lcmToScy']);
  });

  it('throws on a time that is not a positive integer of hundredths', () => {
    expect(() => scyStatementFor({ ...lcm100Free, recordedTime: tv(0) }, null, KNOWN_D2, 'Men', withPreset())).toThrow(RangeError);
    expect(() => scyStatementFor(lcm100Free, tv(0), KNOWN_D2, 'Men', withPreset())).toThrow(RangeError);
  });

  it('scyEventKeyFor maps the three metric distance freestyles and keeps every other key', () => {
    expect(scyEventKeyFor('400 Freestyle', 'LCM')).toBe('500 Freestyle');
    expect(scyEventKeyFor('800 Freestyle', 'SCM')).toBe('1000 Freestyle');
    expect(scyEventKeyFor('1500 Freestyle', 'LCM')).toBe('1650 Freestyle');
    expect(scyEventKeyFor('100 Backstroke', 'LCM')).toBe('100 Backstroke');
    expect(scyEventKeyFor('500 Freestyle', 'SCY')).toBe('500 Freestyle');
  });
});

describe('relay splits (README R60, R62)', () => {
  const split = (over: Partial<Parameters<typeof scyStatementForSplit>[0]> = {}) => ({
    legEventKey: '200 Freestyle' as string | null,
    course: 'LCM' as 'SCY' | 'SCM' | 'LCM' | null,
    split: time('1:50.00'),
    ...over,
  });

  it('converts a split with the individual divisor and turn of its leg, and marks it as a split', () => {
    const s = scyStatementForSplit(split(), KNOWN_D2, 'Men', withPreset());
    // (110.00 - 3.20) / 1.11 = 96.216 -> 96.21
    expect(s).toMatchObject({ kind: 'converted', hundredths: 9621, estimated: true });
    expect(s.kind === 'converted' && s.basis).toMatchObject({ method: 'lcm_scy_tool_derived', appliedTo: 'relay-split' });
    const same = scyStatementFor({ eventKey: '200 Freestyle', recordedCourse: 'LCM', recordedTime: time('1:50.00') }, null, KNOWN_D2, 'Men', withPreset());
    expect(same.kind === 'converted' && same.hundredths).toBe(9621);
    expect(same.kind === 'converted' && same.basis).toMatchObject({ appliedTo: 'individual-swim' });
  });

  it('the 800 free relay itself is absent, but its 200 free leg converts: both stay true', () => {
    expect(scyStatementFor({ eventKey: '800 Freestyle Relay', recordedCourse: 'LCM', recordedTime: time('7:30.00') }, null, KNOWN_D2, 'Men', withPreset()).kind).toBe('not-convertible');
    expect(scyStatementForSplit(split({ legEventKey: '200 Freestyle' }), KNOWN_D2, 'Men', withPreset()).kind).toBe('converted');
  });

  it('an SCM split uses Table A and says so', () => {
    const s = scyStatementForSplit(split({ course: 'SCM', legEventKey: '50 Freestyle', split: time('24.00') }), KNOWN_D2, 'Men', withPreset());
    expect(s.kind === 'converted' && s.basis).toMatchObject({ method: 'ncaa_scm_table', appliedTo: 'relay-split' });
  });

  it('a split with no course, no leg event, or a leg with no row is absent; the course is never assumed SCY', () => {
    for (const over of [{ course: null }, { legEventKey: null }, { legEventKey: '500 Freestyle' }, { legEventKey: '100 Individual Medley' }]) {
      expect(scyStatementForSplit(split(over), KNOWN_D2, 'Men', withPreset()), JSON.stringify(over)).toStrictEqual({ kind: 'not-convertible', reason: 'no_conversion_available' });
    }
  });

  it('an SCY split is recorded SCY, and an excluded meet converts no split', () => {
    expect(scyStatementForSplit(split({ course: 'SCY' }), KNOWN_D2, 'Men', withPreset())).toStrictEqual({ kind: 'recorded-scy' });
    const off: ConversionSettings = { includeConvertedSwims: false, lcmToScy: preset() };
    expect(scyStatementForSplit(split(), KNOWN_D2, 'Men', off)).toStrictEqual({ kind: 'not-convertible', reason: 'conversions_excluded' });
  });
});

describe('the tool-derived provenance kind', () => {
  const good = {
    kind: 'tool-derived',
    tool: { name: 'T', url: 'https://example.test/t' },
    archive: { path: 'data/x.json', sha256: 'a'.repeat(64) },
    capturedOn: '2026-10-26',
    basis: 'inferred-from-tool-outputs',
  };
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      if (e instanceof RulePresetError) return e.code;
      throw e;
    }
    return 'no-throw';
  };

  it('parses a complete record and returns it unchanged', () => {
    expect(parseProvenance(good, 'p')).toStrictEqual(good);
  });

  it('rejects a bad sha256, a changed basis, an unknown key, a missing field and a bad date', () => {
    expect(code(() => parseProvenance({ ...good, archive: { ...good.archive, sha256: 'A'.repeat(64) } }, 'p'))).toBe('invalid');
    expect(code(() => parseProvenance({ ...good, basis: 'published' }, 'p'))).toBe('invalid');
    expect(code(() => parseProvenance({ ...good, extra: 1 }, 'p'))).toBe('invalid');
    const { tool: _tool, ...noTool } = good;
    expect(code(() => parseProvenance(noTool, 'p'))).toBe('missing');
    expect(code(() => parseProvenance({ ...good, capturedOn: '2026-13-01' }, 'p'))).toBe('invalid');
  });

  it('is not published: it has no source field and parses as a different kind', () => {
    const parsed = parseProvenance(good, 'p');
    expect(parsed.kind).not.toBe('published');
    expect('source' in parsed).toBe(false);
    expect(code(() => parseProvenance({ kind: 'published', tool: good.tool, archive: good.archive }, 'p'))).not.toBe('no-throw');
  });
});
