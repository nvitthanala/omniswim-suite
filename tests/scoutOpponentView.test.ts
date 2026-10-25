/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: the plain-word helpers behind the "Scout a team" panel.
 */
import { describe, expect, it } from 'vitest';
import { ClassYear, Gender } from '../packages/core/src/types';
import type { PlannedSwimEntry, Recruit, ScoringSettings } from '../packages/core/src/types';
import { composeDualMeetPreset } from '../packages/core/src/lib/scoringDefaults';
import { scoutOpponent, type ScoutReport } from '../packages/manager/src/lib/opponentScouting';
import {
  NO_TIME_TEXT,
  WORKSPACE_RULES_ID,
  defaultScoringId,
  describeScoutError,
  formatPointChange,
  handTypedRowIds,
  isOwnTeamGroup,
  missingSideText,
  noTimeLine,
  pickerLabel,
  unknownSourceRowIds,
  resolveScoutScoring,
  scoutScoringOptions,
  summaryText,
} from '../packages/manager/src/components/scoutOpponentView';

const DUAL = (() => {
  const preset = composeDualMeetPreset('dual-six-lanes-or-more', 'dual-diving-six-or-more');
  if (preset.settings === undefined) throw new Error('no settings');
  return preset.settings;
})();

function plan(over: Partial<PlannedSwimEntry>): PlannedSwimEntry {
  return {
    id: 'p1',
    name: 'Ann',
    team: 'Henderson State University',
    gender: Gender.MEN,
    event: '100 Free',
    time: '48.00',
    source: 'manual',
    ...over,
  };
}

const US = 'Henderson State University';

describe('hand-typed rows of our side', () => {

  it('returns the id of an active manual plan and the meet row it replaces', () => {
    const ids = handTypedRowIds({ meetEntryPlans: [plan({ id: 'p1', replacesResultId: 'meet-9' })] }, Gender.MEN, US);
    expect([...ids].sort()).toEqual(['meet-9', 'p1']);
  });

  it('leaves out plans from a measured source, another team, another gender or switched off', () => {
    const ids = handTypedRowIds(
      {
        meetEntryPlans: [
          plan({ id: 'a', source: 'swimcloud' }),
          plan({ id: 'b', source: 'optimizer' }),
          plan({ id: 'c', team: 'Other' }),
          plan({ id: 'd', gender: Gender.WOMEN }),
          plan({ id: 'e', active: false, replacesResultId: 'meet-1' }),
        ],
      },
      Gender.MEN,
      US
    );
    expect(ids.size).toBe(0);
  });

  const recruit = (id: string, source?: 'manual' | 'swimcloud' | 'paste'): Recruit => ({
    id,
    name: 'Ann',
    team: US,
    event: '100 Free',
    time: '48.00',
    gender: Gender.MEN,
    classYear: ClassYear.FR,
    timeType: 'SCY',
    ...(source === undefined ? {} : { source }),
  });
  const recruits = [recruit('r-manual', 'manual'), recruit('r-sc', 'swimcloud'), recruit('r-paste', 'paste'), recruit('r-unknown')];

  it('returns a recruit row typed by hand, and not one with a measured source', () => {
    expect([...handTypedRowIds({ meetEntryPlans: [], recruits }, Gender.MEN, US)]).toEqual(['r-manual']);
  });

  it('returns a recruit row with no source apart, as unknown rather than measured', () => {
    expect([...unknownSourceRowIds({ recruits }, Gender.MEN, US)]).toEqual(['r-unknown']);
    expect(unknownSourceRowIds({ recruits }, Gender.WOMEN, US).size).toBe(0);
    expect(unknownSourceRowIds({ recruits }, Gender.MEN, 'Other').size).toBe(0);
  });

  it('honours the active-id list', () => {
    const ids = handTypedRowIds({ meetEntryPlans: [plan({ id: 'p1' }), plan({ id: 'p2' })], activeEntryIds: ['p2'] }, Gender.MEN, US);
    expect([...ids]).toEqual(['p2']);
  });
});

