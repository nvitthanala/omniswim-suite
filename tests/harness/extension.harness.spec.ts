import { test, expect, type Page } from '@playwright/test';
import { FAKE_ORIGIN, rosterIds } from './fakeSwimCloud';
import {
  clearCaptures,
  launchHarness,
  listCaptures,
  openPanel,
  panelText,
  pasteAndRead,
  runToStart,
  startCrawl,
  waitForRunEnd,
  waitForSeasonChoice,
  type Harness,
} from './extensionHarness';

/**
 * End-to-end harness: the REAL built extension in real Chromium, a FAKE SwimCloud built from
 * committed fixtures, and the REAL app (dev server, temp copy of data/) as the backend.
 *
 * Nothing here reaches swimcloud.com. The route handler aborts every request that is not the fake
 * origin or the local app, and each test ends by asserting that nothing was aborted.
 *
 * Time is real: the extension has no clock override, and the 3 s pacing is not to be lowered.
 * So the fixtures are small (two swimmers per roster page) and the runs use one or two teams.
 */
test.describe.configure({ mode: 'serial' });

/** Allowed jitter between two requests the extension starts 3000 ms apart, as the route handler sees them. */
const JITTER_MS = 150;
const MIN_GAP_MS = 3000 - JITTER_MS;

const ROSTER = (team: string, gender: 'M' | 'F', season?: string): string =>
  `${FAKE_ORIGIN}/team/${team}/roster/?${season === undefined ? `gender=${gender}` : `page=1&gender=${gender}&season_id=${season}&sort=name`}`;
const SWIMMER = (id: string): string => `${FAKE_ORIGIN}/api/swimmers/${id}/profile_fastest_times/`;
const CHALLENGE = '<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';

let h: Harness;

test.beforeEach(async ({ request }) => {
  await clearCaptures(request);
  h = await launchHarness(request);
});

test.afterEach(async ({ request }) => {
  const aborted = h.aborted.slice();
  await h.close();
  await clearCaptures(request);
  expect(aborted, 'no request left the fake origin and the local app').toEqual([]);
});

function gaps(harness: Harness): number[] {
  const at = harness.fake.dataLog.map(r => r.at);
  return at.slice(1).map((t, i) => t - at[i]);
}

function expectPaced(harness: Harness): void {
  for (const gap of gaps(harness)) expect(gap, 'two requests closer than the 3 s floor').toBeGreaterThanOrEqual(MIN_GAP_MS);
}

const urlsOf = (harness: Harness): string[] => harness.fake.dataLog.map(r => r.url);

async function expectSettled(harness: Harness, ms = 7_000): Promise<void> {
  const before = harness.fake.dataLog.length;
  await new Promise(resolve => setTimeout(resolve, ms));
  expect(harness.fake.dataLog.length, 'no request after the stop').toBe(before);
}

/** The 12 requests of the two-team run, in the order the extension makes them. Pinned from the committed fixtures. */
const PINNED_HAPPY_PATH = [
  ROSTER('412', 'M'),
  ROSTER('10002824', 'M'),
  ROSTER('412', 'M', '29'),
  ROSTER('412', 'F', '29'),
  ROSTER('10002824', 'M', '29'),
  ROSTER('10002824', 'F', '29'),
  SWIMMER('2527796'),
  SWIMMER('779857'),
  SWIMMER('1825215'),
  SWIMMER('2537259'),
  SWIMMER('1724362'),
  SWIMMER('1337246'),
];

