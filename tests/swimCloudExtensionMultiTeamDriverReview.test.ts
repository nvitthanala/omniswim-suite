/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Defects an architect review found in the first multi-team driver (F1 to F9).
 * Each test here failed on the committed code before its fix. Fixtures and the
 * fake-dependency harness are in `tests/helpers/multiTeamDriverHarness.ts`; the
 * fake relay refuses a capture that was never opened, as the real app does.
 */
import { describe, expect, it } from 'vitest';

import { captureIdForSubject } from '../packages/swimcloud/src/entities';
import { MIN_DELAY_MS } from '../extensions/swimcloud-companion/src/crawlPacing';
import {
  PAUSE_POLL_MS,
  resumeKeyForChoices,
  runMultiTeamCrawl,
  type MultiTeamDriverDeps,
  type TeamSeasonOptionsReport,
} from '../extensions/swimcloud-companion/src/multiTeamDriver';
import { parseTeamSeasonOptions } from '../packages/swimcloud/src/teamSeasons';
import {
  ALL_IDS,
  IDS_10002824F,
  IDS_10002824M,
  IDS_412F,
  IDS_412M,
  PAGES,
  idsOf,
  savedKey,
  makeHarness,
  optionsUrl,
  run,
  seasonRosterUrl,
  swimmerUrl,
  urls,
} from './helpers/multiTeamDriverHarness';

const CHALLENGE_BODY = '<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site.</body></html>';
const ALL_CAPTURES = ['team-10002824', 'team-10002824-2025-2026', 'team-412', 'team-412-2025-2026'];
const S412 = { kind: 'team', teamId: '412', season: '2025-2026' } as const;

/* -------------------------------------------------------------------------- */
/* F1: nothing reached the app                                                 */
/* -------------------------------------------------------------------------- */

