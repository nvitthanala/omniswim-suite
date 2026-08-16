import { test, expect } from '@playwright/test';

/**
 * Regression guard for the "8.3s main-thread freeze" defect.
 *
 * A correctness fix put a multi-second synchronous computation into a React
 * `useMemo`, so it ran synchronously during render every time the Manager's
 * Optimize step mounted/updated. Measured with a PerformanceObserver on
 * `longtask`, opening Manager -> Optimize blocked the main thread for
 * 33,208ms total across the interaction with a single 8,302ms task — the tab
 * was visibly frozen. It is now fixed by moving the scan behind an explicit
 * button so it never runs implicitly during render.
 *
 * Thresholds (chosen to be loose enough not to flake on a slow CI/dev
 * machine, but tight enough that an 8.3s regression fails loudly):
 *   - MAX_SINGLE_TASK_MS = 1000: a single frame/task over 1s is already
 *     well past the ~50ms "long task" threshold and is user-visible jank;
 *     the actual regression's worst single task was 8x this.
 *   - MAX_TOTAL_BLOCKING_MS = 2500: allows for a handful of legitimately
 *     chunky tasks (chart layout, table virtualization setup) totalling a
 *     few seconds without flagging, while the actual regression's total
 *     (33,208ms) blew past it by more than 13x.
 */

const MAX_SINGLE_TASK_MS = 1000;
const MAX_TOTAL_BLOCKING_MS = 2500;
const SETTLE_MS = 2500;

const STEPS = ['Source', 'Lineup', 'Relays', 'Optimize'];
const TEAM_PICKER_NAME = 'Henderson State University';

test.describe('Manager step main-thread budget', () => {
  test('no Manager step blocks the main thread beyond budget', async ({ page, request }) => {
    const wsRes = await request.get('/api/workspaces');
    expect(wsRes.ok()).toBeTruthy();
    const workspaces = (await wsRes.json()) as Array<{ id: string; name?: string }>;
    expect(workspaces.length).toBeGreaterThan(0);

    const results: Array<{
      workspaceId: string;
      step: string;
      totalBlockedMs: number;
      worstTaskMs: number;
      taskCount: number;
      supported: boolean;
    }> = [];

    for (const ws of workspaces) {
      await page.goto(`/manager?workspace=${ws.id}&gender=Men`);

      const supported = await installLongTaskObserver(page);

      for (const step of STEPS) {
        await clearLongTasks(page);

        const tab = page.getByRole('tab', { name: new RegExp(step) });
        await tab.click({ timeout: 30_000 });

        // Some steps (Optimize, Lineup) show a team picker first on
        // multi-team workspaces. Pick Henderson State if present, else
        // proceed — single-team workspaces skip straight past this.
        const teamButton = page.getByRole('button', { name: TEAM_PICKER_NAME, exact: true });
        if (await teamButton.count()) {
          await teamButton.first().click();
        }

        await page.waitForTimeout(SETTLE_MS);

        const tasks = supported ? await readLongTasks(page) : [];
        const totalBlockedMs = tasks.reduce((sum, t) => sum + t, 0);
        const worstTaskMs = tasks.length ? Math.max(...tasks) : 0;

        results.push({
          workspaceId: ws.id,
          step,
          totalBlockedMs,
          worstTaskMs,
          taskCount: tasks.length,
          supported,
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log('\nMain-thread budget by workspace/step:');
    // eslint-disable-next-line no-console
    console.log('workspace'.padEnd(24) + 'step'.padEnd(10) + 'totalBlocked'.padEnd(14) + 'worstTask'.padEnd(12) + 'tasks');
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        r.workspaceId.slice(0, 22).padEnd(24) +
          r.step.padEnd(10) +
          `${r.totalBlockedMs}ms`.padEnd(14) +
          `${r.worstTaskMs}ms`.padEnd(12) +
          `${r.taskCount}${r.supported ? '' : ' (longtask unsupported, skipped)'}`
      );
    }

    if (!results.some(r => r.supported)) {
      test.skip(true, 'PerformanceObserver longtask entry type is not supported in this browser');
      return;
    }

    for (const r of results) {
      if (!r.supported) continue;
      expect(
        r.worstTaskMs,
        `workspace ${r.workspaceId}, step ${r.step}: worst single task ${r.worstTaskMs}ms exceeds ${MAX_SINGLE_TASK_MS}ms budget`
      ).toBeLessThanOrEqual(MAX_SINGLE_TASK_MS);
      expect(
        r.totalBlockedMs,
        `workspace ${r.workspaceId}, step ${r.step}: total blocked ${r.totalBlockedMs}ms exceeds ${MAX_TOTAL_BLOCKING_MS}ms budget`
      ).toBeLessThanOrEqual(MAX_TOTAL_BLOCKING_MS);
    }
  });
});

async function installLongTaskObserver(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    (window as any).__longTasks = [];
    try {
      const po = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          (window as any).__longTasks.push(Math.round(e.duration));
        }
      });
      po.observe({ entryTypes: ['longtask'] });
      (window as any).__longTaskObserver = po;
      return true;
    } catch {
      return false;
    }
  });
}

async function clearLongTasks(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__longTasks = [];
  });
}

async function readLongTasks(page: import('@playwright/test').Page): Promise<number[]> {
  return page.evaluate(() => (window as any).__longTasks ?? []);
}
