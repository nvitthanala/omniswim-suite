import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Phase 6 (wording, case and density sweep).
 *
 * Run against a COPY of the data: OMNI_DATA_DIR=<copy> PORT=<free> npx playwright test tests/e2e/ui-phase-6.spec.ts
 * Set PHASE6_SHOT_DIR=before to write screenshots to docs/reference/ui-phase-6/before.
 */
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/chart-workspace.json'), 'utf8')) as Record<string, unknown>;
const themes = ['midnight', 'deck-light', 'oled'] as const;
const widths = [1440, 800] as const;
const TEAM = 'Alpha University';
const SHOT_DIR = process.env.PHASE6_SHOT_DIR === 'before' ? 'before' : 'after';

async function createWorkspace(request: APIRequestContext, label: string) {
  const stamp = Date.now();
  const id = `ui-p6-${label}-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI Phase 6 ${label} ${stamp}`,
      createdAt: stamp,
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  const body = await created.text();
  expect(created.ok(), body).toBeTruthy();
  return { id: (JSON.parse(body) as { id: string }).id, name: `UI Phase 6 ${label} ${stamp}` };
}

/**
 * A roster-mode clone of the largest workspace in the data copy (about 35 swimmers on its biggest team).
 * Falls back to the chart fixture when the copy has no workspace that large.
 */
