/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `scoring.ties` (RulePreset payload version 2, plans/2026-10-25/D2-ENGINE-API.md, 3.4 and 8.12):
 * the setting, the version 1 migration, the bridge guard, and the `engine-neutral` provenance kind.
 * The presets here are payload version 3: `engineRelayOverCap.test.ts` covers what version 3 adds.
 * `engineScoreMeet.test.ts` covers how `scoreMeet` places a tie under each rule.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RULE_PRESETS,
  editSetting,
  migrateRulePresetV1,
  parseProvenance,
  parseRulePreset,
  parseRulePresetV1,
  pendingPaths,
  requireComplete,
  RulePresetError,
} from '@omniswim/engine';
import type { RulePreset } from '@omniswim/engine';
import { toLegacyScoringSettings } from '@omniswim/engine/rules/legacyBridge';
import { builtinPreset, completeNsisc, nsiscWithTestPoints, set } from './engineTestPresets';

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

const v2 = (): RulePreset => nsiscWithTestPoints();

describe('scoring.ties in a version 2 payload', () => {
  it('round-trips split and ordered through JSON and parseRulePreset', () => {
    for (const ties of ['split', 'ordered'] as const) {
      const p: RulePreset = { ...v2(), scoring: { ...v2().scoring, ties: set(ties) } };
      expect(parseRulePreset(clone(p))).toStrictEqual(p);
    }
  });

  it('refuses a missing ties key, a value outside split and ordered, and a payload marked version 4', () => {
    const missing = clone(v2()) as unknown as { scoring: Record<string, unknown> };
    delete missing.scoring.ties;
    expect(code(() => parseRulePreset(missing))).toBe('missing@scoring.ties');
    const bad = clone(v2());
    (bad.scoring as { ties: unknown }).ties = set('both');
    expect(code(() => parseRulePreset(bad))).toBe('invalid@scoring.ties.value');
    const v4 = { ...clone(v2()), payloadVersion: 4 };
    expect(code(() => parseRulePreset(v4))).toBe('invalid@payloadVersion');
  });

  it('a pending ties setting blocks requireComplete, by path', () => {
    const p: RulePreset = { ...v2(), scoring: { ...v2().scoring, ties: { state: 'pending', question: 'q', blocks: [] } } };
    expect(pendingPaths(p)).toContain('scoring.ties');
    expect(() => requireComplete(p)).toThrow(/scoring\.ties/);
  });

  it('a user edit of ties keeps the old provenance as previous', () => {
    const edited = editSetting(v2().scoring.ties, 'ordered', '2026-10-26T12:00:00Z');
    expect(edited).toMatchObject({ state: 'set', value: 'ordered', provenance: { kind: 'user-edited', previous: { kind: 'user-stated' } } });
  });
});

describe('payload version 1', () => {
  const frozen = () => {
    const b = BUILTIN_RULE_PRESETS.find((x) => x.id === 'nsisc' && x.version === 1);
    if (!b) throw new Error('nsisc v1 missing');
    return parseRulePresetV1(clone(b.frozen));
  };
  const v1Json = () => {
    const { ties: _ties, ...scoring } = builtinPreset('nsisc').scoring;
    const { relayOverCap: _relayOverCap, ...scorers } = builtinPreset('nsisc').scorers;
    return clone({ ...builtinPreset('nsisc'), payloadVersion: 1, scoring, scorers });
  };

  it('parseRulePresetV1 reads version 1 and refuses a version 2 payload, and a ties key', () => {
    const p = parseRulePresetV1(v1Json());
    expect(p.payloadVersion).toBe(1);
    expect('ties' in p.scoring).toBe(false);
    expect(code(() => parseRulePresetV1(clone(v2())))).toBe('invalid@payloadVersion');
    const withTies = { ...v1Json(), scoring: { ...v1Json().scoring, ties: set('split') } };
    expect(code(() => parseRulePresetV1(withTies))).toBe('invalid@scoring.ties');
  });

  it('parseRulePreset migrates a version 1 payload: every setting kept, ties and relayOverCap pending, nothing assumed', () => {
    const migrated = parseRulePreset(v1Json());
    expect(migrated.payloadVersion).toBe(3);
    expect(migrated.scoring.ties.state).toBe('pending');
    expect(migrated.scorers.relayOverCap.state).toBe('pending');
    const { ties: _t, ...scoring } = migrated.scoring;
    const { relayOverCap: _r, ...scorers } = migrated.scorers;
    expect({ ...migrated, payloadVersion: 1, scoring, scorers }).toStrictEqual(parseRulePresetV1(v1Json()));
    expect(() => requireComplete(migrated)).toThrow(/scoring\.ties/);
  });

  it('migrateRulePresetV1 takes the caller\'s stated tie rule, and pends when there is none', () => {
    const stated = migrateRulePresetV1(frozen(), set('split'));
    expect(stated.scoring.ties).toMatchObject({ state: 'set', value: 'split' });
    expect(migrateRulePresetV1(frozen()).scoring.ties.state).toBe('pending');
  });

  it('requireComplete and pendingPaths refuse an object that still says version 1', () => {
    const stale = v1Json() as unknown as RulePreset;
    expect(code(() => requireComplete(stale))).toBe('unsupported_version@payloadVersion');
    expect(code(() => pendingPaths(stale))).toBe('unsupported_version@payloadVersion');
    const stale2 = { ...v1Json(), payloadVersion: 2 } as unknown as RulePreset;
    expect(code(() => requireComplete(stale2))).toBe('unsupported_version@payloadVersion');
    expect(code(() => pendingPaths(stale2))).toBe('unsupported_version@payloadVersion');
  });
});

describe('the legacy bridge and ties', () => {
  const withTies = (ties: 'split' | 'ordered') => requireComplete({ ...nsiscWithTestPoints(), scoring: { ...nsiscWithTestPoints().scoring, ties: set(ties) } });

  it("'split' is the legacy behavior and bridges with no flag", () => {
    expect(() => toLegacyScoringSettings(withTies('split'))).not.toThrow();
    expect(() => toLegacyScoringSettings(completeNsisc())).not.toThrow();
  });

  it("'ordered' is refused unless the caller says it hands the scorer distinct ranks", () => {
    expect(code(() => toLegacyScoringSettings(withTies('ordered')))).toBe('invalid@scoring.ties');
    expect(() => toLegacyScoringSettings(withTies('ordered'), { ranksAreDistinct: true })).not.toThrow();
  });

  it("the bridged settings are the same for 'split' and 'ordered': the rule lives in the ranks", () => {
    expect(toLegacyScoringSettings(withTies('ordered'), { ranksAreDistinct: true })).toStrictEqual(toLegacyScoringSettings(withTies('split')));
  });
});

describe("the 'engine-neutral' provenance kind", () => {
  it('parses, and a reason is required', () => {
    expect(parseProvenance({ kind: 'engine-neutral', reason: 'never read here' }, 'p')).toStrictEqual({ kind: 'engine-neutral', reason: 'never read here' });
    expect(() => parseProvenance({ kind: 'engine-neutral', reason: '' }, 'p')).toThrow();
    expect(() => parseProvenance({ kind: 'engine-neutral' }, 'p')).toThrow();
    expect(() => parseProvenance({ kind: 'engine-neutral', reason: 'x', source: 'y' }, 'p')).toThrow();
  });

  it('is not a way to say published or legacy', () => {
    expect(() => parseProvenance({ kind: 'legacy' }, 'p')).toThrow();
    expect(() => parseProvenance({ kind: 'neutral', reason: 'x' }, 'p')).toThrow();
  });
});