test('happy path: two teams crawl into the app, then build a theoretical meet', async ({ request, page: app }) => {
  const page: Page = await h.newTeamPage('412');
  await openPanel(page);
  await pasteAndRead(page, [`${FAKE_ORIGIN}/team/412/`, `${FAKE_ORIGIN}/team/10002824/`], ['412', '10002824']);
  await waitForSeasonChoice(page, ['412', '10002824']);
  await startCrawl(page);
  await waitForRunEnd(page);

  // The fixtures decide the swimmer ids. The pinned list must agree with them.
  expect(PINNED_HAPPY_PATH.slice(6)).toEqual([...rosterIds('412', 'M'), ...rosterIds('412', 'F'), ...rosterIds('10002824', 'F')].map(SWIMMER));
  expect(urlsOf(h)).toEqual(PINNED_HAPPY_PATH);
  expectPaced(h);
  expect(await panelText(page)).toContain('Finished.');

  // The app holds both season captures, with the page counts the crawl made and the school name from Task A.
  const stored = new Map((await listCaptures(request)).map(c => [c.captureId, c]));
  const ouachita = stored.get('team-412-2025-2026');
  const west = stored.get('team-10002824-2025-2026');
  expect(ouachita, 'capture team-412-2025-2026').toBeDefined();
  expect(west, 'capture team-10002824-2025-2026').toBeDefined();
  expect(ouachita!.pages.length).toBe(6); // 2 rosters + 4 swimmers
  expect(west!.pages.length).toBe(4); // 2 rosters (one is the empty men's page) + 2 swimmers
  expect(ouachita!.completeness).toBe('every-planned-page-fetched');
  expect(west!.completeness).toBe('every-planned-page-fetched');
  expect(ouachita!.label).toBe('Ouachita Baptist University');
  expect(west!.label).toBe('University of West Florida');

  // The app: Build theoretical meet shows the school names and builds a workspace.
  const blank = `harness-blank-${Date.now()}`;
  const made = await request.post('/api/workspaces', { data: { id: blank, name: `Harness blank ${Date.now()}`, createdAt: Date.now() } });
  expect(made.ok(), await made.text()).toBeTruthy();
  let builtId: string | undefined;
  try {
    await app.addInitScript(id => {
      localStorage.setItem('omni-active-workspace-id', id);
      localStorage.setItem('omni-active-gender', 'Women');
    }, blank);
    await app.goto('/matrix');
    await app.getByRole('button', { name: 'Build theoretical meet' }).first().click();
    const dialog = app.getByRole('dialog', { name: 'Build theoretical meet' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /^Ouachita Baptist University NCAA D2$/ })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /^University of West Florida NCAA D2$/ })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /^Team \d+/ })).toHaveCount(0);
    await dialog.locator('#tmeet-capture-team-412-2025-2026').check();
    await dialog.locator('#tmeet-capture-team-10002824-2025-2026').check();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByLabel('Scoring preset').selectOption('nsisc');
    await dialog.getByRole('button', { name: 'Next' }).click();
    const create = dialog.getByRole('button', { name: 'Create theoretical meet' });
    await expect(create).toBeEnabled({ timeout: 60_000 });
    const posted = app.waitForResponse(r => new URL(r.url()).pathname === '/api/workspaces' && r.request().method() === 'POST');
    await create.click();
    const response = await posted;
    expect(response.ok(), await response.text()).toBeTruthy();
    builtId = ((await response.json()) as { id: string }).id;
    await expect(app).toHaveURL(new RegExp(`/matrix\\?workspace=${builtId}`));
    await expect(app.getByRole('tab', { name: /Standings/ })).toHaveAttribute('aria-selected', 'true');
    for (const team of ['Ouachita Baptist University', 'University of West Florida']) await expect(app.getByText(team).first()).toBeVisible({ timeout: 30_000 });

    const list = (await (await request.get('/api/workspaces')).json()) as Array<{ id: string; loadedMeet?: { meetLabel?: string }; womenResults?: Array<{ team?: string }> }>;
    const saved = list.find(w => w.id === builtId);
    expect(saved, 'the new workspace is saved').toBeDefined();
    expect(saved!.loadedMeet?.meetLabel).toMatch(/^Theoretical meet [(]/);
    const teams = new Set((saved!.womenResults ?? []).map(r => r.team));
    expect(teams.has('Ouachita Baptist University')).toBe(true);
    expect(teams.has('University of West Florida')).toBe(true);
  } finally {
    await request.delete(`/api/workspaces/${blank}`);
    if (builtId !== undefined) await request.delete(`/api/workspaces/${builtId}`);
  }
});

test('403 on a swimmer: the crawl halts, nothing more is requested, nothing is retried', async ({ request }) => {
  let swimmers = 0;
  h.fake.addRule(url => (url.pathname.includes('/api/swimmers/') && ++swimmers === 2 ? { status: 403, contentType: 'text/html', body: 'Forbidden' } : undefined));
  const page = await h.newTeamPage('412');
  await runToStart(page, ['412']);
  await waitForRunEnd(page);

  const swimmerUrls = urlsOf(h).filter(u => u.includes('/api/swimmers/'));
  expect(swimmerUrls.length, 'the first swimmer, then the 403, and no more').toBe(2);
  expect(new Set(swimmerUrls).size, 'the 403 was not retried').toBe(2);
  expect(urlsOf(h).at(-1)).toBe(swimmerUrls[1]);
  await expectSettled(h);
  expect(await panelText(page)).toMatch(/challenge/i);

  const filed = (await listCaptures(request)).flatMap(c => c.pages.map(p => p.canonicalUrl));
  expect(filed, 'the 403 page is not filed').not.toContain(swimmerUrls[1]);
});

test('429 once then OK: one retry of the same page, gaps stay at 3 s or more', async ({ request }) => {
  let swimmers = 0;
  h.fake.addRule(url => (url.pathname.includes('/api/swimmers/') && ++swimmers === 1 ? { status: 429, contentType: 'text/html', body: 'Too many requests' } : undefined));
  const page = await h.newTeamPage('412');
  await runToStart(page, ['412']);
  await waitForRunEnd(page);

  const swimmerUrls = urlsOf(h).filter(u => u.includes('/api/swimmers/'));
  const first = swimmerUrls[0];
  expect(swimmerUrls.filter(u => u === first).length, 'the throttled page was asked for twice').toBe(2);
  expect(swimmerUrls[1], 'the retry follows at once, in order').toBe(first);
  expect(swimmerUrls.length, 'four swimmers plus one retry').toBe(5);
  expectPaced(h);
  expect(await panelText(page)).toContain('Finished.');
  const stored = (await listCaptures(request)).find(c => c.captureId === 'team-412-2025-2026');
  expect(stored?.pages.filter(p => p.resourceKind === 'swimmerFastestTimes').length).toBe(4);
});

