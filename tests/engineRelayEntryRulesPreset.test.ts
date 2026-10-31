/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The payload of the two optional relay entry rules (`entries.relaySwimmerOncePerEvent`, `entries.nonScoringRelaysAllowed`,
 * README R72 and R42, plans/2026-10-25/D2-ENGINE-API.md section 9 item 23). They live on payload version 3 only. An
 * absent key means not checked. Only nsisc v5 and generic v2 set one (see the last block).
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RULE_PRESETS,
  builtinRulePreset,
  migrateRulePresetV2,
  parseRulePreset,
  parseRulePresetV1,
  parseRulePresetV2,
  pendingPaths,
  requireComplete,
  RulePresetError,
} from '@omniswim/engine';
import type { RulePreset } from '@omniswim/engine';
import { nsiscWithTestPoints, set } from './engineTestPresets';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const KEYS = ['relaySwimmerOncePerEvent', 'nonScoringRelaysAllowed'] as const;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RulePresetError) return `${e.code}@${e.path}`;
    throw e;
  }
  return 'no-throw';
}

type Json = Record<string, unknown> & { entries: Record<string, unknown>; scorers: Record<string, unknown> };
const withRules = (): RulePreset => {
  const base = nsiscWithTestPoints();
  return { ...base, entries: { ...base.entries, relaySwimmerOncePerEvent: set(true), nonScoringRelaysAllowed: set(false) } };
};

describe('the optional relay entry rules in a version 3 payload', () => {
  it('round-trips through JSON and parseRulePreset, with both keys, one key, or neither', () => {
    const both = withRules();
    expect(parseRulePreset(clone(both))).toStrictEqual(both);
    const base = nsiscWithTestPoints();
    const one: RulePreset = { ...base, entries: { ...base.entries, nonScoringRelaysAllowed: set(false) } };
    const parsedOne = parseRulePreset(clone(one));
    expect(parsedOne).toStrictEqual(one);
    expect(Object.hasOwn(parsedOne.entries, 'relaySwimmerOncePerEvent')).toBe(false);
    const parsedNone = parseRulePreset(clone(base));
    for (const key of KEYS) expect(Object.hasOwn(parsedNone.entries, key), key).toBe(false);
  });

  it('an absent rule stays absent: no key, never undefined, and the JSON round-trip is exact', () => {
    const parsed = parseRulePreset(clone(nsiscWithTestPoints()));
    expect(Object.keys(parsed.entries).sort()).toStrictEqual(Object.keys(nsiscWithTestPoints().entries).sort());
    expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(parsed);
  });

  it('refuses a value that is not true or false, and a null', () => {
    for (const key of KEYS) {
      const bad = clone(withRules()) as unknown as Json;
      bad.entries[key] = set('yes');
      expect(code(() => parseRulePreset(bad)), key).toBe(`invalid@entries.${key}.value`);
      const nul = clone(withRules()) as unknown as Json;
      nul.entries[key] = null;
      expect(() => parseRulePreset(nul), key).toThrow(RulePresetError);
    }
  });

  it('a key it does not know is still refused', () => {
    const bad = clone(withRules()) as unknown as Json;
    bad.entries.somethingElse = set(true);
    expect(code(() => parseRulePreset(bad))).toBe('invalid@entries.somethingElse');
  });

  it('a pending value blocks requireComplete, by path', () => {
    const base = nsiscWithTestPoints();
    const p: RulePreset = { ...base, entries: { ...base.entries, nonScoringRelaysAllowed: { state: 'pending', question: 'q', blocks: [] } } };
    expect(pendingPaths(p)).toStrictEqual(['entries.nonScoringRelaysAllowed']);
    expect(() => requireComplete(p)).toThrow(/entries\.nonScoringRelaysAllowed/);
    expect(pendingPaths(nsiscWithTestPoints())).toStrictEqual([]);
  });

  it('payload version 1 and 2 readers refuse the keys, and the migrations add none', () => {
    const v3 = clone(withRules()) as unknown as Json;
    const v2 = { ...v3, payloadVersion: 2 } as Json;
    expect(code(() => parseRulePresetV2(v2))).toMatch(/^invalid@/);
    const v1 = { ...v3, payloadVersion: 1 } as Json;
    expect(code(() => parseRulePresetV1(v1))).toMatch(/^invalid@/);
    // Strip what version 2 does not have, and the entry rules still stay out of the way.
    const { relayOverCap: _relayOverCap, ...scorers } = v3.scorers;
    const { relaySwimmerOncePerEvent: _a, nonScoringRelaysAllowed: _b, ...entries } = v3.entries;
    const clean = parseRulePresetV2({ ...v3, payloadVersion: 2, scorers, entries });
    const migrated = migrateRulePresetV2(clean);
    for (const key of KEYS) expect(Object.hasOwn(migrated.entries, key), key).toBe(false);
  });
});

describe('the built-ins that set a relay entry rule', () => {
  // README R42 is stated for NSISC (nsisc v5) and NCAA Rule 5-7-1-g is archived (generic v2). A built-in is pinned by
  // hash, so each rule sits in a new version, and every older version leaves both keys absent. The values and their
  // sources are checked in engineBuiltinVersions.test.ts.
  it('only nsisc v5 sets nonScoringRelaysAllowed and only generic v2 sets relaySwimmerOncePerEvent', () => {
    for (const b of BUILTIN_RULE_PRESETS) {
      const label = `${b.id} v${b.version}`;
      expect(Object.hasOwn(b.preset.entries, 'nonScoringRelaysAllowed'), label).toBe(b.id === 'nsisc' && b.version === 5);
      expect(Object.hasOwn(b.preset.entries, 'relaySwimmerOncePerEvent'), label).toBe(b.id === 'generic' && b.version === 2);
    }
    expect(builtinRulePreset('nsisc', 5)!.entries.nonScoringRelaysAllowed).toMatchObject({ state: 'set', value: false });
    expect(builtinRulePreset('generic', 2)!.entries.relaySwimmerOncePerEvent).toMatchObject({ state: 'set', value: true });
  });

  it('every shipped built-in survives parseRulePreset and JSON, with or without a relay entry rule', () => {
    for (const b of BUILTIN_RULE_PRESETS) expect(parseRulePreset(clone(b.preset)), `${b.id} v${b.version}`).toStrictEqual(b.preset);
  });
});
