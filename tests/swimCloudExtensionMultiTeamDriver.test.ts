/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `extensions/swimcloud-companion/src/multiTeamDriver.ts`: the multi-team crawl
 * loop, run with fake dependencies, a fake clock and no network.
 *
 * ## Fixtures and their provenance
 *
 * - `tests/fixtures/swimcloud/team-{412,10002824}-roster-gender-{M,F}-page.html`
 *   are the four real roster pages captured on 2026-09-22 (git-ignored source:
 *   `data/swimcloud-captures/pages/`), TRIMMED: every `<script>` and `<style>`
 *   block, the page header and nav, and everything after the season filter form
 *   were cut. The cut removes the logged-in account's inline user data, a CSRF
 *   token and the global-search blob. Nothing inside the kept region was edited.
 *   `parseTeamRosterHtml` and `parseTeamSeasonOptions` return byte-identical
 *   results on the trimmed and the raw page (checked once when they were made).
 *   Team 10002824's men's page is its real "No rosters found" page (it fields
 *   only a women's programme).
 * - `tests/fixtures/profile_fastest_times-1330318.json` is a real swimmer-times
 *   response. The fake server returns it for every swimmer id: the body's owner
 *   is not what these tests check, the requests are.
 *
 * Every page carries `<option value="29" selected>2025-2026`, so choosing
 * 2025-2026 makes a server that ignores `season_id` correct for that choice.
 * The mismatch tests choose another season on purpose.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { classifySwimCloudUrl } from '../packages/swimcloud/src/urlClassifier';
import { parseTeamRosterHtml } from '../packages/swimcloud/src/parser';
import { SWIMCLOUD_CHALLENGE_MESSAGE } from '../extensions/swimcloud-companion/src/crawlErrorPolicy';
import { MIN_DELAY_MS } from '../extensions/swimcloud-companion/src/crawlPacing';
import { BASE_BACKOFF_MS } from '../extensions/swimcloud-companion/src/rateLimitBackoff';
import { SWIMMER_TIMES_STAGGER_MS, collectSwimmerIds } from '../extensions/swimcloud-companion/src/swimmerTimes';
import {
  MultiTeamDriverError,
  PAUSE_POLL_MS,
  assertFetchableUrl,
  runMultiTeamCrawl,
  type MultiTeamControl,
  type MultiTeamDriverDeps,
  type MultiTeamDriverState,
  type MultiTeamFetchedPage,
  type MultiTeamRelayRequest,
  type MultiTeamSummary,
  type TeamSeasonChoice,
} from '../extensions/swimcloud-companion/src/multiTeamDriver';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures', 'swimcloud');
const SWIMMER_BODY = readFileSync(join(here, 'fixtures', 'profile_fastest_times-1330318.json'), 'utf8');

type Gender = 'M' | 'F';
const rosterPage = (team: string, gender: Gender): string =>
  readFileSync(join(fixturesDir, `team-${team}-roster-gender-${gender}-page.html`), 'utf8');

const PAGES: Record<string, string> = {};
for (const team of ['412', '10002824']) for (const g of ['M', 'F'] as const) PAGES[`${team}|${g}`] = rosterPage(team, g);

/** Swimmer ids per roster page, read by the real parser, in page order. */
function idsOf(team: string, gender: Gender, pages: Record<string, string> = PAGES): string[] {
  const parsed = parseTeamRosterHtml(pages[`${team}|${gender}`], {
    sourceUrl: `https://www.swimcloud.com/team/${team}/roster/?gender=${gender}`,
    retrievedAt: '2026-10-03T00:00:00.000Z',
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error('fixture does not parse');
  return collectSwimmerIds([parsed.data.athletes]).swimmerIds;
}

const IDS_412M = idsOf('412', 'M');
const IDS_412F = idsOf('412', 'F');
const IDS_10002824M = idsOf('10002824', 'M');
const IDS_10002824F = idsOf('10002824', 'F');
const ALL_IDS = [...IDS_412M, ...IDS_412F, ...IDS_10002824M, ...IDS_10002824F];

const swimmerUrl = (id: string): string => `https://www.swimcloud.com/api/swimmers/${id}/profile_fastest_times/`;
const seasonRosterUrl = (team: string, gender: Gender, seasonId: string): string =>
  `https://www.swimcloud.com/team/${team}/roster/?page=1&gender=${gender}&season_id=${seasonId}&sort=name`;
const optionsUrl = (team: string): string => `https://www.swimcloud.com/team/${team}/roster/?gender=M`;

const ROSTER_URL = /^https:\/\/www\.swimcloud\.com\/team\/(\d+)\/roster\/\?(?:page=1&)?gender=([MF])(?:&season_id=(\d+)&sort=name)?$/;

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly deps: MultiTeamDriverDeps;
  readonly control: MultiTeamControl;
  /** Every request, with the virtual time it started. */
  readonly fetches: { url: string; at: number }[];
  readonly relays: MultiTeamRelayRequest[];
  readonly sleeps: number[];
  readonly states: MultiTeamDriverState[];
  readonly saves: (readonly string[])[];
  readonly chooseCalls: number[];
}

interface HarnessOptions {
  /** Override one response. Return `null` for "use the default server". `n` counts requests from 1. */
  readonly respond?: (url: string, n: number) => MultiTeamFetchedPage | undefined | null;
  readonly pages?: Record<string, string>;
  readonly choose?: (teamId: string) => string | undefined;
  readonly finished?: readonly string[];
  /** Called after each request is answered, before the driver sees the answer. */
  readonly afterFetch?: (n: number, h: Harness) => void;
  /** Called on every sleep. */
  readonly onSleep?: (ms: number, h: Harness) => void;
  readonly relayOutcome?: () => 'landed' | 'lost' | 'streak-stop';
}

function makeHarness(options: HarnessOptions = {}): Harness {
  let t = 1_000_000;
  const pages = options.pages ?? PAGES;
  const control: MultiTeamControl = { cancelled: false, paused: false };
  const h: Harness = {
    control,
    fetches: [],
    relays: [],
    sleeps: [],
    states: [],
    saves: [],
    chooseCalls: [],
    // Filled below; `deps` closes over `h` through the const binding.
    deps: undefined as unknown as MultiTeamDriverDeps,
  };
  const defaultServe = (url: string): MultiTeamFetchedPage => {
    const roster = ROSTER_URL.exec(url);
    if (roster !== null) {
      // A server that ignores `season_id`: it always serves the page it has.
      const html = pages[`${roster[1]}|${roster[2]}`];
      if (html === undefined) return { html: 'not found', httpStatus: 404 };
      return { html, httpStatus: 200 };
    }
    if (/\/api\/swimmers\/\d+\/profile_fastest_times\/$/.test(url)) return { html: SWIMMER_BODY, httpStatus: 200 };
    return { html: 'not found', httpStatus: 404 };
  };
  const deps: MultiTeamDriverDeps = {
    async fetchPage(url) {
      h.fetches.push({ url, at: t });
      const n = h.fetches.length;
      t += 200; // the request takes a little while
      const override = options.respond === undefined ? null : options.respond(url, n);
      const answer = override === null ? defaultServe(url) : override; // `undefined` is a network error
      options.afterFetch?.(n, h);
      return answer;
    },
    async relay(request) {
      h.relays.push(request);
      return options.relayOutcome?.() ?? 'landed';
    },
    async sleep(ms) {
      h.sleeps.push(ms);
      t += ms;
      options.onSleep?.(ms, h);
    },
    now: () => t,
    isoNow: () => '2026-10-03T12:00:00.000Z',
    async loadFinished() {
      return options.finished ?? [];
    },
    async saveFinished(keys) {
      h.saves.push([...keys]);
    },
    onProgress(state) {
      h.states.push(state);
    },
    async chooseSeasons(reports) {
      h.chooseCalls.push(reports.length);
      const choices: TeamSeasonChoice[] = [];
      for (const report of reports) {
        if (report.options === undefined) continue;
        const label = options.choose === undefined ? '2025-2026' : options.choose(report.teamId);
        if (label !== undefined) choices.push({ teamId: report.teamId, seasonLabel: label });
      }
      return choices;
    },
    control,
  };
  return Object.assign(h, { deps });
}

const TEAMS = ['412', '10002824'] as const;
const run = (h: Harness, teamIds: readonly string[] = TEAMS): Promise<MultiTeamSummary> => runMultiTeamCrawl(h.deps, { teamIds });
const urls = (h: Harness): string[] => h.fetches.map((f) => f.url);

/** The roster-side URLs of the two-team run, in the order the queue hands them out. */
const EXPECTED_ROSTER_SIDE = [
  optionsUrl('412'),
  optionsUrl('10002824'),
  seasonRosterUrl('412', 'M', '29'),
  seasonRosterUrl('412', 'F', '29'),
  seasonRosterUrl('10002824', 'M', '29'),
  seasonRosterUrl('10002824', 'F', '29'),
];

/* -------------------------------------------------------------------------- */
/* (a) The dry run                                                             */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: full dry run on archived pages', () => {
  it('requests exactly the expected URLs, in order, once each', async () => {
    const h = makeHarness();
    const summary = await run(h);

    const expected = [...EXPECTED_ROSTER_SIDE, ...ALL_IDS.map(swimmerUrl)];
    expect(urls(h)).toEqual(expected);
    expect(summary.requestedUrls).toEqual(expected);
    expect(new Set(urls(h)).size).toBe(urls(h).length);
    // 2 season pages + 4 rosters + 89 distinct swimmers, pinned so fixture drift is loud.
    expect(ALL_IDS.length).toBe(89);
    expect(new Set(ALL_IDS).size).toBe(89);
    expect(urls(h).length).toBe(95);
    expect(summary.outcome).toBe('completed');
  });

  it('requests no denylisted URL: every request is a fetchable roster or fastest-times URL', async () => {
    const h = makeHarness();
    await run(h);
    for (const url of urls(h)) {
      const classified = classifySwimCloudUrl(url);
      expect(classified.outcome, url).toBe('fetchable');
      if (classified.outcome === 'fetchable') {
        expect(['teamRoster', 'swimmerFastestTimes'], url).toContain(classified.resource.kind);
      }
    }
    expect(urls(h).some((u) => /\/facilities\/|\/jsonapi\/|\/tz_detect\//.test(u))).toBe(false);
  });

  it('relays each fetched page once, under the right subject', async () => {
    const h = makeHarness();
    await run(h);
    expect(h.relays.map((r) => r.sourceUrl)).toEqual(urls(h));
    expect(h.relays.every((r) => r.httpStatus === 200)).toBe(true);
    const bySource = new Map(h.relays.map((r) => [r.sourceUrl, r.subject]));
    expect(bySource.get(optionsUrl('412'))).toEqual({ kind: 'team', teamId: '412' });
    expect(bySource.get(seasonRosterUrl('412', 'F', '29'))).toEqual({ kind: 'team', teamId: '412', season: '2025-2026' });
    expect(bySource.get(swimmerUrl(IDS_412M[0]))).toEqual({ kind: 'team', teamId: '412', season: '2025-2026' });
    expect(bySource.get(swimmerUrl(IDS_10002824F[0]))).toEqual({ kind: 'team', teamId: '10002824', season: '2025-2026' });
  });

  it('keeps the pacing: each request starts at least the gap after the previous one', async () => {
    const h = makeHarness();
    await run(h);
    expect(MIN_DELAY_MS).toBe(3000);
    expect(SWIMMER_TIMES_STAGGER_MS).toBe(3000);
    expect(BASE_BACKOFF_MS).toBe(MIN_DELAY_MS);
    for (let i = 1; i < h.fetches.length; i += 1) {
      const gap = h.fetches[i].at - h.fetches[i - 1].at;
      const floor = h.fetches[i].url.includes('/api/swimmers/') ? SWIMMER_TIMES_STAGGER_MS : MIN_DELAY_MS;
      expect(gap, h.fetches[i].url).toBeGreaterThanOrEqual(floor);
    }
  });

  it('saves finished swimmer keys after each swimmer and reports a per-team summary', async () => {
    const h = makeHarness();
    const summary = await run(h);
    expect(h.saves.length).toBe(89);
    expect(h.saves[h.saves.length - 1]).toEqual(ALL_IDS.map((id) => `swimmer|${id}`));
    const [a, b] = summary.teams;
    expect(a).toMatchObject({ teamId: '412', status: 'done', seasonLabel: '2025-2026', seasonId: '29', rostersDone: 2, swimmersDone: 62 });
    expect(b).toMatchObject({ teamId: '10002824', status: 'done', rostersDone: 2, swimmersDone: 27, emptyRosterGenders: ['M'] });
    expect(h.states[h.states.length - 1].phase).toBe('finished');
  });

  it('reads each team\'s season ids from its own page', async () => {
    // Team 10002824's pages print the same season as id 91. A driver that reused
    // team 412's table would send it to season 29.
    const pages = { ...PAGES };
    for (const g of ['M', 'F']) pages[`10002824|${g}`] = PAGES[`10002824|${g}`].replace('<option value="29" selected>', '<option value="91" selected>');
    expect(pages['10002824|F']).not.toBe(PAGES['10002824|F']);
    const h = makeHarness({ pages });
    await run(h);
    expect(urls(h)).toContain(seasonRosterUrl('412', 'M', '29'));
    expect(urls(h)).toContain(seasonRosterUrl('10002824', 'M', '91'));
    expect(urls(h)).toContain(seasonRosterUrl('10002824', 'F', '91'));
    expect(urls(h).some((u) => u.includes('10002824') && u.includes('season_id=29'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* (b) 403                                                                     */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: Cloudflare 403', () => {
  it('on the second roster, stops everything with no further fetch and no retry', async () => {
    const challenge = seasonRosterUrl('412', 'F', '29');
    const h = makeHarness({ respond: (url) => (url === challenge ? { html: 'Just a moment...', httpStatus: 403 } : null) });
    const summary = await run(h);
    expect(urls(h)).toEqual([...EXPECTED_ROSTER_SIDE.slice(0, 4)]);
    expect(urls(h).filter((u) => u === challenge).length).toBe(1);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toBe(SWIMCLOUD_CHALLENGE_MESSAGE);
    expect(summary.teams[0].rostersFailed).toBe(1);
    expect(urls(h).some((u) => u.includes('/api/swimmers/'))).toBe(false);
  });

  it('on a season page, stops before any roster is fetched', async () => {
    const h = makeHarness({ respond: (url) => (url === optionsUrl('10002824') ? { html: 'x', httpStatus: 403 } : null) });
    const summary = await run(h);
    expect(urls(h)).toEqual([optionsUrl('412'), optionsUrl('10002824')]);
    expect(summary.outcome).toBe('halted');
    expect(h.chooseCalls).toEqual([]);
  });

  it('on a swimmer request, stops at that swimmer', async () => {
    const bad = swimmerUrl(ALL_IDS[2]);
    const h = makeHarness({ respond: (url) => (url === bad ? { html: 'x', httpStatus: 403 } : null) });
    const summary = await run(h);
    expect(urls(h).length).toBe(6 + 3);
    expect(urls(h)[urls(h).length - 1]).toBe(bad);
    expect(summary.outcome).toBe('halted');
  });
});

/* -------------------------------------------------------------------------- */
/* (c) resume                                                                  */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: resume', () => {
  it('skips swimmers a saved run finished and keeps their keys when saving', async () => {
    const finished = [...ALL_IDS.slice(0, 3).map((id) => `swimmer|${id}`), 'swimmer|999999999'];
    const h = makeHarness({ finished });
    const summary = await run(h);
    const requested = urls(h);
    for (const id of ALL_IDS.slice(0, 3)) expect(requested).not.toContain(swimmerUrl(id));
    expect(requested.length).toBe(95 - 3);
    expect(requested.filter((u) => u.includes('/api/swimmers/'))).toEqual(ALL_IDS.slice(3).map(swimmerUrl));
    expect(summary.teams[0].swimmersSkippedResumed).toBe(3);
    // The union is saved: this run's keys plus the one key no chosen roster listed.
    const last = h.saves[h.saves.length - 1];
    expect(last).toContain('swimmer|999999999');
    expect(last).toEqual(expect.arrayContaining(ALL_IDS.map((id) => `swimmer|${id}`)));
  });

  it('always fetches roster pages again', async () => {
    const finished = ALL_IDS.map((id) => `swimmer|${id}`);
    const h = makeHarness({ finished });
    await run(h);
    expect(urls(h)).toEqual(EXPECTED_ROSTER_SIDE);
  });
});

/* -------------------------------------------------------------------------- */
/* (d) cancel, (e) pause                                                       */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: cancel and pause', () => {
  it('cancel mid-run issues no more fetches, but the page in flight is relayed', async () => {
    const h = makeHarness({
      afterFetch: (n, hh) => {
        if (n === 8) hh.control.cancelled = true;
      },
    });
    const summary = await run(h);
    expect(urls(h).length).toBe(8);
    expect(h.relays.length).toBe(8);
    expect(summary.outcome).toBe('cancelled');
    expect(h.states[h.states.length - 1].queue?.cancelled).toBe(true);
  });

  it('cancel before the season choice fetches nothing more and asks nothing', async () => {
    const h = makeHarness({
      afterFetch: (n, hh) => {
        if (n === 1) hh.control.cancelled = true;
      },
    });
    const summary = await run(h);
    expect(urls(h)).toEqual([optionsUrl('412')]);
    expect(h.chooseCalls).toEqual([]);
    expect(summary.outcome).toBe('cancelled');
  });

  it('pause holds all fetching, resume continues the same run', async () => {
    let pollsSeen = 0;
    let fetchesWhenPaused = -1;
    const h = makeHarness({
      afterFetch: (n, hh) => {
        if (n === 7) hh.control.paused = true; // the first swimmer request
      },
      onSleep: (ms, hh) => {
        if (ms !== PAUSE_POLL_MS || !hh.control.paused) return;
        pollsSeen += 1;
        if (pollsSeen === 1) fetchesWhenPaused = hh.fetches.length;
        if (pollsSeen === 4) hh.control.paused = false;
      },
    });
    const summary = await run(h);
    expect(pollsSeen).toBe(4);
    expect(fetchesWhenPaused).toBe(7);
    expect(h.states.some((s) => s.queue?.paused === true)).toBe(true);
    expect(urls(h)).toEqual([...EXPECTED_ROSTER_SIDE, ...ALL_IDS.map(swimmerUrl)]);
    expect(summary.outcome).toBe('completed');
    expect(h.states[h.states.length - 1].queue?.paused).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* (f) season mismatch, (g) unavailable season                                 */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: seasons', () => {
  it('a server that ignores season_id fails that roster and fetches no swimmers for it', async () => {
    // Team 412 is asked for 2024-2025 (id 28). The fake server answers with the
    // current season page (id 29 selected) as it always does.
    const h = makeHarness({ choose: (team) => (team === '412' ? '2024-2025' : '2025-2026') });
    const summary = await run(h);
    expect(urls(h)).toContain(seasonRosterUrl('412', 'M', '28'));
    expect(urls(h)).toContain(seasonRosterUrl('412', 'F', '28'));
    const swimmerRequests = urls(h).filter((u) => u.includes('/api/swimmers/'));
    expect(swimmerRequests).toEqual([...IDS_10002824M, ...IDS_10002824F].map(swimmerUrl));
    for (const id of [...IDS_412M, ...IDS_412F]) expect(swimmerRequests).not.toContain(swimmerUrl(id));
    const t412 = summary.teams[0];
    expect(t412).toMatchObject({ rostersDone: 0, rostersFailed: 2, swimmersDone: 0, status: 'done-with-errors' });
    expect(t412.errors[0]).toContain('shows season 2025-2026 (id 29)');
    expect(t412.errors[0]).toContain('asked for season 2024-2025 (id 28)');
    // The wrong-season pages are not filed under the chosen season.
    expect(h.relays.some((r) => r.sourceUrl.includes('season_id=28'))).toBe(false);
    expect(summary.teams[1]).toMatchObject({ status: 'done', swimmersDone: 27 });
  });

  it('a season label missing from the team\'s own page fetches nothing for that team', async () => {
    const h = makeHarness({ choose: (team) => (team === '412' ? '2031-2032' : '2025-2026') });
    const summary = await run(h);
    expect(urls(h).filter((u) => u.includes('/team/412/'))).toEqual([optionsUrl('412')]);
    expect(urls(h).filter((u) => u.includes('/api/swimmers/'))).toEqual([...IDS_10002824M, ...IDS_10002824F].map(swimmerUrl));
    expect(summary.teams[0].status).toBe('season-unavailable');
    expect(summary.teams[0].availableLabels).toContain('2025-2026');
    expect(summary.teams[0].errors[0]).toContain('is not offered');
    expect(summary.teams[1].status).toBe('done');
  });

  it('a team the user did not pick a season for is not crawled', async () => {
    const h = makeHarness({ choose: (team) => (team === '412' ? undefined : '2025-2026') });
    const summary = await run(h);
    expect(urls(h).filter((u) => u.includes('/team/412/'))).toEqual([optionsUrl('412')]);
    expect(summary.teams[0].status).toBe('not-chosen');
  });

  it('a season page without a readable season list is reported and the other team goes on', async () => {
    const pages = { ...PAGES, '412|M': '<html><body>nothing here</body></html>' };
    const h = makeHarness({ pages });
    const summary = await run(h);
    expect(summary.teams[0].status).toBe('seasons-unreadable');
    expect(summary.teams[0].errors[0]).toContain('could not be read');
    expect(summary.teams[1].status).toBe('done');
    expect(urls(h).filter((u) => u.includes('/team/412/'))).toEqual([optionsUrl('412')]);
  });
});

/* -------------------------------------------------------------------------- */
/* (h) 429                                                                     */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: rate limiting', () => {
  const limited = (): MultiTeamFetchedPage => ({ html: 'slow down', httpStatus: 429 });

  it('three consecutive give-ups halt the crawl', async () => {
    const h = makeHarness({ respond: (url) => (url.includes('/api/swimmers/') ? limited() : null) });
    const summary = await run(h);
    // 6 roster-side requests, then 3 swimmers x (1 try + 3 retries).
    expect(urls(h).length).toBe(6 + 3 * 4);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toContain('rate-limited 3 pages in a row');
    expect(new Set(urls(h).slice(6)).size).toBe(3);
    // Backoff only ever waits longer than the pacing floor: 3 s, 6 s, 12 s.
    const backoffs = h.sleeps.filter((ms) => ms >= BASE_BACKOFF_MS);
    expect(backoffs.slice(0, 3)).toEqual([3000, 6000, 12000]);
  });

  it('two give-ups then a success do not halt', async () => {
    const first = [swimmerUrl(ALL_IDS[0]), swimmerUrl(ALL_IDS[1])];
    const h = makeHarness({ respond: (url) => (first.includes(url) ? limited() : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
    expect(summary.teams[0].swimmersFailed).toBe(2);
    expect(summary.teams[0].errors.some((e) => e.includes('rate-limited (HTTP 429) after retries'))).toBe(true);
  });

  it('a 429 that clears on retry is a normal success', async () => {
    const target = swimmerUrl(ALL_IDS[0]);
    let seen = 0;
    const h = makeHarness({
      respond: (url) => {
        if (url !== target) return null;
        seen += 1;
        return seen === 1 ? { html: 'slow down', httpStatus: 429, retryAfter: '5' } : null;
      },
    });
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
    expect(urls(h).filter((u) => u === target).length).toBe(2);
    expect(h.sleeps).toContain(5000);
  });
});

/* -------------------------------------------------------------------------- */
/* Other halts and failures                                                    */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: other outcomes', () => {
  it('a 5xx halts', async () => {
    const h = makeHarness({ respond: (url) => (url === seasonRosterUrl('412', 'M', '29') ? { html: 'x', httpStatus: 503 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(urls(h).length).toBe(3);
  });

  it('a network error halts', async () => {
    const h = makeHarness({ respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? undefined : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toContain('network error');
    expect(urls(h).length).toBe(7);
  });

  it('a 404 swimmer is a failure of that swimmer, not a halt', async () => {
    const h = makeHarness({ respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? { html: 'gone', httpStatus: 404 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
    expect(summary.teams[0].swimmersFailed).toBe(1);
    expect(summary.teams[0].errors[0]).toContain(`swimmer ${ALL_IDS[0]}`);
    // A failed swimmer is not remembered as finished.
    expect(h.saves[h.saves.length - 1]).not.toContain(`swimmer|${ALL_IDS[0]}`);
  });

  it('a 404 roster page is a failure, not an empty roster', async () => {
    const h = makeHarness({ respond: (url) => (url === seasonRosterUrl('412', 'F', '29') ? { html: 'gone', httpStatus: 404 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
    expect(summary.teams[0]).toMatchObject({ rostersDone: 1, rostersFailed: 1 });
    expect(summary.teams[0].emptyRosterGenders).toEqual([]);
  });

  it('a swimmer body that is not JSON halts and is not relayed', async () => {
    const bad = swimmerUrl(ALL_IDS[0]);
    const h = makeHarness({ respond: (url) => (url === bad ? { html: '<html>Just a moment...</html>', httpStatus: 200 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toContain('not JSON');
    expect(h.relays.some((r) => r.sourceUrl === bad)).toBe(false);
    expect(h.saves).toEqual([]);
  });

  it('a relay streak halts the run', async () => {
    const h = makeHarness({ relayOutcome: () => 'streak-stop' });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(urls(h).length).toBe(1);
  });

  it('a repeated team id is refused before any fetch', async () => {
    const h = makeHarness();
    await expect(run(h, ['412', '412'])).rejects.toMatchObject({ code: 'duplicate-team' });
    expect(h.fetches).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The denylist                                                                */
/* -------------------------------------------------------------------------- */

describe('multi-team driver: denylist assertion', () => {
  it('passes the two kinds the driver fetches', () => {
    expect(() => assertFetchableUrl(optionsUrl('412'), 'teamRoster')).not.toThrow();
    expect(() => assertFetchableUrl(seasonRosterUrl('412', 'F', '29'), 'teamRoster')).not.toThrow();
    expect(() => assertFetchableUrl(swimmerUrl('1330318'), 'swimmerFastestTimes')).not.toThrow();
  });

  it.each([
    ['https://www.swimcloud.com/team/412/facilities/', 'teamRoster'],
    ['https://www.swimcloud.com/api/swimmers/1330318/other/', 'swimmerFastestTimes'],
    ['https://www.swimcloud.com/jsonapi/x', 'teamRoster'],
    ['https://www.swimcloud.com/tz_detect/', 'teamRoster'],
    ['https://example.com/team/412/roster/?gender=M', 'teamRoster'],
    ['https://www.swimcloud.com/swimmer/1330318/times/', 'swimmerFastestTimes'],
    [swimmerUrl('1330318'), 'teamRoster'],
  ] as const)('refuses %s', (url, kind) => {
    expect(() => assertFetchableUrl(url, kind)).toThrow(MultiTeamDriverError);
  });
});
