/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 2.5, T-B5 to T-B9: what the extension bundles may and may not contain.
 * Each test reads the esbuild metafile `inputs` or the output text of an
 * in-memory build, and each asserts it saw something, so an empty scan cannot pass.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildAll, buildEntry, entries, extensionRoot, inputFromRepoRoot, outDir, repoRoot, staticFiles, type BuiltEntry } from './helpers/extensionBuild';

/** Largest allowed `sim-bridge.js`, bytes. D3 2.2 said "under 5 KB"; README R79 (line 103) raised it to 10,000. */
const BRIDGE_MAX_BYTES = 10000;

describe('extension bundle boundaries (D3 2.5)', () => {
  let built: BuiltEntry[] = [];
  beforeAll(async () => {
    built = await buildAll();
  }, 60_000);

  const byName = (name: string): BuiltEntry => {
    const found = built.find((b) => b.entry.name === name);
    if (!found) throw new Error(`no build for entry ${name}`);
    return found;
  };
  const jsOf = (name: string): string => {
    const file = byName(name).files.find((f) => f.name === `${name}.js`);
    if (!file) throw new Error(`no ${name}.js output`);
    return file.text;
  };
  const inputsOf = (b: BuiltEntry): string[] => Object.keys(b.metafile.inputs).map(inputFromRepoRoot);

  it('T-B5: no node: import, no Playwright, no SwimCloud fetch layer, no legacy code, no app stylesheet', () => {
    let seen = 0;
    let fromExtensionSource = 0;
    for (const b of built) {
      for (const input of inputsOf(b)) {
        seen += 1;
        if (input.startsWith('apps/extension/src/')) fromExtensionSource += 1;
        expect(input, `${b.entry.name} bundles a node: module`).not.toMatch(/(^|\/)node:/);
        expect(input, `${b.entry.name} bundles playwright-core`).not.toContain('playwright-core');
        expect(input, `${b.entry.name} bundles the SwimCloud fetch layer`).not.toMatch(
          /packages\/swimcloud\/src\/(index|cache|fetcher|playwrightFetcher|captureStore)\.ts$/,
        );
        expect(input, `${b.entry.name} bundles legacy code`).not.toMatch(/^legacy\//);
        expect(input, `${b.entry.name} bundles the app stylesheet`).not.toBe('legacy/packages/ui/src/index.css');
        expect(input, `${b.entry.name} bundles the app stylesheet`).not.toBe('packages/ui/src/index.css');
      }
      // Output text, too: a `node:` specifier left as an external import would show here.
      for (const f of b.files) expect(f.text, `${f.name} mentions a node: specifier`).not.toMatch(/["']node:[a-z_/]+["']/);
    }
    expect(seen).toBeGreaterThan(10);
    expect(fromExtensionSource).toBeGreaterThanOrEqual(5);
  });

  it('T-B6: the page-world bundles contain no indexedDB and no storage module', () => {
    for (const name of ['sim-bridge', 'sim-overlay']) {
      expect(jsOf(name), `${name}.js mentions indexedDB`).not.toMatch(/indexedDB/i);
      const inputs = inputsOf(byName(name));
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input, `${name} bundles the storage layer`).not.toMatch(/^apps\/extension\/src\/storage\//);
      }
    }
  });

  it('T-B7: no eval( and no new Function( in the script bundles (MV3 CSP blocks both)', () => {
    for (const name of ['service-worker', 'optimizer.worker', 'sim-bridge', 'sim-overlay']) {
      const text = jsOf(name);
      expect(text.length, `${name}.js is empty`).toBeGreaterThan(100);
      expect(text, `${name}.js contains eval(`).not.toMatch(/\beval\s*\(/);
      expect(text, `${name}.js contains new Function(`).not.toMatch(/new\s+Function\s*\(/);
    }
  });

  it('T-B8: no output has a top-level import or export', () => {
    let scanned = 0;
    for (const b of built) {
      for (const f of b.files.filter((x) => x.name.endsWith('.js'))) {
        scanned += 1;
        expect(f.text, `${f.name} has a top-level import`).not.toMatch(/^\s*import\s*[\w{*"']/m);
        expect(f.text, `${f.name} has a top-level export`).not.toMatch(/^\s*export\s+(\{|\*|default|const|let|var|function|class|async)/m);
      }
    }
    expect(scanned).toBe(5);
  });

  it('T-B9: every selector in static/light.css begins with .osx- or [data-osx', () => {
    const css = readFileSync(path.join(extensionRoot, 'static', 'light.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Selector lists sit before each `{`. light.css has no at-rules, which this also asserts.
    const preludes = [...css.matchAll(/([^{}]+)\{/g)].map((m) => (m[1] ?? '').trim());
    expect(preludes.length).toBeGreaterThan(0);
    for (const prelude of preludes) {
      expect(prelude.startsWith('@'), `light.css uses an at-rule: ${prelude}`).toBe(false);
      for (const selector of prelude.split(',').map((s) => s.trim())) {
        expect(selector, `light.css selector "${selector}" is not scoped`).toMatch(/^(\.osx-|\[data-osx)/);
      }
    }
  });

  it('sim-bridge.js stays under 10 KB (D3 2.2, README R79)', () => {
    const bytes = Buffer.byteLength(jsOf('sim-bridge'), 'utf8');
    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThan(BRIDGE_MAX_BYTES);
  });

  it('highs.wasm is a static copy, not an entry, and dist/highs.wasm is byte-identical to the package file', (ctx) => {
    for (const b of built) expect(b.files.map((f) => f.name).join(), `${b.entry.name} emits a highs file`).not.toContain('highs');
    expect(staticFiles.map((s) => s.to)).toContain('highs.wasm');
    const source = readFileSync(path.join(repoRoot, 'node_modules', 'highs', 'build', 'highs.wasm'));
    expect(source.length).toBe(3_531_401); // highs 1.15.4
    const copy = staticFiles.find((s) => s.to === 'highs.wasm')!;
    expect(readFileSync(path.join(extensionRoot, copy.from)).equals(source), 'the static list points at another file').toBe(true);
    if (!existsSync(outDir)) {
      if (process.env.CI) throw new Error('apps/extension/dist/ is missing on CI. Run: npm run build:extension');
      ctx.skip();
    }
    expect(readFileSync(path.join(outDir, 'highs.wasm')).equals(source), 'dist/highs.wasm differs from node_modules/highs/build/highs.wasm').toBe(true);
  });

  it('T-B10: the production build holds no osxHarness probe; the harness build does (plant)', async (ctx) => {
    // The probe lives only in the dashboard bundle. Scan every production output, source text included.
    let scanned = 0;
    for (const b of built) {
      for (const f of b.files) {
        scanned += 1;
        expect(f.text, `${f.name} contains the harness probe`).not.toMatch(/osxHarness|__OSX_HARNESS__/);
      }
    }
    expect(scanned).toBeGreaterThan(5);
    // Plant: the same scan must see the probe in the harness build, or the scan above proves nothing.
    const dashboard = entries.find((e) => e.name === 'dashboard')!;
    const planted = await buildEntry(dashboard, { harness: true });
    expect(planted.files.find((f) => f.name === 'dashboard.js')!.text).toMatch(/osxHarness/);
    // And the dist/ on disk, which is what ships.
    if (!existsSync(outDir)) {
      if (process.env.CI) throw new Error('apps/extension/dist/ is missing on CI. Run: npm run build:extension');
      ctx.skip();
    }
    for (const name of readdirSync(outDir).filter((n) => /\.(js|html|json|css)$/.test(n))) {
      expect(readFileSync(path.join(outDir, name), 'utf8'), `dist/${name} contains the harness probe`).not.toMatch(/osxHarness|__OSX_HARNESS__/);
    }
  });
});
