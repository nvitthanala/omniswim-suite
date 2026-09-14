import { describe, it, expect } from 'vitest';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { Gender, type SwimmerResult, type Workspace } from '../packages/core/src/types';

function swimmer(overrides: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id: 'sw1',
    rank: 1,
    name: 'Alpha, Ace',
    classYear: 'JR',
    team: 'Ouachita Baptist University', // real, mapped D2 team
    time: '20.50',
    points: 0,
    event: '50 Freestyle',
    gender: Gender.MEN,
    roundSwam: 'A Final',
    ...overrides,
  } as unknown as SwimmerResult;
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'audit-ws',
    name: 'Conversion provenance test',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    ...overrides,
  } as unknown as Workspace;
}

const team = 'Ouachita Baptist University';

function runAudit(ws: Workspace) {
  return buildTeamLineupAudit({
    workspace: ws,
    gender: Gender.MEN,
    team,
    settings: ws.scoringSettings!,
    allResults: ws.menResults,
    allScored: ws.menResults,
    removeSeniors: false,
  });
}

describe('auditConversionProvenance (via buildTeamLineupAudit)', () => {
  it('flags a swim whose event label states an explicit LCM/SCM code and clears the converted standard', () => {
    // D2 men's 50 Free A standard is 19.39 SCY; 22.00 LCM converts to 19.14
    // yards (inside it) — see scripts/test_cutline_tags.mjs's own fixture for
    // this exact pair of numbers.
    const ws = workspace({
      menResults: [swimmer({ event: 'Event 8 Men 50 LCM Freestyle', time: '22.00' })],
    });
    const items = runAudit(ws).checklistItems.filter(i => i.group === 'provenance');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'conversion_estimate', athleteName: 'Alpha, Ace' });
    expect(items[0].message).toContain('converted-time estimate');
  });

  it('does not flag an ordinary SCY swim', () => {
    const ws = workspace({ menResults: [swimmer({ time: '19.20' })] });
    expect(runAudit(ws).checklistItems.filter(i => i.group === 'provenance')).toEqual([]);
  });

  it('does not flag a metric swim that misses even on the converted time (a genuine no_cut, not indicative)', () => {
    const ws = workspace({
      menResults: [swimmer({ event: 'Event 8 Men 50 LCM Freestyle', time: '30.00' })],
    });
    expect(runAudit(ws).checklistItems.filter(i => i.group === 'provenance')).toEqual([]);
  });

  it('does not flag a relay row', () => {
    const ws = workspace({
      menResults: [
        swimmer({
          id: 'rel1',
          name: 'Relay Team',
          event: 'Event 20 Men 4x100 LCM Freestyle Relay',
          time: '3:20.00',
          isRelay: true,
        }),
      ],
    });
    expect(runAudit(ws).checklistItems.filter(i => i.group === 'provenance')).toEqual([]);
  });

  it('does not flag a swim with no usable time', () => {
    const ws = workspace({
      menResults: [swimmer({ event: 'Event 8 Men 50 LCM Freestyle', time: '' })],
    });
    expect(runAudit(ws).checklistItems.filter(i => i.group === 'provenance')).toEqual([]);
  });
});
