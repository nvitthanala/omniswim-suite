/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `planTeamSeasonRoster` in `packages/swimcloud/src/crawlPlan.ts`.
 *
 * The URL shape is tied to the real roster filter form: the parameter names
 * and their order are read out of the captured form
 * (`tests/fixtures/swimcloud/team-412-roster-gender-F-season-form.html`) inside
 * the test, not retyped. The existing planners are asserted unchanged at the
 * bottom, because their own tests only check that `season_id` is absent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  classifySwimCloudUrl,
  parseTeamSeasonOptions,
  planMeetTeamRosters,
  planTeamSeasonRoster,
  resolveSeasonOption,
  type TeamSeasonOption,
} from '../packages/swimcloud/src/index';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'swimcloud');
const FORM_412_F = readFileSync(join(fixturesDir, 'team-412-roster-gender-F-season-form.html'), 'utf8');

function season(label: string, html = FORM_412_F): TeamSeasonOption {
  const found = resolveSeasonOption(parseTeamSeasonOptions(html), label);
  if (found === undefined) throw new Error(`fixture has no season ${label}`);
  return found;
}

/** Parameter names of the real form, in the order the browser submits them, each once. */
function realFormParameterOrder(): string[] {
  const names: string[] = [];
  for (const match of FORM_412_F.matchAll(/<(?:input|select)\b[^>]*\bname="([^"]+)"/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

describe('planTeamSeasonRoster', () => {
  it('plans men then women, each carrying the chosen season id', () => {
    const steps = planTeamSeasonRoster({ teamId: '412', season: season('2025-2026') });
    expect(steps.map((s) => s.canonicalUrl)).toStrictEqual([
      'https://www.swimcloud.com/team/412/roster/?page=1&gender=M&season_id=29&sort=name',
      'https://www.swimcloud.com/team/412/roster/?page=1&gender=F&season_id=29&sort=name',
    ]);
    expect(steps.map((s) => s.gender)).toStrictEqual(['M', 'F']);
    expect(steps.every((s) => s.resourceKind === 'teamRoster' && s.teamId === '412' && s.seasonId === '29')).toBe(true);
  });

  it('uses the id the page printed for the chosen season, not one computed from the label', () => {
    const renumbered = FORM_412_F.replace('<option value="28">', '<option value="5">');
    const steps = planTeamSeasonRoster({ teamId: '412', season: season('2024-2025', renumbered) });
    expect(steps.every((s) => s.seasonId === '5' && s.canonicalUrl.includes('season_id=5&'))).toBe(true);
    const other = planTeamSeasonRoster({ teamId: '412', season: season('2024-2025') });
    expect(other.every((s) => s.seasonId === '28')).toBe(true);
  });

  it('builds URLs whose parameter names and order are those of the real filter form', () => {
    expect(realFormParameterOrder()).toStrictEqual(['page', 'gender', 'season_id', 'sort']);
    for (const step of planTeamSeasonRoster({ teamId: '412', season: season('2023-2024') })) {
      const keys = [...new URL(step.canonicalUrl).searchParams.keys()];
      expect(keys).toStrictEqual(realFormParameterOrder());
    }
  });

  it('matches a real browser-recorded roster URL for team 58 character for character', () => {
    // From `tests/rosterQueueImport.test.ts`, a sourceUrl the extension recorded.
    const [men, women] = planTeamSeasonRoster({ teamId: '58', season: season('2025-2026') });
    expect(men.canonicalUrl).toBe('https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=29&sort=name');
    expect(women.canonicalUrl).toBe('https://www.swimcloud.com/team/58/roster/?page=1&gender=F&season_id=29&sort=name');
  });

  it('every URL classifies as a fetchable team roster that carries the season id, and round-trips unchanged', () => {
    for (const step of planTeamSeasonRoster({ teamId: '10002824', season: season('2024-2025') })) {
      const classified = classifySwimCloudUrl(step.canonicalUrl);
      expect(classified.outcome).toBe('fetchable');
      if (classified.outcome !== 'fetchable' || classified.resource.kind !== 'teamRoster') {
        throw new Error('expected a teamRoster');
      }
      expect(classified.resource.teamId).toBe('10002824');
      expect(classified.resource.query.seasonId).toBe('28');
      expect(classified.resource.query.gender).toBe(step.gender);
      expect(classified.resource.query.page).toBe('1');
      expect(classified.canonicalUrl).toBe(step.canonicalUrl);
    }
  });

  it('does not accept a bare season string', () => {
    // @ts-expect-error a string is not a TeamSeasonOption
    expect(() => planTeamSeasonRoster({ teamId: '412', season: '29' })).toThrow(/TeamSeasonOption/);
    // @ts-expect-error an object written by hand lacks the compile-time brand
    const call = () => planTeamSeasonRoster({ teamId: '412', season: { seasonId: '29', label: '2025-2026', startYear: 2025, endYear: 2026, selected: true } });
    // The brand is compile-time only. At run time a hand-written object of the right shape is
    // indistinguishable from a parsed one that went through JSON, so it is not refused here.
    expect(call).not.toThrow();
  });

  it('throws on a season whose shape is wrong, instead of planning a URL', () => {
    const real = season('2025-2026');
    const bad = [
      { ...real, seasonId: '' },
      { ...real, seasonId: '29&sort=perf' },
      { ...real, seasonId: '29/../../team/1' },
      { ...real, label: '2025-2027' },
      { ...real, startYear: 1999 },
    ];
    for (const candidate of bad) {
      expect(() => planTeamSeasonRoster({ teamId: '412', season: candidate })).toThrow(/TeamSeasonOption/);
    }
  });

  it('throws on a team id that is not a positive integer without leading zeros', () => {
    for (const teamId of ['', 'abc', '058', '0', '58/roster', '58?x=1', '-1']) {
      expect(() => planTeamSeasonRoster({ teamId, season: season('2025-2026') })).toThrow(/not a fetchable team roster URL/);
    }
  });

  it('plans from a season that lost its brand in JSON', () => {
    const revived = JSON.parse(JSON.stringify(season('2025-2026'))) as TeamSeasonOption;
    expect(planTeamSeasonRoster({ teamId: '412', season: revived })).toHaveLength(2);
  });
});

describe('the existing roster planner is unchanged', () => {
  it('planMeetTeamRosters still emits only ?gender= and no season_id, page or sort', () => {
    const steps = planMeetTeamRosters({ meetId: '356467', teamIds: ['412'] });
    expect(steps.map((s) => s.canonicalUrl)).toStrictEqual([
      'https://www.swimcloud.com/team/412/roster/?gender=M',
      'https://www.swimcloud.com/team/412/roster/?gender=F',
    ]);
  });
});
