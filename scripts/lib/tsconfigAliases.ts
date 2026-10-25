/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Module aliases for Vite and Vitest, derived from `tsconfig.base.json`.
 *
 * ## Why this exists
 *
 * The same `@omniswim/*` mapping used to be written out by hand in four places:
 * `tsconfig.base.json`, `apps/shell/tsconfig.json`, `apps/shell/vite.config.ts`
 * and `vitest.config.ts`. They had already drifted. Vitest knew one alias and
 * Vite knew five, so a path that built in the app could fail in a test and the
 * reverse. A bundler that resolves a module differently from the type checker
 * is a silent-wrong-file bug, not a build error.
 *
 * `tsconfig.base.json` `compilerOptions.paths` is now the one list. Both
 * bundler configs call {@link tsconfigPathAliases}; the type checker reads the
 * list directly. `tests/aliasConfigAgreement.test.ts` fails when a tsconfig or a
 * bundler config disagrees with it.
 *
 * ## What it supports
 *
 * Exactly the two shapes this repo uses, and it throws on anything else rather
 * than guessing:
 *
 * - an exact key (`"@omniswim/core"`) with one target;
 * - a trailing-wildcard key (`"@omniswim/core/*"`) with one target that also
 *   ends in `/*`.
 *
 * Aliases are anchored regular expressions, so `@omniswim/manager` does not
 * capture `@omniswim/manager/lib/x`; subpaths with no entry of their own fall
 * through to the package's `exports` map, as they do under `tsc`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** One alias in the array form both Vite and Vitest accept. */
export interface TsconfigAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

interface TsconfigWithPaths {
  readonly compilerOptions?: {
    readonly paths?: Readonly<Record<string, readonly string[]>>;
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Forward slashes, so a Windows path is safe inside a regex replacement and a URL-ish id. */
function slash(p: string): string {
  return p.split(path.sep).join('/');
}

/** The `compilerOptions.paths` table of a tsconfig file, or `{}` when it declares none. */
export function readTsconfigPaths(tsconfigPath: string): Readonly<Record<string, readonly string[]>> {
  const parsed = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as TsconfigWithPaths;
  return parsed.compilerOptions?.paths ?? {};
}

/**
 * Turn a tsconfig `paths` table into bundler aliases.
 *
 * Targets are resolved against the directory of `tsconfigPath`, as `tsc`
 * resolves them when no `baseUrl` is set. Throws on a key with several targets,
 * on a wildcard anywhere but the end, and on a wildcard key whose target is not
 * a matching wildcard.
 */
export function tsconfigPathAliases(tsconfigPath: string): TsconfigAlias[] {
  const baseDir = path.dirname(tsconfigPath);
  const aliases: TsconfigAlias[] = [];

  for (const [key, targets] of Object.entries(readTsconfigPaths(tsconfigPath))) {
    if (targets.length !== 1) {
      throw new Error(`${tsconfigPath}: path "${key}" has ${targets.length} targets; exactly one is supported`);
    }
    const target = targets[0] as string;
    const keyWildcards = key.split('*').length - 1;
    const targetWildcards = target.split('*').length - 1;

    if (keyWildcards === 0 && targetWildcards === 0) {
      aliases.push({ find: new RegExp(`^${escapeRegExp(key)}$`), replacement: slash(path.resolve(baseDir, target)) });
      continue;
    }
    if (keyWildcards === 1 && targetWildcards === 1 && key.endsWith('/*') && target.endsWith('/*')) {
      const keyPrefix = key.slice(0, -2);
      const targetDir = path.resolve(baseDir, target.slice(0, -2));
      aliases.push({ find: new RegExp(`^${escapeRegExp(keyPrefix)}/(.+)$`), replacement: `${slash(targetDir)}/$1` });
      continue;
    }
    throw new Error(`${tsconfigPath}: path "${key}" -> "${target}" is not an exact mapping or a trailing "/*" mapping`);
  }

  return aliases;
}
