import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const fixturePath = join(import.meta.dirname, '../fixtures/chart-workspace.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  id: string;
  name: string;
  [key: string]: unknown;
};

test.describe('Matrix timeline chart', () => {
  test('renders SVG without ResponsiveContainer or -1 sizing warnings', async ({ page, request }) => {
    const minusOneWarnings: string[] = [];
    page.on('console', msg => {
      if (/width\(-1\).*height\(-1\)/.test(msg.text())) {
        minusOneWarnings.push(msg.text());
      }
    });

    const uniqueId = `chart-e2e-${Date.now()}`;
    const payload = {
      ...fixture,
      id: uniqueId,
      name: `Chart E2E ${Date.now()}`,
      createdAt: Date.now(),
      menResults: (fixture.menResults as Array<{ id: string; [key: string]: unknown }>).map((r, i) => ({
        ...r,
        id: `${uniqueId}-m-${i}`,
      })),
    };

    const createRes = await request.post('/api/workspaces', { data: payload });
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };

    await page.goto(`/matrix?workspace=${created.id}`);
    await expect(page.getByText('Chronological Team Score Timeline')).toBeVisible({ timeout: 30_000 });

    const shell = page.locator('.chart-shell').first();
    await expect(shell).toBeVisible({ timeout: 30_000 });
    await expect(shell).toHaveAttribute('data-chart-live-ready', 'true', { timeout: 30_000 });

    const chartW = Number(await shell.getAttribute('data-chart-w'));
    const chartH = Number(await shell.getAttribute('data-chart-h'));
    expect(chartW).toBeGreaterThan(100);
    expect(chartH).toBeGreaterThan(100);

    await expect(page.locator('.recharts-responsive-container')).toHaveCount(0);

    const wrapper = page.locator('.recharts-wrapper').first();
    await expect(wrapper).toBeVisible({ timeout: 45_000 });
    const box = await wrapper.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);
    expect(box?.height ?? 0).toBeGreaterThan(100);

    const surface = page.locator('svg.recharts-surface').first();
    await expect(surface).toBeVisible({ timeout: 15_000 });
    const svgWidth = Number(await surface.getAttribute('width'));
    const svgHeight = Number(await surface.getAttribute('height'));
    expect(svgWidth).toBeGreaterThan(100);
    expect(svgHeight).toBeGreaterThan(100);

    const gridOrLines = page.locator(
      '.recharts-cartesian-grid line, .recharts-cartesian-grid path, .recharts-line path, path.recharts-curve'
    );
    expect(await gridOrLines.count()).toBeGreaterThan(0);

    expect(minusOneWarnings).toEqual([]);
  });
});
