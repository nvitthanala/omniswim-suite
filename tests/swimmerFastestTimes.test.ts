/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Swimmer personal bests from `/api/swimmers/{id}/profile_fastest_times/`.
 *
 * The swimmer times page is a shell; its table comes from this JSON. These
 * tests run the whole path against the real response saved on 2026-09-22
 * (`tests/fixtures/profile_fastest_times-1330318.json`): the URL exemption,
 * the crawl plan, the parser, and the roster import that names the swimmer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '@omniswim/core/types';
import {
  classifySwimCloudUrl,
  parseSwimmerFastestTimesJson,
  parseTeamRosterHtml,
  planMeetSwimmerTimes,
  type SwimCloudParseContext,
  type SwimCloudMeetId,
} from '@omniswim/swimcloud';
import { buildRosterImportFromCapture } from '@omniswim/manager/lib/rosterQueueImport';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');

const SWIMMER_ID = '1330318';
const CONTEXT: SwimCloudParseContext = {
  sourceUrl: `https://www.swimcloud.com/api/swimmers/${SWIMMER_ID}/profile_fastest_times/`,
  retrievedAt: '2026-09-22T12:02:00.000Z',
  track: 'browser-extension',
};

function parseFixture() {
  const result = parseSwimmerFastestTimesJson(fixture('profile_fastest_times-1330318.json'), CONTEXT);
  if (!result.ok) throw new Error(result.failure.message);
  return result;
}

describe('robots.txt exemption', () => {
  it('makes exactly the profile_fastest_times path fetchable', () => {
    const c = classifySwimCloudUrl(CONTEXT.sourceUrl);
    expect(c.outcome).toBe('fetchable');
    if (c.outcome === 'fetchable') {
      expect(c.resource).toStrictEqual({ kind: 'swimmerFastestTimes', swimmerId: SWIMMER_ID });
    }
  });

  it.each([
    `/api/swimmers/${SWIMMER_ID}/times_by_event/?event=1%7C50%7CY%7C1`,
    `/api/swimmers/${SWIMMER_ID}/`,
    '/api/swimmers/abc/profile_fastest_times/',
    `/api/swimmers/${SWIMMER_ID}/profile_fastest_times/extra/`,
    '/jsonapi/swimmers/1/profile_fastest_times/',
  ])('still forbids %s', (path) => {
    expect(classifySwimCloudUrl(path).outcome).toBe('forbidden');
  });
});

describe('crawl plan', () => {
  it('plans the JSON endpoint, not the rendered page', () => {
    const steps = planMeetSwimmerTimes({ meetId: '356467' as SwimCloudMeetId, swimmerIds: [SWIMMER_ID] });
    expect(steps.map((s) => [s.canonicalUrl, s.resourceKind])).toStrictEqual([
      [CONTEXT.sourceUrl, 'swimmerFastestTimes'],
    ]);
  });
});

describe('parseSwimmerFastestTimesJson', () => {
  it('reads every row of the real response', () => {
    const { data, warnings } = parseFixture();
    expect(data.swimCloudSwimmerId).toBe(SWIMMER_ID);
    expect(data.name).toBeUndefined();
    expect(data.rowCount).toBe(35);
    expect(data.personalBests).toHaveLength(35);
    expect(warnings).toStrictEqual([]);
  });

  it('builds the HTML table’s labels and converts seconds without drift', () => {
    const byLabel = new Map(parseFixture().data.personalBests.map((pb) => [pb.eventLabel, pb]));
    expect(byLabel.get('50 Free SCY')?.time).toBe('20.99');
    expect(byLabel.get('200 Free SCY')?.time).toBe('1:41.29');
    expect(byLabel.get('1650 Free SCY')?.time).toBe('18:15.50');
    expect(byLabel.get('1500 Free LCM')?.time).toBe('18:18.30');
    expect(byLabel.get('400 IM SCY')?.stroke).toBe('Individual Medley');
    expect(byLabel.get('100 Breast SCY')?.course).toBe('SCY');
  });

  it('keeps the leadoff flag, the extracted tag, the season and the swim key', () => {
    const byLabel = new Map(parseFixture().data.personalBests.map((pb) => [pb.eventLabel, pb]));
    const back50 = byLabel.get('50 Back SCY');
    expect(back50).toMatchObject({
      time: '22.53',
      relayLeadoff: true,
      seasonId: '29',
      date: '2026-02-18',
      meetName: 'New South Championships',
    });
    const breast50 = byLabel.get('50 Breast SCY');
    expect(breast50?.tags).toContainEqual({ code: 'X', title: 'Extracted' });
    expect(breast50?.relayLeadoff).toBe(false);
    expect(byLabel.get('50 Free SCY')?.swimKey).toBe('237191:swim:132495294');
  });

  it('fails loudly on a challenge page instead of returning no times', () => {
    const result = parseSwimmerFastestTimesJson('<!DOCTYPE html><title>Just a moment...</title>', CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('unreadable-json');
  });

  it('skips an unknown stroke code and a disqualified swim, and says so', () => {
    const rows = JSON.parse(fixture('profile_fastest_times-1330318.json')) as Record<string, unknown>[];
    const body = JSON.stringify([
      { ...rows[0], eventstroke: '9' },
      { ...rows[1], legal: false },
    ]);
    const result = parseSwimmerFastestTimesJson(body, CONTEXT);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.data.personalBests).toHaveLength(1);
    expect(result.data.personalBests[0].time).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toStrictEqual(['unrecognized-event-label', 'unrecognized-time-token']);
  });
});

