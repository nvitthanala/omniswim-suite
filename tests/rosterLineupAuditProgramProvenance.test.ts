import { describe, it, expect } from 'vitest';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { Gender, type SwimmerResult, type Workspace } from '../packages/core/src/types';

function swimmer(team: string, name: string, event: string, gender: Gender): SwimmerResult {
  return {
    id: `${team}|${name}|${event}`,
    rank: 1,
    name,
    classYear: 'JR',
    team,
    time: '20.50',
    points: 0,
    event,
    gender,
    roundSwam: 'A Final',
  } as unknown as SwimmerResult;
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'audit-ws',
    name: 'Program provenance test',
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

describe('auditProgramProvenance (via buildTeamLineupAudit)', () => {
  it('flags every athlete on an unmapped team as program_division_unknown', () => {
    const team = 'Totally Unrecognized University';
    const ws = workspace({ menResults: [swimmer(team, 'Alpha, Ace', '50 Freestyle', Gender.MEN)] });
    const audit = buildTeamLineupAudit({
      workspace: ws,
      gender: Gender.MEN,
      team,
      settings: ws.scoringSettings!,
      allResults: ws.menResults,
      allScored: ws.menResults,
      removeSeniors: false,
    });
    const items = audit.checklistItems.filter(i => i.group === 'program');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'program_division_unknown', athleteName: 'Alpha, Ace' });
    expect(items[0].message).toContain(team);
  });

  it('flags an athlete on a team not recorded as sponsoring their gender', () => {
    // UWF (University of West Florida) is recorded as sponsoring women's
    // swimming & diving only — see packages/core/src/data/teamDivisions.ts.
    const team = 'University of West Florida';
    const ws = workspace({ menResults: [swimmer(team, 'Beta, Bob', '50 Freestyle', Gender.MEN)] });
    const audit = buildTeamLineupAudit({
      workspace: ws,
      gender: Gender.MEN,
      team,
      settings: ws.scoringSettings!,
      allResults: ws.menResults,
      allScored: ws.menResults,
      removeSeniors: false,
    });
    const items = audit.checklistItems.filter(i => i.group === 'program');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'program_gender_unsponsored', athleteName: 'Beta, Bob' });
  });

  it('does not flag the women\'s side of a team recorded as sponsoring women only', () => {
    const team = 'University of West Florida';
    const ws = workspace({ womenResults: [swimmer(team, 'Gamma, Gia', '50 Freestyle', Gender.WOMEN)] });
    const audit = buildTeamLineupAudit({
      workspace: ws,
      gender: Gender.WOMEN,
      team,
      settings: ws.scoringSettings!,
      allResults: ws.womenResults,
      allScored: ws.womenResults,
      removeSeniors: false,
    });
    expect(audit.checklistItems.filter(i => i.group === 'program')).toEqual([]);
  });

  it('does not flag a fully-mapped, both-genders-sponsored team', () => {
    const team = 'Ouachita Baptist University';
    const ws = workspace({ menResults: [swimmer(team, 'Delta, Dan', '50 Freestyle', Gender.MEN)] });
    const audit = buildTeamLineupAudit({
      workspace: ws,
      gender: Gender.MEN,
      team,
      settings: ws.scoringSettings!,
      allResults: ws.menResults,
      allScored: ws.menResults,
      removeSeniors: false,
    });
    expect(audit.checklistItems.filter(i => i.group === 'program')).toEqual([]);
  });
});
