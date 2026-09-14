import { describe, it, expect } from 'vitest';
import { buildMeetReconciliationSummary } from '../packages/core/src/lib/meetReconciliation';
import { matchOfficialTeamKey, matchOfficialTeamScore } from '../packages/core/src/lib/teamScoreMatching';
import { Gender, type OfficialTeamScores } from '../packages/core/src/types';

describe('matchOfficialTeamKey', () => {
  it('resolves the same key matchOfficialTeamScore reads its value from', () => {
    const official = { 'Ohio State University': 500, 'Ohio University': 300 };
    expect(matchOfficialTeamKey('Ohio State University', official)).toBe('Ohio State University');
    expect(matchOfficialTeamScore('Ohio State University', official)).toBe(500);
  });

  it('reports absent — not a guessed key — for a name ambiguous between two teams', () => {
    const official = { 'Ohio State University': 500, 'Ohio University': 300 };
    expect(matchOfficialTeamKey('Ohio', official)).toBeUndefined();
    expect(matchOfficialTeamScore('Ohio', official)).toBeUndefined();
  });

  it('still resolves a genuinely unambiguous fuzzy match', () => {
    const official = { 'Henderson State University': 1056 };
    expect(matchOfficialTeamKey('Henderson State', official)).toBe('Henderson State University');
  });
});

describe('buildMeetReconciliationSummary', () => {
  const official: OfficialTeamScores = {
    men: { 'Home University': 500, 'Rival College': 420, 'Departed Program': 100 },
    women: {},
  };

  it('reports no summary at all when the workspace carries no official scores for this gender', () => {
    const summary = buildMeetReconciliationSummary(
      new Map([['Home University', 500]]),
      official,
      Gender.WOMEN
    );
    expect(summary.hasOfficialScores).toBe(false);
    expect(summary.entries).toEqual([]);
  });

  it('reports no summary at all when the workspace has no officialTeamScores object', () => {
    const summary = buildMeetReconciliationSummary(new Map([['Home University', 500]]), undefined, Gender.MEN);
    expect(summary.hasOfficialScores).toBe(false);
  });

  it('flags a team present on both sides with agreeing totals as matched', () => {
    const summary = buildMeetReconciliationSummary(
      new Map([['Home University', 500]]),
      official,
      Gender.MEN
    );
    const entry = summary.entries.find(e => e.team === 'Home University');
    expect(entry).toMatchObject({ status: 'matched', computed: 500, official: 500, delta: 0 });
    expect(summary.matchedCount).toBe(1);
  });

  it('flags a real disagreement as mismatched with a signed delta — the ROCK/LU shape', () => {
    const summary = buildMeetReconciliationSummary(
      new Map([['Rival College', 424]]),
      official,
      Gender.MEN
    );
    const entry = summary.entries.find(e => e.team === 'Rival College');
    expect(entry).toMatchObject({ status: 'mismatched', computed: 424, official: 420 });
    expect(entry!.delta).toBeCloseTo(4, 5);
  });

  it('does not flag a delta under the meaningful threshold as a mismatch', () => {
    const summary = buildMeetReconciliationSummary(
      new Map([['Rival College', 420.02]]),
      official,
      Gender.MEN
    );
    expect(summary.entries.find(e => e.team === 'Rival College')!.status).toBe('matched');
  });

  it('flags a computed team the official PDF never named as computedOnly', () => {
    const summary = buildMeetReconciliationSummary(
      new Map([['New Program', 50]]),
      official,
      Gender.MEN
    );
    expect(summary.entries.find(e => e.team === 'New Program')).toMatchObject({
      status: 'computedOnly',
      computed: 50,
    });
  });

  it('flags an official row nothing computed matched as officialOnly, distinct from a mismatch', () => {
    const summary = buildMeetReconciliationSummary(new Map(), official, Gender.MEN);
    const departed = summary.entries.find(e => e.team === 'Departed Program');
    expect(departed).toMatchObject({ status: 'officialOnly', official: 100 });
    expect(departed!.computed).toBeUndefined();
  });

  it('never double-counts an official row already consumed by a matched/mismatched team', () => {
    const summary = buildMeetReconciliationSummary(
      new Map([['Home University', 500]]),
      official,
      Gender.MEN
    );
    const officialOnlyTeams = summary.entries.filter(e => e.status === 'officialOnly').map(e => e.team);
    expect(officialOnlyTeams).not.toContain('Home University');
  });

  it('totalCount covers every team named on either side, matched included', () => {
    const summary = buildMeetReconciliationSummary(
      new Map([
        ['Home University', 500],
        ['New Program', 50],
      ]),
      official,
      Gender.MEN
    );
    // Home University (matched) + Rival College (officialOnly) + Departed Program (officialOnly) + New Program (computedOnly)
    expect(summary.totalCount).toBe(4);
  });
});