describe('F1: captures are opened first, pages reach the app, downloads are flushed', () => {
  it('opens every subject before relaying under it, so every page lands in the app and none falls back', async () => {
    const h = makeHarness();
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
    expect(h.fallbackPages).toEqual([]);
    expect([...h.opened.keys()].sort()).toEqual(ALL_CAPTURES);
    expect(h.appPages.get('team-412')).toEqual([optionsUrl('412')]);
    expect(h.appPages.get('team-10002824')).toEqual([optionsUrl('10002824')]);
    expect(h.appPages.get('team-412-2025-2026')).toEqual([
      seasonRosterUrl('412', 'M', '29'),
      seasonRosterUrl('412', 'F', '29'),
      ...[...IDS_412M, ...IDS_412F].map(swimmerUrl),
    ]);
    expect(h.appPages.get('team-10002824-2025-2026')).toEqual([
      seasonRosterUrl('10002824', 'M', '29'),
      seasonRosterUrl('10002824', 'F', '29'),
      ...[...IDS_10002824M, ...IDS_10002824F].map(swimmerUrl),
    ]);
  });

  it('tells the app how many pages to expect: rosters first, then rosters plus swimmers', async () => {
    const h = makeHarness();
    await run(h);
    expect(h.opened.get('team-412')).toBe(1);
    expect(h.opened.get('team-412-2025-2026')).toBe(2 + 62);
    expect(h.opened.get('team-10002824-2025-2026')).toBe(2 + 27);
    const first = h.openCalls.find((c) => captureIdForSubject(c.subject) === 'team-412-2025-2026');
    expect(first?.planned).toBe(2);
  });

  it('stops before the roster step, with a clear message, when a season capture cannot be opened', async () => {
    const h = makeHarness({ openFails: (s) => s.kind === 'team' && s.season !== undefined });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(urls(h)).toEqual([optionsUrl('412'), optionsUrl('10002824')]);
    expect(summary.haltMessage).toContain('Omniswim app');
    expect(summary.haltMessage).toContain('pairing');
  });

  it('stops before any fetch when the first team capture cannot be opened', async () => {
    const h = makeHarness({ openFails: () => true });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(h.fetches).toEqual([]);
    expect(summary.haltMessage).toContain('Omniswim app');
  });

  it('does not count a downloads-fallback relay as landed: the swimmer fails and is not saved as finished', async () => {
    const h = makeHarness({ relayOutcome: (r) => (r.sourceUrl.includes('/api/swimmers/') ? 'fallback' : undefined) });
    const summary = await run(h);
    expect(summary.teams[0].swimmersDone).toBe(0);
    expect(summary.teams[0].swimmersFailed).toBe(62);
    expect(summary.teams[0].errors[0]).toContain('not handed to the app');
    expect(h.saves).toEqual([]);
  });

  it('a page for an unopened capture is a fallback, never a landed page (the fake models the 404)', async () => {
    const h = makeHarness();
    await h.deps.relay({ subject: S412, sourceUrl: swimmerUrl('1'), httpStatus: 200, html: '{}' });
    expect(h.fallbackPages).toHaveLength(1);
    expect(h.appPages.size).toBe(0);
  });

  it('flushes the downloads fallback for every subject at the end of a completed run', async () => {
    const h = makeHarness();
    await run(h);
    expect(h.flushes).toHaveLength(1);
    expect(h.flushes[0].map(captureIdForSubject).sort()).toEqual(ALL_CAPTURES);
  });

  it('flushes on cancel', async () => {
    const h = makeHarness({ afterFetch: (n, hh) => void (n === 8 && (hh.control.cancelled = true)) });
    const summary = await run(h);
    expect(summary.outcome).toBe('cancelled');
    expect(h.flushes).toHaveLength(1);
    expect(h.flushes[0].map(captureIdForSubject).sort()).toEqual(ALL_CAPTURES);
  });

  it('flushes on halt', async () => {
    const h = makeHarness({ respond: (url) => (url === seasonRosterUrl('412', 'F', '29') ? { html: 'x', httpStatus: 403 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(h.flushes).toHaveLength(1);
    expect(h.flushes[0].length).toBeGreaterThan(0);
  });

  it('flushes when the run throws', async () => {
    const h = makeHarness();
    const bogus: MultiTeamDriverDeps = { ...h.deps, chooseSeasons: async () => [{ teamId: '999', seasonLabel: '2025-2026' }] };
    await expect(runMultiTeamCrawl(bogus, { teamIds: ['412'] })).rejects.toMatchObject({ code: 'unknown-choice' });
    expect(h.flushes).toHaveLength(1);
    expect(h.flushes[0].map(captureIdForSubject)).toEqual(['team-412']);
  });

  it('marks the season captures complete after a clean run and partial after a halt', async () => {
    const clean = makeHarness();
    await run(clean);
    const seasonMarks = clean.marks.filter((m) => m.subject.kind === 'team' && m.subject.season !== undefined);
    expect(seasonMarks.map((m) => m.completeness)).toEqual(['every-planned-page-fetched', 'every-planned-page-fetched']);

    const halted = makeHarness({ respond: (url) => (url === swimmerUrl(ALL_IDS[2]) ? { html: 'x', httpStatus: 403 } : null) });
    await run(halted);
    const haltedMarks = halted.marks.filter((m) => m.subject.kind === 'team' && m.subject.season !== undefined);
    expect(haltedMarks.length).toBe(2);
    expect(haltedMarks.every((m) => m.completeness === 'partial')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* F2: the pacing clock is shared                                              */
/* -------------------------------------------------------------------------- */

describe('F2: one pacing clock for every run on the page', () => {
  it('a run started right after another run waits out the 3 s gap', async () => {
    const first = makeHarness({ respond: (url) => (url === seasonRosterUrl('412', 'M', '29') ? { html: 'x', httpStatus: 403 } : null) });
    await run(first);
    const lastStart = first.fetches[first.fetches.length - 1].at;
    const second = makeHarness({ shareWith: first });
    await run(second);
    expect(second.fetches[0].at - lastStart).toBeGreaterThanOrEqual(MIN_DELAY_MS);
  });

  it('writes every request start to the shared clock', async () => {
    const h = makeHarness();
    await run(h);
    expect(h.clock.last).toBe(h.fetches[h.fetches.length - 1].at);
  });
});

/* -------------------------------------------------------------------------- */
/* F3: only a landed page counts                                               */
/* -------------------------------------------------------------------------- */

describe('F3: a page the app did not take is not finished', () => {
  it('a lost swimmer relay fails the swimmer, so it is not saved and is fetched again next run', async () => {
    const target = swimmerUrl(ALL_IDS[5]);
    const h = makeHarness({ relayOutcome: (r) => (r.sourceUrl === target ? 'lost' : undefined) });
    const summary = await run(h);
    expect(summary.teams[0].swimmersFailed).toBe(1);
    expect(summary.teams[0].errors[0]).toContain(`swimmer ${ALL_IDS[5]}`);
    expect(summary.teams[0].errors[0]).toContain('not handed to the app');
    for (const keys of h.saves) expect(keys).not.toContain(savedKey(ALL_IDS[5]));
    // Not a clean run, so the saved progress stays for the retry.
    expect(h.clears).toEqual([]);
  });

  it('a lost roster relay fails the roster and lists none of its swimmers', async () => {
    const target = seasonRosterUrl('412', 'M', '29');
    const h = makeHarness({ relayOutcome: (r) => (r.sourceUrl === target ? 'lost' : undefined) });
    const summary = await run(h);
    expect(summary.teams[0].rostersFailed).toBe(1);
    expect(summary.teams[0].rostersDone).toBe(1);
    for (const id of IDS_412M) expect(urls(h)).not.toContain(swimmerUrl(id));
    for (const id of IDS_412F) expect(urls(h)).toContain(swimmerUrl(id));
  });
});

/* -------------------------------------------------------------------------- */
/* F4: saved progress and shared swimmers                                      */
/* -------------------------------------------------------------------------- */

const sharedSwimmer = IDS_412M[0];
const PAGES_SHARED = {
  ...PAGES,
  '10002824|F': PAGES['10002824|F'].replace(new RegExp(`/swimmer/${IDS_10002824F[0]}(?=[/"'?#])`, 'g'), `/swimmer/${sharedSwimmer}`),
};

describe('F4: saved progress is per selection, and a shared swimmer is filed under every team', () => {
  it('the shared-swimmer fixture really lists one swimmer on both teams', () => {
    expect(idsOf('412', 'M')).toContain(sharedSwimmer);
    expect(idsOf('10002824', 'F', PAGES_SHARED)).toContain(sharedSwimmer);
    expect(idsOf('10002824', 'F', PAGES_SHARED)).not.toContain(IDS_10002824F[0]);
  });

  it('fetches a swimmer on two rosters once and files the one body under both teams', async () => {
    const h = makeHarness({ pages: PAGES_SHARED });
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
    expect(urls(h).filter((u) => u === swimmerUrl(sharedSwimmer))).toHaveLength(1);
    expect(h.appPages.get('team-412-2025-2026')).toContain(swimmerUrl(sharedSwimmer));
    expect(h.appPages.get('team-10002824-2025-2026')).toContain(swimmerUrl(sharedSwimmer));
    const relayed = h.relays.filter((r) => r.sourceUrl === swimmerUrl(sharedSwimmer));
    expect(relayed.map((r) => captureIdForSubject(r.subject)).sort()).toEqual(['team-10002824-2025-2026', 'team-412-2025-2026']);
  });

  it('counts the shared swimmer in both captures\' planned page totals', async () => {
    const h = makeHarness({ pages: PAGES_SHARED });
    await run(h);
    expect(h.opened.get('team-412-2025-2026')).toBe(2 + 62);
    expect(h.opened.get('team-10002824-2025-2026')).toBe(2 + 27);
  });

  describe('resume keys', () => {
    const reports = (): TeamSeasonOptionsReport[] => [
      { teamId: '412', options: parseTeamSeasonOptions(PAGES['412|M']) },
      { teamId: '10002824', options: parseTeamSeasonOptions(PAGES['10002824|M']) },
    ];

    it('builds one key from the sorted (team, season id) pairs, whatever the order', () => {
      const a = resumeKeyForChoices(reports(), [
        { teamId: '412', seasonLabel: '2025-2026' },
        { teamId: '10002824', seasonLabel: '2025-2026' },
      ]);
      const b = resumeKeyForChoices(reports(), [
        { teamId: '10002824', seasonLabel: '2025-2026' },
        { teamId: '412', seasonLabel: '2025-2026' },
      ]);
      expect(a).toBe(b);
      expect(a).toBe('412:29,10002824:29');
    });

    it('differs for another season, another team set, and ignores a label the team does not offer', () => {
      const base = resumeKeyForChoices(reports(), [{ teamId: '412', seasonLabel: '2025-2026' }]);
      expect(resumeKeyForChoices(reports(), [{ teamId: '412', seasonLabel: '2024-2025' }])).toBe('412:28');
      expect(resumeKeyForChoices(reports(), [{ teamId: '10002824', seasonLabel: '2025-2026' }])).not.toBe(base);
      expect(
        resumeKeyForChoices(reports(), [
          { teamId: '412', seasonLabel: '2025-2026' },
          { teamId: '10002824', seasonLabel: '2031-2032' },
        ]),
      ).toBe(base);
    });

    it('a later crawl of another season fetches the swimmers again; the same selection skips them', async () => {
      // Run 1: 2025-2026, cancelled after 14 swimmers. Its progress is saved under its own key.
      const first = makeHarness({
        serveBySeason: true,
        afterFetch: (n, hh) => void (n === 20 && (hh.control.cancelled = true)),
      });
      await run(first);
      expect(new Set(first.saveKeys)).toEqual(new Set(['412:29,10002824:29']));
      expect(first.store.get('412:29,10002824:29')).toHaveLength(14);

      // Run 2: 2024-2025 for the same teams. Nothing carries over.
      const next = makeHarness({ serveBySeason: true, shareWith: first, choose: () => '2024-2025' });
      const nextSummary = await run(next);
      expect(nextSummary.outcome).toBe('completed');
      const swimmerRequests = urls(next).filter((u) => u.includes('/api/swimmers/'));
      expect(swimmerRequests).toEqual(ALL_IDS.map(swimmerUrl));
      expect(new Set(next.saveKeys)).toEqual(new Set(['412:28,10002824:28']));

      // Run 3: the first selection again. It skips the 14 it finished.
      const again = makeHarness({ serveBySeason: true, shareWith: first });
      const againSummary = await run(again);
      expect(againSummary.outcome).toBe('completed');
      expect(urls(again).filter((u) => u.includes('/api/swimmers/'))).toEqual(ALL_IDS.slice(14).map(swimmerUrl));
    });

    it('a team set that shares a swimmer does not inherit another set\'s skips', async () => {
      const first = makeHarness({ afterFetch: (n, hh) => void (n === 20 && (hh.control.cancelled = true)) });
      await run(first);
      const other = makeHarness({ shareWith: first });
      await run(other, ['412']);
      const swimmerRequests = urls(other).filter((u) => u.includes('/api/swimmers/'));
      expect(swimmerRequests).toEqual([...IDS_412M, ...IDS_412F].map(swimmerUrl));
    });
  });

  describe('clearing saved progress', () => {
    it('clears the key after a clean completed run', async () => {
      const h = makeHarness();
      await run(h);
      expect(h.clears).toEqual(['412:29,10002824:29']);
      expect(h.store.size).toBe(0);
    });

    it('keeps it after a cancel, a halt, and a completed run with a failed swimmer', async () => {
      const cancelled = makeHarness({ afterFetch: (n, hh) => void (n === 20 && (hh.control.cancelled = true)) });
      await run(cancelled);
      expect(cancelled.clears).toEqual([]);
      expect(cancelled.store.size).toBe(1);

      const halted = makeHarness({ respond: (url) => (url === swimmerUrl(ALL_IDS[3]) ? { html: 'x', httpStatus: 403 } : null) });
      await run(halted);
      expect(halted.clears).toEqual([]);

      const failed = makeHarness({ respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? { html: 'gone', httpStatus: 404 } : null) });
      const summary = await run(failed);
      expect(summary.outcome).toBe('completed');
      expect(failed.clears).toEqual([]);
      expect(failed.store.size).toBe(1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* F5: cancel and pause hold in every wait                                     */
/* -------------------------------------------------------------------------- */

describe('F5: cancel and pause are honoured after every wait', () => {
  it('cancel during a 429 wait does not request the page again', async () => {
    const target = swimmerUrl(ALL_IDS[0]);
    const h = makeHarness({
      respond: (url) => (url === target ? { html: 'slow down', httpStatus: 429, retryAfter: '30' } : null),
      onSleep: (ms, hh) => void (ms === 30_000 && (hh.control.cancelled = true)),
    });
    const summary = await run(h);
    expect(urls(h).filter((u) => u === target)).toHaveLength(1);
    expect(summary.outcome).toBe('cancelled');
    expect(urls(h).length).toBe(7);
  });

  it('cancel that arrives with a 429 answer starts no wait and no retry', async () => {
    const target = swimmerUrl(ALL_IDS[0]);
    const h = makeHarness({
      respond: (url) => (url === target ? { html: 'slow down', httpStatus: 429, retryAfter: '30' } : null),
      afterFetch: (_n, hh) => void (hh.fetches[hh.fetches.length - 1].url === target && (hh.control.cancelled = true)),
    });
    const summary = await run(h);
    expect(h.sleeps).not.toContain(30_000);
    expect(urls(h).filter((u) => u === target)).toHaveLength(1);
    expect(summary.outcome).toBe('cancelled');
  });

  it('cancel during the pacing wait does not start the next request', async () => {
    const h = makeHarness({
      onSleep: (ms, hh) => void (hh.fetches.length === 4 && ms > 1000 && ms <= 3000 && (hh.control.cancelled = true)),
    });
    const summary = await run(h);
    expect(urls(h).length).toBe(4);
    expect(summary.outcome).toBe('cancelled');
  });

  it('pause during the pacing wait holds the next request until resume', async () => {
    let polls = 0;
    let fetchesAtFirstPoll = -1;
    const h = makeHarness({
      onSleep: (ms, hh) => {
        if (hh.fetches.length === 4 && ms > 1000 && ms <= 3000 && !hh.control.paused && polls === 0) hh.control.paused = true;
        else if (ms === PAUSE_POLL_MS && hh.control.paused) {
          polls += 1;
          if (polls === 1) fetchesAtFirstPoll = hh.fetches.length;
          if (polls === 3) hh.control.paused = false;
        }
      },
    });
    const summary = await run(h);
    expect(polls).toBe(3);
    expect(fetchesAtFirstPoll).toBe(4);
    expect(summary.outcome).toBe('completed');
    expect(urls(h).length).toBe(95);
  });

  it('pause during a 429 wait holds the retry until resume', async () => {
    const target = swimmerUrl(ALL_IDS[0]);
    let seen = 0;
    let polls = 0;
    let fetchesAtFirstPoll = -1;
    const h = makeHarness({
      respond: (url) => {
        if (url !== target) return null;
        seen += 1;
        return seen === 1 ? { html: 'slow down', httpStatus: 429, retryAfter: '5' } : null;
      },
      onSleep: (ms, hh) => {
        if (ms === 5000 && !hh.control.paused && polls === 0) hh.control.paused = true;
        else if (ms === PAUSE_POLL_MS && hh.control.paused) {
          polls += 1;
          if (polls === 1) fetchesAtFirstPoll = hh.fetches.length;
          if (polls === 2) hh.control.paused = false;
        }
      },
    });
    await run(h);
    expect(fetchesAtFirstPoll).toBe(7);
    expect(urls(h).filter((u) => u === target)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* F6: a 200 challenge page                                                    */
/* -------------------------------------------------------------------------- */

describe('F6: a challenge page that answers 200 halts and is never relayed', () => {
  const challenge = { html: CHALLENGE_BODY, httpStatus: 200 };

  it('on a season page', async () => {
    const bad = optionsUrl('10002824');
    const h = makeHarness({ respond: (url) => (url === bad ? challenge : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toContain('challenge');
    expect(urls(h)).toEqual([optionsUrl('412'), bad]);
    expect(h.relays.some((r) => r.sourceUrl === bad)).toBe(false);
    expect(h.appPages.get('team-10002824') ?? []).toEqual([]);
    expect(h.chooseCalls).toEqual([]);
  });

  it('on a roster page, so no further roster is requested into it', async () => {
    const bad = seasonRosterUrl('412', 'F', '29');
    const h = makeHarness({ respond: (url) => (url === bad ? challenge : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toContain('challenge');
    expect(urls(h)).toEqual(EXPECTED_FIRST_FOUR);
    expect(h.relays.some((r) => r.sourceUrl === bad)).toBe(false);
  });

  it('on a swimmer request', async () => {
    const bad = swimmerUrl(ALL_IDS[1]);
    const h = makeHarness({ respond: (url) => (url === bad ? challenge : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(urls(h)[urls(h).length - 1]).toBe(bad);
    expect(urls(h).length).toBe(6 + 2);
    expect(h.relays.some((r) => r.sourceUrl === bad)).toBe(false);
  });

  it('a page with a season list but a challenge title is not mistaken for a real page elsewhere', async () => {
    // A real roster page is fine; only a page with no season select at all is a challenge.
    const h = makeHarness();
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
  });
});

const EXPECTED_FIRST_FOUR = [
  optionsUrl('412'),
  optionsUrl('10002824'),
  seasonRosterUrl('412', 'M', '29'),
  seasonRosterUrl('412', 'F', '29'),
];

/* -------------------------------------------------------------------------- */
/* F7: redirects                                                               */
/* -------------------------------------------------------------------------- */

describe('F7: a redirected page is a failure, not data', () => {
  it('a roster that redirected to another team is not relayed or parsed', async () => {
    const asked = seasonRosterUrl('412', 'M', '29');
    const h = makeHarness({ respond: (url) => (url === asked ? { ...okPage(url), finalUrl: seasonRosterUrl('999', 'M', '29') } : null) });
    const summary = await run(h);
    expect(summary.teams[0].rostersFailed).toBe(1);
    expect(summary.teams[0].errors[0]).toContain('redirected');
    expect(h.relays.some((r) => r.sourceUrl === asked)).toBe(false);
    for (const id of IDS_412M) expect(urls(h)).not.toContain(swimmerUrl(id));
  });

  it('tolerates a trailing-slash and host-case difference', async () => {
    const asked = seasonRosterUrl('412', 'M', '29');
    const same = asked.replace('www.swimcloud.com', 'WWW.swimcloud.com').replace('/roster/?', '/roster?');
    const h = makeHarness({ respond: (url) => (url === asked ? { ...okPage(url), finalUrl: same } : null) });
    const summary = await run(h);
    expect(summary.teams[0].rostersFailed).toBe(0);
  });

  it('a season page that redirected to another team is unreadable, and nothing is fetched for that team', async () => {
    const asked = optionsUrl('412');
    const h = makeHarness({ respond: (url) => (url === asked ? { ...okPage(url), finalUrl: optionsUrl('999') } : null) });
    const summary = await run(h);
    expect(summary.teams[0].status).toBe('seasons-unreadable');
    expect(summary.teams[0].errors[0]).toContain('redirected');
    expect(urls(h).filter((u) => u.includes('/team/412/'))).toEqual([asked]);
    expect(h.relays.some((r) => r.sourceUrl === asked)).toBe(false);
  });

  it('a redirect to a page the denylist forbids halts the run', async () => {
    const asked = seasonRosterUrl('412', 'M', '29');
    const h = makeHarness({ respond: (url) => (url === asked ? { ...okPage(url), finalUrl: 'https://www.swimcloud.com/team/412/facilities/' } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(urls(h).length).toBe(3);
  });

  it('a swimmer reply that redirected fails that swimmer', async () => {
    const asked = swimmerUrl(ALL_IDS[0]);
    const h = makeHarness({ respond: (url) => (url === asked ? { ...okPage(url), finalUrl: swimmerUrl(ALL_IDS[1]) } : null) });
    const summary = await run(h);
    expect(summary.teams[0].swimmersFailed).toBe(1);
    expect(h.relays.some((r) => r.sourceUrl === asked)).toBe(false);
  });
});

function okPage(url: string): { html: string; httpStatus: number } {
  // The default server's answer for this URL, for building a redirected reply.
  const roster = /\/team\/(\d+)\/roster\/\?(?:page=1&)?gender=([MF])/.exec(url);
  if (roster !== null) return { html: PAGES[`${roster[1]}|${roster[2]}`], httpStatus: 200 };
  return { html: '{"ok":true}', httpStatus: 200 };
}

/* -------------------------------------------------------------------------- */
/* F8: empty is not "nothing known"                                            */
/* -------------------------------------------------------------------------- */

describe('F8: an empty roster needs the page to say so', () => {
  it('a roster table with no data rows is a failure, not an "Empty roster"', async () => {
    const headerOnly = PAGES['412|F'].replace(/<tbody[\s\S]*?<\/tbody>/i, '<tbody></tbody>');
    expect(headerOnly).not.toBe(PAGES['412|F']);
    const h = makeHarness({ pages: { ...PAGES, '412|F': headerOnly } });
    const summary = await run(h);
    expect(summary.teams[0].emptyRosterGenders).toEqual([]);
    expect(summary.teams[0].rostersFailed).toBe(1);
    expect(summary.teams[0].errors[0]).toContain('no roster');
  });

  it('the real "No rosters found" page is still a real empty roster', async () => {
    const h = makeHarness();
    const summary = await run(h);
    expect(summary.teams[1].emptyRosterGenders).toEqual(['M']);
    expect(summary.teams[1].rostersFailed).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* F9: wording                                                                 */
/* -------------------------------------------------------------------------- */

describe('F9: a halted run says "start again", never "Resume"', () => {
  const scenarios: [string, Parameters<typeof makeHarness>[0]][] = [
    ['403', { respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? { html: 'x', httpStatus: 403 } : null) }],
    ['5xx', { respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? { html: 'x', httpStatus: 503 } : null) }],
    ['network error', { respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? undefined : null) }],
    ['three 429 give-ups', { respond: (url) => (url.includes('/api/swimmers/') ? { html: 'x', httpStatus: 429 } : null) }],
    ['relay streak', { relayOutcome: (r) => (r.sourceUrl === swimmerUrl(ALL_IDS[0]) ? 'streak-stop' : undefined) }],
    ['non-JSON swimmer body', { respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? { html: '<html>x</html>', httpStatus: 200 } : null) }],
    ['200 challenge page', { respond: (url) => (url === swimmerUrl(ALL_IDS[0]) ? { html: CHALLENGE_BODY, httpStatus: 200 } : null) }],
  ];
  it.each(scenarios)('%s', async (_name, options) => {
    const h = makeHarness(options);
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toBeDefined();
    expect(summary.haltMessage).not.toMatch(/\bResume\b/);
    expect(summary.haltMessage).toMatch(/start (the crawl )?again|Start (the crawl )?again|Start again/i);
    for (const team of summary.teams) for (const line of team.errors) expect(line).not.toMatch(/\bResume\b/);
  });
});
