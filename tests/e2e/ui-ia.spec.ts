import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/chart-workspace.json'), 'utf8')) as Record<string, unknown>;
const themes = ['midnight', 'deck-light', 'oled'] as const;
const widths = [1440, 800] as const;

async function captureScreenshot(page: import('@playwright/test').Page, name: string) {
  await page.screenshot({ path: `docs/reference/ui-phase-1/after/${name}.png`, fullPage: true });
  await page.screenshot({ path: `test-results/ui-ia/phase-1/${name}.png`, fullPage: true });
}

test('Phase 1 IA regressions and theme/width screenshots', async ({ page, request }) => {
  test.setTimeout(300_000);
  mkdirSync('docs/reference/ui-phase-1/after', { recursive: true });
  mkdirSync('test-results/ui-ia/phase-1', { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const stamp = Date.now();
  const id = `ui-ia-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI IA ${stamp}`,
      createdAt: stamp,
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-m-${index}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-w-${index}` })),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  const createdBody = await created.text();
  expect(created.ok(), createdBody).toBeTruthy();
  const createdWorkspace = JSON.parse(createdBody) as { id: string };

  for (const theme of themes) {
    await page.addInitScript(value => {
      localStorage.setItem('omni-preferences', JSON.stringify({
        themePreset: value, colorMode: value === 'deck-light' ? 'light' : 'dark',
        textScale: 'default', reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
      }));
    }, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });

      await page.goto(`/matrix?workspace=${createdWorkspace.id}`);
      const standingsTab = page.getByRole('tab', { name: /Standings/ });
      await expect(standingsTab).toBeVisible();
      await expect(page.getByLabel('PDF column format')).toHaveCount(0);
      await standingsTab.click();
      const matrixGender = page.locator('nav[aria-label="Gender"] button[aria-pressed]').nth(1);
      await matrixGender.click();
      await expect(page.getByRole('tab', { name: /Standings/ })).toHaveAttribute('aria-selected', 'true');
      await page.reload();
      await expect(page.getByRole('tab', { name: /Standings/ })).toHaveAttribute('aria-selected', 'true');
      await captureScreenshot(page, `${theme}-${width}-matrix`);
      await page.getByRole('tab', { name: /Load/ }).click();
      await expect(page.getByLabel('PDF column format')).toBeVisible();
      await captureScreenshot(page, `${theme}-${width}-matrix-load`);
      await page.getByRole('tab', { name: /Score/ }).click();
      await captureScreenshot(page, `${theme}-${width}-matrix-scoring`);
      await page.getByRole('tab', { name: /Analyze/ }).click();
      await captureScreenshot(page, `${theme}-${width}-matrix-analyze`);

      await page.goto(`/manager?workspace=${createdWorkspace.id}&gender=Men`);
      await expect(page.getByRole('tab', { name: /Source/ })).toBeVisible();
      await captureScreenshot(page, `${theme}-${width}-manager-source`);
      const genderButtons = page.locator('nav[aria-label="Gender"] button[aria-pressed]');
      await expect(genderButtons).toHaveCount(2);
      await expect(genderButtons.first()).toBeVisible();
      await expect(genderButtons.nth(1)).toBeVisible();
      await page.setViewportSize({ width: 700, height: 1000 });
      await expect(genderButtons.first()).toContainText('M');
      await expect(genderButtons.nth(1)).toContainText('W');
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole('tab', { name: /Optimize/ }).click();
      const whatIf = page.getByLabel('What-if');
      if (await whatIf.isChecked()) await whatIf.uncheck();
      const batchButton = page.getByRole('button', { name: 'Batch optimizer' });
      await expect(batchButton).toBeDisabled();
      const recalc = page.getByRole('button', { name: 'Recalc' });
      await recalc.click();
      await expect(page.getByRole('tab', { name: /Optimize/ })).toHaveAttribute('aria-selected', 'true');
      await genderButtons.nth(1).click();
      await expect(page.getByRole('tab', { name: /Optimize/ })).toHaveAttribute('aria-selected', 'true');
      await captureScreenshot(page, `${theme}-${width}-manager`);
      if (!(await whatIf.isChecked())) await whatIf.check();
      await expect(batchButton).toBeEnabled();
      await batchButton.click();
      await expect(page.getByRole('dialog', { name: 'Batch Optimizer' })).toBeVisible();
      await captureScreenshot(page, `${theme}-${width}-batch-optimizer`);
      await page.keyboard.press('Escape');

      await page.goto('/settings', { waitUntil: 'domcontentloaded' });
      const preview = page.locator('aside[aria-hidden="true"]');
      await expect(preview).toHaveAttribute('inert', '');
      const previewButton = preview.locator('button');
      await expect(previewButton).toBeVisible();
      await previewButton.evaluate(button => (button as HTMLElement).focus());
      expect(await previewButton.evaluate(button => document.activeElement === button)).toBe(false);
      await captureScreenshot(page, `${theme}-${width}-settings`);
    }
  }
  expect(pageErrors).toEqual([]);
});
