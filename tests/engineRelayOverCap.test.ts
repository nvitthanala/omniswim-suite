/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `scorers.relayOverCap` and RulePreset payload version 3 (README R67, plans/2026-10-25/D2-ENGINE-API.md 3.4 and 9):
 * the setting, the version 1 and version 2 migrations, and the pending rule. `engineScoreMeet.test.ts` covers
 * how `scoreMeet` treats an over-limit relay, and `engineBuiltinVersions.test.ts` covers the built-in values.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RULE_PRESETS,
  editSetting,
  migrateRulePresetV2,
  parseRulePreset,
  parseRulePresetV1,
  parseRulePresetV2,
  pendingPaths,
  requireComplete,
  RulePresetError,
} from '@omniswim/engine';
import type { RulePreset } from '@omniswim/engine';
import { builtinPreset, nsiscWithTestPoints, set } from './engineTestPresets';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RulePresetError) return `${e.code}@${e.path}`;
    throw e;
  }
  return 'no-throw';
}

type Json = Record<string, unknown> & { scoring: Record<string, unknown>; scorers: Record<string, unknown> };

/** nsisc v3 as the JSON a version 2 payload had: no `scorers.relayOverCap`. */
function v2Json(): Json {
  const v3 = BUILTIN_RULE_PRESETS.find((b) => b.id === 'nsisc' && b.version === 3);
  if (!v3) throw new Error('nsisc v3 missing');
  const { relayOverCap: _relayOverCap, ...scorers } = v3.preset.scorers;
  return clone({ ...v3.preset, payloadVersion: 2, scorers }) as unknown as Json;
}

/** The nsisc v1 test preset as the JSON a version 1 payload had: no `ties`, no `relayOverCap`. */
function v1Json(): Json {
  const { ties: _ties, ...scoring } = builtinPreset('nsisc').scoring;
  const { relayOverCap: _relayOverCap, ...scorers } = builtinPreset('nsisc').scorers;
  return clone({ ...builtinPreset('nsisc'), payloadVersion: 1, scoring, scorers }) as unknown as Json;
}

describe('scorers.relayOverCap in a version 3 payload', () => {
  it('round-trips holds-place and exhibition through JSON and parseRulePreset', () => {
    for (const value of ['holds-place', 'exhibition'] as const) {
      const base = nsiscWithTestPoints();
      const p: RulePreset = { ...base, scorers: { ...base.scorers, relayOverCap: set(value) } };
      expect(p.payloadVersion).toBe(3);
      expect(parseRulePreset(clone(p))).toStrictEqual(p);
    }
  });

  it('every shipped built-in survives parseRulePreset', () => {
    for (const b of BUILTIN_RULE_PRESETS) expect(parseRulePreset(clone(b.preset)), `${b.id} v${b.version}`).toStrictEqual(b.preset);
  });

  it('refuses a missing relayOverCap key, a value outside the two, and a null', () => {
    const missing = clone(nsiscWithTestPoints()) as unknown as Json;
    delete missing.scorers.relayOverCap;
    expect(code(() => parseRulePreset(missing))).toBe('missing@scorers.relayOverCap');
    const bad = clone(nsiscWithTestPoints()) as unknown as Json;
    bad.scorers.relayOverCap = set('removed-from-consideration');
    expect(code(() => parseRulePreset(bad))).toBe('invalid@scorers.relayOverCap.value');
    const nul = clone(nsiscWithTestPoints()) as unknown as Json;
    nul.scorers.relayOverCap = null;
    expect(() => parseRulePreset(nul)).toThrow(RulePresetError);
  });

  it('a pending relayOverCap blocks requireComplete, by path', () => {
    const base = nsiscWithTestPoints();
    const p: RulePreset = { ...base, scorers: { ...base.scorers, relayOverCap: { state: 'pending', question: 'q', blocks: [] } } };
    expect(pendingPaths(p)).toStrictEqual(['scorers.relayOverCap']);
    expect(() => requireComplete(p)).toThrow(/scorers\.relayOverCap/);
  });

  it('a user edit of relayOverCap keeps the old provenance as previous', () => {
    const v3 = BUILTIN_RULE_PRESETS.find((b) => b.id === 'nsisc' && b.version === 3)!.preset;
    const edited = editSetting(v3.scorers.relayOverCap, 'holds-place', '2026-10-27T12:00:00Z');
    expect(edited).toMatchObject({ state: 'set', value: 'holds-place', provenance: { kind: 'user-edited', previous: { kind: 'user-stated' } } });
  });
});

