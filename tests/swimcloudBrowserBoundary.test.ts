/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Boundary of `@omniswim/swimcloud/browser` (plans/2026-10-25/01-REDESIGN-PLAN.md, section 3.1,
 * invariant 7). The extension bundles this folder into a browser page, so it may import only
 * `@omniswim/engine`, its own files, and the ten shared pure parser files named in SHARED_PURE.
 * It never imports `node:*`, `playwright-core`, or any other file of the swimcloud package.
 *
 * Invariant 7 is about Node and Playwright code. The roster fetch reader (D7 section 1) wraps the
 * existing page parsers and does not edit them, so it must reach them. SHARED_PURE keeps the
 * guarantee: each listed file imports no `node:*`, no package but the engine, no file but a listed
 * one, and names no Node or browser-only global. A test fails if the files the browser folder really
 * reaches differ from the list, in either direction.
 *
 * The scan reads each file with the TypeScript parser, so a word in a comment never trips it. The
 * scanner has its own tests, so a scanner that stops matching fails here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SRC = join(process.cwd(), 'packages', 'swimcloud', 'src');
const BROWSER = join(SRC, 'browser');

/**
 * The files of `packages/swimcloud/src/` that `browser/` may import, by name without `.ts`. They are
 * the page parsers and their helpers. This is the exact set the browser folder reaches: the test
 * "the browser folder reaches exactly SHARED_PURE" fails if an entry is stale or a new one is missing.
 */
const SHARED_PURE: readonly string[] = [
  'entities',
  'html',
  'indexed',
  'parseCells',
  'parseElements',
  'parseResult',
  'rosterPage',
  'swimFields',
  'teamSeasons',
  'urlClassifier',
];

/** Every module specifier a source text imports, re-exports, `import()`s or `require()`s. */
function specifiersOf(text: string, fileName = 'x.ts'): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((dynamicImport || requireCall) && arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** A relative specifier of the form `<prefix><name>` with no further slash; the name, or `null`. */
function bareName(specifier: string, prefix: string): string | null {
  if (!specifier.startsWith(prefix)) return null;
  const name = specifier.slice(prefix.length);
  return name.length > 0 && !name.includes('/') && !name.startsWith('.') ? name : null;
}

/**
 * The reason a specifier is not allowed, or `null`. `from` is where the importing file lives:
 * `browser` for `browser/*.ts`, `shared` for a file named in SHARED_PURE.
 */
function banned(specifier: string, from: 'browser' | 'shared'): string | null {
  if (specifier === '@omniswim/engine' || specifier.startsWith('@omniswim/engine/')) return null;
  if (from === 'browser') {
    if (specifier.startsWith('./')) return /\.\.\//.test(specifier) ? 'leaves browser/' : null;
    const name = bareName(specifier, '../');
    if (name !== null) return SHARED_PURE.includes(name) ? null : `a swimcloud file that is not in SHARED_PURE ("${name}")`;
    if (specifier.startsWith('../') || specifier === '..' || specifier.startsWith('/')) return 'leaves browser/';
  } else {
    const name = bareName(specifier, './');
    if (name !== null) return SHARED_PURE.includes(name) ? null : `a file that is not in SHARED_PURE ("${name}")`;
    if (specifier.startsWith('.') || specifier.startsWith('/')) return 'leaves the shared pure files';
  }
  if (specifier.startsWith('node:')) return 'a node: module';
  if (specifier === 'playwright-core' || specifier.startsWith('playwright-core/')) return 'playwright-core';
  if (specifier.startsWith('@omniswim/')) return 'another @omniswim package';
  return `a package other than @omniswim/engine ("${specifier}")`;
}

/** The shared files `browser/` reaches by relative imports, followed through the shared files themselves. */
function reachedShared(): { readonly reached: string[]; readonly problems: string[] } {
  const reached = new Set<string>();
  const problems: string[] = [];
  const queue: string[] = [];
  for (const file of readdirSync(BROWSER).filter((f) => f.endsWith('.ts'))) {
    for (const specifier of specifiersOf(readFileSync(join(BROWSER, file), 'utf8'), file)) {
      const name = bareName(specifier, '../');
      if (name !== null) queue.push(name);
      else if (specifier.startsWith('../')) problems.push(`${file}: "${specifier}" is not a bare ../<name> import`);
    }
  }
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    for (const specifier of specifiersOf(readFileSync(join(SRC, `${name}.ts`), 'utf8'), `${name}.ts`)) {
      const next = bareName(specifier, './');
      if (next !== null) queue.push(next);
      else if (specifier.startsWith('.')) problems.push(`${name}.ts: "${specifier}" is not a bare ./<name> import`);
    }
  }
  return { reached: [...reached].sort(), problems };
}

