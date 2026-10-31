import { describe, expect, it } from 'vitest';
import {
  bestRelaySplitsAcrossTeams,
  parseTeamRelayHistory,
  parseTimesByEventResponse,
  teamsFromTimesByEvent,
} from '../packages/swimcloud/src/browser';

const source = { fetchedAt: '2026-10-27T12:00:00Z', url: 'https://www.swimcloud.com/api/test' };
const historyOptions = { ...source, swimmerId: 'swimmer-1', eventKey: '50 Freestyle' as never, course: 'SCY' as const };
const individual = {
  id: 101, team_id: 11, meet_id: 21, dateofswim: '2026-02-01', eventtime: '19.42', flystart: false,
  relay_id: null, legposition: 1, split: { splitdistance: null },
};
const teamResponse = (splitId: number, splitTime: string, leadId: number, leadTime: string) => ({
  swimmers: [{ id: 'swimmer-1', relaysplits: [{ id: splitId, eventstroke: '1', eventdistance: 50, eventcourse: 'Y', eventgender: 'M', numlegs: 1, eventtime: splitTime, flystart: true, pointvalue: null }],
    relayleadoffs: [{ id: leadId, eventstroke: '1', eventdistance: 50, eventcourse: 'Y', eventgender: 'M', numlegs: 1, eventtime: leadTime, flystart: false, pointvalue: null }], indrecords: [] }], relays: [],
});

describe('SwimCloud history adapter', () => {
  it('maps individual rows with the source id, date and leadoff flag', () => {
    const swims = parseTimesByEventResponse([individual], historyOptions);
    expect(swims).toHaveLength(1);
    expect(swims[0]).toMatchObject({ swimId: 'history:101', eventKey: '50 Freestyle', date: '2026-02-01', flags: {}, origin: { kind: 'history-fetch' } });
    const leadoff = parseTimesByEventResponse([{ ...individual, relay_id: 9 }], historyOptions)[0];
    expect(leadoff?.flags).toEqual({ extractedSplit: true });
  });

  it('fails loudly at each required times_by_event field', () => {
    for (const key of ['id', 'team_id', 'dateofswim', 'eventtime', 'flystart', 'relay_id', 'legposition']) {
      const row = { ...individual } as Record<string, unknown>;
      delete row[key];
      expect(() => parseTimesByEventResponse([row], historyOptions), key).toThrow(`times_by_event[0].${key}`);
    }
    expect(() => parseTimesByEventResponse([{ ...individual, eventtime: 'bad' }], historyOptions)).toThrow('times_by_event[0].eventtime');
    expect(() => parseTimesByEventResponse([{ ...individual, dateofswim: 'bad' }], historyOptions)).toThrow('times_by_event[0].dateofswim');
  });

  it('distinguishes verified empty history from a missing/non-array response', () => {
    expect(parseTimesByEventResponse([], historyOptions)).toEqual([]);
    expect(() => parseTimesByEventResponse(undefined, historyOptions)).toThrow('times_by_event');
    expect(() => teamsFromTimesByEvent([{ ...individual, team_id: undefined }])).toThrow('times_by_event[0].team_id');
  });

  it('parses relay splits and flat relay leadoffs for one team', () => {
    const result = parseTeamRelayHistory(teamResponse(201, '19.06', 202, '19.42'), {
      ...source, swimmerId: 'swimmer-1', teamId: '11', teams: ['11'],
    });
    expect(result.splits[0]).toMatchObject({ splitId: 'history-split:201', start: 'flying', legEventKey: '50 Freestyle', split: { hundredths: 1906 } });
    expect(result.swims[0]).toMatchObject({ swimId: 'history-leadoff:202', flags: { extractedSplit: true }, recordedTime: { hundredths: 1942 } });
  });

  it('fails loudly for missing simulator endpoint fields', () => {
    const good = teamResponse(201, '19.06', 202, '19.42');
    const missingArray = { swimmers: [{ id: 'swimmer-1', relaysplits: [] }], relays: [] };
    expect(() => parseTeamRelayHistory(missingArray, { ...source, swimmerId: 'swimmer-1', teamId: '11', teams: ['11'] })).toThrow('relayleadoffs');
    for (const key of ['id', 'eventstroke', 'eventdistance', 'eventcourse', 'eventgender', 'eventtime', 'flystart']) {
      const malformed = structuredClone(good) as typeof good;
      delete (malformed.swimmers[0]?.relaysplits[0] as unknown as Record<string, unknown>)[key];
      expect(() => parseTeamRelayHistory(malformed, { ...source, swimmerId: 'swimmer-1', teamId: '11', teams: ['11'] }), key).toThrow(`team_simulator.swimmers.relaysplits[0].${key}`);
    }
    const malformedTime = structuredClone(good);
    malformedTime.swimmers[0]!.relaysplits[0]!.eventtime = '0';
    expect(() => parseTeamRelayHistory(malformedTime, { ...source, swimmerId: 'swimmer-1', teamId: '11', teams: ['11'] })).toThrow('eventtime');
  });

  it('selects best splits across two teams and keeps ties by source row id', () => {
    const first = parseTeamRelayHistory(teamResponse(301, '19.06', 302, '19.42'), { ...source, swimmerId: 'swimmer-1', teamId: '11', teams: ['11', '12'] }).splits;
    const second = parseTeamRelayHistory(teamResponse(401, '19.49', 402, '19.50'), { ...source, swimmerId: 'swimmer-1', teamId: '12', teams: ['11', '12'] }).splits;
    const best = bestRelaySplitsAcrossTeams(new Map([['11', first], ['12', second]]), ['11', '12']);
    expect(best.map((item) => item.split.splitId)).toEqual(['history-split:301']);
    const tied = bestRelaySplitsAcrossTeams(new Map([['11', first], ['12', [{ ...second[0]!, splitId: 'history-split:999', split: first[0]!.split }]]]), ['11', '12']);
    expect(tied.map((item) => item.split.splitId)).toEqual(['history-split:301', 'history-split:999']);
    expect(bestRelaySplitsAcrossTeams(new Map([['11', first], ['12', second]]), ['11', '12'])[0]?.split).toBe(first[0]);
  });
});
