import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A5: Lineup and Standings in Dark, Light and a custom theme, at 1280 and 768 px wide.
 *
 * Each page must have no horizontal page overflow and no clipped primary button.
 * Screenshots are attached to the test report (testInfo.attach). They are not
 * committed and there is no baseline to compare against.
 *
 * Run against a COPY of the data:
 *   OMNI_DATA_DIR=<copy> PORT=<free> npx playwright test tests/e2e/ui-theme-screenshots.spec.ts
 */
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/chart-workspace.json'), 'utf8')) as Record<string, unknown>;
const TEAM = 'Alpha University';
const WIDTHS = [1280, 768] as const;

type ThemeCase = {
  label: 'dark' | 'light' | 'custom';
  preferences: Record<string, unknown>;
  expectMode: 'dark' | 'light';
  expectPreset: string;
};

const THEMES: ThemeCase[] = [
  { label: 'dark', preferences: { themePreset: 'midnight', colorMode: 'dark' }, expectMode: 'dark', expectPreset: 'midnight' },
  { label: 'light', preferences: { themePreset: 'deck-light', colorMode: 'light' }, expectMode: 'light', expectPreset: 'deck-light' },
  // "Your Colors": a user-picked accent on a dark base.
  { label: 'custom', preferences: { themePreset: 'custom', colorMode: 'dark', accentColor: '#22c55e' }, expectMode: 'dark', expectPreset: 'custom' },
];

const createdIds: string[] = [];

async function createWorkspace(request: APIRequestContext) {
  const stamp = Date.now() + createdIds.length;
  const id = `ui-a5-${stamp}`;
  const name = `UI A5 ${stamp}`;
  createdIds.push(id);
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name,
      createdAt: stamp,
      // Result ids are unique across workspaces, so give this copy its own.
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return { id, name };
}

async function applyTheme(page: Page, workspaceId: string, theme: ThemeCase) {
  await page.addInitScript(
    ({ id, prefs }) => {
      localStorage.setItem('omni-active-workspace-id', id);
      localStorage.setItem('omni-active-gender', 'Men');
      localStorage.setItem(
        'omni-preferences',
        JSON.stringify({
          accentColor: '#f87171',
          textScale: 'default',
          reducedMotion: false,
          highContrast: false,
          focusRingEnhanced: false,
          sidebarCollapsedDefault: false,
          ...prefs,
        })
      );
    },
    { id: workspaceId, prefs: theme.preferences }
  );
}

async function expectThemeApplied(page: Page, theme: ThemeCase) {
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', theme.expectMode);
  await expect(root).toHaveAttribute('data-theme-preset', theme.expectPreset);
  if (theme.label === 'custom') {
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-accent').trim());
    expect(accent.toLowerCase()).toBe('#22c55e');
  }
}

async function chooseTeam(page: Page) {
  const bar = page.getByRole('combobox', { name: /^Team$/ }).first();
  await bar.locator('option', { hasText: TEAM }).waitFor({ state: 'attached', timeout: 15_000 });
  await bar.selectOption({ label: TEAM });
}

/**
 * No horizontal page scroll, and no button cut off. Primary buttons (`.btn-primary`) get every check.
 * Other visible buttons get the same viewport and overflow-hidden checks unless they sit inside a
 * sideways-scrolling region (a wide table), where being off-screen is expected.
 */
async function expectLayoutFits(page: Page, where: string) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = doc.clientWidth;
    const tolerance = 1;
    const clipped: string[] = [];
    let primaryCount = 0;
    let checked = 0;
    for (const button of document.querySelectorAll<HTMLElement>('button, a.btn-primary')) {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      const primary = button.classList.contains('btn-primary');
      let scrollsSideways = false;
      for (let el = button.parentElement; el && el !== document.body; el = el.parentElement) {
        const overflowX = getComputedStyle(el).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') scrollsSideways = true;
      }
      if (!primary && scrollsSideways) continue;
      if (primary) primaryCount += 1;
      checked += 1;
      const label = (button.getAttribute('aria-label') || button.textContent || '').trim().slice(0, 40);
      if (rect.left < -tolerance || rect.right > viewport + tolerance) clipped.push(`${label}: outside the viewport (${Math.round(rect.left)}..${Math.round(rect.right)} of ${viewport})`);
      if (primary && button.scrollWidth > button.clientWidth + tolerance) clipped.push(`${label}: its text is cut off (${button.scrollWidth} > ${button.clientWidth})`);
      for (let el = button.parentElement; el && el !== document.body; el = el.parentElement) {
        const overflowX = getComputedStyle(el).overflowX;
        if (overflowX !== 'hidden' && overflowX !== 'clip') continue;
        const box = el.getBoundingClientRect();
        if (rect.left < box.left - tolerance || rect.right > box.right + tolerance) {
          clipped.push(`${label}: clipped by an overflow-hidden ancestor <${el.tagName.toLowerCase()}>`);
          break;
        }
      }
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: viewport, primaryCount, checked, clipped };
  });
  expect(report.scrollWidth, `${where}: page scrolls sideways`).toBeLessThanOrEqual(report.clientWidth);
  expect(report.clipped, `${where}: clipped button`).toEqual([]);
  // The check must look at something, or it proves nothing.
  expect(report.checked, `${where}: no visible button was checked`).toBeGreaterThan(0);
  return report;
}

test.afterEach(async ({ request }) => {
  while (createdIds.length) {
    const id = createdIds.pop()!;
    await request.delete(`/api/workspaces/${id}`);
  }
});

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`Lineup and Standings fit in the ${theme.label} theme at ${width}px`, async ({ page, request }, testInfo) => {
      test.setTimeout(120_000);
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const { id, name } = await createWorkspace(request);
      await applyTheme(page, id, theme);
      await page.setViewportSize({ width, height: 1000 });

      // Lineup
      await page.goto('/manager');
      await expect(page.locator('header')).toContainText(name.slice(0, 18));
      await expectThemeApplied(page, theme);
      const lineupTab = page.getByRole('tab', { name: /Lineup/ });
      await lineupTab.click();
      await chooseTeam(page);
      await expect(lineupTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { name: 'Team management' })).toBeVisible();
      await page.waitForTimeout(500);
      const lineup = await expectLayoutFits(page, `Lineup, ${theme.label}, ${width}px`);
      expect(lineup.primaryCount, 'Lineup shows its primary action').toBeGreaterThan(0);
      await testInfo.attach(`lineup-${theme.label}-${width}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      // Standings
      await page.goto('/matrix');
      const standingsTab = page.getByRole('tab', { name: /Standings/ });
      await expect(standingsTab).toBeVisible();
      await standingsTab.click();
      await expect(standingsTab).toHaveAttribute('aria-selected', 'true');
      await expectThemeApplied(page, theme);
      await page.waitForTimeout(600);
      await expectLayoutFits(page, `Standings, ${theme.label}, ${width}px`);
      await testInfo.attach(`standings-${theme.label}-${width}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      expect(pageErrors).toEqual([]);
    });
  }
}
