import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Gender, type Workspace } from '../packages/core/src/types';
import { optimizeEventLineupForTeam } from '../packages/core/src/lib/rosterOptimizer';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

/**
 * The committed demo workspace: two invented teams, no real swimmer or time. This test
 * used to read the gitignored `data/meets.json` and skipped on a clean checkout and in CI.
 * The demo seed carries no entry plans, so the first team's plans come from the
 * optimizer itself instead of being typed in here.
 */
const SEED_PATH = new URL('../data/demo-seed.json', import.meta.url);
const FIRST_TEAM = 'Northgate University';
const SECOND_TEAM = 'Riverside College';

describe('the optimizer event stage preserves other teams’ active plans', () => {
  it('keeps the first team’s plans active when optimizing the second team', () => {
    const [seed] = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as Workspace[];
    const settings = NSISC_PRESET_SETTINGS;
    // Plan-sheet mode plans an athlete's events even when the loaded meet already holds a swim
    // in them, which is what lets the demo seed (every swimmer already in every event) produce plans.
    const planSheet: Workspace = { ...seed, entryPlanMode: 'plan_sheet', scoringSettings: settings };

    // Step 1: the first team gets plans, and every one of them is made active.
    const first = optimizeEventLineupForTeam(planSheet, Gender.MEN, FIRST_TEAM, settings);
    expect(first.plans.filter(plan => plan.team === FIRST_TEAM).length).toBeGreaterThan(0);
    const workspace: Workspace = {
      ...planSheet,
      meetEntryPlans: first.plans,
      activeEntryIds: first.activeEntryIds,
    };

    const firstPlans = (workspace.meetEntryPlans ?? []).filter(
      plan => plan.team === FIRST_TEAM && plan.gender === Gender.MEN,
    );
    expect(firstPlans.length).toBeGreaterThan(0);
    const firstActive = firstPlans
      .filter(plan => (workspace.activeEntryIds ?? []).includes(plan.id))
      .map(plan => plan.id);
    expect(firstActive.length).toBeGreaterThan(0);

    // Step 2: optimizing the other team must leave those ids active.
    const result = optimizeEventLineupForTeam(workspace, Gender.MEN, SECOND_TEAM, settings);
    expect(result.activeEntryIds).toEqual(expect.arrayContaining(firstActive));
  });
});
