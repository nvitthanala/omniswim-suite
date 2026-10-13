/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C3 (user decision U7, 2026-10-12). The season "Team score trends" series used
 * to sum EVERY team's points in each meet and plot the total as the team's
 * trend. It now plots one chosen team's score, emits no point for a meet the
 * team is not in, and skips unreadable points instead of counting them as 0.
 *
 * Mutation map (revert the fix, the named case turns red):
 *  - sum every team again                         -> "a three-team meet returns only the chosen team"
 *  - absent team emits 0 instead of no point      -> "a meet without the team emits no point"
 *  - official match by exact name only            -> "published scores spelled with a doubled name"
 *  - unreadable points read as 0 without a count  -> "unreadable points are skipped and counted"
 *  - no team and several teams plots one anyway   -> "no team chosen"
 */
import { describe, expect, it } from 'vitest';
import {
  buildSeasonTrends,
  defaultSeasonTeam,
  seasonTeams,
} from '../packages/core/src/lib/seasonAnalytics';
import { THEORETICAL_MEET_LABEL } from '../packages/core/src/lib/theoreticalMeetLabel';
import type { Workspace } from '../packages/core/src/types';

const row = (id: string, team: string, points: number | string, name = `${team} Swimmer ${id}`) => ({
  id,
  name,
  team,
  event: '100 Free',
  time: '50.00',
  gender: 'Men',
  rank: 1,
  classYear: 'FR',
  points,
  isRelay: false,
});

function meet(name: string, men: unknown[], women: unknown[] = [], extra: Record<string, unknown> = {}): Workspace {
  return {
    id: name,
    name,
    createdAt: 1,
    menResults: men,
    womenResults: women,
    recruits: [],
    deletedSwimmers: [],
    ...extra,
  } as unknown as Workspace;
}

const THREE_TEAM_MEET = meet('Tri Meet', [
  row('a1', 'Alpha U', 20),
  row('a2', 'Alpha U', 17),
  row('b1', 'Beta U', 16),
  row('b2', 'Beta U', 15),
  row('c1', 'Gamma U', 14),
]);

describe('the chosen team, not every team', () => {
  it('a three-team meet returns only the chosen team (calculated rows)', () => {
    const t = buildSeasonTrends([THREE_TEAM_MEET], { team: 'Beta U' });
    expect(t.teamScoreSelection).toBe('chosen');
    expect(t.team).toBe('Beta U');
    expect(t.teamScoreTrends).toHaveLength(1);
    expect(t.teamScoreTrends[0]).toMatchObject({
      meetLabel: 'Tri Meet',
      menTotal: 31, // 16 + 15, not 82
      menSource: 'calculated',
    });
  });

  it('the other two teams each get their own figure from the same meet', () => {
    expect(buildSeasonTrends([THREE_TEAM_MEET], { team: 'Alpha U' }).teamScoreTrends[0].menTotal).toBe(37);
    expect(buildSeasonTrends([THREE_TEAM_MEET], { team: 'Gamma U' }).teamScoreTrends[0].menTotal).toBe(14);
  });

  it('published team scores: the chosen team official total, not the sum of all of them', () => {
    const published = meet('Official Meet', [row('a', 'Alpha U', 1)], [], {
      officialTeamScores: { men: { 'Alpha U': 120, 'Beta U': 95, 'Gamma U': 40 }, women: { 'Alpha U': 70 } },
    });
    const t = buildSeasonTrends([published], { team: 'Beta U' });
    expect(t.teamScoreTrends).toEqual([
      expect.objectContaining({ menTotal: 95, menSource: 'official', womenTotal: null, womenSource: null }),
    ]);
  });

  it('published scores spelled with a doubled name still match the team (as the real PDF prints them)', () => {
    const published = meet(
      'Doubled Meet',
      [row('h', 'Henderson State University', 1), row('o', 'Ouachita Baptist University', 1)],
      [],
      {
        officialTeamScores: {
          men: {
            'Henderson State University Henderson State University': 1056,
            'Ouachita Baptist University Ouachita Baptist University': 1029.5,
          },
          women: {},
        },
      }
    );
    const t = buildSeasonTrends([published], { team: 'Henderson State University' });
    expect(t.teamScoreTrends[0]).toMatchObject({ menTotal: 1056, menSource: 'official' });
    // The picker lists each school once, under the spelling its rows use.
    expect(t.availableTeams).toEqual(['Henderson State University', 'Ouachita Baptist University']);
  });

  it('a published 0 is a real total and is not replaced by the calculated sum', () => {
    const zero = meet('Zero Meet', [row('a', 'Alpha U', 99)], [], {
      officialTeamScores: { men: { 'Alpha U': 0 }, women: {} },
    });
    expect(buildSeasonTrends([zero], { team: 'Alpha U' }).teamScoreTrends[0].menTotal).toBe(0);
  });
});

