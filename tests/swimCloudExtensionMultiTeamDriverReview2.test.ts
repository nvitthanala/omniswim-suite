/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Defects the second architect review found in the multi-team driver (N1, N2, N7).
 * Fixtures and the fake-dependency harness are in `tests/helpers/multiTeamDriverHarness.ts`;
 * the fake relay refuses a capture that was never opened, as the real app does.
 */
import { describe, expect, it } from 'vitest';

import { captureIdForSubject } from '../packages/swimcloud/src/entities';
import { capturePagesComplete } from '../extensions/swimcloud-companion/src/multiTeamDriver';
import {
  ALL_IDS,
  IDS_10002824F,
  IDS_412F,
  IDS_412M,
  PAGES,
  idsOf,
  makeHarness,
  run,
  seasonRosterUrl,
  swimmerUrl,
  urls,
} from './helpers/multiTeamDriverHarness';

const CAPTURE_B = 'team-10002824-2025-2026';
const CAPTURE_A = 'team-412-2025-2026';

/** Team 10002824's women's page lists a swimmer that team 412's men's page also lists. */
const SHARED = IDS_412M[0];
const PAGES_SHARED = {
  ...PAGES,
  '10002824|F': PAGES['10002824|F'].replace(new RegExp(`/swimmer/${IDS_10002824F[0]}(?=[/"'?#])`, 'g'), `/swimmer/${SHARED}`),
};
const IDS_B_SHARED = idsOf('10002824', 'F', PAGES_SHARED);

/* -------------------------------------------------------------------------- */
/* N1: a resumed swimmer is finished only for the teams that have it           */
/* -------------------------------------------------------------------------- */

describe('N1: saved progress is per team, so a late team still gets the swimmer', () => {
  const failB = seasonRosterUrl('10002824', 'F', '29');

  async function runOneThenTwo() {
    // Run 1: team 10002824's women's roster is a 404, so the shared swimmer is filed under 412 only.
    const first = makeHarness({ pages: PAGES_SHARED, respond: (u) => (u === failB ? { html: 'nf', httpStatus: 404 } : null) });
    const firstSummary = await run(first);
    // Run 2 clears the store it shares, so the progress run 1 left is read here.
    const savedAfterFirst = [...(first.store.get('412:29,10002824:29') ?? [])];
    const clearsAfterFirst = [...first.clears];
    // Run 2: the same selection, and the roster answers.
    const second = makeHarness({ pages: PAGES_SHARED, shareWith: first });
    const secondSummary = await run(second);
    return { first, firstSummary, savedAfterFirst, clearsAfterFirst, second, secondSummary };
  }

  it('run 1 filed the shared swimmer under 412 only and saved a key for 412 only', async () => {
    const { first, firstSummary, savedAfterFirst, clearsAfterFirst } = await runOneThenTwo();
    expect(firstSummary.outcome).toBe('completed');
    expect(first.appPages.get(CAPTURE_A)).toContain(swimmerUrl(SHARED));
    expect(first.appPages.get(CAPTURE_B) ?? []).not.toContain(swimmerUrl(SHARED));
    const saved = savedAfterFirst;
    expect(saved).toContain(`swimmer|${SHARED}|412|29`);
    expect(saved).not.toContain(`swimmer|${SHARED}|10002824|29`);
    // A failed roster and a partial capture: the progress is kept for the retry.
    expect(clearsAfterFirst).toEqual([]);
  });

  it('run 2 fetches the shared swimmer again, once, and files it under both teams', async () => {
    const { second } = await runOneThenTwo();
    expect(urls(second).filter((u) => u === swimmerUrl(SHARED))).toHaveLength(1);
    const under = second.relays.filter((r) => r.sourceUrl === swimmerUrl(SHARED)).map((r) => captureIdForSubject(r.subject)).sort();
    expect(under).toEqual([CAPTURE_B, CAPTURE_A]);
    expect(second.appPages.get(CAPTURE_B)).toContain(swimmerUrl(SHARED));
  });

  it('run 2 skips the swimmers that are finished for every team that lists them', async () => {
    const { second } = await runOneThenTwo();
    const requested = urls(second).filter((u) => u.includes('/api/swimmers/'));
    // 412 finished in run 1. The only swimmers fetched are team 10002824's women's roster.
    expect(requested).toEqual(IDS_B_SHARED.map(swimmerUrl));
    for (const id of IDS_412F) expect(requested).not.toContain(swimmerUrl(id));
  });

  it('marks team 10002824 complete only after every planned page is in the app, then clears the progress', async () => {
    const { first, second, secondSummary } = await runOneThenTwo();
    // Run 1: a failed roster means a partial capture.
    expect(first.marks.find((m) => captureIdForSubject(m.subject) === CAPTURE_B)?.completeness).toBe('partial');
    // Run 2: 2 rosters + 27 swimmers planned, and all 29 landed.
    expect(second.opened.get(CAPTURE_B)).toBe(2 + IDS_B_SHARED.length);
    expect(second.appPages.get(CAPTURE_B)).toHaveLength(2 + IDS_B_SHARED.length);
    expect(second.marks.find((m) => captureIdForSubject(m.subject) === CAPTURE_B)?.completeness).toBe('every-planned-page-fetched');
    expect(secondSummary.outcome).toBe('completed');
    expect(second.clears).toEqual(['412:29,10002824:29']);
  });

  it('saves one key per team that has the swimmer', async () => {
    const h = makeHarness({ pages: PAGES_SHARED });
    await run(h);
    const last = h.saves[h.saves.length - 1];
    expect(last).toContain(`swimmer|${SHARED}|412|29`);
    expect(last).toContain(`swimmer|${SHARED}|10002824|29`);
  });

  it('an old-format key (the swimmer id alone) matches nothing: the swimmer is fetched', async () => {
    const h = makeHarness({ finished: ALL_IDS.map((id) => `swimmer|${id}`) });
    await run(h);
    expect(urls(h).filter((u) => u.includes('/api/swimmers/'))).toEqual(ALL_IDS.map(swimmerUrl));
  });
});

