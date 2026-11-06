/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Built-in versions and content (plans/2026-10-25/D2-ENGINE-API.md, 3.12 and 4).
 *
 * A built-in is addressed by `{id, version}`. The sha256 below pins the content of each one. If you
 * change a built-in, raise its `version` and pin the new hash here. Do not edit a hash in place:
 * a saved reference to `{nsisc, 1}` must keep meaning what it meant.
 *
 * The content tests read the sources the built-ins cite (the user plan, the README rows, the
 * scoring manifest) and fail if a copied value or a quoted wording stops matching its source line.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_RULE_PRESETS,
  BUILTIN_SESSION_PRESETS,
  BUILTIN_LCM_TO_SCY,
  BUILTIN_TABLE_D,
  builtinRulePreset,
  parseRulePreset,
  parseRulePresetV1,
  parseRulePresetV2,
  pendingPaths,
  requireComplete,
} from '@omniswim/engine';
import type { Provenance, RulePreset, ScheduledEvent, Setting } from '@omniswim/engine';
import { normalizeEventForCutline } from '@omniswim/engine/lib/cutlineEventNames';
import { NCAA_FORMAT_RULESETS } from '@omniswim/engine/lib/ncaaScoringRules';

const ROOT = path.resolve(__dirname, '..');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(k => [k, canonical(record[k])]));
  }
  return value;
}

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** kind|id|version to the sha256 of the sorted-key JSON of the preset. */
const PINNED: Readonly<Record<string, string>> = {
  // `rule|` pins the version 1 shaped body of each rule preset (`frozen`): the hashes of nsisc v1, nsisc v2 and
  // generic v1 were set before the ties setting and did not change. nsisc v3 has no v1 payload: its body is
  // v2's, so it carries v2's hash.
  // `rule2|` pins the payload version 2 view (`scoring.ties`, no `relayOverCap`), set before relayOverCap. The
  // three shipped hashes did not change: relayOverCap is stripped before hashing. nsisc v3's view is v2's.
  // `rule3|` pins what each (id, version) resolves to now: payload version 3.
  'rule3|nsisc|1': '3be16841765bfa368e5a0a04539bf46c63683b6d680aadc48d395952c6e4cb33',
  'rule3|nsisc|2': '1c747b84a34fa83c243e7c84c8f10f9a02d06cac8105d0e0d8784872752a1951',
  'rule3|nsisc|3': '2f69ea3d7ce85e46f46df1a8849269d52047840f76332c7ed7c8827041753798',
  // nsisc v4 is a new body (the 7 total cap, README R73), so all three of its hashes are new.
  'rule3|nsisc|4': '5f1cbe51e7e9e10f3bc06f1eb8213012981714998d443ccde79607a7ec9e0d51',
  'rule2|nsisc|4': '3fce6204305ea2f0e91c9d262c6403e3a3151bdfa9782b992fd7bc80a20726c1',
  'rule|nsisc|4': '3a5b13dccaad26b73475b2b6a03311f512e23f40413638fdd071eaa335673d46',
  // nsisc v5 is v4 plus entries.nonScoringRelaysAllowed (README R42); generic v2 is v1 plus entries.relaySwimmerOncePerEvent
  // (NCAA Rule 5-7-1-g). Each reuses its predecessor's version 1 body and version 2 view, so those hashes repeat. Only the
  // version 3 hash is new.
  'rule3|nsisc|5': 'd37621a9ce4a5083a7244bb702f3e3977c48b433424575a9b37b9c45a98eef39',
  'rule2|nsisc|5': '3fce6204305ea2f0e91c9d262c6403e3a3151bdfa9782b992fd7bc80a20726c1',
  'rule|nsisc|5': '3a5b13dccaad26b73475b2b6a03311f512e23f40413638fdd071eaa335673d46',
  'rule3|generic|2': '76268c1966c439ba468229863d63207f50f6b06f553f8ca803e1c6104d12b9db',
  'rule2|generic|2': '23847dfed79cb372043ff2d0afa24a8561fffa4ce38156c2cd343164e1c855b4',
  'rule|generic|2': '56d58f3ed13b00de5732039b3f40da7f5117c9562fdce0df3bfb7f0829668ac4',
  'rule3|generic|1':'b42d9f8eec4785b03e3c7dd29f6f6b520cbb5fc8dee31084bba636cb55d6f3c4',
  'rule2|nsisc|1': '7670e51fcdb704b0dce2ff899fa2a0d13d443d5bb66bf02936e1cadb73213358',
  'rule2|nsisc|2': '2b72f5a6bc2982aceef0342e3566e42e5cf23ef0cd610f21b6fbc8e2947e638d',
  'rule2|nsisc|3': '2b72f5a6bc2982aceef0342e3566e42e5cf23ef0cd610f21b6fbc8e2947e638d',
  'rule2|generic|1': '23847dfed79cb372043ff2d0afa24a8561fffa4ce38156c2cd343164e1c855b4',
  'rule|nsisc|1': 'd753a42865adf2450528464be02b6cf69697558d1e08dbf3f046a6a1edd72348',
  'rule|nsisc|2': '6000b59d78e33663ff6f4a485dd3a75a5d20c060eb4ad70fc65a34fb2e7dd2c2',
  'rule|nsisc|3': '6000b59d78e33663ff6f4a485dd3a75a5d20c060eb4ad70fc65a34fb2e7dd2c2',
  'rule|generic|1': '56d58f3ed13b00de5732039b3f40da7f5117c9562fdce0df3bfb7f0829668ac4',
  'session|nsisc-table-c|1': '17c5ccef7f94c0900aa8997ffe1447bb6cafb71350fbe906e05c7a9dfd8bb731',
  'tableD|table-d-user|1': 'ad287084f4934bfee8a5e1285ee5f3cd3283b2564cff9faa91653fbc25b80359',
  'lcmToScy|lcm-scy-swimswam|1': '76d9b570e06aed33b90bd64d48bbd3653e0816b0c0a88a398b9fce8e43986c7c',
};

