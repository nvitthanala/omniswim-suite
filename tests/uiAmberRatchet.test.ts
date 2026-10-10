/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Amber ratchet. A fixed amber (`text-amber-400`, `#fbbf24`, ...) does not
 * follow the theme: it stays bright amber on Light, where it fails contrast.
 * Cautions use the warning-tone utilities (`text-warning`, `bg-warning-faint`,
 * `border-warning`, ...) which read `--color-warning`. Each theme sets that
 * token. The baseline is zero. It may never go up.
 *
 * Allowed hex literals, each with a reason:
 *  - apps/shell/src/pages/SettingsPage.tsx: the accent swatches are data.
 *  - packages/metrics/src/components/TagTimeline.tsx: one of eleven distinct
 *    categorical series colours for race tags. It is not a warning.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DIRS = ['packages/manager', 'packages/matrix', 'packages/metrics', 'packages/ui', 'apps/shell/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', 'coverage']);
const HEX_ALLOWLIST = new Set([
  'apps/shell/src/pages/SettingsPage.tsx',
  'packages/metrics/src/components/TagTimeline.tsx',
]);

const AMBER_CLASS = /\bamber-\d{2,3}\b/g;
const AMBER_HEX = /#(?:f59e0b|fbbf24|d97706|b45309|fcd34d)\b/gi;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(tsx?|jsx?)$/.test(name)) found.push(full);
  }
  return found;
}

const FILES = DIRS.flatMap(dir => sourceFiles(join(ROOT, dir)));
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, '/');

function offenders(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    const hexAllowed = HEX_ALLOWLIST.has(rel(file));
    const count = (text.match(AMBER_CLASS)?.length ?? 0) + (hexAllowed ? 0 : (text.match(AMBER_HEX)?.length ?? 0));
    if (count > 0) out[rel(file)] = count;
  }
  return out;
}

describe('amber ratchet', () => {
  it('scans the UI packages', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.map(rel)).toContain('packages/manager/src/components/RelayGroupCard.tsx');
  });

  it('finds no fixed amber class or hex (baseline 0)', () => {
    expect(offenders(), 'files with a fixed amber: use text-warning / bg-warning-faint / border-warning').toEqual({});
  });

  it('counts a fixed amber (the matcher itself works)', () => {
    expect('className="text-amber-400/90 border-amber-500/40"'.match(AMBER_CLASS)).toHaveLength(2);
    expect('const c = "#FBBF24"; const d = "#d97706";'.match(AMBER_HEX)).toHaveLength(2);
    expect('className="text-warning"'.match(AMBER_CLASS)).toBeNull();
  });
});

describe('warning-tone utilities follow the theme', () => {
  const css = readFileSync(join(ROOT, 'packages/ui/src/index.css'), 'utf8');
  const defined = new Set([...css.matchAll(/@utility\s+([\w-]+)\s*\{/g)].map(m => m[1]));

  it('defines --color-warning for Dark (:root) and Light', () => {
    const root = css.match(/^:root\s*\{[\s\S]*?^\}/m)?.[0] ?? '';
    const light = css.match(/^\[data-theme='light'\]\s*\{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(root).toMatch(/--color-warning:\s*#/);
    expect(light).toMatch(/--color-warning:\s*#/);
  });

  it('every warning-tone class used in source is defined, and reads the token', () => {
    const used = new Set<string>();
    const usage = /(?<![\w-])(?:[a-z]+:)*((?:text|bg|border)-warning(?:-[a-z]+)?)(?![\w-])/g;
    for (const file of FILES) {
      for (const m of readFileSync(file, 'utf8').matchAll(usage)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(defined.has(name), `${name} is used but not defined with @utility`).toBe(true);
    for (const name of defined) {
      const body = css.match(new RegExp(`@utility\\s+${name}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, `${name} must read var(--color-warning)`).toContain('var(--color-warning)');
      expect(body, `${name} must not hard-code a colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
});
