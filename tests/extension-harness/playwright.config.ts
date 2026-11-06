import { defineConfig } from '@playwright/test';

/**
 * The S3 worker harness config. Run it with `npm run test:extension-harness`
 * (scripts/run-extension-harness.mjs checks that Chromium and the extension build exist first).
 * It is not part of `npm test` or vitest, and it starts no server: the extension loads into
 * Chromium and the fake SwimCloud is a Playwright route.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { actionTimeout: 15_000 },
});
