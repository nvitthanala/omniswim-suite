import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * R4, against the real app: the All-teams optimizer runs in the scoring Web Worker.
 *
 * Uses the local real workspace "Blank Workspace 1" (a loaded meet, three teams). A full all-teams
 * run on it is long enough to watch progress and press Cancel before it ends, and an in-thread run
 * would freeze the page for that whole time. So this spec proves two things a vitest run cannot:
 *  - the page keeps painting and running timers while the optimizer runs (a heartbeat timer keeps
 *    ticking), and the progress line counts teams;
 *  - Cancel stops the run, and nothing is applied (no Apply, no save request).
 *
 * The spec posts a copy of that workspace from data/meets.json (a local file, not committed), never
 * applies, and deletes the copy. It skips when data/meets.json or the workspace is absent.
 *   PORT=<free> npx playwright test tests/e2e/optimize-worker.spec.ts
 */
const MEETS_JSON = join(import.meta.dirname, '../../data/meets.json');
const SOURCE_ID = '8fc8e12e-7fea-4dfc-923f-394361232f94';

test('All-teams run reports progress, keeps the page alive, and Cancel applies nothing', async ({ page, request }) => {
  test.skip(!existsSync(MEETS_JSON), 'data/meets.json is not present');
  const all = JSON.parse(readFileSync(MEETS_JSON, 'utf8')) as Array<Record<string, unknown>>;
  const source = all.find(w => w.id === SOURCE_ID);
  test.skip(!source, 'real workspace not present in data/meets.json');

  const stamp = Date.now();
  const id = `ui-r4-${stamp}`;
  // Result ids are unique across workspaces, so the copy gets its own.
  const rows = (key: string, tag: string) =>
    ((source![key] ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-${tag}-${index}` }));
  const created = await request.post('/api/workspaces', {
    data: {
      ...source,
      id,
      name: `UI R4 ${stamp}`,
      createdAt: stamp,
      menResults: rows('menResults', 'm'),
      womenResults: rows('womenResults', 'w'),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  try {
    const saves: string[] = [];
    page.on('request', r => {
      if (r.method() === 'PUT' && r.url().includes('/api/workspaces/')) saves.push(r.url());
    });

    await page.addInitScript(workspaceId => {
      localStorage.setItem('omni-active-workspace-id', workspaceId);
      localStorage.setItem('omni-active-gender', 'Men');
    }, id);
    await page.goto('/manager');
    await page.getByRole('tab', { name: /Optimize/ }).click();

    const whatIf = page.getByLabel('What-if');
    if (!(await whatIf.isChecked())) await whatIf.check();

    await page.getByRole('button', { name: 'All teams…' }).click();
    // A heartbeat on the page's main thread. It cannot tick while that thread is blocked.
    await page.evaluate(() => {
      const w = window as unknown as { __beats: number };
      w.__beats = 0;
      setInterval(() => {
        w.__beats += 1;
      }, 50);
    });
    await page.getByRole('button', { name: /Run optimizer/ }).click();

    // Plain-word progress: "Optimizing 2 of 3 teams".
    await expect(page.getByText(/Optimizing \d+ of \d+ teams?/)).toBeVisible({ timeout: 30_000 });
    const beatsA = await page.evaluate(() => (window as unknown as { __beats: number }).__beats);
    await page.waitForTimeout(1500);
    const beatsB = await page.evaluate(() => (window as unknown as { __beats: number }).__beats);
    // 1.5 s at 50 ms is 30 beats when the page is free. A blocked main thread gives 0.
    expect(beatsB - beatsA).toBeGreaterThan(10);

    await page.screenshot({ path: 'test-results/optimize-worker-progress.png' });

    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByRole('button', { name: /Run optimizer/ })).toBeVisible();
    await expect(page.getByText('Optimization cancelled. Nothing was changed.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Apply to workspace/ })).toBeDisabled();

    // Give a stray reply and the debounced save time to show up, then check nothing was written.
    await page.waitForTimeout(1500);
    expect(saves).toEqual([]);
  } finally {
    await request.delete(`/api/workspaces/${id}`);
  }
});

/**
 * The single-team button in the real app: the worker result is applied on the main thread, the
 * summary and Undo appear, and a save follows. Uses the committed synthetic fixture.
 */
test('Optimize team runs in the worker and applies on the main thread', async ({ page, request }) => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, '../fixtures/optimize-undo-workspace.json'), 'utf8')
  ) as Record<string, unknown>;
  const stamp = Date.now();
  const id = `ui-r4t-${stamp}`;
  const rows = (key: string, tag: string) =>
    ((fixture[key] ?? []) as Array<Record<string, unknown>>).map((row, index) => ({ ...row, id: `${id}-${tag}-${index}` }));
  const created = await request.post('/api/workspaces', {
    data: {
      ...fixture,
      id,
      name: `UI R4 team ${stamp}`,
      createdAt: stamp,
      menResults: rows('menResults', 'm'),
      womenResults: rows('womenResults', 'w'),
      loadedMeet: { pdfFilename: 'fixture.pdf' },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  try {
    await page.addInitScript(workspaceId => {
      localStorage.setItem('omni-active-workspace-id', workspaceId);
      localStorage.setItem('omni-active-gender', 'Men');
    }, id);
    await page.goto('/manager');
    await page.getByRole('tab', { name: /Optimize/ }).click();
    const whatIf = page.getByLabel('What-if');
    if (!(await whatIf.isChecked())) await whatIf.check();
    await page
      .getByRole('combobox', { name: 'Team', exact: true })
      .first()
      .selectOption({ label: 'Henderson State University' });

    const isSave = (r: { method(): string; url(): string }) => r.method() === 'PUT' && r.url().endsWith(`/api/workspaces/${id}`);
    const saved = page.waitForRequest(isSave);
    await page.getByRole('button', { name: 'Optimize team', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo this optimize' })).toBeVisible({ timeout: 30_000 });
    await saved;
    // The run is over: no status line, and the button is free again.
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Optimize team', exact: true })).toBeEnabled();
  } finally {
    await request.delete(`/api/workspaces/${id}`);
  }
});
