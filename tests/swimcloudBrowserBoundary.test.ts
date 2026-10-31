/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Boundary of `@omniswim/swimcloud/browser` (plans/2026-10-25/01-REDESIGN-PLAN.md, section 3.1,
 * invariant 7). The extension bundles this folder into a browser page, so it may import only
 * `@omniswim/engine` and its own files. It never imports `node:*`, `playwright-core`, or a file of
 * the swimcloud package outside `browser/`.
 *
 * The scan reads each file with the TypeScript parser, so a word in a comment never trips it. The
 * scanner has its own tests, so a scanner that stops matching fails here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const BROWSER = join(process.cwd(), 'packages', 'swimcloud', 'src', 'browser');

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

/** The reason a specifier is not allowed in `browser/`, or `null`. */
function banned(specifier: string): string | null {
  if (specifier.startsWith('./')) return /\.\.\//.test(specifier) ? 'leaves browser/' : null;
  if (specifier.startsWith('../') || specifier === '..' || specifier.startsWith('/')) return 'leaves browser/';
  if (specifier === '@omniswim/engine' || specifier.startsWith('@omniswim/engine/')) return null;
  if (specifier.startsWith('node:')) return 'a node: module';
  if (specifier === 'playwright-core' || specifier.startsWith('playwright-core/')) return 'playwright-core';
  if (specifier.startsWith('@omniswim/')) return 'another @omniswim package';
  return `a package other than @omniswim/engine ("${specifier}")`;
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
        const why = banned(specifier);
        if (why !== null) problems.push(`${file}: "${specifier}" is ${why}`);
      }
    }
    expect(seen, 'the scan must find imports').toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });

  it('no file names a Node global or a browser-only global', () => {
    const globals = /\b(process|Buffer|__dirname|require|window|document|chrome|localStorage|fetch)\b/;
    const problems: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(join(BROWSER, file), 'utf8'), ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && globals.test(node.text) && !ts.isPropertyAccessExpression(node.parent)) problems.push(`${file}: ${node.text}`);
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

  it('flags each banned kind and allows the two permitted ones', () => {
    expect(banned('./adapt')).toBeNull();
    expect(banned('@omniswim/engine')).toBeNull();
    expect(banned('@omniswim/engine/lib/cutlineEventNames')).toBeNull();
    expect(banned('node:fs')).not.toBeNull();
    expect(banned('playwright-core')).not.toBeNull();
    expect(banned('../crawler')).not.toBeNull();
    expect(banned('@omniswim/swimcloud')).not.toBeNull();
    expect(banned('@omniswim/db')).not.toBeNull();
    expect(banned('zod')).not.toBeNull();
    expect(banned('react')).not.toBeNull();
  });

  it('ignores a banned word in a comment or a string', () => {
    expect(specifiersOf(`// import x from 'node:fs'\nconst s = "require('node:fs')";`)).toEqual([]);
  });
});
