#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `npm run test:harness`: the end-to-end extension harness (tests/harness).
 *
 * It loads the REAL built extension into real Chromium, against a fake SwimCloud made of committed
 * fixtures, with the real app as the backend. It never requests swimcloud.com. It is NOT part of
 * `npm test` or `vitest run`. It uses real 3 s pacing, so a full run takes a few minutes.
 *
 * It skips cleanly (exit 0, with a message) when Chromium or the extension build is missing,
 * except when CI is set, where a skip exits 1.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(import.meta.dirname, '..');

function skip(reason, fix) {
  console.log(`[harness] SKIPPED: ${reason}`);
  console.log(`[harness] To run it: ${fix}`);
  // On CI a skip would let the job pass without running the harness, so it fails there.
  process.exit(process.env.CI ? 1 : 0);
}

const chromiumPath = chromium.executablePath();
if (!existsSync(chromiumPath)) skip(`Chromium is not installed (looked for ${chromiumPath}).`, 'npx playwright install chromium');

for (const file of ['background.js', 'crawler.js', 'content.js', 'manifest.json']) {
  if (!existsSync(join(root, 'extensions', 'swimcloud-companion', file))) {
    skip(`the extension build is missing (extensions/swimcloud-companion/${file}).`, 'npm run build:extension');
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = process.env.HARNESS_PORT ?? String(await freePort());
console.log(`[harness] app on 127.0.0.1:${port}, data copied to a temp folder, Chromium at ${chromiumPath}`);
const result = spawnSync(process.execPath, [join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', 'tests/harness/playwright.harness.config.ts', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HARNESS_PORT: port },
});
process.exit(result.status ?? 1);