describe('scoring choice', () => {
  it('offers the workspace rules first and picks them when they are usable', () => {
    const settings: ScoringSettings = { ...DUAL };
    const options = scoutScoringOptions(settings);
    expect(options[0]?.id).toBe(WORKSPACE_RULES_ID);
    expect(options[0]?.disabledReason).toBeNull();
    expect(options.length).toBeGreaterThan(1);
    expect(defaultScoringId(settings)).toBe(WORKSPACE_RULES_ID);
  });

  it('picks nothing for a workspace that scores from a meet PDF', () => {
    const settings: ScoringSettings = { ...DUAL, usePdfPlacePoints: true };
    expect(scoutScoringOptions(settings)[0]?.disabledReason).not.toBeNull();
    expect(defaultScoringId(settings)).toBe('');
    expect(resolveScoutScoring(WORKSPACE_RULES_ID, { scoringSettings: settings, conference: 'NSISC' })).toBeNull();
    expect(resolveScoutScoring('', { scoringSettings: settings, conference: 'NSISC' })).toBeNull();
  });

  it('a preset never carries the workspace conference', () => {
    const preset = scoutScoringOptions(undefined).find(o => o.id !== WORKSPACE_RULES_ID);
    if (preset === undefined) throw new Error('no preset offered');
    const resolved = resolveScoutScoring(preset.id, { scoringSettings: undefined, conference: 'SOME-OTHER-CONFERENCE' });
    expect(resolved).not.toBeNull();
    expect(resolved?.conference).not.toBe('SOME-OTHER-CONFERENCE');
  });

  it('the workspace rules keep the workspace conference', () => {
    expect(resolveScoutScoring(WORKSPACE_RULES_ID, { scoringSettings: DUAL, conference: 'NSISC' })?.conference).toBe('NSISC');
  });
});

describe('the team picker', () => {
  const named = { teamId: '412', title: 'Ouachita Baptist University', named: true, divisionTag: { text: 'NCAA D2' } };
  const unnamed = { teamId: '58', title: 'Team 58', named: false, divisionTag: { text: 'unknown division' } };

  it('says when the school name was not recorded', () => {
    expect(pickerLabel(named)).toBe('Ouachita Baptist University (NCAA D2)');
    expect(pickerLabel(unnamed)).toBe('Team 58 (school name not recorded)');
  });

  it('hides a named crawl of your own school, under any spelling the division table knows', () => {
    expect(isOwnTeamGroup({ title: 'Henderson State University', named: true }, US)).toBe(true);
    expect(isOwnTeamGroup({ title: 'Henderson State', named: true }, US)).toBe(true);
    expect(isOwnTeamGroup(named, US)).toBe(false);
  });

  it('cannot hide an unnamed crawl by name. The comparison refuses it after the load.', () => {
    expect(isOwnTeamGroup(unnamed, US)).toBe(false);
  });
});

describe('words', () => {
  it('writes "no entry" for a measured time the entry limit left out and "no time" for an absent time', () => {
    const present = { swimmer: 'Cy', time: '52.00' };
    const capped = noTimeLine({ event: '100 Butterfly', missing: 'theirs', reason: 'entry_cap', cappedBest: { swimmer: 'Dee', time: '53.10' }, present }, US, 'Ouachita Baptist University');
    expect(capped).toContain('Ouachita Baptist University: no entry');
    expect(capped).toContain('Dee 53.10');
    expect(capped).not.toContain('no time');
    const absent = noTimeLine({ event: '100 Butterfly', missing: 'theirs', reason: 'no_time', present }, US, 'Ouachita Baptist University');
    expect(absent).toContain('Ouachita Baptist University: no time');
    expect(absent).not.toContain('no entry');
  });

  it('formats a point change with its sign and keeps a tenth only when there is one', () => {
    expect(formatPointChange(0)).toBe('0');
    expect(formatPointChange(3)).toBe('+3');
    expect(formatPointChange(-1.5)).toBe('-1.5');
  });

  it('names the side with no time and never writes a zero', () => {
    const text = missingSideText('theirs', 'Henderson State University', 'Ouachita Baptist University');
    expect(text).toBe(`Ouachita Baptist University: ${NO_TIME_TEXT}`);
    expect(text).not.toMatch(/\b0(\.0+)?\b/);
  });

  it('says plainly when nothing can be compared', () => {
    const report: ScoutReport = scoutOpponent({
      gender: Gender.MEN,
      ourTeam: 'Henderson State University',
      opponentTeam: 'Ouachita Baptist University',
      ourRows: [],
      theirRows: [],
      settings: DUAL,
    });
    expect(summaryText(report)).toMatch(/nothing can be compared/);
  });

  it('turns a scout error into one sentence and keeps the builder text', () => {
    try {
      scoutOpponent({
        gender: Gender.MEN,
        ourTeam: 'A',
        opponentTeam: 'a',
        ourRows: [],
        theirRows: [],
        settings: DUAL,
      });
      throw new Error('expected a throw');
    } catch (error) {
      const problem = describeScoutError(error);
      expect(problem.code).toBe('same-team');
      expect(problem.message).toMatch(/your own team/);
      expect(problem.detail).not.toBeNull();
    }
  });
});