describe('rows first seen in live responses (2026-09-22)', () => {
  const parseLive = (file: string, id: string) => {
    const result = parseSwimmerFastestTimesJson(fixture(file), {
      ...CONTEXT,
      sourceUrl: `https://www.swimcloud.com/api/swimmers/${id}/profile_fastest_times/`,
    });
    if (!result.ok) throw new Error(result.failure.message);
    return result;
  };

  it('keeps a diver’s rows as diving, with the score as a raw token and no time', () => {
    const { data, warnings } = parseLive('profile_fastest_times-2508045-diver.json', '2508045');
    expect(data.personalBests).toHaveLength(9);
    const diving = data.personalBests.filter((pb) => pb.stroke === 'Diving');
    expect(diving.map((pb) => pb.eventLabel).sort()).toStrictEqual(['1M Diving', '1M Diving', '3M Diving', '3M Diving']);
    expect(diving.every((pb) => pb.time === undefined && pb.rawTimeToken !== undefined)).toBe(true);
    expect(diving.find((pb) => pb.rawTimeToken === '318.05')?.meetName).toBe('New South Championships');
    expect(warnings.map((w) => w.code)).toStrictEqual(Array(4).fill('diving-score-not-a-time'));
  });

  it('reads the swim id from #time on a user-inputted row with a non-numeric event ref', () => {
    const { data, warnings } = parseLive('profile_fastest_times-2352628-user-inputted.json', '2352628');
    expect(warnings).toStrictEqual([]);
    const userInputted = data.personalBests.filter((pb) => pb.tags.some((t) => t.code === 'U'));
    expect(userInputted).toHaveLength(3);
    const free100 = userInputted.find((pb) => pb.eventLabel === '100 Free SCM');
    expect(free100).toMatchObject({ eventRef: '1100M', swimCloudSwimId: '137434121', time: '54.49' });
    expect(data.personalBests.every((pb) => pb.swimCloudSwimId !== undefined)).toBe(true);
  });
});

describe('roster import from a JSON capture', () => {
  it('names the swimmer from the roster by id and imports the swims', () => {
    const rosterResult = parseTeamRosterHtml(fixture('swimcloud-real-team-roster-58-gender-m.html'), {
      sourceUrl: 'https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=29&sort=name',
      retrievedAt: '2026-09-09T02:08:38.793Z',
      track: 'browser-extension',
    });
    if (!rosterResult.ok) throw new Error(rosterResult.failure.message);
    const rosterName = rosterResult.data.athletes.find((a) => a.swimCloudSwimmerId === SWIMMER_ID)?.name;
    expect(rosterName).toBeDefined();

    const result = buildRosterImportFromCapture({
      roster: rosterResult.data,
      swimmerTimes: [parseFixture().data],
      team: 'Henderson State',
      gender: Gender.MEN,
      existingRosterNames: [],
    });

    expect(result.importedSwimmerCount).toBe(1);
    expect(result.swims).toHaveLength(35);
    expect(new Set(result.swims.map((s) => s.name))).toStrictEqual(new Set([rosterName]));
    expect(result.rosterQueue.entries.filter((e) => e.captured).map((e) => e.name)).toStrictEqual([rosterName]);
  });
});
