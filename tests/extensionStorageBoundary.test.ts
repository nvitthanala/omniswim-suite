/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 decision 0.2: a content script never touches IndexedDB. T-B6 in
 * extensionBundleBoundaries.test.ts matches the path `apps/extension/src/storage/idb`, which no
 * file in the storage folder has, so that half of T-B6 cannot fail. This test covers the folder.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildEntry, entries, extensionRoot, inputFromRepoRoot } from './helpers/extensionBuild';

const STORAGE = /^apps\/extension\/src\/storage\//;

describe('the storage layer stays out of the page-world bundles (D3 0.2)', () => {
  it('no content-script bundle includes a file from apps/extension/src/storage, or idb', async () => {
    for (const name of ['sim-bridge', 'sim-overlay']) {
      const entry = entries.find((e) => e.name === name);
      if (!entry) throw new Error(`no entry ${name}`);
      const built = await buildEntry(entry);
      const inputs = Object.keys(built.metafile.inputs).map(inputFromRepoRoot);
      expect(inputs.length, `${name} has no inputs`).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input, `${name} bundles the storage layer`).not.toMatch(STORAGE);
        expect(input, `${name} bundles idb`).not.toMatch(/node_modules\/idb\//);
      }
    }
  }, 60_000);

  it('non-vacuous: a bundle that does import the storage layer shows both patterns', async () => {
    const probe = await buildEntry({
      name: 'storage-probe',
      in: path.join(extensionRoot, 'src', 'storage', 'index.ts'),
      format: 'iife',
      loader: {},
    });
    const inputs = Object.keys(probe.metafile.inputs).map(inputFromRepoRoot);
    expect(inputs.some((i) => STORAGE.test(i))).toBe(true);
    expect(inputs.some((i) => /node_modules\/idb\//.test(i))).toBe(true);
    const js = probe.files.find((f) => f.name === 'storage-probe.js');
    expect(js?.text).toMatch(/indexedDB/);
  }, 60_000);
});