/**
 * The payload version 2 view of a built-in: no `scorers.relayOverCap`, and none of the optional relay entry rules
 * (README R42 and R72, version 3 only). The hashes of the shipped views must not move.
 */
function payloadV2View(preset: RulePreset): unknown {
  const { relayOverCap: _relayOverCap, ...scorers } = preset.scorers;
  const { relaySwimmerOncePerEvent: _once, nonScoringRelaysAllowed: _allowed, ...entries } = preset.entries;
  return { ...preset, payloadVersion: 2, scorers, entries };
}

const SHIPPED: readonly { key: string; preset: unknown }[] = [
  ...BUILTIN_RULE_PRESETS.map(b => ({ key: `rule|${b.id}|${b.version}`, preset: b.frozen })),
  ...BUILTIN_RULE_PRESETS.map(b => ({ key: `rule2|${b.id}|${b.version}`, preset: payloadV2View(b.preset) })),
  ...BUILTIN_RULE_PRESETS.map(b => ({ key: `rule3|${b.id}|${b.version}`, preset: b.preset })),
  ...BUILTIN_SESSION_PRESETS.map(b => ({ key: `session|${b.id}|${b.version}`, preset: b.preset })),
  ...BUILTIN_TABLE_D.map(b => ({ key: `tableD|${b.id}|${b.version}`, preset: b.preset })),
  ...BUILTIN_LCM_TO_SCY.map(b => ({ key: `lcmToScy|${b.id}|${b.version}`, preset: b.preset })),
];