describe('absent is not 0', () => {
  it('a meet without the team emits no point', () => {
    const other = meet('Other Meet', [row('d1', 'Delta U', 20)]);
    const t = buildSeasonTrends([THREE_TEAM_MEET, other], { team: 'Alpha U' });
    expect(t.teamScoreTrends.map(x => x.meetLabel)).toEqual(['Tri Meet']);
  });

  it('a meet that published its scores and does not list the team, and where the team swam no row, emits no point', () => {
    const published = meet('Published', [row('d1', 'Delta U', 20)], [], {
      officialTeamScores: { men: { 'Delta U': 20 }, women: {} },
    });
    const t = buildSeasonTrends([THREE_TEAM_MEET, published], { team: 'Alpha U' });
    expect(t.teamScoreTrends.map(x => x.meetLabel)).toEqual(['Tri Meet']);
  });

  it('a gender the team did not enter is null, a gender it entered and scored nothing in is 0', () => {
    const ws = meet('Mixed', [row('a1', 'Alpha U', 12)], [{ ...row('a2', 'Alpha U', 0), gender: 'Women' }, row('b1', 'Beta U', 9)]);
    const alpha = buildSeasonTrends([ws], { team: 'Alpha U' }).teamScoreTrends[0];
    expect(alpha.menTotal).toBe(12);
    expect(alpha.womenTotal).toBe(0);
    const beta = buildSeasonTrends([ws], { team: 'Beta U' }).teamScoreTrends[0];
    expect(beta.menTotal).toBeNull();
    expect(beta.menSource).toBeNull();
    expect(beta.womenTotal).toBe(9);
  });

  it('a team nobody names: no point, and the selection says why', () => {
    const t = buildSeasonTrends([THREE_TEAM_MEET], { team: 'Zeta U' });
    expect(t.teamScoreTrends).toEqual([]);
    expect(t.team).toBeNull();
    expect(t.teamScoreSelection).toBe('team-not-in-any-meet');
  });
});

describe('unreadable points are skipped and counted', () => {
  it('a row whose points are not a number is not added as 0, and is counted', () => {
    const ws = meet('Messy', [row('a1', 'Alpha U', 20), row('a2', 'Alpha U', 'n/a'), row('a3', 'Alpha U', ''), row('a4', 'Alpha U', '7')]);
    const t = buildSeasonTrends([ws], { team: 'Alpha U' });
    expect(t.teamScoreTrends[0].menTotal).toBe(27); // 20 + 7; "n/a" and "" are skipped
    expect(t.teamScoreTrends[0].unreadablePointRows).toBe(2);
    expect(t.unreadablePointRows).toBe(2);
  });

  it('a clean meet reports 0 unreadable rows', () => {
    expect(buildSeasonTrends([THREE_TEAM_MEET], { team: 'Alpha U' }).unreadablePointRows).toBe(0);
  });
});

describe('which team is plotted', () => {
  it('no team chosen and several in the meets: nothing is plotted, and the selection says a team is required', () => {
    const t = buildSeasonTrends([THREE_TEAM_MEET]);
    expect(t.teamScoreTrends).toEqual([]);
    expect(t.team).toBeNull();
    expect(t.teamScoreSelection).toBe('team-required');
    expect(t.availableTeams).toEqual(['Alpha U', 'Beta U', 'Gamma U']);
  });

  it('no team chosen and exactly one in the meets: that team', () => {
    const solo = meet('Solo', [row('a1', 'Alpha U', 20)]);
    const t = buildSeasonTrends([solo]);
    expect(t.team).toBe('Alpha U');
    expect(t.teamScoreTrends[0].menTotal).toBe(20);
  });

  it('matches the team on trimmed, case-folded name', () => {
    expect(buildSeasonTrends([THREE_TEAM_MEET], { team: '  beta u ' }).team).toBe('Beta U');
  });

  it('a theoretical meet names no team and scores nothing', () => {
    const theoretical = {
      ...meet('Theoretical', [row('t1', 'Phantom U', 20)]),
      loadedMeet: { pdfFilename: THEORETICAL_MEET_LABEL, uploadedAt: 1, meetLabel: THEORETICAL_MEET_LABEL },
    } as unknown as Workspace;
    expect(seasonTeams([THREE_TEAM_MEET, theoretical])).toEqual(['Alpha U', 'Beta U', 'Gamma U']);
  });
});

describe('defaultSeasonTeam: the workspace own team, never a guess', () => {
  it('the one team a workspace names', () => {
    expect(defaultSeasonTeam(meet('Roster', [], [], { recruits: [{ team: 'Alpha U' }, { team: ' alpha u' }] }))).toBe('Alpha U');
  });
  it('null when the workspace names several teams', () => {
    expect(defaultSeasonTeam(THREE_TEAM_MEET)).toBeNull();
  });
  it('null when it names none, and for no workspace', () => {
    expect(defaultSeasonTeam(meet('Empty', []))).toBeNull();
    expect(defaultSeasonTeam(undefined)).toBeNull();
  });
});
