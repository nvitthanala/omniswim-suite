#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `npm run test:extension-harness`: the S3 worker harness (tests/extension-harness).
 *
 * It builds the harness copy of the OmniSwim extension (apps/extension/dist-harness) and loads it into real Chromium, against a fake
 * SwimCloud page made of a committed synthetic fixture. It never requests swimcloud.com. It is NOT
 * part of `npm test` or `vitest run`.
 *
 * It skips cleanly (exit 0, with a message) when Chromium or the extension build is missing,
 * except when CI is set, where a skip exits 1. Same rule as legacy/scripts/run-harness.mjs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(import.meta.dirname, '..');

function skip(reason, fix) {
  console.log(`[extension-harness] SKIPPED: ${reason}`);
  console.log(`[extension-harness] To run it: ${fix}`);
  // On CI a skip would let the job pass without running the harness, so it fails there.
  process.exit(process.env.CI ? 1 : 0);
}

const chromiumPath = chromium.executablePath();
if (!existsSync(chromiumPath)) skip(`Chromium is not installed (looked for ${chromiumPath}).`, 'npx playwright install chromium');

// The harness loads its own build, apps/extension/dist-harness/, where the dashboard has the
// `osxHarness` probe. The production dist/ never has it. Build it fresh so it cannot go stale.
const wasm = join(root, 'node_modules', 'highs', 'build', 'highs.wasm');
if (!existsSync(wasm)) skip(`the highs package is not installed (looked for ${wasm}).`, 'npm ci');

const dist = join(root, 'apps', 'extension', 'dist-harness');
console.log('[extension-harness] building the harness extension (build.mjs --harness)');
const build = spawnSync(process.execPath, [join(root, 'apps', 'extension', 'build.mjs'), '--harness'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  console.log('[extension-harness] FAILED: the harness build did not finish.');
  process.exit(1);
}
for (const file of ['manifest.json', 'service-worker.js', 'sim-bridge.js', 'sim-overlay.js', 'dashboard.html', 'dashboard.js', 'optimizer.worker.js', 'autobuilder.worker.js', 'highs.wasm']) {
  if (!existsSync(join(dist, file))) skip(`the harness build is missing (apps/extension/dist-harness/${file}).`, 'node apps/extension/build.mjs --harness');
}

console.log(`[extension-harness] extension at ${dist}, Chromium at ${chromiumPath}`);
const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', 'tests/extension-harness/playwright.config.ts', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