test('a 200 "Just a moment..." challenge on the team page halts and files nothing', async ({ request }) => {
  h.fake.addRule(() => ({ status: 200, contentType: 'text/html', body: CHALLENGE }));
  const page = await h.newTeamPage('412');
  await openPanel(page);
  await pasteAndRead(page, [`${FAKE_ORIGIN}/team/412/`], ['412']);
  await waitForRunEnd(page);

  expect(urlsOf(h).length, 'one request, then the halt').toBe(1);
  expect(await panelText(page)).toMatch(/challenge/i);
  await expectSettled(h);
  const filed = (await listCaptures(request)).flatMap(c => c.pages);
  expect(filed, 'no page of the challenge is filed as data').toEqual([]);
});

test('a 200 "Just a moment..." challenge where swimmer JSON belongs halts and is not filed as data', async ({ request }) => {
  let swimmers = 0;
  h.fake.addRule(url => (url.pathname.includes('/api/swimmers/') && ++swimmers === 2 ? { status: 200, contentType: 'text/html', body: CHALLENGE } : undefined));
  const page = await h.newTeamPage('412');
  await runToStart(page, ['412']);
  await waitForRunEnd(page);

  const swimmerUrls = urlsOf(h).filter(u => u.includes('/api/swimmers/'));
  expect(swimmerUrls.length, 'the first swimmer, then the challenge, and no more').toBe(2);
  await expectSettled(h);
  expect(await panelText(page)).toMatch(/not JSON/i);
  const filed = (await listCaptures(request)).flatMap(c => c.pages.map(p => p.canonicalUrl));
  expect(filed, 'the challenge page is not filed under its swimmer').not.toContain(swimmerUrls[1]);
  expect(filed).toContain(swimmerUrls[0]);
});

// FIXME (observed, not guessed): Playwright's route.fulfill with a 302 and a Location header does not
// make Chromium follow the redirect for the extension's fetch. The fake logs the 302, the Location
// target is never requested, and the extension reports "A network error stopped the crawl". The
// extension's redirect rule (finalUrl differs from the asked URL) is covered by the driver unit tests.
// Driving it end to end needs a real HTTPS origin for www.swimcloud.com, which this harness does not run.
test.fixme('a redirect to another team: that roster fails and is not filed', async ({ request }) => {
  h.fake.addRule(url =>
    url.pathname === '/team/412/roster/' && url.searchParams.get('gender') === 'M' && url.searchParams.get('season_id') === '29'
      ? { status: 302, contentType: 'text/html', body: 'Found', headers: { location: ROSTER('58', 'M', '29') } }
      : undefined
  );
  const page = await h.newTeamPage('412');
  await runToStart(page, ['412']);
  await waitForRunEnd(page);

  expect(urlsOf(h), 'the browser followed the redirect, so the other team was asked for').toContain(ROSTER('58', 'M', '29'));
  expect(await panelText(page)).toMatch(/redirected/i);
  const filed = (await listCaptures(request)).flatMap(c => c.pages.map(p => p.canonicalUrl));
  expect(filed.filter(u => u.includes('/team/58/')), 'nothing of team 58 is filed').toEqual([]);
  expect(filed, "the redirected men's roster is not filed under team 412").not.toContain(ROSTER('412', 'M', '29'));
  expect(filed, "the women's roster is").toContain(ROSTER('412', 'F', '29'));
});

test('the lock: a second crawl in a second tab is refused', async () => {
  const a = await h.newTeamPage('412');
  await openPanel(a);
  await pasteAndRead(a, [`${FAKE_ORIGIN}/team/412/`], ['412']);
  await waitForSeasonChoice(a, ['412']);
  await startCrawl(a);

  const b = await h.newTeamPage('412');
  await openPanel(b);
  await pasteAndRead(b, [`${FAKE_ORIGIN}/team/412/`], ['412']);
  await expect(b.locator('#omniswim-multiteam-panel')).toContainText('Another SwimCloud crawl is running', { timeout: 15_000 });
  expect(urlsOf(h).filter(u => u === ROSTER('412', 'M')).length, 'the second tab fetched nothing').toBe(1);

  await a.locator('#omniswim-multiteam-panel').getByRole('button', { name: 'Cancel' }).click();
  await waitForRunEnd(a);
});

test('cancel mid-run stops the requests', async () => {
  const page = await h.newTeamPage('412');
  await runToStart(page, ['412']);
  await expect.poll(() => urlsOf(h).filter(u => u.includes('/api/swimmers/')).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  await page.locator('#omniswim-multiteam-panel').getByRole('button', { name: 'Cancel' }).click();
  await waitForRunEnd(page);
  const stopped = urlsOf(h).length;
  expect(urlsOf(h).filter(u => u.includes('/api/swimmers/')).length, 'the run stopped before all four swimmers').toBeLessThan(4);
  await expectSettled(h);
  expect(urlsOf(h).length).toBe(stopped);
  expectPaced(h);
});
