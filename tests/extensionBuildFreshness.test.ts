/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 2.5, T-B1 to T-B4: the extension build is the one in the spec, is
 * deterministic, and `dist/` is not stale.
 *
 * `dist/` is not committed (D3 2.4), so T-B3 is the stale-bundle guard. Locally
 * it skips when `dist/` is missing. On CI it fails, so CI must run
 * `npm run build:extension` before the tests.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { buildAll, buildEntry, entries, extensionRoot, outDir, staticFiles, type BuiltEntry } from './helpers/extensionBuild';

const normalise = (s: string): string => s.replace(/\r\n/g, '\n');
/** Static files compared as text. Anything else (highs.wasm) is compared as bytes. */
const TEXT_STATIC = /\.(json|html|css|js)$/;

describe('extension build (D3 2.5)', () => {
  let built: BuiltEntry[] = [];
  beforeAll(async () => {
    built = await buildAll();
  }, 60_000);

  it('T-B1: the entries are exactly the five in D3 2.2', () => {
    expect(entries.map((e) => e.name).sort()).toStrictEqual([
      'dashboard',
      'optimizer.worker',
      'service-worker',
      'sim-bridge',
      'sim-overlay',
    ]);
    // Content scripts and the service worker must be classic scripts.
    expect(entries.every((e) => e.format === 'iife')).toBe(true);
  });

  it('T-B2: building an entry twice gives byte-equal output', async () => {
    expect(built.length).toBe(entries.length);
    for (const first of built) {
      const second = await buildEntry(first.entry);
      expect(second.files.map((f) => f.name)).toStrictEqual(first.files.map((f) => f.name));
      for (const [i, file] of first.files.entries()) {
        expect(second.files[i]?.text, `${file.name} differs between two builds`).toBe(file.text);
      }
    }
  }, 60_000);

  it('T-B3: dist/ matches a fresh build, and each static file matches its source', (ctx) => {
    if (!existsSync(outDir)) {
      if (process.env.CI) {
        throw new Error('apps/extension/dist/ is missing on CI. Run: npm run build:extension (before the tests)');
      }
      ctx.skip();
    }
    const expectedNames = [
      ...built.flatMap((b) => b.files.map((f) => f.name)),
      ...staticFiles.map((s) => s.to),
    ].sort();
    const actualNames = readdirSync(outDir).sort();
    expect(actualNames, 'dist/ lists different files than the build produces. Run: npm run build:extension').toStrictEqual(expectedNames);

    for (const b of built) {
      for (const file of b.files) {
        const onDisk = readFileSync(path.join(outDir, file.name), 'utf8');
        expect(normalise(onDisk), `dist/${file.name} is stale. Run: npm run build:extension`).toBe(normalise(file.text));
      }
    }
    for (const s of staticFiles) {
      const message = `dist/${s.to} differs from ${s.from}. Run: npm run build:extension`;
      if (TEXT_STATIC.test(s.to)) {
        // Text: line endings may differ by checkout, so normalise them.
        const source = readFileSync(path.join(extensionRoot, s.from), 'utf8');
        const onDisk = readFileSync(path.join(outDir, s.to), 'utf8');
        expect(normalise(onDisk), message).toBe(normalise(source));
      } else {
        // Binary (highs.wasm): bytes, never decoded.
        const source = readFileSync(path.join(extensionRoot, s.from));
        const onDisk = readFileSync(path.join(outDir, s.to));
        expect(onDisk.equals(source), message).toBe(true);
      }
    }
  });

  it('T-B4: the esbuild that runs is the exact version in apps/extension/package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const pin = pkg.devDependencies?.esbuild ?? pkg.dependencies?.esbuild;
    expect(pin, 'esbuild must be declared in apps/extension/package.json').toBeTypeOf('string');
    expect(pin, 'the esbuild pin has no ^ or ~').toMatch(/^\d+\.\d+\.\d+$/);
    expect(esbuild.version).toBe(pin);
    // A second copy under the workspace would build with a different esbuild than this test sees.
    expect(existsSync(path.join(extensionRoot, 'node_modules', 'esbuild'))).toBe(false);
  });
});
