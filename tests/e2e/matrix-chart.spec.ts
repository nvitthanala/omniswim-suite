import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, request as apiRequest } from '@playwright/test';

const fixturePath = join(import.meta.dirname, '../fixtures/chart-workspace.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  id: string;
  name: string;
  [key: string]: unknown;
};

// Must mirror the id/name patterns used when the spec creates its workspace
// below (`chart-e2e-${Date.now()}` / `Chart E2E ${Date.now()}`). ONLY
// workspaces matching these patterns are ever deleted by the teardown.
const E2E_WORKSPACE_ID_RE = /^chart-e2e-\d+$/;
const E2E_WORKSPACE_NAME_RE = /^Chart E2E \d+$/;

// Same base URL resolution as playwright.config.ts.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`;

test.describe('Matrix timeline chart', () => {
  // Auto-cleanup: delete the workspace(s) this run created AND stale leftovers
  // from prior runs (they otherwise accumulate in the sidebar). Matches only
  // the e2e naming pattern — never touches user workspaces.
  test.afterAll(async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL });
    try {
      const listRes = await ctx.get('/api/workspaces');
      if (!listRes.ok()) return; // best-effort cleanup — never fail the run
      const workspaces = (await listRes.json()) as Array<{ id: string; name?: string }>;
      const stale = workspaces.filter(
        ws => E2E_WORKSPACE_ID_RE.test(ws.id) || E2E_WORKSPACE_NAME_RE.test(ws.name ?? '')
      );
      for (const ws of stale) {
        await ctx.delete(`/api/workspaces/${ws.id}`).catch(() => {});
      }
    } catch {
      // Best-effort: cleanup failures must not fail the e2e run.
    } finally {
      await ctx.dispose();
    }
  });

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