describe('N1: a capture is complete only when its pages are present', () => {
  it('needs the team done AND landed plus proven pages to reach the planned count', () => {
    expect(capturePagesComplete({ planned: 29, landedThisRun: 29, resumedProven: 0, teamDone: true })).toBe(true);
    expect(capturePagesComplete({ planned: 29, landedThisRun: 1, resumedProven: 28, teamDone: true })).toBe(true);
    expect(capturePagesComplete({ planned: 29, landedThisRun: 28, resumedProven: 0, teamDone: true })).toBe(false);
    expect(capturePagesComplete({ planned: 29, landedThisRun: 29, resumedProven: 0, teamDone: false })).toBe(false);
    expect(capturePagesComplete({ planned: undefined, landedThisRun: 29, resumedProven: 0, teamDone: true })).toBe(false);
  });

  it('tells the app the real planned count even when every swimmer was skipped', async () => {
    const first = makeHarness();
    await run(first, ['412']); // clean run: clears. Seed progress by hand for the second run.
    const keys = [...IDS_412M, ...IDS_412F].map((id) => `swimmer|${id}|412|29`);
    const second = makeHarness({ finished: keys });
    const summary = await run(second, ['412']);
    expect(summary.outcome).toBe('completed');
    expect(urls(second).filter((u) => u.includes('/api/swimmers/'))).toEqual([]);
    expect(second.opened.get(CAPTURE_A)).toBe(2 + 62);
    expect(second.marks.find((m) => captureIdForSubject(m.subject) === CAPTURE_A)?.completeness).toBe('every-planned-page-fetched');
  });
});

/* -------------------------------------------------------------------------- */
/* N2: a halting outcome carries no data and is never relayed                  */
/* -------------------------------------------------------------------------- */

describe('N2: pages from halting outcomes are not relayed', () => {
  it('a 403 roster page is not relayed', async () => {
    const target = seasonRosterUrl('412', 'M', '29');
    const h = makeHarness({ respond: (u) => (u === target ? { html: 'cf', httpStatus: 403 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(h.relays.some((r) => r.sourceUrl === target)).toBe(false);
  });

  it('a 500 on a swimmer shared by two teams is not relayed under either team', async () => {
    const h = makeHarness({ pages: PAGES_SHARED, respond: (u) => (u === swimmerUrl(SHARED) ? { html: 'err', httpStatus: 500 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(h.relays.filter((r) => r.sourceUrl === swimmerUrl(SHARED))).toEqual([]);
  });

  it('the third rate-limited page is not relayed', async () => {
    const h = makeHarness({ respond: (u) => (u.includes('/api/swimmers/') ? { html: 'slow', httpStatus: 429 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    // The first two give-ups did not halt: those failures are recorded. The third halted: it is not.
    const swimmerRelays = h.relays.filter((r) => r.sourceUrl.includes('/api/swimmers/'));
    expect(swimmerRelays.map((r) => r.httpStatus)).toEqual([429, 429]);
  });

  it('a 404 swimmer is still recorded with the app (a real answer, protected by the store merge rule)', async () => {
    const target = swimmerUrl(ALL_IDS[0]);
    const h = makeHarness({ respond: (u) => (u === target ? { html: 'gone', httpStatus: 404 } : null) });
    await run(h);
    expect(h.relays.filter((r) => r.sourceUrl === target).map((r) => r.httpStatus)).toEqual([404]);
  });
});

/* -------------------------------------------------------------------------- */
/* N7: the swimmer reply is a JSON object or array                             */
/* -------------------------------------------------------------------------- */

describe('N7: a swimmer reply that is JSON but not an object or array halts', () => {
  it.each(['"blocked"', '123', 'null', 'true'])('halts on the body %s and does not relay it', async (body) => {
    const target = swimmerUrl(ALL_IDS[2]);
    const h = makeHarness({ respond: (u) => (u === target ? { html: body, httpStatus: 200 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('halted');
    expect(summary.haltMessage).toContain('not JSON');
    expect(h.relays.some((r) => r.sourceUrl === target)).toBe(false);
    expect(urls(h)[urls(h).length - 1]).toBe(target);
  });

  it.each(['{}', '[]', '{"personal_bests":[]}'])('accepts the body %s', async (body) => {
    const target = swimmerUrl(ALL_IDS[2]);
    const h = makeHarness({ respond: (u) => (u === target ? { html: body, httpStatus: 200 } : null) });
    const summary = await run(h);
    expect(summary.outcome).toBe('completed');
    expect(h.relays.some((r) => r.sourceUrl === target)).toBe(true);
  });
});
