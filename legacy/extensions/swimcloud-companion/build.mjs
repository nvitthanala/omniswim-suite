#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bundles the extension's two TypeScript entry points:
 *
 *   src/crawler-content.ts -> crawler.js     (Track A′ content script)
 *   src/background.ts      -> background.js  (the service worker)
 *
 * Per `plans/2026-09-08/03-extension-crawler.md`, this is the mechanism that
 * lets the extension consume `packages/swimcloud`'s real, tested modules —
 * `crawlPlan.ts`, `parser.ts`, `urlClassifier.ts`, `entities.ts` — never
 * hand-copied or reimplemented. `esbuild` is already a dependency of this repo
 * (`apps/shell`'s own build script bundles `server.ts` the same way), so this
 * adds no new tooling.
 *
 * `background.js` joined this list on 2026-09-08. It was hand-written JS
 * carrying its own copy of the capture-id rule; that copy is gone and the
 * worker now imports `captureIdForSubject` from `@omniswim/swimcloud/entities`,
 * which only a bundle can give it. Both outputs are IIFEs, so neither needs
 * `"type": "module"` in `manifest.json`: a Manifest V3 content script and a
 * classic service worker both load a plain non-module script, and nothing in
 * the extension ever `import`s either output.
 *
 * The build inputs live in `./build.config.mjs` so that
 * `tests/swimCloudExtensionBuildFreshness.test.ts` can rebuild with the same
 * options and fail when a committed artifact is stale.
 *
 * Run with: `npm run build:extension` (or `node extensions/swimcloud-companion/build.mjs`)
 */
import * as esbuild from 'esbuild';
import { entries, sharedBuildOptions } from './build.config.mjs';

for (const entry of entries) {
  const result = await esbuild.build({
    ...sharedBuildOptions,
    entryPoints: [entry.in],
    outfile: entry.out,
    logLevel: 'info',
    metafile: true,
  });
  console.log(`Built ${Object.keys(result.metafile.outputs).join(', ')}`);
}
