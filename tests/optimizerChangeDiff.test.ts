import { describe, it, expect } from 'vitest';
import { diffOptimizerChanges } from '../packages/core/src/lib/rosterOptimizer';
import { Gender, type PlannedSwimEntry, type ScorerRosterOverride } from '../packages/core/src/types';

function override(name: string, isScorer: boolean, team = 'Home'): ScorerRosterOverride {
  return { name, team, gender: Gender.MEN, isScorer };
}

function plan(id: string, event: string, time: string, overrides: Partial<PlannedSwimEntry> = {}): PlannedSwimEntry {
  return {
    id,
    name: 'Alan Gonzalez',
    team: 'Home',
    gender: Gender.MEN,
    event,
    time,
    source: 'optimizer',
    ...overrides,
  };
}

describe('diffOptimizerChanges', () => {
  it('reports no changes when before and after are identical — the common "unchanged" outcome', () => {
    const state = { overrides: [override('A', true)], plans: [plan('p1', '100 Free', '48.50')] };
    const diff = diffOptimizerChanges(state, state);
    expect(diff.scorerChanges).toEqual([]);
    expect(diff.entryChanges).toEqual([]);
  });

  it('does NOT report a prior override the run left untouched — the bug this diff exists to avoid', () => {
    const before = { overrides: [override('Untouched Swimmer', true)], plans: [] };
    const after = { overrides: [override('Untouched Swimmer', true), override('New Scorer', true)], plans: [] };
    const diff = diffOptimizerChanges(before, after);
    expect(diff.scorerChanges).toEqual([{ name: 'New Scorer', team: 'Home', gender: Gender.MEN, isScorer: true }]);
  });

  it('reports a flipped scorer flag on an athlete who already had an override', () => {
    const before = { overrides: [override('Flipped', false)], plans: [] };
    const after = { overrides: [override('Flipped', true)], plans: [] };
    const diff = diffOptimizerChanges(before, after);
    expect(diff.scorerChanges).toEqual([{ name: 'Flipped', team: 'Home', gender: Gender.MEN, isScorer: true }]);
  });

  it('reports an added planned entry', () => {
    const before = { overrides: [], plans: [] };
    const after = { overrides: [], plans: [plan('p1', '200 IM', '1:55.00')] };
    const diff = diffOptimizerChanges(before, after);
    expect(diff.entryChanges).toEqual([
      { status: 'added', name: 'Alan Gonzalez', team: 'Home', event: '200 IM', time: '1:55.00' },
    ]);
  });

  it('reports a removed planned entry', () => {
    const before = { overrides: [], plans: [plan('p1', '200 IM', '1:55.00')] };
    const after = { overrides: [], plans: [] };
    const diff = diffOptimizerChanges(before, after);
    expect(diff.entryChanges).toEqual([
      { status: 'removed', name: 'Alan Gonzalez', team: 'Home', event: '200 IM', time: '1:55.00' },
    ]);
  });

  it('reports a changed entry (same id, different event) with the previous value carried', () => {
    const before = { overrides: [], plans: [plan('p1', '100 Free', '48.50')] };
    const after = { overrides: [], plans: [plan('p1', '100 Fly', '50.10')] };
    const diff = diffOptimizerChanges(before, after);
    expect(diff.entryChanges).toEqual([
      {
        status: 'changed',
        name: 'Alan Gonzalez',
        team: 'Home',
        event: '100 Fly',
        time: '50.10',
        previousEvent: '100 Free',
        previousTime: '48.50',
      },
    ]);
  });

  it('does not report an unchanged entry that merely appears in both arrays in a different order', () => {
    const before = { overrides: [], plans: [plan('p1', '100 Free', '48.50'), plan('p2', '200 Free', '1:45.00')] };
    const after = { overrides: [], plans: [plan('p2', '200 Free', '1:45.00'), plan('p1', '100 Free', '48.50')] };
    const diff = diffOptimizerChanges(before, after);
    expect(diff.entryChanges).toEqual([]);
  });
});
