/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The driver's own denylist assertion. Its URL builders (`planTeamRosterPage`,
 * `planSwimmerFastestTimes`, the queue's roster plan) already refuse a bad URL, so
 * the driver-level check is a second wall. This file proves the wall holds by
 * making a planner return a denylisted URL and requiring that nothing is fetched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureIdForSubject } from '../packages/swimcloud/src/entities';

const bad = vi.hoisted(() => ({ roster: undefined as string | undefined, swimmer: undefined as string | undefined }));

vi.mock('../packages/swimcloud/src/crawlPlan', async (importOriginal) => {
  const real = await importOriginal<typeof import('../packages/swimcloud/src/crawlPlan')>();
  return {
    ...real,
    planTeamRosterPage: (...args: Parameters<typeof real.planTeamRosterPage>) => {
      const step = real.planTeamRosterPage(...args);
      return bad.roster === undefined ? step : { ...step, canonicalUrl: bad.roster };
    },
    planSwimmerFastestTimes: (...args: Parameters<typeof real.planSwimmerFastestTimes>) => {
      const step = real.planSwimmerFastestTimes(...args);
      return bad.swimmer === undefined ? step : { ...step, canonicalUrl: bad.swimmer };
    },
  };
});

import { runMultiTeamCrawl, type MultiTeamDriverDeps } from '../extensions/swimcloud-companion/src/multiTeamDriver';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, 'fixtures', 'swimcloud', 'team-10002824-roster-gender-F-page.html'), 'utf8');

function deps(fetched: string[]): MultiTeamDriverDeps {
  let t = 0;
  let last: number | undefined;
  return {
    async fetchPage(url) {
      fetched.push(url);
      return { html: url.includes('/api/') ? '{}' : PAGE, httpStatus: 200, finalUrl: url };
    },
    async relay() {
      return 'landed';
    },
    async openCapture(subject) {
      return captureIdForSubject(subject);
    },
    async markCapture() {},
    async flushDownloads() {
      return [];
    },
    async sleep(ms) {
      t += ms;
    },
    now: () => t,
    isoNow: () => '2026-10-03T00:00:00.000Z',
    paceClock: { get: () => last, set: (ms) => void (last = ms) },
    async loadFinished() {
      return [];
    },
    async saveFinished() {},
    async clearFinished() {},
    onProgress() {},
    async chooseSeasons(reports) {
      return reports.flatMap((r) => (r.options === undefined ? [] : [{ teamId: r.teamId, seasonLabel: '2025-2026' }]));
    },
    control: { cancelled: false, paused: false },
  };
}

afterEach(() => {
  bad.roster = undefined;
  bad.swimmer = undefined;
});

describe('multi-team driver: denylist wall', () => {
  it('refuses a denylisted season-page URL before fetching', async () => {
    bad.roster = 'https://www.swimcloud.com/team/10002824/facilities/';
    const fetched: string[] = [];
    await expect(runMultiTeamCrawl(deps(fetched), { teamIds: ['10002824'] })).rejects.toMatchObject({ code: 'denylisted-url' });
    expect(fetched).toEqual([]);
  });

  it('refuses a denylisted swimmer URL before fetching it', async () => {
    bad.swimmer = 'https://www.swimcloud.com/api/swimmers/1/other_endpoint/';
    const fetched: string[] = [];
    await expect(runMultiTeamCrawl(deps(fetched), { teamIds: ['10002824'] })).rejects.toMatchObject({ code: 'denylisted-url' });
    expect(fetched.some((u) => u.includes('/api/'))).toBe(false);
    expect(fetched.length).toBe(3); // season page, then the two season rosters; never the bad URL
  });

  it('fetches normally when nothing is overridden', async () => {
    const fetched: string[] = [];
    await runMultiTeamCrawl(deps(fetched), { teamIds: ['10002824'] });
    expect(fetched.some((u) => u.includes('/api/swimmers/'))).toBe(true);
  });
});
