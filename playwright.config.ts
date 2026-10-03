import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Every server start writes a startup backup, and specs create workspaces. Pointing either at the
 * real `data/` folder left stale `ui-*` workspaces and 20 duplicate backups. So unless the caller
 * sets OMNI_DATA_DIR, specs run against a fresh copy of `data/` under the temp folder.
 * Playwright loads this file in the main process and again in each worker. Only the main process
 * (no TEST_WORKER_INDEX) builds the copy; workers reuse the same path.
 */
function e2eDataDir(): string | undefined {
  if (process.env.OMNI_DATA_DIR || process.env.PLAYWRIGHT_BASE_URL) return process.env.OMNI_DATA_DIR;
  const dir = join(tmpdir(), `omniswim-e2e-data-${PORT}`);
  if (process.env.TEST_WORKER_INDEX === undefined) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(join(import.meta.dirname, 'data'), dir, {
      recursive: true,
      filter: src => !/[\\/]data[\\/]backups([\\/]|$)/.test(src),
    });
  }
  return existsSync(dir) ? dir : undefined;
}
const dataDir = e2eDataDir();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      ...(dataDir ? { OMNI_DATA_DIR: dataDir } : {}),
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--use-system-ca',
    },
  },
});
