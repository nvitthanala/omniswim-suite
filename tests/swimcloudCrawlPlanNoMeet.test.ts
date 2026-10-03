/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `planTeamRosterPage` and `planSwimmerFastestTimes` in `packages/swimcloud/src/crawlPlan.ts`:
 * the two meet-less planners the multi-team crawl uses.
 */
import { describe, expect, it } from 'vitest';

import { planMeetSwimmerTimes, planMeetTeamRosters, planSwimmerFastestTimes, planTeamRosterPage } from '../packages/swimcloud/src/crawlPlan';

describe('planTeamRosterPage', () => {
  it('builds the same URL as the meet roster planner, with no season', () => {
    const fromMeet = planMeetTeamRosters({ meetId: '1', teamIds: ['412'] });
    expect(planTeamRosterPage('412', 'M').canonicalUrl).toBe(fromMeet[0].canonicalUrl);
    expect(planTeamRosterPage('412', 'F').canonicalUrl).toBe(fromMeet[1].canonicalUrl);
    expect(planTeamRosterPage('412', 'M').canonicalUrl).toBe('https://www.swimcloud.com/team/412/roster/?gender=M');
    expect(planTeamRosterPage('412', 'M').canonicalUrl).not.toContain('season_id');
  });

  it('throws on a team id that is not a fetchable team', () => {
    expect(() => planTeamRosterPage('0', 'M')).toThrow();
    expect(() => planTeamRosterPage('4/1', 'M')).toThrow();
    expect(() => planTeamRosterPage('', 'F')).toThrow();
  });
});

describe('planSwimmerFastestTimes', () => {
  it('builds the same URL as the meet swimmer planner', () => {
    const fromMeet = planMeetSwimmerTimes({ meetId: '1', swimmerIds: ['1330318'] });
    const step = planSwimmerFastestTimes('1330318');
    expect(step.canonicalUrl).toBe(fromMeet[0].canonicalUrl);
    expect(step.canonicalUrl).toBe('https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/');
    expect(step).toMatchObject({ resourceKind: 'swimmerFastestTimes', swimmerId: '1330318' });
  });

  it('throws on an id that is not a positive integer', () => {
    for (const bad of ['', '0', '012', '1/2', 'abc', '1 ', '-5']) expect(() => planSwimmerFastestTimes(bad), bad).toThrow();
  });
});