describe('built-in versions', () => {
  it('the shipped set is exactly the pinned set', () => {
    expect(SHIPPED.map(s => s.key).sort()).toStrictEqual(Object.keys(PINNED).sort());
  });

  it('each built-in matches its pinned sha256 (change the content, raise the version)', () => {
    for (const { key, preset } of SHIPPED) {
      expect(sha(preset), key).toBe(PINNED[key]);
    }
  });

  it('each built-in survives JSON unchanged', () => {
    for (const { key, preset } of SHIPPED) {
      expect(JSON.parse(JSON.stringify(preset)), key).toStrictEqual(preset);
    }
  });

  it('rule presets pass parseRulePreset unchanged', () => {
    for (const b of BUILTIN_RULE_PRESETS) {
      expect(parseRulePreset(JSON.parse(JSON.stringify(b.preset))), b.id).toStrictEqual(b.preset);
      expect(parseRulePresetV1(JSON.parse(JSON.stringify(b.frozen))), b.id).toStrictEqual(b.frozen);
    }
  });

  it('a saved reference keeps resolving to the same values: the view is the frozen payload plus scoring.ties and scorers.relayOverCap', () => {
    for (const b of BUILTIN_RULE_PRESETS) {
      const { ties: _ties, ...scoring } = b.preset.scoring;
      const { relayOverCap: _relayOverCap, ...scorers } = b.preset.scorers;
      const { relaySwimmerOncePerEvent: _once, nonScoringRelaysAllowed: _allowed, ...entries } = b.preset.entries;
      expect({ ...b.preset, payloadVersion: 1, scoring, scorers, entries }, `${b.id} v${b.version}`).toStrictEqual(b.frozen);
      expect(b.frozen.payloadVersion).toBe(1);
      expect(b.preset.payloadVersion).toBe(3);
    }
  });

  it('the shipped payload version 2 views and the version 2 parser agree', () => {
    for (const b of BUILTIN_RULE_PRESETS) {
      const view = JSON.parse(JSON.stringify(payloadV2View(b.preset)));
      expect(parseRulePresetV2(view), `${b.id} v${b.version}`).toStrictEqual(view);
    }
  });

  it('scorers.relayOverCap: nsisc v3 is exhibition (README R67), nsisc v1, v2 and generic v1 stay pending', () => {
    const over = (id: string, version: number) => builtinRulePreset(id, version)!.scorers.relayOverCap;
    expect(over('nsisc', 3)).toMatchObject({
      state: 'set',
      value: 'exhibition',
      provenance: { kind: 'user-stated', statedOn: '2026-10-27', where: 'plans/2026-10-25/README.md:91', verbatim: false },
    });
    expect(linesOf('plans/2026-10-25/README.md')[90]).toContain('| R67 |');
    expect(linesOf('plans/2026-10-25/README.md')[90]).toContain('A relay entered beyond the scoring-relay limit is tagged exhibition.');
    for (const [id, version] of [['nsisc', 1], ['nsisc', 2], ['generic', 1]] as const) {
      const s = over(id, version);
      expect(s.state, `${id} v${version}`).toBe('pending');
      expect(s.state === 'pending' && s.question, `${id} v${version}`).toContain('R67');
    }
    expect(() => requireComplete(builtinRulePreset('nsisc', 2)!)).toThrow(/scorers.relayOverCap/);
  });

  it('nsisc v3 is nsisc v2 plus relayOverCap and nothing else, and it resolves complete', () => {
    const v2 = builtinRulePreset('nsisc', 2)!;
    const v3 = builtinRulePreset('nsisc', 3)!;
    const { relayOverCap: _a, ...v2Scorers } = v2.scorers;
    const { relayOverCap: _b, ...v3Scorers } = v3.scorers;
    expect({ ...v3, scorers: v3Scorers }).toStrictEqual({ ...v2, scorers: v2Scorers });
    expect(pendingPaths(v3)).toStrictEqual([]);
    expect(() => requireComplete(v3)).not.toThrow();
    expect(v3.scorers.scoringRelaysPerTeamPerEvent).toMatchObject({ state: 'set', value: 2 });
  });

  it('nsisc v4 is nsisc v3 with the total cap 7 (README R73) and exhibitionCounts citing R75, and nothing else', () => {
    const v3 = builtinRulePreset('nsisc', 3)!;
    const v4 = builtinRulePreset('nsisc', 4)!;
    const { maxTotalPerSwimmer: _a, exhibitionCounts: _b, ...v3Entries } = v3.entries;
    const { maxTotalPerSwimmer: _c, exhibitionCounts: _d, ...v4Entries } = v4.entries;
    expect({ ...v4, entries: v4Entries }).toStrictEqual({ ...v3, entries: v3Entries });
    expect(v3.entries.maxTotalPerSwimmer).toMatchObject({ state: 'set', value: 8 });
    expect(v4.entries.maxTotalPerSwimmer).toMatchObject({
      state: 'set',
      value: 7,
      provenance: { kind: 'user-stated', statedOn: '2026-10-27', where: 'plans/2026-10-25/README.md:97' },
    });
    expect(v4.entries.exhibitionCounts).toMatchObject({
      state: 'set',
      value: true,
      provenance: { kind: 'user-stated', statedOn: '2026-10-27', where: 'plans/2026-10-25/README.md:99' },
    });
    const readme = linesOf('plans/2026-10-25/README.md');
    expect(readme[96]).toMatch(/^\| R73 \|/);
    expect(readme[96]).toContain('capped at 7 total events across individuals and relays');
    expect(readme[96]).toContain('7 total events per swimmer, individuals and relays together.');
    expect(readme[98]).toContain(
      'Entry limits (per-swimmer individual, relay and total) count every entry, whether the swimmer is a scorer, a non-scorer or exhibition.'
    );
    expect(readme[98]).toMatch(/^\| R75 \|/);
    expect(readme[98]).toContain('entry limits are still present regardless of what group you are in');
    expect(pendingPaths(v4)).toStrictEqual([]);
    expect(() => requireComplete(v4)).not.toThrow();
  });

  it('scoring.ties: nsisc v2 splits (R45), nsisc v1 and generic v1 stay pending, nobody gets a default', () => {
    const ties = (id: string, version: number) => builtinRulePreset(id, version)!.scoring.ties;
    expect(ties('nsisc', 2)).toMatchObject({
      state: 'set',
      value: 'split',
      provenance: { kind: 'user-stated', statedOn: '2026-10-26', where: 'plans/2026-10-25/README.md:69', verbatim: false },
    });
    expect(linesOf('plans/2026-10-25/README.md')[68]).toContain('Ties split.');
    expect(ties('nsisc', 1).state).toBe('pending');
    expect(ties('generic', 1).state).toBe('pending');
    expect(() => requireComplete(builtinRulePreset('generic', 1)!)).toThrow(/scoring.ties/);
  });

  it('builtinRulePreset returns undefined for an unknown id or version, never a fallback', () => {
    expect(builtinRulePreset('nsisc', 1)).toBe(BUILTIN_RULE_PRESETS.find(b => b.id === 'nsisc')?.preset);
    expect(builtinRulePreset('nsisc', 2)).toBe(BUILTIN_RULE_PRESETS.find(b => b.id === 'nsisc' && b.version === 2)?.preset);
    expect(builtinRulePreset('nsisc', 3)).toBe(BUILTIN_RULE_PRESETS.find(b => b.id === 'nsisc' && b.version === 3)?.preset);
    expect(builtinRulePreset('nsisc', 4)).toBe(BUILTIN_RULE_PRESETS.find(b => b.id === 'nsisc' && b.version === 4)?.preset);
    expect(builtinRulePreset('nsisc', 5)).toBe(BUILTIN_RULE_PRESETS.find(b => b.id === 'nsisc' && b.version === 5)?.preset);
    expect(builtinRulePreset('generic', 2)).toBe(BUILTIN_RULE_PRESETS.find(b => b.id === 'generic' && b.version === 2)?.preset);
    expect(builtinRulePreset('nsisc', 6)).toBeUndefined();
    expect(builtinRulePreset('generic', 3)).toBeUndefined();
    expect(builtinRulePreset('nsisc', 0)).toBeUndefined();
    expect(builtinRulePreset('ncaa', 1)).toBeUndefined();
    expect(builtinRulePreset('', 1)).toBeUndefined();
    expect(builtinRulePreset('NSISC', 1)).toBeUndefined();
  });

  it('NSISC v2 sets only the three confirmed points tables and preserves v1', () => {
    const v1 = builtinRulePreset('nsisc', 1)!;
    const v2 = builtinRulePreset('nsisc', 2)!;
    const individual = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];
    const relay = [40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2];
    expect(v1.scoring.individualPoints.state).toBe('pending');
    expect(v1.scoring.divingPoints.state).toBe('pending');
    expect(v1.scoring.relayPoints.state).toBe('pending');
    expect(v2.scoring.individualPoints).toMatchObject({ state: 'set', value: individual });
    expect(v2.scoring.divingPoints).toMatchObject({ state: 'set', value: { kind: 'table', points: individual } });
    expect(v2.scoring.relayPoints).toMatchObject({ state: 'set', value: { kind: 'table', points: relay } });
    const withoutPoints = (preset: typeof v1) => {
      // `ties` differs by design: v1 is pending, v2 states R45's "Ties split" (its own test below).
      const { individualPoints: _individual, divingPoints: _diving, relayPoints: _relay, ties: _ties, ...scoring } = preset.scoring;
      return { ...preset, scoring };
    };
    expect(withoutPoints(v2)).toStrictEqual(withoutPoints(v1));
    const source = linesOf('plans/2026-10-25/README.md')[68] as string;
    expect(source.startsWith('| R45 |')).toBe(true);
    for (const s of [v2.scoring.individualPoints, v2.scoring.divingPoints, v2.scoring.relayPoints]) {
      expect(s.state).toBe('set');
      if (s.state !== 'set') throw new Error('expected v2 points to be set');
      expect(s.provenance).toMatchObject({ kind: 'user-stated', statedOn: '2026-10-26', where: 'plans/2026-10-25/README.md:69' });
    }
  });

  it('no built-in carries the legacy provenance kind', () => {
    for (const { key, preset } of SHIPPED) {
      expect(JSON.stringify(preset), key).not.toContain('"legacy"');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Every provenance record points at a line that holds its wording            */
/* -------------------------------------------------------------------------- */

function collectProvenance(value: unknown, out: Provenance[] = []): Provenance[] {
  if (Array.isArray(value)) {
    for (const v of value) collectProvenance(v, out);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.state === 'set' && record.provenance) out.push(record.provenance as Provenance);
    for (const v of Object.values(record)) collectProvenance(v, out);
  }
  return out;
}

/** `path:21`, `path:38,55,56,57`, `path:55-76`, `path:41,45`. Returns 1-based lines. */
function parseWhere(where: string): { file: string; lines: number[] } {
  const colon = where.lastIndexOf(':');
  const file = where.slice(0, colon);
  const lines: number[] = [];
  for (const part of where.slice(colon + 1).split(',')) {
    const range = part.split('-').map(Number);
    const lo = range[0] as number;
    const hi = range.length === 2 ? (range[1] as number) : lo;
    for (let n = lo; n <= hi; n++) lines.push(n);
  }
  return { file, lines };
}

const fileCache = new Map<string, string[]>();
function linesOf(file: string): string[] {
  let lines = fileCache.get(file);
  if (!lines) {
    lines = readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    fileCache.set(file, lines);
  }
  return lines;
}

describe('built-in provenance', () => {
  it('every user-stated wording is a substring of the lines it cites', () => {
    let checked = 0;
    for (const { key, preset } of SHIPPED) {
      for (const p of collectProvenance(preset)) {
        if (p.kind !== 'user-stated') continue;
        const { file, lines } = parseWhere(p.where);
        const all = linesOf(file);
        for (const n of lines) expect(n >= 1 && n <= all.length, `${key}: ${p.where} is out of range`).toBe(true);
        // A quote may span lines of a code comment, so drop the comment marker and fold whitespace.
        const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();
        const cited = fold(lines.map(n => (all[n - 1] as string).replace(/^\s*(\*|\/\/)\s?/, '')).join(' '));
        expect(cited.includes(fold(p.wording)), `${key}: "${p.wording}" is not in ${p.where}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('a verbatim record cites the user plan and a paraphrase never claims to be verbatim there', () => {
    for (const { preset } of SHIPPED) {
      for (const p of collectProvenance(preset)) {
        if (p.kind !== 'user-stated') continue;
        if (p.verbatim) expect(p.where.startsWith('plans/2026-10-25/00-USER-PLAN.md:')).toBe(true);
        if (p.where.startsWith('plans/2026-10-25/README.md:')) expect(p.verbatim).toBe(false);
      }
    }
  });

  it('no built-in is published except the generic championship tables', () => {
    for (const b of BUILTIN_RULE_PRESETS) {
      const published = collectProvenance(b.preset).filter(p => p.kind === 'published');
      expect(published.length > 0, b.id).toBe(b.id === 'generic');
    }
    expect(collectProvenance(BUILTIN_SESSION_PRESETS.map(b => b.preset)).filter(p => p.kind === 'published')).toStrictEqual([]);
    expect(collectProvenance(BUILTIN_TABLE_D.map(b => b.preset)).filter(p => p.kind === 'published')).toStrictEqual([]);
    // The LCM to SCY values are fitted to a converter's outputs (R58): tool-derived, never published.
    const lcm = collectProvenance(BUILTIN_LCM_TO_SCY.map(b => b.preset));
    expect(lcm.length).toBeGreaterThan(30);
    expect(lcm.every(p => p.kind === 'tool-derived')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* generic v1: published tables                                               */
/* -------------------------------------------------------------------------- */

describe('nsisc v5 and generic v2: the relay entry rules', () => {
  const RULEBOOK = 'data/scoring_rules/sources/ncaa-rulebook-2025-27.txt';
  const without = (p: RulePreset, ...keys: ('relaySwimmerOncePerEvent' | 'nonScoringRelaysAllowed')[]): unknown => {
    const entries: Record<string, unknown> = { ...p.entries };
    for (const k of keys) delete entries[k];
    return { ...p, entries };
  };

  it('nsisc v5 is v4 plus entries.nonScoringRelaysAllowed false, citing README R42, and nothing else', () => {
    const v4 = builtinRulePreset('nsisc', 4)!;
    const v5 = builtinRulePreset('nsisc', 5)!;
    expect(without(v5, 'nonScoringRelaysAllowed')).toStrictEqual(v4);
    expect(v5.entries.nonScoringRelaysAllowed).toMatchObject({
      state: 'set',
      value: false,
      provenance: { kind: 'user-stated', statedOn: '2026-10-25', where: 'plans/2026-10-25/README.md:59', verbatim: false },
    });
    const row = linesOf('plans/2026-10-25/README.md')[58] as string;
    expect(row).toMatch(/^\| R42 \|/);
    expect(row).toContain('NSISC has no non-scoring relays: a team enters only relays that score.');
    expect(row).toContain('For NSISC a 3rd relay is an entry violation.');
  });

  it('nsisc v5 leaves relaySwimmerOncePerEvent absent: no archived NSISC source says NCAA relay rules govern NSISC', () => {
    expect(Object.hasOwn(builtinRulePreset('nsisc', 5)!.entries, 'relaySwimmerOncePerEvent')).toBe(false);
  });

  it('generic v2 is generic v1 plus entries.relaySwimmerOncePerEvent true, and nothing else', () => {
    const v1 = builtinRulePreset('generic', 1)!;
    const v2 = builtinRulePreset('generic', 2)!;
    expect(without(v2, 'relaySwimmerOncePerEvent')).toStrictEqual(v1);
    expect(v2.entries.relaySwimmerOncePerEvent).toMatchObject({ state: 'set', value: true });
    // Every other entry rule is still pending, and the new key is not pending.
    expect(pendingPaths(v2)).toStrictEqual(pendingPaths(v1));
  });

  it('generic v2 cites the archived rule book: same sha256 and url as the manifest, and the rule text says what it is read for', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data/scoring_rules/sources/manifest.json'), 'utf8')) as {
      sources: { id: string; sha256: string; url: string; textExtraction: string; coversSections: string[] }[];
    };
    const v2 = builtinRulePreset('generic', 2)!;
    const once = v2.entries.relaySwimmerOncePerEvent as Extract<Setting<boolean>, { state: 'set' }>;
    expect(once.provenance.kind).toBe('published');
    if (once.provenance.kind !== 'published') throw new Error('expected a published source');
    const ref = once.provenance.source;
    const entry = manifest.sources.find(s => s.id === ref.sourceId);
    expect(ref.sourceId).toBe('ncaa-rulebook-2025-27');
    expect(entry).toBeDefined();
    expect(ref.sha256).toBe(entry!.sha256);
    expect(ref.url).toBe(entry!.url);
    expect(ref.manifest).toBe('data/scoring_rules/sources/manifest.json');
    expect(ref.locator).toBe('Rule 5-7-1-g');
    expect(entry!.coversSections).toContain('Rule 5-7-1-g Relay participation in a timed final');
    expect(`data/scoring_rules/sources/${entry!.textExtraction}`).toBe(RULEBOOK);
    // The archived text, whitespace folded: the rule limits a swimmer in a timed final of a relay.
    const lines = linesOf(RULEBOOK);
    const text = lines.join(' ').replace(/\s+/g, ' ');
    expect(text).toContain(
      "In a timed final of a relay, a swimmer is limited to participating in only one of the team's relays (i.e., A relay or B relay, etc.)."
    );
    expect(lines[2885]).toContain('In a timed final of a relay, a');
    expect(lines[2886]).toContain("swimmer is limited to participating in only one of the team's relays");
  });

  it('no other built-in sets either relay entry rule', () => {
    for (const b of BUILTIN_RULE_PRESETS) {
      const has = (k: string) => Object.hasOwn(b.preset.entries, k);
      expect(has('nonScoringRelaysAllowed'), `${b.id} v${b.version}`).toBe(b.id === 'nsisc' && b.version === 5);
      expect(has('relaySwimmerOncePerEvent'), `${b.id} v${b.version}`).toBe(b.id === 'generic' && b.version === 2);
    }
  });
});

describe('generic v1', () => {
  const generic = BUILTIN_RULE_PRESETS.find(b => b.id === 'generic')!.preset;
  const ruleset = NCAA_FORMAT_RULESETS['championship-16'];

  it('cites a source in the scoring manifest with the same sha256 and url', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data/scoring_rules/sources/manifest.json'), 'utf8')) as {
      sources: { id: string; sha256: string; url: string }[];
    };
    const published = collectProvenance(generic).filter((p): p is Extract<Provenance, { kind: 'published' }> => p.kind === 'published');
    expect(published.length).toBe(3);
    for (const p of published) {
      const entry = manifest.sources.find(s => s.id === p.source.sourceId);
      expect(entry, p.source.sourceId).toBeDefined();
      expect(p.source.sha256).toBe(entry!.sha256);
      expect(p.source.url).toBe(entry!.url);
      expect(p.source.manifest).toBe('data/scoring_rules/sources/manifest.json');
      expect(p.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('holds the Rule 7-6-4 tables and the A-final bracket of the ruleset', () => {
    const individual = generic.scoring.individualPoints as Extract<Setting<readonly number[]>, { state: 'set' }>;
    const relay = generic.scoring.relayPoints as Extract<Setting<{ kind: string; points: number[] }>, { state: 'set' }>;
    const bracket = generic.scoring.aFinalBracketSize as Extract<Setting<number>, { state: 'set' }>;
    const placesOf = (slot: unknown): number[] => {
      if (slot === null || typeof slot !== 'object' || !('places' in slot)) throw new Error('expected a point table');
      return [...(slot as { places: readonly number[] }).places];
    };
    expect(individual.value).toStrictEqual(placesOf(ruleset.individual));
    expect(relay.value).toStrictEqual({ kind: 'table', points: placesOf(ruleset.relay) });
    const finals = ruleset.finals;
    if (finals.kind !== 'split') throw new Error('expected a split finals structure');
    expect(bracket.value).toBe(finals.pools[0]!.lastPlace);
  });

  it('leaves everything else pending: Rule 7 states no pool, diver weight or entry limit', () => {
    expect(pendingPaths(generic)).toStrictEqual([
      'entries.exhibitionCounts',
      'entries.maxIndividualPerSwimmer',
      'entries.maxRelayPerSwimmer',
      'entries.maxTotalPerSwimmer',
      'entries.relayLegsAllowTimeTrials',
      'entries.timeTrialsCount',
      'scorers.autoRules',
      'scorers.diverWeight',
      'scorers.divingPerEventScorerCap',
      'scorers.eligibility',
      'scorers.perEventScorerCap',
      'scorers.relayEligibleFromScorerPool',
      'scorers.relayLegsMustBeScorers',
      'scorers.relayOverCap',
      'scorers.scoringRelaysPerTeamPerEvent',
      'scorers.scoringTeamScope',
      'scorers.scoringTeamSize',
      'scoring.abFinalsScorersOnly',
      'scoring.cFinal',
      'scoring.divingPoints',
      'scoring.halfRateRelaySwimmer',
      'scoring.nonScorerPlacement',
      'scoring.ties',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* nsisc v1: what stays pending                                               */
/* -------------------------------------------------------------------------- */

describe('nsisc v1', () => {
  const nsisc = BUILTIN_RULE_PRESETS.find(b => b.id === 'nsisc')!.preset;

  it('leaves the three points settings pending: no source is archived for them', () => {
    expect(pendingPaths(nsisc)).toStrictEqual([
      'scorers.relayOverCap',
      'scoring.divingPoints',
      'scoring.individualPoints',
      'scoring.relayPoints',
      'scoring.ties',
    ]);
    for (const s of [nsisc.scoring.individualPoints, nsisc.scoring.relayPoints, nsisc.scoring.divingPoints]) {
      expect(s.state).toBe('pending');
      expect('value' in s).toBe(false);
    }
  });

  it('stores relayEligibleFromScorerPool as not applicable (pending) under roster', () => {
    expect(nsisc.scorers.eligibility).toMatchObject({ state: 'set', value: 'roster' });
    expect(nsisc.scorers.relayEligibleFromScorerPool.state).toBe('pending');
  });

  it('never writes unlimited for a limit nobody stated', () => {
    // Each unlimited is a stated one: the two per-event caps (R15, R27) and the two per-type entry
    // caps (U:24). Anything else would be a missing limit read as no limit.
    const unlimited: string[] = [];
    const walk = (value: unknown, at: string) => {
      if (value === 'unlimited') unlimited.push(at);
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`));
      else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) if (k !== 'provenance') walk(v, at === '' ? k : `${at}.${k}`);
      }
    };
    walk(nsisc, '');
    expect(unlimited.sort()).toStrictEqual([
      'entries.maxIndividualPerSwimmer.value',
      'entries.maxRelayPerSwimmer.value',
      'scorers.perEventScorerCap.value.cap',
    ]);
  });

  it('cites the 2026-10-12 answer to D9 and the 2026-10-01 ruling through "exhibition"', () => {
    const where = (s: Setting<boolean>): { statedOn: string; where: string; wording: string } => {
      if (s.state !== 'set' || s.provenance.kind !== 'user-stated') throw new Error('expected a user-stated setting');
      return { statedOn: s.provenance.statedOn, where: s.provenance.where, wording: s.provenance.wording };
    };
    expect(where(nsisc.entries.relayLegsAllowTimeTrials)).toStrictEqual({
      statedOn: '2026-10-12',
      where: 'docs/reference/IMPROVEMENT_PLAN_2026-10-10_STATE.json:154',
      wording: 'Time trials do not fill relay legs by default',
    });
    expect(where(nsisc.entries.exhibitionCounts)).toStrictEqual({
      statedOn: '2026-10-01',
      where: 'packages/engine/src/lib/scoringDefaults.ts:85-86',
      wording: "These are the user's rulings (2026-09-21 for time trials, 2026-10-01 for exhibition)",
    });
  });

  it('holds the user-stated values of the D2 section 4 table', () => {
    const value = (s: Setting<unknown>) => (s as Extract<Setting<unknown>, { state: 'set' }>).value;
    expect(value(nsisc.scoring.halfRateRelaySwimmer)).toBe(true);
    expect(value(nsisc.scoring.aFinalBracketSize)).toBe(8);
    expect(value(nsisc.scoring.nonScorerPlacement)).toBe('removed-from-consideration');
    expect(value(nsisc.scoring.abFinalsScorersOnly)).toBe(true);
    expect(value(nsisc.scoring.cFinal)).toStrictEqual({ kind: 'non-scorers', size: 8 });
    expect(value(nsisc.scorers.scoringTeamSize)).toBe(18);
    expect(value(nsisc.scorers.scoringTeamScope)).toBe('meet');
    expect(value(nsisc.scorers.diverWeight)).toStrictEqual({ numerator: 1, denominator: 3 });
    expect(value(nsisc.scorers.scoringRelaysPerTeamPerEvent)).toBe(2);
    expect(value(nsisc.scorers.relayLegsMustBeScorers)).toBe(true);
    expect(value(nsisc.entries.maxTotalPerSwimmer)).toBe(8);
    expect(value(nsisc.entries.timeTrialsCount)).toBe(false);
    expect(value(nsisc.entries.exhibitionCounts)).toBe(true);
    expect(value(nsisc.entries.relayLegsAllowTimeTrials)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* nsisc-table-c v1 against the user plan                                     */
/* -------------------------------------------------------------------------- */

describe('nsisc-table-c v1', () => {
  const table = BUILTIN_SESSION_PRESETS.find(b => b.id === 'nsisc-table-c')!.preset;
  const plan = linesOf('plans/2026-10-25/00-USER-PLAN.md');

  const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

  /** The cells of a plan table row: Day, Time, Event. */
  function planRow(lineNo: number): { day: number; slot: string; events: string } {
    const cells = (plan[lineNo - 1] as string).split('|').map(c => c.trim());
    return { day: Number(cells[1]), slot: cells[2] as string, events: clean(cells[3] as string) };
  }

  const DIVE = /^(One|Three) Meter Dive [(](Men|Women)[)]/;

  function sessionOf(e: ScheduledEvent): { prelimsSlot: string; finalsSlot: string; day: number } {
    const f = e.format;
    if (f.kind === 'timed-final') return { day: f.session.day, prelimsSlot: 'none', finalsSlot: f.session.slot };
    if (f.kind === 'prelims-finals') return { day: f.finals.day, prelimsSlot: f.prelims.slot, finalsSlot: f.finals.slot };
    return { day: f.fastHeat.day, prelimsSlot: f.slowHeats.slot, finalsSlot: f.fastHeat.slot };
  }

  it('cites lines 55 to 76 and the plan still reads "Table C" there', () => {
    expect(table.provenance).toMatchObject({ kind: 'user-stated', verbatim: true, where: 'plans/2026-10-25/00-USER-PLAN.md:55-76' });
    expect(plan[54]).toContain('Table C: NSISC Event Order');
    expect(plan[75]).toContain('One Meter Dive (Women) (Finals)');
  });

  it('every event key is the key normalizeEventForCutline gives', () => {
    for (const e of table.events) {
      const normalized = normalizeEventForCutline(e.eventKey);
      expect(normalized, e.eventKey).toBe(e.eventKey);
    }
  });

  it('matches each row of the plan: events, order, sessions and dive genders', () => {
    // Day 1 evening: a single relay final.
    expect(planRow(60)).toMatchObject({ day: 1, slot: 'Evening', events: '800 Freestyle Relay (Finals)' });
    const day1 = table.events.filter(e => sessionOf(e).day === 1);
    expect(day1.map(e => e.eventKey)).toStrictEqual(['800 Freestyle Relay']);
    expect(day1[0]!.format).toMatchObject({ kind: 'timed-final', session: { day: 1, slot: 'evening' } });

    // Days 2 to 5: morning prelims row, afternoon dive row, evening finals row.
    for (const firstLine of [62, 66, 70, 74]) {
      const morning = planRow(firstLine);
      const afternoon = planRow(firstLine + 1);
      const evening = planRow(firstLine + 2);
      const day = morning.day;
      expect([morning.slot, afternoon.slot, evening.slot]).toStrictEqual(['Morning', 'Afternoon', 'Evening']);
      expect(afternoon.day).toBe(day);
      expect(evening.day).toBe(day);

      const mine = table.events.filter(e => sessionOf(e).day === day);

      // Morning: the swims with a morning session, in plan order.
      const morningNames = morning.events.replace(' (Prelims)', '').split(', ').map(n => normalizeEventForCutline(n));
      expect(
        mine.filter(e => sessionOf(e).prelimsSlot === 'morning').map(e => e.eventKey),
        `day ${day} morning`
      ).toStrictEqual(morningNames);

      // Afternoon: one dive.
      const dive = DIVE.exec(afternoon.events)!;
      const diveKey = `${dive[1] === 'One' ? 1 : 3}-Meter Diving`;
      const myDives = mine.filter(e => sessionOf(e).prelimsSlot === 'afternoon');
      expect(myDives.map(e => [e.eventKey, e.gender]), `day ${day} dive`).toStrictEqual([[diveKey, dive[2]]]);

      // Evening: finals in plan order, then the relay, then the dive.
      const eveningNames = evening.events
        .replace(' (Finals)', '')
        .split(', ')
        .map(n => (DIVE.test(n) ? `DIVE:${n}` : n));
      const expectedEvening = eveningNames.map(n => {
        const d = DIVE.exec(n.replace('DIVE:', ''));
        return d ? diveKey : normalizeEventForCutline(n);
      });
      expect(
        mine.filter(e => sessionOf(e).finalsSlot === 'evening').map(e => e.eventKey),
        `day ${day} evening`
      ).toStrictEqual(expectedEvening);
    }
  });

  it('has one row per scheduled event: 23 events, each key and gender once per day', () => {
    expect(table.events.length).toBe(23);
    const seen = new Set<string>();
    for (const e of table.events) {
      const id = `${sessionOf(e).day}|${e.eventKey}|${e.gender}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
  });

  it('relays are evening timed finals and swims are "both" genders', () => {
    for (const e of table.events) {
      if (e.eventKey.includes('Relay')) expect(e.format).toMatchObject({ kind: 'timed-final' });
      if (!e.eventKey.includes('Diving')) expect(e.gender).toBe('both');
      else expect(['Men', 'Women']).toContain(e.gender);
    }
  });

  it('the 1000 and the 1650 are split timed finals with a fast heat of 8 and no small-field default', () => {
    const splits = table.events.filter(e => e.format.kind === 'timed-final-split');
    expect(splits.map(e => e.eventKey)).toStrictEqual(['1000 Freestyle', '1650 Freestyle']);
    for (const e of splits) {
      const f = e.format as Extract<ScheduledEvent['format'], { kind: 'timed-final-split' }>;
      expect(f.fastHeatSize).toMatchObject({ state: 'set', value: 8 });
      expect(f.smallFieldSession.state).toBe('pending');
      expect(f.slowHeats.slot).toBe('morning');
      expect(f.fastHeat.slot).toBe('evening');
    }
    expect(table.events.filter(e => e.format.kind === 'timed-final-split').length).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* table-d-user v1 against the user plan                                      */
/* -------------------------------------------------------------------------- */

describe('table-d-user v1', () => {
  const tableD = BUILTIN_TABLE_D.find(b => b.id === 'table-d-user')!.preset;
  const plan = linesOf('plans/2026-10-25/00-USER-PLAN.md');
  const ROW = /^[|] (.+?) [|] (0[.]892) [|] (\d+)[.](\d\d)s [|]/;

  const setValue = <T>(s: Setting<T>): T => (s as Extract<Setting<T>, { state: 'set' }>).value;

  it('has 19 set rows from lines 82-84 and 88-103, each line once, and 3 pending rows', () => {
    const setRows = tableD.rows.filter(r => r.multiplierPermille.state === 'set');
    const pendingRows = tableD.rows.filter(r => r.multiplierPermille.state === 'pending');
    expect(setRows.length).toBe(19);
    expect(pendingRows.length).toBe(3);

    const lines = setRows.map(r => {
      const p = (r.multiplierPermille as Extract<Setting<number>, { state: 'set' }>).provenance;
      if (p.kind !== 'user-stated') throw new Error('expected user-stated');
      return Number(p.where.split(':')[1]);
    });
    const expected = [82, 83, 84, ...Array.from({ length: 16 }, (_, i) => 88 + i)];
    expect([...lines].sort((a, b) => a - b)).toStrictEqual(expected);
  });

  it('each set row equals the plan line it cites: name, 0.892 and the turn adjustment in hundredths', () => {
    for (const r of tableD.rows) {
      if (r.multiplierPermille.state !== 'set') continue;
      const mp = r.multiplierPermille.provenance;
      if (mp.kind !== 'user-stated') throw new Error('expected user-stated');
      const lineNo = Number(mp.where.split(':')[1]);
      const m = ROW.exec(plan[lineNo - 1] as string);
      expect(m, `line ${lineNo}`).not.toBeNull();
      const [, name, , whole, frac] = m as unknown as [string, string, string, string, string];
      expect(setValue(r.multiplierPermille)).toBe(892);
      expect(setValue(r.turnAdjustmentHundredths)).toBe(Number(whole) * 100 + Number(frac));
      // The plan names the event in short form; both keys are the long form of it.
      const long = normalizeEventForCutline(name.replace(/ IM$/, ' Individual Medley'));
      expect(r.lcmEventKey, `line ${lineNo}`).toBe(long);
      expect(r.scyEventKey, `line ${lineNo}`).toBe(long);
      expect(r.turnAdjustmentHundredths.state === 'set' && r.turnAdjustmentHundredths.provenance).toStrictEqual(mp);
    }
  });

  it('lines 85 to 87 are the cross-distance rows and both of their settings are pending (R29)', () => {
    expect(plan[84]).toContain('400 / 500 Freestyle');
    expect(plan[85]).toContain('800 / 1000 Freestyle');
    expect(plan[86]).toContain('1500 / 1650 Freestyle');
    const pendingRows = tableD.rows.filter(r => r.multiplierPermille.state === 'pending');
    expect(pendingRows.map(r => [r.lcmEventKey, r.scyEventKey])).toStrictEqual([
      ['400 Freestyle', '500 Freestyle'],
      ['800 Freestyle', '1000 Freestyle'],
      ['1500 Freestyle', '1650 Freestyle'],
    ]);
    for (const r of pendingRows) {
      expect(r.multiplierPermille.state).toBe('pending');
      expect(r.turnAdjustmentHundredths.state).toBe('pending');
    }
  });

  it('the pending reason quotes R29 as README.md line 46 prints it', () => {
    const readme = linesOf('plans/2026-10-25/README.md');
    const quote = 'Do not use the 0.892 rows for 400→500, 800→1000 and 1500→1650. Use SwimCloud';
    expect(readme[45]).toContain('| R29 |');
    expect(readme[45]).toContain(quote);
    for (const r of tableD.rows.filter(row => row.multiplierPermille.state === 'pending')) {
      for (const s of [r.multiplierPermille, r.turnAdjustmentHundredths]) {
        expect(s.state === 'pending' && s.question).toContain(quote);
        expect(s.state === 'pending' && s.question).toContain('SwimSwam archive');
      }
    }
  });

  it('uses truncate rounding (R23) and no row repeats an event pair', () => {
    expect(tableD.rounding).toMatchObject({ state: 'set', value: 'truncate' });
    const pairs = tableD.rows.map(r => `${r.lcmEventKey}>${r.scyEventKey}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
