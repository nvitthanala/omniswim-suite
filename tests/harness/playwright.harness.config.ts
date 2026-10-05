import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * The extension harness config. Run it with `npm run test:harness` (scripts/run-harness.mjs checks
 * that Chromium and the extension build exist first). It is not part of `npm test` or vitest.
 *
 * The app is the real dev server on a COPY of data/, as the e2e specs do. Only the main process
 * builds the copy; workers reuse the path.
 */
const PORT = Number(process.env.HARNESS_PORT ?? 3711);
const root = join(import.meta.dirname, '..', '..');

function dataDir(): string {
  const dir = join(tmpdir(), `omniswim-harness-data-${PORT}`);
  if (process.env.TEST_WORKER_INDEX === undefined) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, 'data'), dir, { recursive: true, filter: src => !/[\\/]data[\\/]backups([\\/]|$)/.test(src) });
  }
  return dir;
}
const dir = dataDir();

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: '*.harness.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  // Real 3 s pacing: one scenario takes up to a few minutes.
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, actionTimeout: 15_000 },
  webServer: {
    command: 'npm run dev',
    cwd: root,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      PORT: String(PORT),
      OMNI_DATA_DIR: existsSync(dir) ? dir : '',
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--use-system-ca',
    },
  },
});
