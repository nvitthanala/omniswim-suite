/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Status colors (README R46, plans/2026-10-25/README.md). Two rules, both enforced here:
 *
 * 1. Contrast, computed from the hex values. Good and bad may be text on the light page. The warn
 *    orange is not readable as text on white (3.1:1), so it is a fill with a dark foreground.
 * 2. Warn is a fill only. No CSS in `apps/extension/src` or `static` may use the warn color as
 *    `color`, a border, an outline, a stroke, an SVG fill or a shadow. The scanner is tested against
 *    bad and good snippets, so it cannot pass by finding nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DARK_TOKENS, LIGHT_TOKENS, TOKEN_NAMES } from '../apps/extension/src/shared/theme';
import { extensionRoot, repoRoot } from './helpers/extensionBuild';

// ---- WCAG 2.x contrast, computed here so the test does not trust theme.ts -----------------------

function hexToRgb(value: string, label: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${label} must be a #rrggbb hex to be measured, got ${JSON.stringify(value)}`);
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(value: string, label: string): number {
  const [r, g, b] = hexToRgb(value, label).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string, label: string): number {
  const la = luminance(a, `${label} (first)`);
  const lb = luminance(b, `${label} (second)`);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const light = (name: string): string => (LIGHT_TOKENS as Record<string, string>)[name] ?? '';

describe('R46 status tokens: shape', () => {
  it('good and bad are text tokens; warn is a background token paired with a foreground token', () => {
    const names: readonly string[] = TOKEN_NAMES;
    for (const n of ['--osx-good', '--osx-bad', '--osx-warn-bg', '--osx-warn-fg']) expect(names, n).toContain(n);
    // No token named plain `--osx-warn`: a name that does not say "fill" invites `color: var(--osx-warn)`.
    expect(names).not.toContain('--osx-warn');
  });

  it('light values are the R46 Material 800 shades', () => {
    expect(light('--osx-good')).toBe('#2E7D32');
    expect(light('--osx-bad')).toBe('#C62828');
    expect(light('--osx-warn-bg')).toBe('#EF6C00');
    expect(light('--osx-warn-fg')).toBe('#000000');
  });

  it('dark good and bad stay neutral; dark warn is the light pair (README R57), so no hex is invented', () => {
    const dark = DARK_TOKENS as Record<string, string>;
    for (const n of ['--osx-good', '--osx-bad']) {
      expect(dark[n], n).toBeDefined();
      expect(dark[n], `dark ${n} must be a system color, not a hex`).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
    // R57: the warn fill and its text do not depend on the page background, so dark reuses them.
    expect(dark['--osx-warn-bg']).toBe(LIGHT_TOKENS['--osx-warn-bg']);
    expect(dark['--osx-warn-fg']).toBe(LIGHT_TOKENS['--osx-warn-fg']);
    // The pair still reads as a fill with a contrasting foreground: they must not be the same color.
    expect(dark['--osx-warn-bg']).not.toBe(dark['--osx-warn-fg']);
  });

  it('is recorded as R46 in the README and cited in theme.ts', () => {
    const readme = readFileSync(path.join(repoRoot, 'plans', '2026-10-25', 'README.md'), 'utf8');
    expect(readme).toMatch(/\| R46 \| Status colors \|/);
    for (const hex of ['#2E7D32', '#EF6C00', '#C62828']) expect(readme.split('| R46 |')[1]?.split('\n')[0]).toContain(hex);
    expect(readFileSync(path.join(extensionRoot, 'src', 'shared', 'theme.ts'), 'utf8')).toMatch(/README R46/);
  });
});

describe('R46 status tokens: contrast on the light theme (WCAG 2.x, computed from hex)', () => {
  const backgrounds = ['--osx-bg', '--osx-surface'];

  it.each(['--osx-good', '--osx-bad'])('%s is at least 4.5:1 as text on the page and on a card', (token) => {
    for (const bg of backgrounds) {
      const ratio = contrast(light(token), light(bg), `${token} on ${bg}`);
      expect(ratio, `${token} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the warn fill with its foreground is at least 4.5:1', () => {
    const ratio = contrast(light('--osx-warn-bg'), light('--osx-warn-fg'), 'warn fill on warn foreground');
    expect(ratio, `warn fill vs foreground = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('control: warn used as text on the light page fails 4.5:1, which is why it is fill only', () => {
    for (const bg of backgrounds) {
      const ratio = contrast(light('--osx-warn-bg'), light(bg), `warn as text on ${bg}`);
      expect(ratio, `warn as text on ${bg} = ${ratio.toFixed(2)}`).toBeLessThan(4.5);
    }
  });
});

// ---- the fill-only scanner ----------------------------------------------------------------------

/** The warn fill by token or by value. A hex or rgb() copy of the orange counts as the warn color. */
const WARN_REF = /--osx-warn-bg\b|--osx-warn(?![-\w])|#ef6c00\b|rgba?\(\s*239\s*,\s*108\s*,\s*0\s*[,)]/i;
/** The only properties that may carry the warn fill. */
const FILL_PROPERTIES = new Set(['background', 'background-color']);

interface Declaration {
  property: string;
  value: string;
  line: number;
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function stripComments(text: string, isCss: boolean): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return isCss ? noBlock : noBlock.replace(/(^|\s)\/\/.*$/gm, blank);
}

/** `property: value` pairs in CSS, a CSS template string, or a TS style object. */
function declarations(text: string, isCss: boolean): Declaration[] {
  const out: Declaration[] = [];
  const head = /(?<![\w-])(--[\w-]+|[A-Za-z][\w-]*)['"]?\s*:\s*(?!:)/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    let depth = 0;
    let i = head.lastIndex;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ';' || ch === '{' || ch === '}') break;
      // In a TS object a top-level comma followed by `key:` starts the next property.
      else if (!isCss && ch === ',' && depth === 0 && /^,\s*['"]?[A-Za-z_-][\w-]*['"]?\s*:/.test(text.slice(i))) break;
    }
    out.push({ property: kebab(m[1] as string), value: text.slice(head.lastIndex, i), line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Every use of the warn color that is not a plain background fill. Empty means clean. */
function findWarnMisuse(raw: string, isCss: boolean): string[] {
  const text = stripComments(raw, isCss);
  const found: string[] = [];
  for (const d of declarations(text, isCss)) {
    if (!WARN_REF.test(d.value)) continue;
    if (d.property === '--osx-warn-bg') continue; // the token's own definition
    if (!FILL_PROPERTIES.has(d.property)) found.push(`line ${d.line}: ${d.property}: ${d.value.trim()}`);
  }
  if (!isCss) {
    // Assignments such as `el.style.color = '...'` and attributes such as `stroke="#EF6C00"`.
    text.split('\n').forEach((l, idx) => {
      if (WARN_REF.test(l) && !/background/i.test(l) && !/^\s*['"]?--osx-warn-bg['"]?\s*:/.test(l)) found.push(`line ${idx + 1}: ${l.trim()}`);
    });
  }
  return [...new Set(found)];
}

describe('R46 warn is fill only: the scanner', () => {
  const badCss = [
    '.a { color: var(--osx-warn-bg); }',
    '.a { border: 1px solid #EF6C00; }',
    '.a { border-left-color: #ef6c00 }',
    '.a { stroke: var(--osx-warn-bg); }',
    '.a { fill: var(--osx-warn-bg); }',
    '.a { outline: 2px solid var(--osx-warn-bg); }',
    '.a { text-decoration-color: rgb(239, 108, 0); }',
    '.a { box-shadow: 0 0 1px red, 0 0 2px color-mix(in srgb, var(--osx-warn-bg) 50%, white); }',
    '.a { --alias: var(--osx-warn-bg); color: var(--alias); }',
    '.a {\n  color:\n    var(--osx-warn-bg);\n}',
  ];
  it.each(badCss)('flags %j', (css) => {
    expect(findWarnMisuse(css, true)).not.toStrictEqual([]);
  });

  const goodCss = [
    '.a { background: var(--osx-warn-bg); color: var(--osx-warn-fg); }',
    '.a { background-color: #EF6C00; color: #000; }',
    '.a { --osx-warn-bg: #EF6C00; --osx-warn-fg: #000000; }',
    '/* color: var(--osx-warn-bg) is banned */ .a { background: var(--osx-warn-bg); }',
    '.a { color: var(--osx-warn-fg); border: 1px solid var(--osx-border); }',
  ];
  it.each(goodCss)('passes %j', (css) => {
    expect(findWarnMisuse(css, true)).toStrictEqual([]);
  });

  const badTs = [
    "el.style.color = 'var(--osx-warn-bg)';",
    "const s = { borderColor: 'var(--osx-warn-bg)' };",
    "const s = { color: 'var(--osx-warn-bg)', background: 'white' };",
    '<path stroke="#EF6C00" />',
    'const css = `.a { border: 1px solid #EF6C00; }`;',
  ];
  it.each(badTs)('flags TS %j', (src) => {
    expect(findWarnMisuse(src, false)).not.toStrictEqual([]);
  });

  const goodTs = [
    "const s = { background: 'var(--osx-warn-bg)', color: 'var(--osx-warn-fg)' };",
    "el.style.backgroundColor = 'var(--osx-warn-bg)';",
    "// color: var(--osx-warn-bg) is banned\nconst x = 1;",
  ];
  it.each(goodTs)('passes TS %j', (src) => {
    expect(findWarnMisuse(src, false)).toStrictEqual([]);
  });
});

describe('R46 warn is fill only: the extension source', () => {
  /** `src` and `static`, minus theme.ts, which defines the value. */
  function sources(): { name: string; text: string; css: boolean }[] {
    const files: { name: string; text: string; css: boolean }[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(css|html|ts|tsx|js|mjs)$/.test(e.name)) {
          const name = path.relative(repoRoot, full).split(path.sep).join('/');
          if (name === 'apps/extension/src/shared/theme.ts') continue;
          files.push({ name, text: readFileSync(full, 'utf8'), css: /\.(css|html)$/.test(e.name) });
        }
      }
    };
    walk(path.join(extensionRoot, 'src'));
    walk(path.join(extensionRoot, 'static'));
    return files;
  }

  it('the scan sees the stylesheet that defines the warn fill, so it is not vacuous', () => {
    const files = sources();
    const dash = files.find((f) => f.name === 'apps/extension/src/dashboard/dashboard.css');
    expect(dash, 'dashboard.css was not scanned').toBeDefined();
    expect(dash?.text).toMatch(/--osx-warn-bg:\s*#EF6C00;/);
    expect(dash?.text).toMatch(/--osx-warn-fg:\s*#000000;/);
    expect(files.length).toBeGreaterThan(20);
  });

  it('no file uses the warn color as text, a border, an outline, a stroke, an SVG fill or a shadow', () => {
    const misuse = sources().flatMap((f) => findWarnMisuse(f.text, f.css).map((m) => `${f.name} ${m}`));
    expect(misuse).toStrictEqual([]);
  });
});
