/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P1 model and rule tests (plans/2026-10-25/D2-ENGINE-API.md, 3.1 to 3.4 and 3.7).
 * The built-in content and the legacy bridge have their own files.
 */
import { describe, expect, it } from 'vitest';

import {
  RulePresetError,
  capAllows,
  editSetting,
  entryKey,
  formatHundredths,
  parseCap,
  parseProvenance,
  parseRulePreset,
  parseSetting,
  parseTimeText,
  pendingPaths,
  requireComplete,
  stripSwimCloudData,
} from '@omniswim/engine';
import type { Lineup, LineupEntry, RulePreset, Setting } from '@omniswim/engine';
import { BUILTIN_RULE_PRESETS } from '@omniswim/engine';

function nsisc(): RulePreset {
  const found = BUILTIN_RULE_PRESETS.find(b => b.id === 'nsisc');
  if (!found) throw new Error('nsisc built-in missing');
  return JSON.parse(JSON.stringify(found.preset)) as RulePreset;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RulePresetError) return e.code;
    throw e;
  }
  return 'no-throw';
}

describe('3.1 primitives', () => {
  it('round-trips every hundredths value from 0 to 360000 through text', () => {
    for (let h = 0; h <= 360000; h++) {
      const parsed = parseTimeText(formatHundredths(h));
      expect(parsed?.hundredths).toBe(h);
    }
  });

  it('keeps the original text', () => {
    expect(parseTimeText('1:57.57')).toStrictEqual({ text: '1:57.57', hundredths: 11757 });
    expect(parseTimeText('57.57')).toStrictEqual({ text: '57.57', hundredths: 5757 });
  });

  it('returns null, never 0, for blank, NT and DQ', () => {
    for (const text of ['', '   ', 'NT', 'nt', 'DQ', ' dq ']) {
      expect(parseTimeText(text), text).toBeNull();
    }
  });

  it('throws on text that is not a time', () => {
    for (const text of ['abc', '57', '57.5', '1:7.57', '1:60.00', '60.00', '-1.00', '1:57:57', '57,57', 'NS', 'SCR']) {
      expect(() => parseTimeText(text), text).toThrow(RangeError);
    }
  });

  it('formats below and from one minute', () => {
    expect(formatHundredths(0)).toBe('0.00');
    expect(formatHundredths(5999)).toBe('59.99');
    expect(formatHundredths(6000)).toBe('1:00.00');
    expect(formatHundredths(11757)).toBe('1:57.57');
    expect(() => formatHundredths(-1)).toThrow(RangeError);
    expect(() => formatHundredths(1.5)).toThrow(RangeError);
  });
});

