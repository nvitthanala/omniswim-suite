import { describe, it, expect } from 'vitest';
import { buildSeasonTrends } from '../packages/core/src/lib/seasonAnalytics';
import type { Workspace } from '../packages/core/src/types';

describe('seasonAnalytics', () => {
  it('aggregates swimmer bests across workspaces', () => {
    const ws: Workspace = {
      id: 'w1',
      name: 'Test Meet',
      createdAt: Date.now(),
      menResults: [
        {
          id: 'r1',
          name: 'Alice Swimmer',
          event: '100 Free',
          time: '52.10',
          team: 'Home',
          gender: 'Men',
          rank: 1,
          classYear: 'FR',
          points: 20,
          isRelay: false,
        },
        {
          id: 'r2',
          name: 'Alice Swimmer',
          event: '100 Free',
          time: '51.50',
          team: 'Home',
          gender: 'Men',
          rank: 1,
          classYear: 'FR',
          points: 20,
          isRelay: false,
        },
      ],
      womenResults: [],
      recruits: [],
      deletedSwimmers: [],
    };
    const trends = buildSeasonTrends([ws]);
    expect(trends.swimmerTrends.length).toBe(1);
    expect(trends.swimmerTrends[0].bestTime).toBe('51.50');
    expect(trends.swimmerTrends[0].meetCount).toBe(2);
  });
});
