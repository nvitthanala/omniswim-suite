import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Gender, type Workspace } from '../packages/core/src/types';
import { optimizeEventLineupForTeam } from '../packages/core/src/lib/rosterOptimizer';

const MEETS_PATH = new URL('../data/meets.json', import.meta.url);
const hasLocalMeets = existsSync(MEETS_PATH);

describe('the optimizer event stage preserves other teams’ active plans', () => {
  it.skipIf(!hasLocalMeets)('keeps HSU plans active when optimizing OBU in Blank Workspace 1', () => {
    const workspaces = JSON.parse(readFileSync(MEETS_PATH, 'utf8')) as Workspace[];
    const ws = workspaces.find(item => item.name === 'Blank Workspace 1');
    expect(ws).toBeDefined();
    const workspace = ws!;
    const hsuPlans = (workspace.meetEntryPlans ?? []).filter(plan => plan.team === 'Henderson State University' && plan.gender === Gender.MEN);
    expect(hsuPlans.length).toBeGreaterThan(0);
    const hsuActive = hsuPlans.filter(plan => (workspace.activeEntryIds ?? []).includes(plan.id)).map(plan => plan.id);
    expect(hsuActive.length).toBeGreaterThan(0);

    const result = optimizeEventLineupForTeam(
      workspace,
      Gender.MEN,
      'Ouachita Baptist University',
      workspace.scoringSettings!
    );
    expect(result.activeEntryIds).toEqual(expect.arrayContaining(hsuActive));
  });
});