describe('3.2 provenance', () => {
  const published = {
    kind: 'published',
    source: {
      sourceId: 'x',
      manifest: 'data/m.json',
      sha256: 'a'.repeat(64),
      url: 'https://example.test/x.pdf',
      publisher: 'NCAA',
    },
  };

  it('rejects the legacy kind with legacy_provenance', () => {
    expect(codeOf(() => parseProvenance({ kind: 'legacy' }, 'p'))).toBe('legacy_provenance');
  });

  it('rejects an unknown kind and a bad sha256', () => {
    expect(codeOf(() => parseProvenance({ kind: 'guess' }, 'p'))).toBe('invalid');
    expect(codeOf(() => parseProvenance({ ...published, source: { ...published.source, sha256: 'abc' } }, 'p'))).toBe('invalid');
    expect(codeOf(() => parseProvenance({ ...published, source: { ...published.source, sha256: 'A'.repeat(64) } }, 'p'))).toBe('invalid');
  });

  it('rejects an unknown key', () => {
    expect(codeOf(() => parseProvenance({ ...published, extra: 1 }, 'p'))).toBe('invalid');
  });

  it('parses a published record and a user-stated record', () => {
    expect(parseProvenance(published, 'p')).toStrictEqual(published);
    const stated = { kind: 'user-stated', statedOn: '2026-10-25', wording: 'w', where: 'a:1', verbatim: true };
    expect(parseProvenance(stated, 'p')).toStrictEqual(stated);
    expect(codeOf(() => parseProvenance({ ...stated, statedOn: '2026-13-01' }, 'p'))).toBe('invalid');
  });

  it('editSetting gives user-edited provenance that keeps the old one as previous', () => {
    const before = nsisc().scoring.aFinalBracketSize;
    if (before.state !== 'set') throw new Error('expected a set value');
    const after = editSetting(before, 6, '2026-10-26T10:00:00Z');
    expect(after).toStrictEqual({
      state: 'set',
      value: 6,
      provenance: { kind: 'user-edited', editedAt: '2026-10-26T10:00:00Z', previous: before.provenance },
    });
    expect(() => editSetting(before, 6, 'yesterday')).toThrow(RangeError);
  });

  it('editSetting on a pending setting records previous as null', () => {
    const before = nsisc().scoring.individualPoints;
    expect(before.state).toBe('pending');
    const after = editSetting(before, [20, 17], '2026-10-26T10:00:00Z');
    expect(after.state === 'set' && after.provenance).toStrictEqual({
      kind: 'user-edited',
      editedAt: '2026-10-26T10:00:00Z',
      previous: null,
    });
  });

  it('a pending setting has no value key and no provenance key', () => {
    const pending = parseSetting({ state: 'pending', question: 'q', blocks: ['b'] }, 's', v => v);
    expect(pending).toStrictEqual({ state: 'pending', question: 'q', blocks: ['b'] });
    expect('value' in pending).toBe(false);
    expect('provenance' in pending).toBe(false);
    expect(codeOf(() => parseSetting({ state: 'pending', question: 'q', blocks: [], value: 1 }, 's', v => v))).toBe('invalid');
  });
});

describe('3.3 cap', () => {
  it('parseCap(undefined) is missing, never unlimited', () => {
    expect(codeOf(() => parseCap(undefined, 'c'))).toBe('missing');
  });

  it('accepts unlimited and the integers 0 to 998', () => {
    expect(parseCap('unlimited', 'c')).toBe('unlimited');
    for (const n of [0, 1, 7, 18, 998]) expect(parseCap(n, 'c')).toBe(n);
  });

  it('treats 0 as a cap that allows nothing', () => {
    const zero = parseCap(0, 'c');
    expect(capAllows(zero, 0)).toBe(true);
    expect(capAllows(zero, 1)).toBe(false);
  });

  it('rejects 999 and above as legacy_sentinel', () => {
    for (const n of [999, 1000, 100000]) expect(codeOf(() => parseCap(n, 'c')), String(n)).toBe('legacy_sentinel');
  });

  it('rejects null, NaN, infinity, fractions, negatives and strings as invalid', () => {
    for (const raw of [null, NaN, Infinity, -Infinity, 1.5, -1, '7', 'Unlimited', '', 'none', true, {}, []]) {
      expect(codeOf(() => parseCap(raw, 'c')), JSON.stringify(raw)).toBe('invalid');
    }
  });

  it('carries the path on the error', () => {
    try {
      parseCap(undefined, 'entries.maxTotalPerSwimmer');
    } catch (e) {
      expect(e).toBeInstanceOf(RulePresetError);
      expect((e as RulePresetError).path).toBe('entries.maxTotalPerSwimmer');
      return;
    }
    throw new Error('expected a throw');
  });

  it('capAllows reads unlimited as no limit and a number as count <= cap', () => {
    expect(capAllows('unlimited', 1_000_000)).toBe(true);
    expect(capAllows(8, 8)).toBe(true);
    expect(capAllows(8, 9)).toBe(false);
  });
});

