#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the OmniSwim Chrome extension into `apps/extension/dist/`.
 *
 *   node apps/extension/build.mjs            build once
 *   node apps/extension/build.mjs --watch    rebuild on change (reload the extension by hand)
 *   node apps/extension/build.mjs --harness  build into dist-harness/ with the test probe on
 *
 * `dist/` is not committed (D3 2.4). `tests/extensionBuildFreshness.test.ts`
 * fails on CI when it is missing or stale, so run `npm run build:extension`
 * before the tests.
 */
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { entries, entryBuildOptions, extensionRoot, harnessOutDir, outDir as productionOutDir, staticFiles } from './build.config.mjs';

const watch = process.argv.includes('--watch');
const harness = process.argv.includes('--harness');
const outDir = harness ? harnessOutDir : productionOutDir;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

function copyStatic() {
  for (const file of staticFiles) cpSync(path.join(extensionRoot, file.from), path.join(outDir, file.to));
}

copyStatic();

if (watch) {
  for (const entry of entries) {
    const ctx = await esbuild.context({ ...entryBuildOptions(entry, { harness }), logLevel: 'info' });
    await ctx.watch();
  }
  console.log(`Watching ${entries.length} entries. Static files are copied once; restart to refresh them.`);
} else {
  for (const entry of entries) {
    const result = await esbuild.build({ ...entryBuildOptions(entry, { harness }), write: true });
    console.log(`Built ${Object.keys(result.metafile.outputs).join(', ')}`);
  }
  console.log(`Copied ${staticFiles.map((f) => f.to).join(', ')}`);
}