async function createBigRosterWorkspace(request: APIRequestContext) {
  const list = (await (await request.get('/api/workspaces')).json()) as Array<Record<string, any>>;
  const source = list
    .filter(w => !String(w.id).startsWith('ui-'))
    .sort((a, b) => (b.menResults?.length ?? 0) - (a.menResults?.length ?? 0))[0];
  if (!source || (source.menResults?.length ?? 0) < 100) return createWorkspace(request, 'count');
  const stamp = Date.now();
  const id = `ui-p6-big-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...source,
      id,
      name: `UI Phase 6 big ${stamp}`,
      createdAt: stamp,
      scoringSettings: { ...(source.scoringSettings ?? {}), scorerEligibilityMode: 'roster', usePdfPlacePoints: false },
      menResults: source.menResults.map((row: Record<string, unknown>, i: number) => ({ ...row, id: `${id}-m-${i}` })),
      womenResults: (source.womenResults ?? []).map((row: Record<string, unknown>, i: number) => ({ ...row, id: `${id}-w-${i}` })),
      sourceMenResults: (source.sourceMenResults ?? []).map((row: Record<string, unknown>, i: number) => ({ ...row, id: `${id}-sm-${i}` })),
      sourceWomenResults: (source.sourceWomenResults ?? []).map((row: Record<string, unknown>, i: number) => ({ ...row, id: `${id}-sw-${i}` })),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return { id, name: `UI Phase 6 big ${stamp}`, team: (source.menResults[0] as { team: string }).team };
}

async function setPreferences(page: Page, theme: (typeof themes)[number], extra: Record<string, unknown> = {}) {
  await page.addInitScript(
    ({ value, more }) => {
      localStorage.setItem('omni-preferences', JSON.stringify({
        themePreset: value, colorMode: value === 'deck-light' ? 'light' : 'dark',
        textScale: 'default', reducedMotion: false, highContrast: false, focusRingEnhanced: false,
        sidebarCollapsedDefault: false, ...more,
      }));
    },
    { value: theme, more: extra }
  );
}

/** Start the shell on this workspace through the key the app reads (the `?workspace=` loop was fixed in A1; storage start is kept for its many callers). */
async function startOnWorkspace(page: Page, id: string) {
  await page.addInitScript(workspaceId => {
    localStorage.setItem('omni-active-workspace-id', workspaceId);
    localStorage.setItem('omni-active-gender', 'Men');
  }, id);
}

async function chooseTeam(page: Page, team: string) {
  const bar = page.getByRole('combobox', { name: /^Team$/ });
  await bar.first().locator('option', { hasText: team }).waitFor({ state: 'attached', timeout: 15_000 });
  await bar.first().selectOption({ label: team });
}

async function shot(page: Page, name: string) {
  mkdirSync(`docs/reference/ui-phase-6/${SHOT_DIR}`, { recursive: true });
  await page.screenshot({ path: `docs/reference/ui-phase-6/${SHOT_DIR}/${name}.png`, fullPage: true });
}

test('Phase 6 screenshots: Athletes, Lineup, Optimize, Matrix, Metrics', async ({ page, request }) => {
  test.setTimeout(420_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id, name } = await createWorkspace(request, 'shots');
  await startOnWorkspace(page, id);
  for (const theme of themes) {
    await setPreferences(page, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/manager');
      await expect(page.locator('header')).toContainText(name.slice(0, 18));
      for (const step of [
        { tab: /Athletes/, name: 'athletes', team: false },
        { tab: /Lineup/, name: 'lineup', team: true },
        { tab: /Optimize/, name: 'optimize', team: true },
      ]) {
        const tab = page.getByRole('tab', { name: step.tab });
        await tab.click();
        if (step.team) await chooseTeam(page, TEAM);
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('heading', { name: 'Team management' })).toBeVisible();
        await page.waitForTimeout(500);
        await shot(page, `${theme}-${width}-${step.name}`);
      }

      await page.goto('/matrix');
      await expect(page.getByRole('tab', { name: /Standings/ })).toBeVisible();
      for (const step of [{ tab: /Standings/, name: 'standings' }, { tab: /Analyze/, name: 'analyze' }]) {
        const tab = page.getByRole('tab', { name: step.tab });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await page.waitForTimeout(600);
        await shot(page, `${theme}-${width}-matrix-${step.name}`);
      }

      await page.goto('/metrics');
      await expect(page.getByRole('heading', { name: /Swim Metrics/i })).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, `${theme}-${width}-metrics`);
    }
  }
  expect(pageErrors).toEqual([]);
});

test('Phase 6 Lineup stays at 45 buttons or fewer and keeps every action reachable', async ({ page, request }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // The largest workspace in the data copy, switched to roster mode. Falls back to the small chart fixture.
  const big = await createBigRosterWorkspace(request);
  const { id, name } = big;
  await setPreferences(page, 'midnight');
  await startOnWorkspace(page, id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/manager');
  await expect(page.locator('header')).toContainText(name.slice(0, 18));
  await page.getByRole('tab', { name: /Lineup/ }).click();
  await chooseTeam(page, (big as { team?: string }).team ?? TEAM);
  const roster = page.getByRole('listbox', { name: /Team roster/ });
  await expect(roster).toBeVisible();
  await page.waitForTimeout(500);

  const counts = await page.getByRole('tabpanel').evaluate(panel => {
    const all = Array.from(panel.querySelectorAll('button'));
    const visible = all.filter(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return { dom: all.length, visible: visible.length, rows: panel.querySelectorAll('tr[role="option"]').length };
  });
  console.log('LINEUP_BUTTONS', JSON.stringify(counts));
  expect(counts.dom).toBeLessThanOrEqual(45);
  expect(counts.visible).toBeLessThanOrEqual(45);
  // No per-row Remove button remains.
  await expect(page.getByRole('button', { name: /^Remove .+$/ })).toHaveCount(0);

  // Keyboard: arrow to the first athlete, Delete asks to remove, the confirm dialog opens, Escape closes it.
  await roster.focus();
  await page.keyboard.press('ArrowDown');
  const drawer = page.getByRole('dialog', { name: /^Edit / });
  await expect(drawer).toBeVisible();
  // The drawer carries a Remove button for the selected athlete.
  await expect(page.getByRole('button', { name: /^Remove .+ from roster$/ })).toHaveCount(1);
  await roster.focus();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog').filter({ hasText: /remove/i }).last()).toBeVisible();

  // The checklist renders once.
  await expect(page.getByRole('complementary', { name: 'Compliance checklist' })).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('Phase 6 sidebar collapses below lg without overwriting the stored choice', async ({ page, request }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id } = await createWorkspace(request, 'sidebar');
  await setPreferences(page, 'midnight');
  await startOnWorkspace(page, id);
  await page.addInitScript(() => localStorage.setItem('omni-sidebar-collapsed', 'false'));

  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/matrix');
  const sidebar = page.locator('aside.workspace-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveClass(/sidebar-collapsed/);
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeLessThan(80);
  expect(await page.evaluate(() => localStorage.getItem('omni-sidebar-collapsed'))).toBe('false');

  // The toggle opens it for now. That does not change the saved choice.
  const toggle = sidebar.getByRole('button', { name: /workspace sidebar/i });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
  expect(await page.evaluate(() => localStorage.getItem('omni-sidebar-collapsed'))).toBe('false');

  // Widening past lg gives the saved choice back (expanded) and leaves storage alone.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeGreaterThan(200);
  expect(await page.evaluate(() => localStorage.getItem('omni-sidebar-collapsed'))).toBe('false');

  // Narrowing again collapses it once more.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(sidebar).toHaveClass(/sidebar-collapsed/);

  // At lg and up the toggle still saves the choice.
  await page.setViewportSize({ width: 1280, height: 900 });
  await sidebar.getByRole('button', { name: /Collapse workspace sidebar/ }).click();
  expect(await page.evaluate(() => localStorage.getItem('omni-sidebar-collapsed'))).toBe('true');
  expect(pageErrors).toEqual([]);
});

test('Phase 6 Analyze score differences fit their container at 800px', async ({ page, request }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id } = await createWorkspace(request, 'analyze');
  await setPreferences(page, 'midnight');
  await startOnWorkspace(page, id);
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto('/matrix');
  await page.getByRole('tab', { name: /Analyze/ }).click();
  const table = page.locator('table').filter({ hasText: 'Baseline' }).first();
  await expect(table).toBeVisible();
  const checkFit = async (label: string) => {
    const fit = await table.evaluate(el => {
      const wrap = el.parentElement as HTMLElement;
      return { wrapClient: wrap.clientWidth, wrapScroll: wrap.scrollWidth, table: el.getBoundingClientRect().width };
    });
    console.log('ANALYZE_TABLE_FIT', label, JSON.stringify(fit));
    expect(fit.wrapScroll, label).toBeLessThanOrEqual(fit.wrapClient);
    const rankBox = await table.getByRole('columnheader', { name: 'Rank' }).boundingBox();
    const wrapBox = await table.locator('xpath=..').boundingBox();
    expect(rankBox!.x + rankBox!.width, label).toBeLessThanOrEqual(wrapBox!.x + wrapBox!.width + 1);
  };
  // 800px with the sidebar auto-collapsed.
  await checkFit('sidebar collapsed');
  // 800px with the sidebar opened by hand: the narrowest content width, which is where the table used to be cut off.
  await page.locator('aside.workspace-sidebar').getByRole('button', { name: 'Expand workspace sidebar' }).click();
  await expect(page.locator('aside.workspace-sidebar')).not.toHaveClass(/sidebar-collapsed/);
  await checkFit('sidebar open');
  expect(pageErrors).toEqual([]);
});

test('Phase 6 labels and one Open video control', async ({ page, request }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { id } = await createWorkspace(request, 'labels');
  await setPreferences(page, 'midnight');
  await startOnWorkspace(page, id);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto('/manager');
  await page.getByRole('tab', { name: /Lineup/ }).click();
  await chooseTeam(page, TEAM);
  await expect(page.getByRole('button', { name: 'Cross-course' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Arbitrage' })).toHaveCount(0);
  await page.getByRole('tab', { name: /Optimize/ }).click();
  await expect(page.getByRole('heading', { name: /^Point opportunities/ })).toBeVisible();

  await page.goto('/matrix');
  await page.getByRole('tab', { name: /Meet/ }).click();
  await expect(page.getByText('Link psych sheet', { exact: true })).toBeVisible();
  await expect(page.getByText('Scoring rules', { exact: true })).toBeVisible();

  await page.goto('/metrics');
  const open = page.getByRole('button', { name: 'Open video' });
  await expect(open).toHaveCount(1);
  // The header button is keyboard reachable and opens the file chooser.
  await open.focus();
  await expect(open).toBeFocused();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  expect(chooser.isMultiple()).toBe(false);
  expect(pageErrors).toEqual([]);
});
