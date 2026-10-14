/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * X6 ratchet: an icon-only button has an accessible name.
 *
 * A button whose only content is an icon has no text, so a screen reader
 * announces "button" and nothing else. `title` alone is not enough. It shows a
 * tooltip on hover, but touch and keyboard users do not get it, and some
 * screen readers skip it. The name has to come from `aria-label` (or
 * `aria-labelledby`, or visible text).
 *
 * The scan parses every `*.tsx` under the UI packages and looks at each native
 * `<button>` and each `<Button>` from packages/ui. A button is icon-only when
 * its children are whitespace, an svg, an icon from `lucide-react`, or a
 * conditional that picks between those. Both kinds need an explicit
 * `aria-label`. The `<Button>` primitive also copies `title` into `aria-label`
 * when it has no text, but that is a runtime safety net: the tooltip may be a
 * hint ("Set frame rate to nudge by frame") and not the name of the action.
 *
 * To fix a failure, add `aria-label="what the button does"` to the element.
 * Never add a name to a button that already shows text: the visible text is
 * its name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { elementWithChildren } from './helpers/elementWithChildren';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Button } from '../packages/ui/src/components/Button';
import { Menu, MenuItem } from '../packages/ui/src/components/Menu';
import { ThemeToggle } from '../packages/ui/src/components/ThemeToggle';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = ['packages/ui', 'packages/manager', 'packages/matrix', 'packages/metrics', 'apps/shell/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', 'coverage']);

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...tsxFiles(full));
    else if (name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

export type UnnamedButton = { line: number; tag: string };

/** Tags that render a native button. `motion.button` counts. */
function isNativeButtonTag(tag: string): boolean {
  return tag === 'button' || tag.endsWith('.button');
}

/** Find icon-only buttons with no accessible name in one source file. */
export function findUnnamedIconButtons(source: string, fileName = 'file.tsx'): UnnamedButton[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Local names bound to lucide-react icons, including `X as CloseIcon`.
  const iconNames = new Set<string>();
  sf.forEachChild(node => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'lucide-react') return;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach(el => iconNames.add(el.name.text));
  });

  const isIcon = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node)) return isIcon(node.expression);
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = open.tagName.getText();
      if (tag === 'svg' || iconNames.has(tag) || /Icon$/.test(tag)) return true;
      // `<span aria-hidden><Icon /></span>` is a wrapper, not text.
      if (ts.isJsxElement(node) && tag === 'span') return node.children.every(isIconChild);
    }
    return false;
  };

  // A child that adds no text: whitespace, an icon, or a conditional of icons.
  const isIconChild = (child: ts.Node): boolean => {
    if (ts.isJsxText(child)) return child.getText().trim() === '';
    if (ts.isJsxExpression(child)) {
      const expr = child.expression;
      if (!expr) return true; // `{/* comment */}`
      return isIconExpression(expr);
    }
    return isIcon(child);
  };

  const isIconExpression = (expr: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expr)) return isIconExpression(expr.expression);
    if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isConditionalExpression(expr)) return isIconExpression(expr.whenTrue) && isIconExpression(expr.whenFalse);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return isIconExpression(expr.right);
    }
    return isIcon(expr);
  };

  const found: UnnamedButton[] = [];
  const visit = (node: ts.Node): void => {
    let open: ts.JsxOpeningLikeElement | null = null;
    let children: readonly ts.Node[] = [];
    if (ts.isJsxElement(node)) {
      open = node.openingElement;
      children = node.children;
    } else if (ts.isJsxSelfClosingElement(node)) {
      open = node;
    }
    if (open) {
      const tag = open.tagName.getText();
      const isPrimitive = tag === 'Button';
      if (isPrimitive || isNativeButtonTag(tag)) {
        const attrs = new Map<string, ts.JsxAttribute>();
        let hasSpread = false;
        for (const prop of open.attributes.properties) {
          if (ts.isJsxAttribute(prop)) attrs.set(prop.name.getText(), prop);
          else hasSpread = true;
        }
        const named = attrs.has('aria-label') || attrs.has('aria-labelledby');
        const hasIconProp = attrs.has('leadingIcon') || attrs.has('trailingIcon');
        const noChildren = children.every(c => ts.isJsxText(c) && c.getText().trim() === '');
        const iconOnly = noChildren
          ? isPrimitive
            ? hasIconProp
            : true
          : children.every(isIconChild);
        if (iconOnly && !named && !hasSpread) {
          const { line } = sf.getLineAndCharacterOfPosition(open.getStart());
          found.push({ line: line + 1, tag });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('icon-only buttons have an accessible name', () => {
  const files = SCAN_DIRS.flatMap(dir => tsxFiles(join(ROOT, dir)));

  it('scans the UI package folders', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(f => f.replace(/\\/g, '/').endsWith('apps/shell/src/components/SuiteHeader.tsx'))).toBe(true);
    expect(files.some(f => f.replace(/\\/g, '/').endsWith('packages/ui/src/components/Button.tsx'))).toBe(true);
  });

  it('finds no icon-only button without aria-label, aria-labelledby or visible text', () => {
    const unnamed: string[] = [];
    for (const file of files) {
      for (const hit of findUnnamedIconButtons(readFileSync(file, 'utf8'), file)) {
        unnamed.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${hit.line} <${hit.tag}>`);
      }
    }
    expect(unnamed, `Add aria-label to each:\n${unnamed.join('\n')}`).toEqual([]);
  });
});

describe('the scan itself', () => {
  const lucide = "import { X, Sun, Moon } from 'lucide-react';\n";
  const wrap = (jsx: string) => `${lucide}export const A = () => (${jsx});`;

  it('flags a native button whose only child is an icon', () => {
    expect(findUnnamedIconButtons(wrap('<button type="button" onClick={f}><X size={14} /></button>'))).toHaveLength(1);
  });

  it('flags a native button that has a title but no aria-label', () => {
    expect(findUnnamedIconButtons(wrap('<button title="Close"><X size={14} /></button>'))).toHaveLength(1);
  });

  it('flags a button that swaps between two icons', () => {
    const jsx = '<button onClick={f}>{open ? <Sun size={14} /> : <Moon size={14} />}</button>';
    expect(findUnnamedIconButtons(wrap(jsx))).toHaveLength(1);
  });

  it('flags an empty button and an icon-only Button with no title', () => {
    expect(findUnnamedIconButtons(wrap('<button onClick={f} />'))).toHaveLength(1);
    expect(findUnnamedIconButtons(wrap('<Button leadingIcon={<X />} />'))).toHaveLength(1);
  });

  it('accepts aria-label, aria-labelledby and visible text', () => {
    expect(findUnnamedIconButtons(wrap('<button aria-label="Close"><X size={14} /></button>'))).toEqual([]);
    expect(findUnnamedIconButtons(wrap('<button aria-labelledby="t"><X size={14} /></button>'))).toEqual([]);
    expect(findUnnamedIconButtons(wrap('<button><X size={14} /> Close</button>'))).toEqual([]);
    expect(findUnnamedIconButtons(wrap('<button><X size={14} /><span className="sr-only">Close</span></button>'))).toEqual([]);
    expect(findUnnamedIconButtons(wrap('<button>{label}</button>'))).toEqual([]);
  });

  it('flags an icon-only Button that relies on title alone', () => {
    expect(findUnnamedIconButtons(wrap('<Button title="Close" leadingIcon={<X />} />'))).toHaveLength(1);
    expect(findUnnamedIconButtons(wrap('<Button title="Close" aria-label="Close" leadingIcon={<X />} />'))).toEqual([]);
  });

  it('leaves a Button with text alone, even when it has an icon', () => {
    expect(findUnnamedIconButtons(wrap('<Button leadingIcon={<X />}>Remove</Button>'))).toEqual([]);
  });
});

describe('the Button primitive names an icon-only button', () => {
  const icon = createElement('svg', { 'data-icon': true });

  it('falls back to title as aria-label when the button has no text', () => {
    const html = renderToStaticMarkup(createElement(Button, { title: 'Remove swimmer', leadingIcon: icon }));
    expect(html).toContain('aria-label="Remove swimmer"');
  });

  it('keeps an explicit aria-label', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { title: 'Remove', 'aria-label': 'Remove swimmer', leadingIcon: icon })
    );
    expect(html).toContain('aria-label="Remove swimmer"');
    expect(html).not.toContain('aria-label="Remove"');
  });

  it('does not rename a button that shows text', () => {
    const html = renderToStaticMarkup(createElement(Button, { title: 'Longer tooltip text' }, 'Save'));
    expect(html).not.toContain('aria-label');
  });

  it('names the shared header controls', () => {
    const toggle = renderToStaticMarkup(createElement(ThemeToggle, { theme: 'dark', onToggle: () => undefined }));
    expect(toggle).toContain('aria-label="Toggle color mode"');
    const menu = renderToStaticMarkup(
      elementWithChildren(Menu, { label: 'More', icon }, createElement(MenuItem, null, 'Item'))
    );
    expect(menu).toContain('aria-label="More"');
  });
});
