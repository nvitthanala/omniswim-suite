/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The committed extension bundles must match their TypeScript source.
 *
 * ## Why this test exists
 *
 * `extensions/swimcloud-companion/` ships two generated artifacts —
 * `crawler.js` and `background.js` — built from `src/*.ts` by `build.mjs`.
 * Until 2026-09-20 that build was **manual only**: not in any npm script, not
 * in `.github/workflows/ci.yml`, and checked by no test. Lint, the full suite
 * and the production build all passed against a stale bundle.
 *
 * The failure that allows is silent and expensive. A developer edits
 * `crawler-content.ts`, runs the tests (which exercise the TypeScript through
 * `tests/swimCloudExtension*.test.ts` and pass), commits, and loads the
 * extension — which reads `crawler.js`, the *previous* build. The crawl then
 * runs logic nobody is looking at, and every test that "covers" it was testing
 * a different file. This repo already treats "a guard that cannot fail" as a
 * first-class defect (`docs/INVARIANTS.md` item 8); a bundle nothing verifies
 * is the same shape of problem one layer out.
 *
 * ## Why it rebuilds instead of comparing timestamps
 *
 * An mtime check answers "was the artifact written after the source?", which a
 * `git checkout` or a clone can make true or false for reasons unrelated to
 * correctness. Rebuilding answers the question that actually matters: does the
 * committed byte sequence equal what the current source produces? esbuild is
 * deterministic for fixed options and a fixed version, which was verified by
 * rebuilding twice and getting byte-identical output both times.
 *
 * The options come from `build.config.mjs`, imported here rather than copied,
 * so this test cannot drift from the real build — a copied config would let the
 * guard pass while the shipped bundle was built differently.
 */

import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
// @ts-expect-error -- plain .mjs config, deliberately untyped; see its header.
import { entries, sharedBuildOptions } from '../extensions/swimcloud-companion/build.config.mjs';

interface BuildEntry {
  readonly in: string;
  readonly out: string;
}

const buildEntries = entries as readonly BuildEntry[];

describe('extension bundles are in sync with their source', () => {
  it('builds both entry points', () => {
    // Guards the loop below: if build.config.mjs ever stops exporting entries,
    // a forEach over an empty array would report success having checked nothing.
    expect(buildEntries).toHaveLength(2);
    expect(buildEntries.map((e) => path.basename(e.out)).sort()).toStrictEqual([
      'background.js',
      'crawler.js',
    ]);
  });

  for (const entry of buildEntries) {
    const artifact = path.basename(entry.out);

    it(`${artifact} matches a fresh build of ${path.basename(entry.in)}`, async () => {
      const result = await esbuild.build({
        ...sharedBuildOptions,
        entryPoints: [entry.in],
        write: false,
        logLevel: 'silent',
      });

      expect(result.outputFiles).toHaveLength(1);
      const rebuilt = result.outputFiles![0].text;
      const committed = await readFile(entry.out, 'utf-8');

      // Normalise only line endings. This repo runs on Windows with
      // core.autocrlf, so a committed artifact can differ from esbuild's
      // LF output by nothing but CRLF — which is not a staleness signal.
      const normalise = (s: string): string => s.replace(/\r\n/g, '\n');

      expect(
        normalise(committed),
        `${artifact} is stale. Run: npm run build:extension`,
      ).toBe(normalise(rebuilt));
    }, 30_000);
  }
});