describe('swimcloud browser boundary', () => {
  const files = readdirSync(BROWSER).filter((f) => f.endsWith('.ts'));

  it('scans a real folder: at least the adapter files exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const expected of ['adapt.ts', 'parity.ts', 'rescore.ts', 'simulatorRules.ts', 'index.ts']) expect(files).toContain(expected);
  });

  it('no file imports node:*, playwright-core, anything outside browser/, or any package but the engine', () => {
    const problems: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(join(BROWSER, file), 'utf8'), file)) {
        seen += 1;
        const why = banned(specifier, 'browser');
        if (why !== null) problems.push(`${file}: "${specifier}" is ${why}`);
      }
    }
    expect(seen, 'the scan must find imports').toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });

  it('the browser folder reaches exactly SHARED_PURE, and each shared file imports only the engine and other shared files', () => {
    const { reached, problems } = reachedShared();
    expect(problems).toEqual([]);
    expect(reached).toEqual([...SHARED_PURE].sort());
    const bad: string[] = [];
    for (const name of SHARED_PURE) {
      for (const specifier of specifiersOf(readFileSync(join(SRC, `${name}.ts`), 'utf8'), `${name}.ts`)) {
        const why = banned(specifier, 'shared');
        if (why !== null) bad.push(`${name}.ts: "${specifier}" is ${why}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no file, in browser/ or in SHARED_PURE, names a Node global or a browser-only global', () => {
    const globals = /\b(process|Buffer|__dirname|require|window|document|chrome|localStorage|fetch)\b/;
    const problems: string[] = [];
    const paths = [...files.map((f) => join(BROWSER, f)), ...SHARED_PURE.map((n) => join(SRC, `${n}.ts`))];
    for (const file of paths) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && globals.test(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) problems.push(`${file}: ${node.text}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(problems).toEqual([]);
  });
});

describe('the boundary scanner', () => {
  it('finds every import form', () => {
    const text = `
      import a from './a';
      import type { B } from '@omniswim/engine';
      export * from './c';
      export { d } from 'node:fs';
      const e = await import('playwright-core');
      const f = require('../x');
      type G = import('@omniswim/swimcloud').T;
    `;
    expect(specifiersOf(text)).toEqual(['./a', '@omniswim/engine', './c', 'node:fs', 'playwright-core', '../x', '@omniswim/swimcloud']);
  });

  it('flags each banned kind and allows the permitted ones', () => {
    expect(banned('./adapt', 'browser')).toBeNull();
    expect(banned('@omniswim/engine', 'browser')).toBeNull();
    expect(banned('@omniswim/engine/lib/cutlineEventNames', 'browser')).toBeNull();
    expect(banned('node:fs', 'browser')).not.toBeNull();
    expect(banned('playwright-core', 'browser')).not.toBeNull();
    expect(banned('../crawler', 'browser')).not.toBeNull();
    expect(banned('@omniswim/swimcloud', 'browser')).not.toBeNull();
    expect(banned('@omniswim/db', 'browser')).not.toBeNull();
    expect(banned('zod', 'browser')).not.toBeNull();
    expect(banned('react', 'browser')).not.toBeNull();
  });

  it('allows a listed shared file from browser/ and nothing else outside it', () => {
    expect(banned('../rosterPage', 'browser')).toBeNull();
    for (const name of SHARED_PURE) expect(banned(`../${name}`, 'browser'), name).toBeNull();
    expect(banned('../crawlPlan', 'browser')).not.toBeNull();
    expect(banned('../../x', 'browser')).not.toBeNull();
    expect(banned('../rosterPage/x', 'browser')).not.toBeNull();
    expect(banned('..', 'browser')).not.toBeNull();
    expect(banned('./../rosterPage', 'browser')).not.toBeNull();
  });

  it('a shared file may import the engine and another listed file, and nothing else', () => {
    expect(banned('./html', 'shared')).toBeNull();
    expect(banned('@omniswim/engine', 'shared')).toBeNull();
    expect(banned('./fetcher', 'shared')).not.toBeNull();
    expect(banned('./browser/adapt', 'shared')).not.toBeNull();
    expect(banned('../x', 'shared')).not.toBeNull();
    expect(banned('node:fs', 'shared')).not.toBeNull();
    expect(banned('zod', 'shared')).not.toBeNull();
  });

  it('ignores a banned word in a comment or a string', () => {
    expect(specifiersOf(`// import x from 'node:fs'\nconst s = "require('node:fs')";`)).toEqual([]);
  });
});
