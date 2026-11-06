/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * E3 purity gate for `packages/engine` (plans/2026-10-25/D2-ENGINE-API.md, 2.1 and 2.5 E3).
 *
 * Two halves guard the engine. `npm run lint -w @omniswim/engine` compiles it with
 * `lib: ["ES2022"]` and `types: []`, so a DOM or Node global fails to type-check. This file is the
 * scan half. It parses each engine source file with the TypeScript parser (not a text search, so a
 * word in a comment or a string never trips it) and fails on:
 *
 * - an import, re-export, dynamic `import()` or `require()` of a banned module: `react`, `react-dom`,
 *   `@tanstack/*`, `node:*`, `fs`, `path`, `playwright-core`, `@omniswim/*`;
 * - a reference to a banned global: `window`, `document`, `fetch`, `XMLHttpRequest`, `localStorage`,
 *   `sessionStorage`, `indexedDB`, `navigator`, `self`, `postMessage`, `Worker`, `chrome`,
 *   `setTimeout`, `setInterval`, also as `globalThis.<name>`.
 *
 * A global name that the same file declares itself (a parameter called `self`) is not a reference to
 * the global. That is a deliberate blind spot: a file that both declares and misuses one name is left
 * to the compile-time half.
 *
 * The scanner has its own tests below, so a scanner that stops matching fails here and does not pass
 * silently over a real violation.
 *
 * A second scan, `scanDeterminism`, covers only the new engine code (`model`, `rules`, `sourcing`,
 * `planner` and `index.ts`). The moved files are exempt from it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ENGINE_ROOT = join(process.cwd(), 'packages', 'engine');
const ENGINE_SRC = join(ENGINE_ROOT, 'src');

/**
 * The fewest files the walk must find under `packages/engine/src`.
 * Step A moved 17 leaf files. Step B moved 62 more: 79 in all (77 `.ts` and 2 `.json`).
 * Step C added 14 new files: 13 under `model`, `rules`, `sourcing` and `planner`, and `index.ts`.
 */
const MOVED_FILE_COUNT = 79;
const NEW_ENGINE_FILES = 14;
const MIN_ENGINE_FILES_SCANNED = MOVED_FILE_COUNT + NEW_ENGINE_FILES;

/** The Step A leaves. They stay in the engine after every later step. */
const STEP_A_LEAVES: readonly string[] = [
  'lib/indexedAccess.ts',
  'lib/cutlineEventNames.ts',
  'lib/eventCatalog.ts',
  'lib/teamColorLookup.ts',
  'lib/timeFormat.ts',
  'lib/eventLabels.ts',
  'lib/ncaaScoringRules.ts',
  'lib/raceAnalysis/course.ts',
  'lib/raceAnalysis/index.ts',
  'lib/raceAnalysis/metrics.ts',
  'lib/raceAnalysis/reference.ts',
  'lib/raceAnalysis/segment.ts',
  'lib/raceAnalysis/tagStateMachine.ts',
  'lib/raceAnalysis/types.ts',
  'data/relayPrograms.ts',
  'data/teamAliases.ts',
  'data/teamAbbreviations.json',
];

/** The Step B files: everything else the engine closure needs, moved in one diff. */
const STEP_B_FILES: readonly string[] = [
  'types.ts',
  'constants.ts',
  'cutlines.ts',
  'team_colors.json',
  'data/teamDivisions.ts',
  'lib/altitude.ts',
  'lib/athleteAliases.ts',
  'lib/athleteHistory.ts',
  'lib/bestTimeEligibility.ts',
  'lib/calculatePoints.ts',
  'lib/catalogScoringInputs.ts',
  'lib/courseEvents.ts',
  'lib/crossCourseArbitrage.ts',
  'lib/cutlineTags.ts',
  'lib/cutlineUtils.ts',
  'lib/entryExport.ts',
  'lib/eventIdentity.ts',
  'lib/eventStrength.ts',
  'lib/individualScoring.ts',
  'lib/meetPool.ts',
  'lib/meetSource.ts',
  'lib/optimizeJob.ts',
  'lib/ownTeam.ts',
  'lib/prelimsProjection.ts',
  'lib/programSwim.ts',
  'lib/psychProjection.ts',
  'lib/relayBuilder.ts',
  'lib/relayLegCredits.ts',
  'lib/relayLegHistoryCandidates.ts',
  'lib/relayLegMatching.ts',
  'lib/relayScoring.ts',
  'lib/relaySimulation.ts',
  'lib/relaySplits.ts',
  'lib/reportBuilder.ts',
  'lib/rosterArbitrage.ts',
  'lib/rosterCatalog.ts',
  'lib/rosterLineupAudit.ts',
  'lib/rosterOptimizer.ts',
  'lib/scenarioDiff.ts',
  'lib/scoredProgramBoundary.ts',
  'lib/scorerRoster.ts',
  'lib/scoringBundleAggregation.ts',
  'lib/scoringDefaults.ts',
  'lib/scoringEngine.ts',
  'lib/scoringPlaceTables.ts',
  'lib/scoringRules.ts',
  'lib/scyConversion.ts',
  'lib/seasonAnalytics.ts',
  'lib/swimCloudMultiProfile.ts',
  'lib/swimEditor.ts',
  'lib/swimmerEntryLimits.ts',
  'lib/swimmerNames.ts',
  'lib/teamColorStyles.ts',
  'lib/teamScoreMatching.ts',
  'lib/theoreticalMeetLabel.ts',
  'lib/utils.ts',
  'lib/whatIfProjection.ts',
  'lib/arbitrage/crossCourseTable.ts',
  'lib/arbitrage/dropAdd.ts',
  'lib/arbitrage/exactSwaps.ts',
  'lib/arbitrage/relayLegSwaps.ts',
  'lib/arbitrage/shared.ts',
];

