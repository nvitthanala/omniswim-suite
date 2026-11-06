import { describe, expect, it } from 'vitest';
import { ruleBuiltinChoices } from '../apps/extension/src/storage/presets';

describe('retired rule presets', () => {
  it('hides retired built-ins by default but labels a saved retired choice', () => {
    const registry = [
      { id: 'active', version: 1, label: 'Active' },
      { id: 'retired', version: 1, label: 'Old rules', retired: { on: '2026-10-26', reason: 'retired', supersededBy: 'active' } },
    ];
    const retired = registry[1]!;
    const ref = { kind: 'builtin' as const, id: retired.id, version: retired.version };
    expect(ruleBuiltinChoices(registry).some(c => JSON.stringify(c.ref) === JSON.stringify(ref))).toBe(false);
    expect(ruleBuiltinChoices(registry, ref)).toContainEqual({ source: 'builtin', ref, label: 'Old rules (retired)', retired: true });
  });

  it('keeps showing a saved older version once a newer one exists', () => {
    const registry = [
      { id: 'rules', version: 1, label: 'Rules' },
      { id: 'rules', version: 2, label: 'Rules' },
    ];
    const ref = { kind: 'builtin' as const, id: 'rules', version: 1 };
    expect(ruleBuiltinChoices(registry).map(c => c.ref)).toEqual([{ kind: 'builtin', id: 'rules', version: 2 }]);
    expect(ruleBuiltinChoices(registry, ref)).toContainEqual({ source: 'builtin', ref, label: 'Rules (older version 1)' });
    expect(ruleBuiltinChoices(registry, { kind: 'builtin', id: 'rules', version: 2 })).toHaveLength(1);
  });
});
