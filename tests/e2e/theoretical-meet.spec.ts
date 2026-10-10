import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * U2: the "Build theoretical meet" flow, end to end.
 *
 * Only the SwimCloud capture routes are mocked (the pairing token, the list and the parse), with
 * responses built from the committed fixtures in tests/fixtures/theoretical-meet by the same functions
 * the data-layer golden test uses
 * (tests/e2e/theoreticalMeetCaptureMocks.ts, run through tsx because Playwright's loader cannot import
 * the core data files). Workspaces are REAL: the spec posts to /api/workspaces on the data
 * copy that playwright.config.ts makes, and deletes everything it made in `finally` / afterEach.
 *
 * Workspace ids are fresh UUIDs (newTheoreticalWorkspaceId), so ids cannot be told by a prefix. The
 * spec finds its workspace by the id the app posted, and sweeps by the theoretical meet label and the
 * time the test started.
 *
 * Run against a COPY of the data:
 *   PORT=3493 npx playwright test tests/e2e/theoretical-meet.spec.ts
 */
const TEAMS = ['Ouachita Baptist University', 'Henderson State University', 'Delta State University'];
const WIDTHS = [1280, 768] as const;
/** The label a theoretical meet carries (THEORETICAL_MEET_LABEL in theoreticalMeetWorkspace.ts). */
const THEORETICAL_LABEL = /^Theoretical meet [(]/;

const THEMES = [
  { label: 'dark', preferences: { themePreset: 'midnight', colorMode: 'dark' }, mode: 'dark' },
  { label: 'light', preferences: { themePreset: 'deck-light', colorMode: 'light' }, mode: 'light' },
] as const;
type Theme = (typeof THEMES)[number];

type Mocks = { list: Array<Record<string, unknown>>; parses: Record<string, unknown>; names: Record<string, string> };
let mocks: Mocks;

test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tmeet-mocks-'));
  const out = join(dir, 'mocks.json');
  try {
    execFileSync(process.execPath, [join(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs'), join(import.meta.dirname, 'theoreticalMeetCaptureMocks.ts'), out], { stdio: 'inherit' });
    mocks = JSON.parse(readFileSync(out, 'utf8')) as Mocks;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The list the capture route returns: the fixture captures plus one crawl that is still running. */
function captureList() {
  const running = { ...mocks.list[0], captureId: 'team-99-2026-2027', subject: { kind: 'team', teamId: '99', season: '2026-2027' }, completeness: 'in-progress', label: undefined, teamName: undefined };
  // A capture whose roster pages print no name: no label, no teamName. It must show as Team 77.
  const unnamed = { ...mocks.list[0], captureId: 'team-77-2026-2027', subject: { kind: 'team', teamId: '77', season: '2026-2027' }, label: undefined };
  return [...mocks.list, running, unnamed];
}

async function mockCaptureApi(page: Page) {
  await page.route(/\/api\/swimcloud\/pairing-token$/, route => route.fulfill({ json: { token: 'e2e-token' } }));
  await page.route(/\/api\/swimcloud\/captures$/, route => route.fulfill({ json: captureList() }));
  await page.route(/\/api\/swimcloud\/captures\/([^/]+)\/parse$/, async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').slice(-2)[0]);
    await route.fulfill({ json: mocks.parses[id] });
  });
}

const startedAt = Date.now();
const createdIds: string[] = [];

async function createBlankWorkspace(request: APIRequestContext) {
  const stamp = Date.now();
  const id = `ui-tm-blank-${stamp}`;
  createdIds.push(id);
  const created = await request.post('/api/workspaces', { data: { id, name: `UI TM blank ${stamp}`, createdAt: stamp } });
  expect(created.ok(), await created.text()).toBeTruthy();
  return id;
}

/** Every workspace this run made: the ids it knows, plus any theoretical meet created since the run started. */
async function deleteWhatWeMade(request: APIRequestContext) {
  const list = await request.get('/api/workspaces');
  if (list.ok()) {
    for (const ws of (await list.json()) as Array<{ id: string; createdAt?: number; loadedMeet?: { meetLabel?: string } }>) {
      if (THEORETICAL_LABEL.test(ws.loadedMeet?.meetLabel ?? '') && (ws.createdAt ?? 0) >= startedAt - 5_000) createdIds.push(ws.id);
    }
  }
  while (createdIds.length) await request.delete(`/api/workspaces/${createdIds.pop()!}`);
}

test.afterEach(async ({ request }) => {
  await deleteWhatWeMade(request);
});

async function applyTheme(page: Page, workspaceId: string, theme: Theme) {
  await page.addInitScript(
    ({ id, prefs }) => {
      localStorage.setItem('omni-active-workspace-id', id);
      localStorage.setItem('omni-active-gender', 'Men');
      localStorage.setItem(
        'omni-preferences',
        JSON.stringify({ accentColor: '#f87171', textScale: 'default', reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false, ...prefs })
      );
    },
    { id: workspaceId, prefs: theme.preferences }
  );
}

/** No sideways page scroll, and nothing inside the dialog wider than the dialog. */
async function expectNoOverflow(page: Page, where: string) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const box = dialog?.getBoundingClientRect();
    const wide: string[] = [];
    if (dialog && box) {
      for (const el of dialog.querySelectorAll<HTMLElement>('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        let clipsSideways = false;
        for (let p = el.parentElement; p && p !== dialog.parentElement; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'auto' || o === 'scroll') clipsSideways = true;
        }
        if (!clipsSideways && (r.right > box.right + 1 || r.left < box.left - 1)) wide.push(`${el.tagName.toLowerCase()} ${(el.textContent ?? '').trim().slice(0, 30)}`);
      }
    }
    return {
      page: doc.scrollWidth - doc.clientWidth,
      dialogScroll: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
      dialogInViewport: box ? box.left >= -1 && box.right <= doc.clientWidth + 1 : true,
      wide: wide.slice(0, 5),
    };
  });
  expect(report.page, `${where}: page scrolls sideways`).toBeLessThanOrEqual(0);
  expect(report.dialogScroll, `${where}: dialog scrolls sideways`).toBeLessThanOrEqual(0);
  expect(report.dialogInViewport, `${where}: dialog leaves the viewport`).toBe(true);
  expect(report.wide, `${where}: content wider than the dialog`).toEqual([]);
}

/** Attach a screenshot to the report. Set TMEET_SHOT_DIR to also write the files there, to look at them. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const body = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body, contentType: 'image/png' });
  if (process.env.TMEET_SHOT_DIR) writeFileSync(join(process.env.TMEET_SHOT_DIR, `${name}.png`), body);
}

async function openDialog(page: Page) {
  await page.getByRole('button', { name: 'Build theoretical meet' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Build theoretical meet' });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`the dialog fits in the ${theme.label} theme at ${width}px, on every step`, async ({ page, request }, testInfo) => {
      test.setTimeout(120_000);
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const id = await createBlankWorkspace(request);
      await mockCaptureApi(page);
      await applyTheme(page, id, theme);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/matrix');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.mode);

      const dialog = await openDialog(page);
      // Teams: four ready crawls (one has no school name, so it shows Team 77) and one still running (disabled, with its reason).
      await expect(dialog.getByRole('checkbox')).toHaveCount(5);
      const running = dialog.locator('input[id="tmeet-capture-team-99-2026-2027"]');
      await expect(running).toBeDisabled();
      await expect(dialog.getByText('The crawl is still running. Wait for it to finish.')).toBeVisible();
      await expectNoOverflow(page, `Teams, ${theme.label}, ${width}px`);
      await shot(page, testInfo, `teams-${theme.label}-${width}`);

      await dialog.getByRole('checkbox').first().check();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog.getByRole('heading', { name: 'Scoring rules' })).toBeVisible();
      await dialog.getByLabel('Scoring preset').selectOption('nsisc');
      await expectNoOverflow(page, `Scoring, ${theme.label}, ${width}px`);
      await shot(page, testInfo, `scoring-${theme.label}-${width}`);

      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog.getByRole('button', { name: 'Create theoretical meet' })).toBeEnabled({ timeout: 30_000 });
      await dialog.getByRole('button', { name: /Men/ }).first().click();
      await expect(dialog.getByRole('heading', { name: 'This is not a real meet' })).toBeVisible();
      await expectNoOverflow(page, `Preview, ${theme.label}, ${width}px`);
      await shot(page, testInfo, `preview-${theme.label}-${width}`);

      // Escape closes the dialog and focus goes back to the button that opened it.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Build theoretical meet' }).first()).toBeFocused();
      expect(pageErrors).toEqual([]);
    });
  }
}

test('builds a theoretical meet from three crawled teams and opens it on Standings', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const before = (await (await request.get('/api/workspaces')).json()) as Array<{ id: string }>;
  const blankId = await createBlankWorkspace(request);
  const existing = new Set([...before.map(w => w.id), blankId]);
  await mockCaptureApi(page);
  await applyTheme(page, blankId, THEMES[0]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/matrix');

  const dialog = await openDialog(page);
  // School names: team 412 carries a label (new crawl). Teams 48 and 58 carry only a server-read teamName
  // (old captures). Team 77 has no name anywhere, so it shows its number and an unknown division.
  for (const id of ['412', '48', '58']) {
    await expect(dialog.getByRole('heading', { name: new RegExp(`^${mocks.names[id]} NCAA D[123]$`) })).toBeVisible();
  }
  await expect(dialog.getByRole('heading', { name: 'Team 77 unknown division' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /^Team (412|48|58)/ })).toHaveCount(0);
  for (const id of ['412', '48', '58']) {
    await dialog.getByRole('heading', { name: new RegExp(`^${mocks.names[id]} `) }).locator('xpath=following-sibling::ul[1]').getByRole('checkbox').check();
  }
  await expect(dialog.getByText('3 teams picked.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();

  // Nothing is chosen for the user; Next waits for a choice. SCY is fixed and the note says why.
  await expect(dialog.getByLabel('Scoring preset')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled();
  await expect(dialog.getByText('Long course meters (LCM) and short course meters (SCM) are not supported yet.')).toBeVisible();
  await dialog.getByLabel('Scoring preset').selectOption('nsisc');
  await dialog.getByRole('button', { name: 'Next' }).click();

  const create = dialog.getByRole('button', { name: 'Create theoretical meet' });
  await expect(create).toBeEnabled({ timeout: 60_000 });
  // Relays are on by default (NSISC has a relay program): the caveat says they are estimates.
  await expect(dialog.getByText(/^Relays are estimates\. Each relay time is the sum of four swimmers/)).toBeVisible();
  await expect(dialog.getByText(/Relays are not included/)).toHaveCount(0);
  await expect(dialog.getByText(/Seeds are all-time bests/).first()).toBeVisible();
  for (const team of TEAMS) await expect(dialog.getByRole('button', { name: new RegExp(`^${team}, Men`) })).toBeVisible();
  // Each relay is listed with four swimmers and the estimated tag.
  await dialog.getByRole('button', { name: new RegExp(`^${TEAMS[1]}, Men`) }).click();
  const relayCard = dialog.locator('[data-tmeet-relay]:visible').first();
  await expect(relayCard).toBeVisible();
  await expect(relayCard).toContainText('estimated');
  await expect(relayCard.locator('ol > li')).toHaveCount(4);

  const posted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/workspaces' && r.request().method() === 'POST');
  await create.click();
  const response = await posted;
  expect(response.ok(), await response.text()).toBeTruthy();
  const workspaceId = ((await response.json()) as { id: string }).id;
  createdIds.push(workspaceId);

  // A fresh id: never one of the workspaces that existed.
  expect(existing.has(workspaceId)).toBe(false);
  expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/);

  // The app opens it: Matrix, Standings, the banner, the three teams.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/matrix\\?workspace=${workspaceId}`));
  await expect(page.getByRole('tab', { name: /Standings/ })).toHaveAttribute('aria-selected', 'true');
  const banner = page.getByRole('region', { name: 'Theoretical meet notice' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Theoretical meet: seeded from crawled teams.');
  await expect(banner).toContainText('Relays are estimates.');
  await expect(banner).not.toContainText('Relays are not included');
  // The caveats are collapsed behind a disclosure.
  const toggle = banner.getByRole('button', { name: /What this means/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  for (const team of TEAMS) await expect(page.getByText(team).first()).toBeVisible({ timeout: 30_000 });

  // The saved workspace is the one the data layer built, under that id, and the old ones are untouched.
  const list = (await (await request.get('/api/workspaces')).json()) as Array<{ id: string; name: string; menResults?: unknown[]; womenResults?: unknown[]; loadedMeet?: { meetLabel?: string } }>;
  const saved = list.find(w => w.id === workspaceId);
  expect(saved, 'the new workspace is saved').toBeTruthy();
  expect(saved!.loadedMeet?.meetLabel).toMatch(THEORETICAL_LABEL);
  expect((saved!.menResults ?? []).length).toBeGreaterThan(0);
  expect((saved!.womenResults ?? []).length).toBeGreaterThan(0);
  expect(saved!.name).toMatch(/^Theoretical meet: 3 teams/);
  for (const id of before.map(w => w.id)) expect(list.some(w => w.id === id), `existing workspace ${id} is still there`).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(banner.getByText(/Exhibition swims did not score at their meet/)).toBeVisible();
  await shot(page, testInfo, 'banner-open-dark-1280');

  // The banner is token-based: look at it in Light at tablet width too, and check nothing overflows.
  await page.setViewportSize({ width: 768, height: 900 });
  // Init scripts run on every load, in order, so this later one wins over the Dark one set at the start.
  await page.addInitScript(() => {
    const prefs = JSON.parse(localStorage.getItem('omni-preferences') ?? '{}');
    localStorage.setItem('omni-preferences', JSON.stringify({ ...prefs, themePreset: 'deck-light', colorMode: 'light' }));
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('region', { name: 'Theoretical meet notice' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'banner-light-768');

  expect(pageErrors).toEqual([]);
});

test('a real meet has no banner, and the sidebar offers a new theoretical meet', async ({ page, request }) => {
  const id = await createBlankWorkspace(request);
  await mockCaptureApi(page);
  await applyTheme(page, id, THEMES[0]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/matrix');
  await expect(page.getByRole('region', { name: 'Theoretical meet notice' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New theoretical meet' }).click();
  await expect(page.getByRole('dialog', { name: 'Build theoretical meet' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'New theoretical meet' })).toBeFocused();
});

test('removes and restores a chosen event in the preview, by keyboard too, and saves the meet without it', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const blankId = await createBlankWorkspace(request);
  await mockCaptureApi(page);
  await applyTheme(page, blankId, THEMES[0]);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/matrix');

  const dialog = await openDialog(page);
  await dialog.getByRole('heading', { name: new RegExp(`^${mocks.names['412']} `) }).locator('xpath=following-sibling::ul[1]').getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByLabel('Scoring preset').selectOption('nsisc');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('button', { name: 'Create theoretical meet' })).toBeEnabled({ timeout: 60_000 });
  await dialog.getByRole('button', { name: /Men/ }).first().click();

  // No sentence says the events cannot be edited.
  await expect(dialog.getByText(/read-only/)).toHaveCount(0);
  const removeButtons = dialog.getByRole('button', { name: /^Remove .+ for .+/ });
  await expect(removeButtons.first()).toBeVisible();
  const label = (await removeButtons.first().getAttribute('aria-label'))!;
  const [, event, swimmer] = /^Remove (.+) for (.+)$/.exec(label)!;
  const restoreName = `Restore ${event} for ${swimmer}`;
  const before = await removeButtons.count();

  // Remove it with the keyboard: the button is a real button in the tab order.
  await removeButtons.first().focus();
  await page.keyboard.press('Enter');
  const restore = dialog.getByRole('button', { name: restoreName });
  await expect(restore).toBeVisible();
  await expect(restore).toBeFocused();
  await expect(dialog.getByText('removed by you').first()).toBeVisible();
  await expect(dialog.getByText('You removed 1 event.')).toBeVisible();
  // The slot is refilled when the swimmer has another event, so the count of Remove buttons holds, and the
  // refill is tagged. A swimmer with no further event shows the empty-slot note instead.
  const refilled = await dialog.getByText('in place of a removed event').count();
  if (refilled > 0) await expect(removeButtons).toHaveCount(before);
  else await expect(dialog.getByText(/freed slot stays empty/).first()).toBeVisible();
  await expectNoOverflow(page, 'Preview with a removal, 768px');
  await shot(page, testInfo, 'preview-removed-dark-768');

  // Restore it with the keyboard.
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('button', { name: `Remove ${event} for ${swimmer}` })).toBeFocused();
  await expect(dialog.getByText('removed by you')).toHaveCount(0);
  await expect(removeButtons).toHaveCount(before);

  // Remove again, create, and check the saved meet has no row for that swimmer and event.
  await dialog.getByRole('button', { name: `Remove ${event} for ${swimmer}` }).click();
  await expect(dialog.getByRole('button', { name: restoreName })).toBeVisible();
  const posted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/workspaces' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create theoretical meet' }).click();
  const response = await posted;
  expect(response.ok(), await response.text()).toBeTruthy();
  const saved = (await response.json()) as { id: string; menResults?: Array<{ name: string; event: string }>; womenResults?: Array<{ name: string; event: string }> };
  createdIds.push(saved.id);
  const rows = [...(saved.menResults ?? []), ...(saved.womenResults ?? [])].filter(r => r.name === swimmer);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some(r => r.event === event)).toBe(false);
  expect(pageErrors).toEqual([]);
});