const MOVED_FILES: readonly string[] = [...STEP_A_LEAVES, ...STEP_B_FILES];

const BANNED_GLOBALS: ReadonlySet<string> = new Set([
  'window',
  'document',
  'fetch',
  'XMLHttpRequest',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator',
  'self',
  'postMessage',
  'Worker',
  'chrome',
  'setTimeout',
  'setInterval',
]);

function isBannedModule(specifier: string): boolean {
  if (specifier.startsWith('node:') || specifier.startsWith('@omniswim/') || specifier.startsWith('@tanstack/')) return true;
  return ['react', 'react-dom', 'fs', 'path', 'playwright-core'].some(
    name => specifier === name || specifier.startsWith(`${name}/`)
  );
}

/** Names this file declares itself, so a same-named use is not a use of the global. */
function declaredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBinding(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) addBinding(node.name);
    else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      names.add(node.name.text);
    } else if (ts.isImportClause(node) && node.name) names.add(node.name.text);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** True when `node` is a name in a position that is not a reference: `a.NAME`, `{ NAME: 1 }`, `class { NAME() {} }`. */
function isNonReferenceName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  return false;
}

/** Violations in one source text, as readable strings. Empty when the text is pure. */
export function scanEngineSource(fileName: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ES2022,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: string[] = [];
  const declared = declaredNames(sourceFile);
  const at = (node: ts.Node): string =>
    `${fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;

  const checkSpecifier = (node: ts.Node, specifier: ts.Node | undefined): void => {
    if (specifier && ts.isStringLiteralLike(specifier) && isBannedModule(specifier.text)) {
      found.push(`${at(node)} imports banned module "${specifier.text}"`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) checkSpecifier(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifier(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) checkSpecifier(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkSpecifier(node, node.argument.literal);
    }

    if (ts.isIdentifier(node) && BANNED_GLOBALS.has(node.text) && !declared.has(node.text) && !isNonReferenceName(node)) {
      found.push(`${at(node)} uses banned global "${node.text}"`);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      BANNED_GLOBALS.has(node.name.text)
    ) {
      found.push(`${at(node)} uses banned global "globalThis.${node.name.text}"`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      BANNED_GLOBALS.has(node.argumentExpression.text)
    ) {
      found.push(`${at(node)} uses banned global "globalThis['${node.argumentExpression.text}']"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The determinism ban (D2 section 3, "the engine has no clock, no randomness, no ids").
 *
 * A new engine function gives the same output for the same input. A caller passes in the time
 * (`editedAt`), and storage makes ids. So the new code, and only the new code, may not read a clock,
 * draw a random number, make a uuid or use the crypto object. The moved files are exempt: they
 * predate the rule, and their fingerprint tests pin their behavior.
 *
 * Bans: `Date.now`, `new Date(...)`, `Math.random`, `crypto.<anything>`, `performance.now`, and any
 * import of `uuid`. The scan is on the syntax tree, so a comment that names one trips nothing.
 */
export function scanDeterminism(fileName: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: ts.Node): string =>
    `${fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;

  /** `object.member` or `object['member']` where `object` is the identifier `objectName`. */
  const memberOf = (node: ts.Node, objectName: string): string | null => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === objectName) {
      return node.name.text;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === objectName &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      return node.argumentExpression.text;
    }
    return null;
  };
  const isUuid = (specifier: string): boolean => specifier === 'uuid' || specifier.startsWith('uuid/');
  const checkSpecifier = (node: ts.Node, specifier: ts.Node | undefined): void => {
    if (specifier && ts.isStringLiteralLike(specifier) && isUuid(specifier.text)) {
      found.push(`${at(node)} imports "${specifier.text}"`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (memberOf(node, 'Date') === 'now') found.push(`${at(node)} uses Date.now`);
    if (memberOf(node, 'Math') === 'random') found.push(`${at(node)} uses Math.random`);
    if (memberOf(node, 'performance') === 'now') found.push(`${at(node)} uses performance.now`);
    if (memberOf(node, 'crypto') !== null) found.push(`${at(node)} uses crypto.${memberOf(node, 'crypto')}`);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      node.name.text === 'crypto'
    ) {
      found.push(`${at(node)} uses globalThis.crypto`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      found.push(`${at(node)} uses new Date(`);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) checkSpecifier(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifier(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        checkSpecifier(node, node.arguments[0]);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkSpecifier(node, node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The new engine code, relative to `packages/engine/src`: these folders and `index.ts`. */
const NEW_ENGINE_FOLDERS: readonly string[] = ['model', 'rules', 'sourcing', 'planner'];
const NEW_ENGINE_ROOT_FILES: readonly string[] = ['index.ts'];

/** The files the determinism ban covers, as paths relative to `packages/engine/src`. */
function determinismScope(): string[] {
  const out: string[] = [];
  for (const folder of NEW_ENGINE_FOLDERS) {
    const directory = join(ENGINE_SRC, folder);
    if (!existsSync(directory)) continue;
    for (const file of filesUnder(directory)) {
      if (/\.tsx?$/.test(file)) out.push(relative(ENGINE_SRC, file).split('\\').join('/'));
    }
  }
  for (const file of NEW_ENGINE_ROOT_FILES) {
    if (existsSync(join(ENGINE_SRC, file))) out.push(file);
  }
  return out.sort();
}

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

describe('engine purity scanner', () => {
  const scan = (text: string): string[] => scanEngineSource('probe.ts', text);

  it('flags each banned import form', () => {
    expect(scan("import 'react';")).toHaveLength(1);
    expect(scan("import fs from 'node:fs';")).toHaveLength(1);
    expect(scan("import { readFileSync } from 'fs';")).toHaveLength(1);
    expect(scan("import { join } from 'path/posix';")).toHaveLength(1);
    expect(scan("export * from '@omniswim/core/types';")).toHaveLength(1);
    expect(scan("const m = await import('@tanstack/react-query');")).toHaveLength(1);
    expect(scan("const p = require('playwright-core');")).toHaveLength(1);
    expect(scan("type T = import('react-dom').Root;")).toHaveLength(1);
  });

  it('flags each banned global form', () => {
    expect(scan("fetch('x');")).toHaveLength(1);
    expect(scan('const w = window.location;')).toHaveLength(1);
    expect(scan('const t = typeof document;')).toHaveLength(1);
    expect(scan('setTimeout(() => 1, 0);')).toHaveLength(1);
    expect(scan('globalThis.setInterval(() => 1, 0);')).toHaveLength(1);
    expect(scan("const f = globalThis['localStorage'];")).toHaveLength(1);
    expect(scan('const w = new Worker("x");')).toHaveLength(1);
  });

  it('passes pure code, including names in comments, strings and property positions', () => {
    expect(scan("import { z } from 'zod';")).toStrictEqual([]);
    expect(scan("import { v4 } from 'uuid';")).toStrictEqual([]);
    expect(scan("import { a } from './a'; export * from '../b';")).toStrictEqual([]);
    expect(scan("// fetch the window\nconst s = 'self document navigator';")).toStrictEqual([]);
    expect(scan('const o = { window: 1, fetch: 2 }; o.window + o.fetch;')).toStrictEqual([]);
    expect(scan('class A { self = 1; chrome() { return 2; } }')).toStrictEqual([]);
    expect(scan('function f(self: number) { return self; }')).toStrictEqual([]);
  });
});

describe('engine determinism scanner', () => {
  const scan = (text: string): string[] => scanDeterminism('probe.ts', text);

  it('flags each clock, random and crypto form', () => {
    expect(scan('const t = Date.now();')).toHaveLength(1);
    expect(scan("const t = Date['now']();")).toHaveLength(1);
    expect(scan('const d = new Date();')).toHaveLength(1);
    expect(scan("const d = new Date('2026-10-25');")).toHaveLength(1);
    expect(scan('const r = Math.random();')).toHaveLength(1);
    expect(scan('const f = Math.random;')).toHaveLength(1);
    expect(scan('const a = crypto.randomUUID();')).toHaveLength(1);
    expect(scan('const a = crypto.getRandomValues(new Uint8Array(1));')).toHaveLength(1);
    expect(scan('const a = globalThis.crypto;')).toHaveLength(1);
    expect(scan('const t = performance.now();')).toHaveLength(1);
  });

  it('flags each uuid import form', () => {
    expect(scan("import { v4 } from 'uuid';")).toHaveLength(1);
    expect(scan("import { v4 } from 'uuid/dist/v4';")).toHaveLength(1);
    expect(scan("export { v4 } from 'uuid';")).toHaveLength(1);
    expect(scan("const u = await import('uuid');")).toHaveLength(1);
    expect(scan("const u = require('uuid');")).toHaveLength(1);
    expect(scan("type U = import('uuid').V4Options;")).toHaveLength(1);
  });

  it('passes deterministic code, including the banned words in comments and strings', () => {
    expect(scan('// Date.now() and Math.random() and new Date()\nconst s = "crypto.randomUUID performance.now";')).toStrictEqual([]);
    expect(scan("import { z } from 'zod'; import { a } from './uuidLike';")).toStrictEqual([]);
    expect(scan('const o = { now: 1, random: 2 }; o.now + o.random;')).toStrictEqual([]);
    expect(scan('function f(at: string) { return at; }')).toStrictEqual([]);
    expect(scan("const m = Math.max(1, 2); const d: Date | null = null; const s = 'Date.now';")).toStrictEqual([]);
  });

  it('covers the new folders and index.ts, and nothing moved', () => {
    const scope = determinismScope();
    expect(scope).toContain('index.ts');
    for (const folder of NEW_ENGINE_FOLDERS) {
      expect(scope.some(file => file.startsWith(`${folder}/`)), `no file scanned under ${folder}/`).toBe(true);
    }
    for (const file of scope) {
      expect(MOVED_FILES, file).not.toContain(file);
      expect(file.startsWith('lib/') || file.startsWith('data/'), file).toBe(false);
    }
  });
});

describe('engine purity (D2 E3)', () => {
  it('the new engine code reads no clock, draws no random number and makes no uuid', () => {
    const scope = determinismScope();
    expect(scope.length).toBeGreaterThanOrEqual(NEW_ENGINE_FILES);
    const violations: string[] = [];
    for (const rel of scope) violations.push(...scanDeterminism(rel, readFileSync(join(ENGINE_SRC, rel), 'utf8')));
    expect(violations).toStrictEqual([]);
  });

  it('compiles with lib ES2022 and no ambient types', () => {
    const tsconfig = JSON.parse(readFileSync(join(ENGINE_ROOT, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { lib?: string[]; types?: string[] };
    };
    expect(tsconfig.compilerOptions.lib).toStrictEqual(['ES2022']);
    expect(tsconfig.compilerOptions.types).toStrictEqual([]);
  });

  it('declares only zod and uuid as dependencies, and no peers', () => {
    const pkg = JSON.parse(readFileSync(join(ENGINE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toStrictEqual(['uuid', 'zod']);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });

  it('scans every file under packages/engine/src and finds no banned import or global', () => {
    const files = filesUnder(ENGINE_SRC);
    expect(files.length).toBeGreaterThanOrEqual(MIN_ENGINE_FILES_SCANNED);

    const present = new Set(files.map(file => relative(ENGINE_SRC, file).split('\\').join('/')));
    for (const moved of MOVED_FILES) expect(present.has(moved), `missing engine file ${moved}`).toBe(true);

    const violations: string[] = [];
    let scanned = 0;
    for (const file of files) {
      if (!/\.tsx?$/.test(file)) continue;
      scanned += 1;
      const rel = relative(ENGINE_SRC, file).split('\\').join('/');
      violations.push(...scanEngineSource(rel, readFileSync(file, 'utf8')));
    }
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toStrictEqual([]);
  });

  it('keeps the core shims thin: a moved path is two lines, never a copy', () => {
    for (const leaf of MOVED_FILES.filter(file => file.endsWith('.ts'))) {
      const corePath = join(process.cwd(), 'packages', 'core', 'src', leaf);
      expect(existsSync(corePath), corePath).toBe(true);
      const specifier = leaf.replace(/\.ts$/, '');
      expect(readFileSync(corePath, 'utf8')).toBe(
        `// Moved to packages/engine (D2). Edit packages/engine/src/${leaf}.\nexport * from '@omniswim/engine/${specifier}';\n`
      );
    }
    for (const json of MOVED_FILES.filter(file => file.endsWith('.json'))) {
      expect(existsSync(join(process.cwd(), 'packages', 'core', 'src', json)), `${json} must not remain in core`).toBe(false);
    }
    expect(MOVED_FILES).toHaveLength(79);
  });
});
