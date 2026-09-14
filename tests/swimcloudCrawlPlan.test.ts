/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/swimcloud/src/crawlPlan.ts` — pure planner tests. No network, no
 * fixture files: every assertion is about the shape and order of the URLs
 * the planner emits, and that every one of them classifies as the resource
 * kind it claims to be (so a planner bug can never silently emit a
 * denylisted or malformed URL for the extension to fetch).
 */
import { describe, expect, it } from 'vitest';
import {
  classifySwimCloudUrl,
  planMeetEventResults,
  planMeetSwimmerTimes,
  planMeetTeamDiscovery,
  planMeetTeamDiscoveryFallback,
  planMeetTeamRosters,
  planMeetTeamSwims,
} from '@omniswim/swimcloud';

describe('planMeetTeamDiscovery', () => {
  it('emits both genders\' topteams URLs', () => {
    const steps = planMeetTeamDiscovery('379295');
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.gender)).toStrictEqual(['M', 'F']);
    expect(steps.every((s) => s.resourceKind === 'meetTopTeams')).toBe(true);
    expect(steps.every((s) => s.meetId === '379295')).toBe(true);
  });

  it('every emitted URL actually classifies as meetTopTeams', () => {
    for (const step of planMeetTeamDiscovery('379295')) {
      const classification = classifySwimCloudUrl(step.canonicalUrl);
      expect(classification.outcome).toBe('fetchable');
      if (classification.outcome === 'fetchable') {
        expect(classification.resource.kind).toBe('meetTopTeams');
      }
    }
  });
});

describe('planMeetTeamDiscoveryFallback', () => {
  it('emits both genders\' meet-root URLs, never topteams', () => {
    const steps = planMeetTeamDiscoveryFallback('356467');
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.resourceKind === 'meet')).toBe(true);
  });

  it('every emitted URL classifies as the meet root', () => {
    for (const step of planMeetTeamDiscoveryFallback('356467')) {
      const classification = classifySwimCloudUrl(step.canonicalUrl);
      expect(classification.outcome).toBe('fetchable');
      if (classification.outcome === 'fetchable') {
        expect(classification.resource.kind).toBe('meet');
      }
    }
  });
});

describe('planMeetTeamSwims', () => {
  it('defaults to page 1 only for a team+gender with no known page count', () => {
    const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58', '412'] });
    // 2 teams x 2 genders x 1 page = 4
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.page === 1)).toBe(true);
    expect(steps.every((s) => s.resourceKind === 'meetTeamSwims')).toBe(true);
  });

  it('is deterministic: team-by-team, men then women within a team, page 1 upward', () => {
    const steps = planMeetTeamSwims({
      meetId: '356467',
      teamIds: ['58', '412'],
      knownTotalPages: { '58:M': 3 },
    });
    const shape = steps.map((s) => `${s.teamId}:${s.gender}:${s.page}`);
    expect(shape).toStrictEqual([
      '58:M:1', '58:M:2', '58:M:3',
      '58:F:1',
      '412:M:1',
      '412:F:1',
    ]);
  });

  it('emits exactly totalPages pages for a known team+gender — never one more, never one fewer', () => {
    const steps = planMeetTeamSwims({
      meetId: '356467',
      teamIds: ['58'],
      knownTotalPages: { '58:M': 8 },
    });
    const menSteps = steps.filter((s) => s.gender === 'M');
    expect(menSteps).toHaveLength(8);
    expect(menSteps.map((s) => s.page)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('never emits a resourceKind other than meetTeamSwims for this planner', () => {
    const steps = planMeetTeamSwims({
      meetId: '356467',
      teamIds: ['58', '412', '48'],
      knownTotalPages: { '58:M': 8, '412:F': 4 },
    });
    expect(steps.every((s) => s.resourceKind === 'meetTeamSwims')).toBe(true);
  });

  it('every emitted URL round-trips through classifySwimCloudUrl as meetTeamSwims with the right ids', () => {
    const steps = planMeetTeamSwims({ meetId: '356467', teamIds: ['58'], knownTotalPages: { '58:F': 2 } });
    for (const step of steps) {
      const classification = classifySwimCloudUrl(step.canonicalUrl);
      expect(classification.outcome).toBe('fetchable');
      if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetTeamSwims') {
        throw new Error(`expected meetTeamSwims for ${step.canonicalUrl}`);
      }
      expect(classification.resource.meetId).toBe('356467');
      expect(classification.resource.teamId).toBe('58');
      expect(classification.resource.query.gender).toBe(step.gender);
    }
  });

  it('returns no steps for an empty team list', () => {
    expect(planMeetTeamSwims({ meetId: '356467', teamIds: [] })).toHaveLength(0);
  });
});

describe('planMeetTeamRosters', () => {
  it('plans both genders\' roster pages for every discovered team', () => {
    const steps = planMeetTeamRosters({ meetId: '356467', teamIds: ['58', '412'] });
    // 2 teams x 2 genders x 1 page = 4
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.resourceKind === 'teamRoster')).toBe(true);
  });

  it('is deterministic: team by team, men then women, matching planMeetTeamSwims', () => {
    const steps = planMeetTeamRosters({ meetId: '356467', teamIds: ['58', '412'] });
    expect(steps.map((s) => `${s.teamId}:${s.gender}`)).toStrictEqual([
      '58:M', '58:F', '412:M', '412:F',
    ]);
  });

  it('emits the real /team/{id}/roster/ URL shape', () => {
    const [first] = planMeetTeamRosters({ meetId: '356467', teamIds: ['58'] });
    expect(first.canonicalUrl).toBe('https://www.swimcloud.com/team/58/roster/?gender=M');
  });

  it('every emitted URL round-trips through classifySwimCloudUrl as teamRoster', () => {
    for (const step of planMeetTeamRosters({ meetId: '356467', teamIds: ['58', '412'] })) {
      const classification = classifySwimCloudUrl(step.canonicalUrl);
      expect(classification.outcome).toBe('fetchable');
      if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'teamRoster') {
        throw new Error(`expected teamRoster for ${step.canonicalUrl}`);
      }
      expect(classification.resource.teamId).toBe(step.teamId);
      expect(classification.resource.query.gender).toBe(step.gender);
    }
  });

  it('carries the planning meet id even though a roster URL is not meet-scoped', () => {
    const steps = planMeetTeamRosters({ meetId: '379295', teamIds: ['58'] });
    expect(steps.every((s) => s.meetId === '379295')).toBe(true);
    expect(steps.every((s) => !s.canonicalUrl.includes('379295'))).toBe(true);
  });

  it('never emits a season_id: the server\'s own current season is what a roster fetch gets', () => {
    // The roster page's season filter is `season_id`, a numeric id whose
    // id-to-label table nothing here trusts as stable or site-wide. No URL
    // carries one and no formula derives one.
    for (const step of planMeetTeamRosters({ meetId: '356467', teamIds: ['58', '412', '48'] })) {
      expect(step.canonicalUrl).not.toContain('season_id');
      expect(step.canonicalUrl).not.toContain('year=');
    }
  });

  it('never emits a page parameter: roster pagination is unproven, not assumed absent-then-guessed', () => {
    for (const step of planMeetTeamRosters({ meetId: '356467', teamIds: ['58'] })) {
      expect(step.canonicalUrl).not.toContain('page=');
      expect(step.page).toBeUndefined();
    }
  });

  it('returns no steps for an empty team list', () => {
    expect(planMeetTeamRosters({ meetId: '356467', teamIds: [] })).toHaveLength(0);
  });
});

describe('planMeetSwimmerTimes', () => {
  it('plans one times page per swimmer', () => {
    const steps = planMeetSwimmerTimes({ meetId: '356467', swimmerIds: ['1472365', '1330318'] });
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.resourceKind === 'swimmerTimes')).toBe(true);
    expect(steps.map((s) => s.swimmerId)).toStrictEqual(['1472365', '1330318']);
  });

  it('emits the real /swimmer/{id}/times/ URL shape', () => {
    const [first] = planMeetSwimmerTimes({ meetId: '356467', swimmerIds: ['1472365'] });
    expect(first.canonicalUrl).toBe('https://www.swimcloud.com/swimmer/1472365/times/');
  });

  it('every emitted URL round-trips through classifySwimCloudUrl as swimmerTimes', () => {
    for (const step of planMeetSwimmerTimes({ meetId: '356467', swimmerIds: ['1472365', '1330318'] })) {
      const classification = classifySwimCloudUrl(step.canonicalUrl);
      expect(classification.outcome).toBe('fetchable');
      if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'swimmerTimes') {
        throw new Error(`expected swimmerTimes for ${step.canonicalUrl}`);
      }
      expect(classification.resource.swimmerId).toBe(step.swimmerId);
    }
  });

  it('carries the planning meet id even though a swimmer-times URL is not meet-scoped', () => {
    const steps = planMeetSwimmerTimes({ meetId: '379295', swimmerIds: ['1472365'] });
    expect(steps.every((s) => s.meetId === '379295')).toBe(true);
    expect(steps.every((s) => !s.canonicalUrl.includes('379295'))).toBe(true);
  });

  it('emits no gender: a swimmer-times page is not gender-filtered the way a roster is', () => {
    for (const step of planMeetSwimmerTimes({ meetId: '356467', swimmerIds: ['1472365', '1330318'] })) {
      expect(step.canonicalUrl).not.toContain('gender');
      expect(step.gender).toBeUndefined();
    }
  });

  it('emits no season_id and no page: neither is proven on this page', () => {
    for (const step of planMeetSwimmerTimes({ meetId: '356467', swimmerIds: ['1472365'] })) {
      expect(step.canonicalUrl).not.toContain('season_id');
      expect(step.canonicalUrl).not.toContain('page=');
      expect(step.page).toBeUndefined();
    }
  });

  it('emits no query string at all — the real capture URL carries none', () => {
    for (const step of planMeetSwimmerTimes({ meetId: '356467', swimmerIds: ['1472365'] })) {
      expect(step.canonicalUrl).not.toContain('?');
    }
  });

  it('collapses a repeated swimmer id, keeping first-seen order', () => {
    // A swimmer can reach this planner twice — two rosters a caller unioned, or
    // a transfer listed on both. The URL is scoped to the swimmer alone, so a
    // second step would fetch the identical page again.
    const steps = planMeetSwimmerTimes({
      meetId: '356467',
      swimmerIds: ['1472365', '1330318', '1472365'],
    });
    expect(steps.map((s) => s.swimmerId)).toStrictEqual(['1472365', '1330318']);
  });

  it('is deterministic: the same input yields the same steps', () => {
    const input = { meetId: '356467', swimmerIds: ['1472365', '1330318', '58'] } as const;
    expect(planMeetSwimmerTimes(input)).toStrictEqual(planMeetSwimmerTimes(input));
  });

  it('returns no steps for an empty swimmer list', () => {
    expect(planMeetSwimmerTimes({ meetId: '356467', swimmerIds: [] })).toHaveLength(0);
  });
});

describe('planMeetEventResults', () => {
  it('plans one page per event reference', () => {
    const steps = planMeetEventResults({ meetId: '356467', eventRefs: ['26', '11'] });
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.resourceKind === 'meetEvent')).toBe(true);
    expect(steps.map((s) => s.eventRef)).toStrictEqual(['26', '11']);
  });

  it('emits the real /results/{meetId}/event/{n}/ URL shape', () => {
    const [first] = planMeetEventResults({ meetId: '356467', eventRefs: ['26'] });
    expect(first.canonicalUrl).toBe('https://www.swimcloud.com/results/356467/event/26/');
  });

  it('every emitted URL round-trips through classifySwimCloudUrl as meetEvent', () => {
    for (const step of planMeetEventResults({ meetId: '356467', eventRefs: ['26', '11', '100'] })) {
      const classification = classifySwimCloudUrl(step.canonicalUrl);
      expect(classification.outcome).toBe('fetchable');
      if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetEvent') {
        throw new Error(`expected meetEvent for ${step.canonicalUrl}`);
      }
      expect(classification.resource.meetId).toBe('356467');
      expect(classification.resource.eventRef).toBe(step.eventRef);
    }
  });

  it('fetches a repeated event reference exactly once, first occurrence winning', () => {
    // This is the whole point of the pass: one event page holds every team's
    // swimmers in that event, so a 40-team meet's swims lists name the same
    // handful of references over and over. Without this dedupe the pass would
    // fetch one page per team per event.
    const steps = planMeetEventResults({
      meetId: '356467',
      eventRefs: ['26', '11', '26', '26', '11', '3'],
    });
    expect(steps.map((s) => s.eventRef)).toStrictEqual(['26', '11', '3']);
  });

  it('emits no gender: an event page is one gender already', () => {
    // The real capture's own toggle proves it — event 26 is "100 Breast Men
    // Finals" and its Women link points at event 400, a different page, not a
    // `?gender=` variant of this one.
    for (const step of planMeetEventResults({ meetId: '356467', eventRefs: ['26'] })) {
      expect(step.canonicalUrl).not.toContain('gender');
      expect(step.gender).toBeUndefined();
    }
  });

  it('emits no season_id and no page: neither is proven on this page', () => {
    for (const step of planMeetEventResults({ meetId: '356467', eventRefs: ['26'] })) {
      expect(step.canonicalUrl).not.toContain('season_id');
      expect(step.canonicalUrl).not.toContain('page=');
      expect(step.page).toBeUndefined();
    }
  });

  it('drops an empty reference rather than emitting /event//', () => {
    expect(planMeetEventResults({ meetId: '356467', eventRefs: ['', '26'] }).map((s) => s.eventRef)).toStrictEqual(['26']);
  });

  it('returns no steps for an empty reference list', () => {
    expect(planMeetEventResults({ meetId: '356467', eventRefs: [] })).toHaveLength(0);
  });
});
