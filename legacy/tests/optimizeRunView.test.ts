/**
 * Wording and the staleness rules for an optimizer run that happens off the
 * main thread (packages/manager/src/components/optimizeRunView.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../packages/core/src/types';
import {
  OPTIMIZER_INPUT_FIELDS,
  changedOptimizerInputs,
  describeOptimizeRun,
  optimizerInputRefsOf,
  optimizerInputsMoved,
  teamRunContextChanged,
} from '../packages/manager/src/components/optimizeRunView';

describe('describeOptimizeRun', () => {
  it('counts teams in plain words', () => {
    expect(
      describeOptimizeRun({ kind: 'allTeams', team: '', progress: { current: 3, total: 12, team: 'X' } })
    ).toBe('Optimizing 3 of 12 teams');
  });

  it('says "team" for a field of one', () => {
    expect(
      describeOptimizeRun({ kind: 'allTeams', team: '', progress: { current: 1, total: 1, team: 'X' } })
    ).toBe('Optimizing 1 of 1 team');
  });

  it('does not invent a count before the first progress report', () => {
    expect(describeOptimizeRun({ kind: 'allTeams', team: '', progress: null })).toBe('Optimizing all teams…');
  });

  it('names the team for single-team runs and the scan', () => {
    expect(describeOptimizeRun({ kind: 'teamArbitrage', team: 'HSU', progress: null })).toBe('Optimizing HSU…');
    expect(describeOptimizeRun({ kind: 'teamLegacy', team: 'HSU', progress: null })).toBe('Optimizing HSU…');
    expect(describeOptimizeRun({ kind: 'scan', team: 'HSU', progress: null })).toBe('Scanning HSU…');
  });
});

describe('optimizerInputsMoved', () => {
  const base = {
    id: 'w1',
    name: 'W',
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    athleteAliases: [],
    athleteHistory: [],
    scorerRosterOverrides: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    relayLegOverrides: [],
  } as unknown as Workspace;

  it('is false for the same references, and when a field the job does not read changes', () => {
    const started = optimizerInputRefsOf(base);
    expect(optimizerInputsMoved(started, { ...base })).toBe(false);
    expect(optimizerInputsMoved(started, { ...base, createdAt: 5, raceAnalyses: [] } as Workspace)).toBe(false);
  });

  it('is true when any field on the list is replaced, whichever it is', () => {
    const started = optimizerInputRefsOf(base);
    for (const field of OPTIMIZER_INPUT_FIELDS) {
      const next = { ...base, [field]: field === 'id' || field === 'name' ? 'other' : [] } as Workspace;
      expect(optimizerInputsMoved(started, next), field).toBe(true);
      expect(changedOptimizerInputs(started, next), field).toEqual([field]);
    }
  });

  it('names the three fields a roster edit touches', () => {
    for (const field of ['deletedSwimmers', 'athleteAliases', 'recruits']) {
      expect(OPTIMIZER_INPUT_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('is true when an absent field appears, and false while it stays absent', () => {
    const bare = {} as Workspace;
    const started = optimizerInputRefsOf(bare);
    expect(optimizerInputsMoved(started, { activeEntryIds: ['a'] } as Workspace)).toBe(true);
    expect(optimizerInputsMoved(started, {} as Workspace)).toBe(false);
  });
});

describe('teamRunContextChanged', () => {
  const started = { workspaceId: 'w1', team: 'HSU', mode: 'individual_first' };

  it('is false when nothing differs', () => {
    expect(teamRunContextChanged(started, { ...started })).toBe(false);
  });

  it('is true when the workspace, team or strategy differs', () => {
    expect(teamRunContextChanged(started, { ...started, workspaceId: 'w2' })).toBe(true);
    expect(teamRunContextChanged(started, { ...started, team: 'OBU' })).toBe(true);
    expect(teamRunContextChanged(started, { ...started, mode: 'relay_first' })).toBe(true);
  });

  it('ignores the strategy for a run that does not use it', () => {
    expect(teamRunContextChanged({ ...started, mode: null }, { ...started, mode: 'relay_first' })).toBe(false);
  });
});
