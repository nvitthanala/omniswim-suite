/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One alias list: `tsconfig.base.json` `compilerOptions.paths`.
 *
 * ## Why this test exists
 *
 * The `@omniswim/*` mapping was once written by hand in four files and had
 * drifted: Vitest aliased one package, Vite five, and the type checker a
 * different set again. A bundler that resolves a specifier to a different file
 * than `tsc` does gives a wrong-file bug no compiler reports.
 *
 * `scripts/lib/tsconfigAliases.ts` now derives the bundler aliases from the
 * base tsconfig. This test closes the other two gaps:
 *
 * 1. Any other tsconfig that declares `paths` must agree with the base on every
 *    key it declares (same target, resolved to an absolute path).
 * 2. The aliases the live Vite and Vitest configs actually hold must resolve
 *    every base path to the file `tsc` resolves it to, apart from the one
 *    documented override.
 *
 * The configs are imported, not text-matched, so a hand-written entry that
 * disagrees is caught whatever it looks like.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTsconfigPaths, tsconfigPathAliases } from '../../scripts/lib/tsconfigAliases';
import viteConfig from '../apps/shell/vite.config';
import vitestConfig from '../../vitest.config';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const slash = (p: string): string => p.split(path.sep).join('/');

const BASE = path.join(root, 'tsconfig.base.json');
// Every tsconfig that carries its own `paths` table. A new one belongs here.
const OTHER_TSCONFIGS = [
  path.join(root, 'legacy/apps/shell/tsconfig.json'),
  path.join(root, 'legacy/packages/db/tsconfig.json'),
];

/**
 * Specifiers that Vite deliberately resolves differently from `tsc`, with the
 * file it must resolve to. `@omniswim/ui/*` maps to `src/*`, which has no
 * `styles.css`; the stylesheet lives in `index.css`.
 */
const DELIBERATE_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  vite: { '@omniswim/ui/styles.css': slash(path.join(root, 'legacy/packages/ui/src/index.css')) },
  vitest: {},
};

type AliasEntry = { find: string | RegExp; replacement: string };

function toEntries(alias: unknown): AliasEntry[] {
  if (Array.isArray(alias)) return alias as AliasEntry[];
  if (alias !== null && typeof alias === 'object') {
    return Object.entries(alias as Record<string, string>).map(([find, replacement]) => ({ find, replacement }));
  }
  return [];
}

/** First matching alias wins, as in `@rollup/plugin-alias`. `undefined` when none match. */
function resolveWithAliases(entries: readonly AliasEntry[], specifier: string): string | undefined {
  for (const { find, replacement } of entries) {
    if (typeof find === 'string') {
      if (specifier === find || specifier.startsWith(`${find}/`)) {
        return slash(replacement) + specifier.slice(find.length);
      }
    } else if (find.test(specifier)) {
      return specifier.replace(find, replacement);
    }
  }
  return undefined;
}

/** Specifier and the absolute file `tsc` maps it to, for every base path. */
function tscResolutions(): Array<{ specifier: string; target: string }> {
  const baseDir = path.dirname(BASE);
  const out: Array<{ specifier: string; target: string }> = [];
  for (const [key, targets] of Object.entries(readTsconfigPaths(BASE))) {
    const target = targets[0] as string;
    if (key.endsWith('/*')) {
      out.push({
        specifier: `${key.slice(0, -2)}/lib/sample`,
        target: `${slash(path.resolve(baseDir, target.slice(0, -2)))}/lib/sample`,
      });
    } else {
      out.push({ specifier: key, target: slash(path.resolve(baseDir, target)) });
    }
  }
  return out;
}

describe('alias config agreement', () => {
  it('the base tsconfig declares the suite aliases (a vacuous table would pass everything below)', () => {
    const specifiers = tscResolutions().map((r) => r.specifier);
    for (const name of ['core', 'ui', 'swimcloud', 'manager', 'matrix', 'metrics']) {
      expect(specifiers).toContain(`@omniswim/${name}`);
    }
  });

  it.each(OTHER_TSCONFIGS.map((file) => [path.relative(root, file).split(path.sep).join('/'), file]))(
    '%s paths agree with the base tsconfig',
    (_label, file) => {
      const baseDir = path.dirname(BASE);
      const base = readTsconfigPaths(BASE);
      const here = readTsconfigPaths(file as string);
      for (const [key, targets] of Object.entries(here)) {
        expect(base[key], `${key} is declared here but not in tsconfig.base.json`).toBeDefined();
        const resolvedHere = targets.map((t) => path.resolve(path.dirname(file as string), t));
        const resolvedBase = (base[key] as readonly string[]).map((t) => path.resolve(baseDir, t));
        expect(resolvedHere, `${key} resolves differently from tsconfig.base.json`).toStrictEqual(resolvedBase);
      }
    },
  );

  it.each([
    ['vite', (): unknown => viteConfig.resolve?.alias],
    ['vitest', (): unknown => vitestConfig.resolve?.alias],
  ] as const)('%s resolves every base path to the file tsc resolves', (name, getAlias) => {
    const entries = toEntries(getAlias());
    expect(entries.length).toBeGreaterThan(0);
    const overrides = DELIBERATE_OVERRIDES[name] as Readonly<Record<string, string>>;

    for (const { specifier, target } of tscResolutions()) {
      expect(resolveWithAliases(entries, specifier), `${name}: ${specifier}`).toBe(target);
    }
    for (const [specifier, expected] of Object.entries(overrides)) {
      expect(resolveWithAliases(entries, specifier), `${name}: override ${specifier}`).toBe(expected);
    }
  });

  it('derives the same aliases the configs hold', () => {
    const derived = tsconfigPathAliases(BASE);
    const inVitest = toEntries(vitestConfig.resolve?.alias).map((e) => String(e.find));
    for (const alias of derived) expect(inVitest).toContain(String(alias.find));
  });
});
