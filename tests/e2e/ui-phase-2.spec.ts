import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/chart-workspace.json'), 'utf8')) as Record<string, unknown>;
const themes = ['midnight', 'deck-light', 'oled'] as const;
const widths = [1440, 800] as const;

async function capture(page: import('@playwright/test').Page, name: string) {
  await page.screenshot({ path: `docs/reference/ui-phase-2/after/${name}.png`, fullPage: true });
}

test('Phase 2 scoring editor, eligibility lock and screenshots', async ({ page, request }) => {
  test.setTimeout(300_000);
  mkdirSync('docs/reference/ui-phase-2/after', { recursive: true });
  mkdirSync('test-results/ui-ia/phase-2', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const stamp = Date.now();
  const id = `ui-phase-2-${stamp}`;
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture, id, name: `UI Phase 2 ${stamp}`, createdAt: stamp,
      scoringSettings: { ...(fixture.scoringSettings as Record<string, unknown>), usePdfPlacePoints: true },
      menResults: ((fixture.menResults ?? []) as Array<Record<string, unknown>>).map((row, i) => ({ ...row, id: `${id}-m-${i}` })),
      womenResults: ((fixture.womenResults ?? []) as Array<Record<string, unknown>>).map((row, i) => ({ ...row, id: `${id}-w-${i}` })),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const workspace = JSON.parse(await created.text()) as { id: string };

  for (const theme of themes) {
    await page.addInitScript(value => localStorage.setItem('omni-preferences', JSON.stringify({
      themePreset: value, colorMode: value === 'deck-light' ? 'light' : 'dark', textScale: 'default',
      reducedMotion: false, highContrast: false, focusRingEnhanced: false, sidebarCollapsedDefault: false,
    })), theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/matrix?workspace=${workspace.id}`);
      await page.getByRole('tab', { name: /Score/ }).click();
      await expect(page.getByRole('button', { name: 'Edit scoring rules' })).toBeVisible();
      await capture(page, `${theme}-${width}-matrix-scoring`);
      await page.getByRole('button', { name: 'Edit scoring rules' }).click();
      await expect(page.getByRole('dialog', { name: 'Scoring Matrix Configuration' })).toBeVisible();
      await expect(page.getByLabel('Scorer eligibility')).toBeDisabled();
      await capture(page, `${theme}-${width}-scoring-rules-modal-matrix`);
      await page.keyboard.press('Escape');

      await page.goto(`/manager?workspace=${workspace.id}&gender=Men`);
      await expect(page.getByRole('button', { name: 'Edit scoring rules' })).toBeVisible();
      await capture(page, `${theme}-${width}-manager-scoring-summary`);
      await page.getByRole('tab', { name: 'Lineup' }).click();
      await page.getByRole('button', { name: 'Alpha University' }).click();
      await expect(page.getByRole('button', { name: 'Open scoring rules' })).toBeVisible();
      await capture(page, `${theme}-${width}-manager-lineup-lock`);
      await page.getByRole('button', { name: 'Open scoring rules' }).click();
      await expect(page.getByRole('dialog', { name: 'Scoring Matrix Configuration' })).toBeVisible();
      await capture(page, `${theme}-${width}-scoring-rules-modal-manager`);
    }
  }
  expect(errors).toEqual([]);
});