describe('3.4 rule preset', () => {
  it('parses every built-in back to itself', () => {
    for (const b of BUILTIN_RULE_PRESETS) {
      expect(parseRulePreset(JSON.parse(JSON.stringify(b.preset))), b.id).toStrictEqual(b.preset);
    }
  });

  it('pendingPaths skips relayEligibleFromScorerPool under roster', () => {
    const p = nsisc();
    expect(p.scorers.relayEligibleFromScorerPool.state).toBe('pending');
    expect(pendingPaths(p)).toStrictEqual(['scorers.relayOverCap', 'scoring.divingPoints', 'scoring.individualPoints', 'scoring.relayPoints', 'scoring.ties']);
  });

  it('pendingPaths skips relayLegsMustBeScorers under points_pool', () => {
    const p = nsisc();
    const scorers = p.scorers as { -readonly [K in keyof RulePreset['scorers']]: RulePreset['scorers'][K] };
    scorers.eligibility = { ...(scorers.eligibility as Extract<Setting<unknown>, { state: 'set' }>), value: 'points_pool' } as RulePreset['scorers']['eligibility'];
    scorers.relayLegsMustBeScorers = { state: 'pending', question: 'q', blocks: [] };
    const paths = pendingPaths(p);
    expect(paths).not.toContain('scorers.relayLegsMustBeScorers');
    expect(paths).toContain('scorers.relayEligibleFromScorerPool');
  });

  it('pendingPaths skips neither while the eligibility mode is itself pending', () => {
    const p = nsisc();
    const scorers = p.scorers as { -readonly [K in keyof RulePreset['scorers']]: RulePreset['scorers'][K] };
    scorers.eligibility = { state: 'pending', question: 'q', blocks: [] };
    scorers.relayLegsMustBeScorers = { state: 'pending', question: 'q', blocks: [] };
    const paths = pendingPaths(p);
    expect(paths).toContain('scorers.eligibility');
    expect(paths).toContain('scorers.relayEligibleFromScorerPool');
    expect(paths).toContain('scorers.relayLegsMustBeScorers');
  });

  it('requireComplete names every pending path', () => {
    const p = nsisc();
    try {
      requireComplete(p);
    } catch (e) {
      expect(e).toBeInstanceOf(RulePresetError);
      const err = e as RulePresetError;
      expect(err.code).toBe('pending');
      expect(err.paths).toStrictEqual(['scorers.relayOverCap', 'scoring.divingPoints', 'scoring.individualPoints', 'scoring.relayPoints', 'scoring.ties']);
      for (const path of err.paths) expect(err.message).toContain(path);
      return;
    }
    throw new Error('expected requireComplete to throw');
  });

  it('rejects unknown keys at every level', () => {
    const base = JSON.parse(JSON.stringify(nsisc())) as Record<string, Record<string, unknown>>;
    for (const mutate of [
      (j: typeof base) => ((j as Record<string, unknown>).extra = 1),
      (j: typeof base) => (j.scoring!.extra = 1),
      (j: typeof base) => (j.scorers!.extra = 1),
      (j: typeof base) => (j.entries!.extra = 1),
    ]) {
      const copy = JSON.parse(JSON.stringify(base)) as typeof base;
      mutate(copy);
      expect(() => parseRulePreset(copy)).toThrow(RulePresetError);
    }
  });

  it('rejects a numeric cap of 999 or more inside a preset', () => {
    const j = JSON.parse(JSON.stringify(nsisc())) as { entries: { maxTotalPerSwimmer: { value: unknown } } };
    j.entries.maxTotalPerSwimmer.value = 999;
    try {
      parseRulePreset(j);
    } catch (e) {
      expect((e as RulePresetError).code).toBe('legacy_sentinel');
      return;
    }
    throw new Error('expected a throw');
  });

  it('rejects a missing limit, an empty point list, a bad diver weight and roster with null auto rules', () => {
    const fresh = () => JSON.parse(JSON.stringify(nsisc())) as {
      entries: Record<string, unknown>;
      scoring: { individualPoints: unknown };
      scorers: { diverWeight: { value: unknown }; autoRules: { value: unknown } };
    };
    const a = fresh();
    delete a.entries.maxTotalPerSwimmer;
    expect(() => parseRulePreset(a)).toThrow(RulePresetError);

    const b = fresh();
    b.scoring.individualPoints = { state: 'set', value: [], provenance: { kind: 'user-stated', statedOn: '2026-10-25', wording: 'w', where: 'a:1', verbatim: false } };
    expect(() => parseRulePreset(b)).toThrow(RulePresetError);

    for (const weight of [{ numerator: 0, denominator: 3 }, { numerator: 4, denominator: 3 }, { numerator: 1, denominator: 0 }, { numerator: 1.5, denominator: 3 }]) {
      const c = fresh();
      c.scorers.diverWeight.value = weight;
      expect(() => parseRulePreset(c), JSON.stringify(weight)).toThrow(RulePresetError);
    }

    const d = fresh();
    d.scorers.autoRules.value = null;
    expect(() => parseRulePreset(d)).toThrow(RulePresetError);
  });

  it('the legacy provenance kind fails inside a preset', () => {
    const j = JSON.parse(JSON.stringify(nsisc())) as { scoring: { aFinalBracketSize: { provenance: unknown } } };
    j.scoring.aFinalBracketSize.provenance = { kind: 'legacy' };
    try {
      parseRulePreset(j);
    } catch (e) {
      expect((e as RulePresetError).code).toBe('legacy_provenance');
      return;
    }
    throw new Error('expected a throw');
  });
});

