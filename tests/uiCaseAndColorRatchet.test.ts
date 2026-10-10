/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase 6 ratchets. Both counts may only go down.
 *
 * 1. Hex colour literals in `*.tsx` under packages/manager, packages/matrix,
 *    packages/ui and apps/shell/src. Components take colour from CSS variables
 *    so Dark, Light, OLED and custom themes all work. A hex literal does not
 *    follow the theme. The 18 that exist are chart-path colours (team and class
 *    series, axis strokes) and the Settings accent swatches, which are data.
 *    To lower the baseline, remove literals and edit HEX_LITERAL_BASELINE.
 *    Never raise it: use a `var(--...)` token instead.
 *
 * 2. Forced upper case (`uppercase` class) in the same packages plus
 *    packages/metrics. Labels and headings read in sentence case. What is left
 *    are badges, abbreviations (M / W, FPS), the app nav and chart tooltips.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/** Counted at the start of Phase 6 (commit b16c78e5, before any Phase 6 edit). */
const HEX_LITERAL_BASELINE = 18;
/** Counted at the start of Phase 6: 161 non-comment lines in packages/** and apps/shell/src/**. */
const UPPERCASE_START_OF_PHASE_6 = 161;
/** After the Phase 6 sweep. Lower it when more labels move to sentence case. */
const UPPERCASE_BASELINE = 14;

const HEX_DIRS = ['packages/manager', 'packages/matrix', 'packages/ui', 'apps/shell/src'];
const UPPERCASE_DIRS = [...HEX_DIRS, 'packages/metrics'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', 'coverage']);

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) found.push(...tsxFiles(full));
    else if (name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

function filesIn(dirs: string[]): string[] {
  return dirs.flatMap(dir => tsxFiles(join(ROOT, dir)));
}

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;

export function countHexLiterals(files: string[]): { total: number; byFile: Record<string, number> } {
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const file of files) {
    const matches = readFileSync(file, 'utf8').match(HEX_LITERAL);
    if (!matches) continue;
    byFile[relative(ROOT, file).replace(/\\/g, '/')] = matches.length;
    total += matches.length;
  }
  return { total, byFile };
}

export function countUppercaseClasses(files: string[]): number {
  let total = 0;
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (/\buppercase\b/.test(line)) total += 1;
    }
  }
  return total;
}

describe('hex colour ratchet', () => {
  it('scans the four package folders', () => {
    const files = filesIn(HEX_DIRS);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(f => f.replace(/\\/g, '/').endsWith('packages/matrix/src/components/TeamCard.tsx'))).toBe(true);
    expect(files.some(f => f.replace(/\\/g, '/').endsWith('apps/shell/src/App.tsx'))).toBe(true);
  });

  it(`finds no more than ${HEX_LITERAL_BASELINE} hex literals in *.tsx`, () => {
    const { total, byFile } = countHexLiterals(filesIn(HEX_DIRS));
    expect(total, `hex literals by file: ${JSON.stringify(byFile, null, 2)}`).toBeLessThanOrEqual(HEX_LITERAL_BASELINE);
  });

  it('counts a literal (the counter itself works)', () => {
    expect('const c = "#abc123"; const d = "#FFF";'.match(HEX_LITERAL)).toHaveLength(2);
    expect('href="#main-content"'.match(HEX_LITERAL)).toBeNull();
  });
});

describe('forced upper case ratchet', () => {
  it(`uses the uppercase class on no more than ${UPPERCASE_BASELINE} lines`, () => {
    expect(countUppercaseClasses(filesIn(UPPERCASE_DIRS))).toBeLessThanOrEqual(UPPERCASE_BASELINE);
  });

  it('stays well below where Phase 6 started', () => {
    expect(UPPERCASE_BASELINE).toBeLessThan(UPPERCASE_START_OF_PHASE_6);
  });
});