describe('payload version 2 migrates to version 3', () => {
  it('parseRulePresetV2 reads version 2, and refuses version 1, version 3, and a relayOverCap key', () => {
    const p = parseRulePresetV2(v2Json());
    expect(p.payloadVersion).toBe(2);
    expect('relayOverCap' in p.scorers).toBe(false);
    expect(code(() => parseRulePresetV2(v1Json()))).toBe('invalid@payloadVersion');
    expect(code(() => parseRulePresetV2(clone(nsiscWithTestPoints())))).toBe('invalid@payloadVersion');
    const withKey = { ...v2Json(), scorers: { ...v2Json().scorers, relayOverCap: set('exhibition') } };
    expect(code(() => parseRulePresetV2(withKey))).toBe('invalid@scorers.relayOverCap');
  });

  it('parseRulePresetV1 still refuses a version 2 payload', () => {
    expect(code(() => parseRulePresetV1(v2Json()))).toBe('invalid@payloadVersion');
  });

  it('parseRulePreset migrates a version 2 payload: every setting kept, relayOverCap pending, nothing assumed', () => {
    const migrated = parseRulePreset(v2Json());
    expect(migrated.payloadVersion).toBe(3);
    expect(migrated.scorers.relayOverCap.state).toBe('pending');
    expect(pendingPaths(migrated)).toStrictEqual(['scorers.relayOverCap']);
    // The tie rule the version 2 payload stated is kept.
    expect(migrated.scoring.ties).toMatchObject({ state: 'set', value: 'split' });
    const { relayOverCap: _r, ...scorers } = migrated.scorers;
    expect({ ...migrated, payloadVersion: 2, scorers }).toStrictEqual(parseRulePresetV2(v2Json()));
    expect(() => requireComplete(migrated)).toThrow(/scorers\.relayOverCap/);
  });

  it('parseRulePreset migrates a version 1 payload through both steps: ties and relayOverCap both pending', () => {
    const migrated = parseRulePreset(v1Json());
    expect(migrated.payloadVersion).toBe(3);
    expect(migrated.scoring.ties.state).toBe('pending');
    expect(migrated.scorers.relayOverCap.state).toBe('pending');
    expect(pendingPaths(migrated)).toEqual(expect.arrayContaining(['scoring.ties', 'scorers.relayOverCap']));
  });

  it("the pending question names README R67 and offers both values", () => {
    const migrated = parseRulePreset(v2Json());
    const s = migrated.scorers.relayOverCap;
    if (s.state !== 'pending') throw new Error('expected pending');
    expect(s.question).toContain('R67');
    expect(s.question).toContain('holds-place');
    expect(s.question).toContain('exhibition');
    expect(s.blocks).toEqual(['requireComplete', 'scoreMeet']);
  });

  it("migrateRulePresetV2 takes the caller's stated rule, and pends when there is none", () => {
    const old = parseRulePresetV2(v2Json());
    expect(migrateRulePresetV2(old, set('exhibition')).scorers.relayOverCap).toMatchObject({ state: 'set', value: 'exhibition' });
    expect(migrateRulePresetV2(old).scorers.relayOverCap.state).toBe('pending');
  });

  it('requireComplete and pendingPaths refuse an object that still says version 2', () => {
    const stale = v2Json() as unknown as RulePreset;
    expect(code(() => requireComplete(stale))).toBe('unsupported_version@payloadVersion');
    expect(code(() => pendingPaths(stale))).toBe('unsupported_version@payloadVersion');
  });
});