describe('3.7 lineup', () => {
  const individual: LineupEntry = {
    kind: 'individual',
    teamId: 'hsu',
    swimmerId: 's1',
    eventKey: '100 Freestyle',
    gender: 'Women',
    seedSwimId: null,
  };
  const relay: LineupEntry = {
    kind: 'relay',
    teamId: 'hsu',
    eventKey: '200 Freestyle Relay',
    gender: 'Men',
    letter: 'A',
    legs: [
      { swimmerId: 'a', basis: { kind: 'no-time' } },
      { swimmerId: 'b', basis: { kind: 'no-time' } },
      { swimmerId: 'c', basis: { kind: 'no-time' } },
      { swimmerId: 'd', basis: { kind: 'no-time' } },
    ],
  };

  it('entryKey is stable and tells entries apart', () => {
    expect(entryKey(individual)).toBe('i|hsu|s1|100 Freestyle|Women');
    expect(entryKey(relay)).toBe('r|hsu|200 Freestyle Relay|Men|A');
    expect(entryKey({ ...individual, gender: 'Men' })).not.toBe(entryKey(individual));
    expect(entryKey({ ...relay, letter: 'B' })).not.toBe(entryKey(relay));
  });

  it('entryKey throws when a part holds the separator', () => {
    expect(() => entryKey({ ...individual, swimmerId: 's|1' })).toThrow(RangeError);
    expect(() => entryKey({ ...relay, letter: 'A|B' })).toThrow(RangeError);
  });

  const withDisplay: Lineup = {
    payloadVersion: 1,
    meetKey: 'm1',
    entries: [individual, relay],
    display: {
      swimmers: { s1: { name: 'Pat Example' } },
      teams: { hsu: { name: 'Henderson State' } },
      entryTimes: { [entryKey(individual)]: { text: '52.10', hundredths: 5210 } },
    },
  };

  it('stripSwimCloudData removes the display key, it does not set it to undefined', () => {
    const stripped = stripSwimCloudData(withDisplay);
    expect('display' in stripped).toBe(false);
    expect(Object.keys(stripped).sort()).toStrictEqual(['entries', 'meetKey', 'payloadVersion']);
  });

  it('the stripped lineup survives JSON unchanged', () => {
    const stripped = stripSwimCloudData(withDisplay);
    expect(JSON.parse(JSON.stringify(stripped))).toStrictEqual(stripped);
  });

  it('stripSwimCloudData leaves its input alone and handles a lineup with no display', () => {
    const before = JSON.stringify(withDisplay);
    stripSwimCloudData(withDisplay);
    expect(JSON.stringify(withDisplay)).toBe(before);
    const bare: Lineup = { payloadVersion: 1, meetKey: 'm1', entries: [] };
    expect(stripSwimCloudData(bare)).toStrictEqual(bare);
    expect('display' in stripSwimCloudData(bare)).toBe(false);
  });

  it('no name or time string from the display survives the strip', () => {
    const text = JSON.stringify(stripSwimCloudData(withDisplay));
    expect(text).not.toContain('Pat Example');
    expect(text).not.toContain('Henderson State');
    expect(text).not.toContain('52.10');
  });
});
