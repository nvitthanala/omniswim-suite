/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P1.shadow (D3 section 4): the shadow host reset, the keyboard guard, the design tokens, theme
 * modes, the accent setter, and the no-rem / no-@font-face rule.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Window as HappyWindow } from 'happy-dom';
import { mountShadowHost, themeOf } from '../apps/extension/src/overlay/overlay';
import { mountDockedPanel } from '../apps/extension/src/overlay/dockedPanel';
import type { PanelRuntime } from '../apps/extension/src/overlay/dockedPanel';
import { SHADOW_CSS } from '../apps/extension/src/overlay/shadowStyle';
import {
  DARK_QUERY,
  DARK_TOKENS,
  LIGHT_TOKENS,
  TOKEN_NAMES,
  applyAccent,
  bindTheme,
  clearAccent,
  printTokenCss,
  tokenCss,
} from '../apps/extension/src/shared/theme';
import type { MediaQueryLike } from '../apps/extension/src/shared/theme';
import { buildAll, extensionRoot, repoRoot, type BuiltEntry } from './helpers/extensionBuild';

const windows: HappyWindow[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});
function page(): { win: HappyWindow; doc: Document } {
  const win = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/' });
  windows.push(win);
  return { win, doc: win.document as unknown as Document };
}
const wrapperOf = (host: HTMLElement): HTMLElement => {
  const w = host.shadowRoot?.querySelector<HTMLElement>('.osx-root');
  if (!w) throw new Error('no .osx-root');
  return w;
};

/** A stub `matchMedia` whose answer a test can flip, with a change event. */
function fakeMedia(initial: boolean) {
  const state = { matches: initial, queries: [] as string[], listeners: new Set<() => void>() };
  const mql: MediaQueryLike = {
    get matches() {
      return state.matches;
    },
    addEventListener: (_t, l) => void state.listeners.add(l),
    removeEventListener: (_t, l) => void state.listeners.delete(l),
  };
  return {
    state,
    matchMedia: (q: string) => {
      state.queries.push(q);
      return mql;
    },
    flip(matches: boolean) {
      state.matches = matches;
      state.listeners.forEach((l) => l());
    },
  };
}

describe('(a) shadow host reset and theme attribute', () => {
  it('holds the reset style, the wrapper, and data-osx-theme=light by default', () => {
    const { doc } = page();
    const host = mountShadowHost(doc);
    const styles = host.shadowRoot?.querySelectorAll('style') ?? [];
    expect(styles).toHaveLength(1);
    const css = styles[0]?.textContent ?? '';
    expect(css).toMatch(/\.osx-root\s*\{[^}]*all:\s*initial/);
    expect(css).toMatch(/\.osx-root\s*\{[^}]*font-family:\s*var\(--osx-font\)/);
    expect(css).toMatch(/\.osx-root\s*\{[^}]*color:\s*var\(--osx-fg\)/);
    expect(css).toMatch(/\.osx-root\s*\{[^}]*line-height:/);
    expect(css).toBe(SHADOW_CSS);
    expect(wrapperOf(host).getAttribute('data-osx-theme')).toBe('light');
    expect(host.style.cssText).toContain('all: initial');
    expect(host.style.cssText).toContain('position: fixed');
    expect(host.style.cssText).toContain('z-index: 2147483000');
  });

  it('leaves the page alone: no custom property on :root, no style in the page, no custom element', () => {
    const { doc, win } = page();
    mountShadowHost(doc);
    expect(doc.documentElement.getAttribute('style')).toBeNull();
    expect(doc.documentElement.hasAttribute('data-osx-theme')).toBe(false);
    expect(doc.querySelectorAll('style, link[rel="stylesheet"]')).toHaveLength(0);
    expect(win.customElements.get('osx-root')).toBeUndefined();
  });

  it('is idempotent and exposes the theme controller', () => {
    const { doc } = page();
    const host = mountShadowHost(doc, { theme: 'dark' });
    expect(mountShadowHost(doc)).toBe(host);
    expect(doc.querySelectorAll('[data-osx-host]')).toHaveLength(1);
    expect(wrapperOf(host).getAttribute('data-osx-theme')).toBe('dark');
    expect(themeOf(host)?.resolved).toBe('dark');
  });

  it('the docked iframe has an explicit background and a color-scheme that follows the theme', async () => {
    const { doc } = page();
    const host = mountShadowHost(doc);
    const runtime: PanelRuntime = {
      getURL: (p) => `chrome-extension://abc/${p}`,
      connect: () => {
        throw new Error('not connected in this test');
      },
    };
    const { iframe } = mountDockedPanel(host, runtime);
    expect(iframe.style.cssText).toContain('background: var(--osx-bg)');
    expect(iframe.style.colorScheme).toBe('light');
    themeOf(host)?.setPreference('dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(iframe.style.colorScheme).toBe('dark');
  });
});

describe('(b) keyboard events stay inside the wrapper', () => {
  it('keydown, keyup and keypress inside the wrapper do not reach a document listener', () => {
    const { doc, win } = page();
    const host = mountShadowHost(doc);
    const input = doc.createElement('input');
    wrapperOf(host).append(input);
    const seen: string[] = [];
    for (const t of ['keydown', 'keyup', 'keypress']) doc.addEventListener(t, (e) => seen.push(e.type));
    for (const t of ['keydown', 'keyup', 'keypress']) {
      input.dispatchEvent(new win.KeyboardEvent(t, { key: 'a', bubbles: true, composed: true }) as unknown as Event);
    }
    expect(seen).toStrictEqual([]);
    // Control: the same listener does hear a key typed on the page itself.
    doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }) as unknown as Event);
    expect(seen).toStrictEqual(['keydown']);
  });
});

describe('(c) system mode follows matchMedia', () => {
  it('resolves from the stub, follows a change event, and stops after a switch away from system', () => {
    const m = fakeMedia(true);
    const el = page().doc.createElement('div');
    const seen: string[] = [];
    const theme = bindTheme(el, { preference: 'system', matchMedia: m.matchMedia, onChange: (r) => seen.push(r) });
    expect(m.state.queries).toStrictEqual([DARK_QUERY]);
    expect(el.getAttribute('data-osx-theme')).toBe('dark');
    m.flip(false);
    expect(el.getAttribute('data-osx-theme')).toBe('light');
    m.flip(true);
    expect(el.getAttribute('data-osx-theme')).toBe('dark');
    expect(seen).toStrictEqual(['dark', 'light', 'dark']);
    theme.setPreference('light');
    expect(m.state.listeners.size).toBe(0);
    m.flip(true);
    expect(el.getAttribute('data-osx-theme')).toBe('light');
  });

  it('light is the default and ignores the system setting', () => {
    const m = fakeMedia(true);
    const el = page().doc.createElement('div');
    bindTheme(el, { matchMedia: m.matchMedia });
    expect(el.getAttribute('data-osx-theme')).toBe('light');
    expect(m.state.queries).toStrictEqual([]);
  });

  it('system mode works through the shadow host too', () => {
    const m = fakeMedia(false);
    const host = mountShadowHost(page().doc, { theme: 'system', matchMedia: m.matchMedia });
    expect(wrapperOf(host).getAttribute('data-osx-theme')).toBe('light');
    m.flip(true);
    expect(wrapperOf(host).getAttribute('data-osx-theme')).toBe('dark');
  });
});

describe('(d) the accent setter', () => {
  const el = (): HTMLElement => page().doc.createElement('div') as unknown as HTMLElement;

  it.each(['red', '#fff', '#12345g', 'url(x)', '#1565C0 ', '#1565C0;color:red', '', 'rgb(1,2,3)'])('rejects %j and changes nothing', (bad) => {
    const node = el();
    expect(applyAccent(node, bad)).toBe(false);
    expect(node.style.getPropertyValue('--osx-accent')).toBe('');
    expect(node.style.getPropertyValue('--osx-accent-fg')).toBe('');
  });

  it('accepts #1565C0, sets it, picks a readable foreground, and clears', () => {
    const node = el();
    expect(applyAccent(node, '#1565C0')).toBe(true);
    expect(node.style.getPropertyValue('--osx-accent')).toBe('#1565C0');
    expect(node.style.getPropertyValue('--osx-accent-fg')).toBe('white');
    expect(applyAccent(node, '#ffee00')).toBe(true);
    expect(node.style.getPropertyValue('--osx-accent-fg')).toBe('black');
    clearAccent(node);
    expect(node.style.getPropertyValue('--osx-accent')).toBe('');
  });

  it('derives the soft tint with color-mix(), not a second hex', () => {
    expect(LIGHT_TOKENS['--osx-accent-soft']).toMatch(/^color-mix\(in srgb, var\(--osx-accent\)/);
  });
});

describe('(e) light tokens equal recon Q15', () => {
  // plans/2026-10-25/02-SIMULATOR-RECON.md, "Look", item 15. Only the values Q15 records.
  const Q15: Record<string, string> = {
    '--osx-font': 'Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif',
    '--osx-bg': '#FAFAFA',
    '--osx-surface': '#FFFFFF',
    '--osx-fg': 'rgba(0,0,0,0.87)',
    '--osx-fg-muted': 'rgba(0,0,0,0.54)',
    '--osx-border': '#E0E0E0',
    '--osx-accent': '#1565C0',
    '--osx-radius': '8px',
  };

  it('every Q15 token has exactly the Q15 value', () => {
    expect(Object.keys(Q15).length).toBe(8);
    for (const [name, value] of Object.entries(Q15)) {
      expect(LIGHT_TOKENS[name as keyof typeof LIGHT_TOKENS], name).toBe(value);
    }
  });

  it('the Q15 table matches the recon document', () => {
    const recon = readFileSync(path.join(repoRoot, 'plans', '2026-10-25', '02-SIMULATOR-RECON.md'), 'utf8');
    const q15 = recon.slice(recon.indexOf('15. **Light theme only**'), recon.indexOf('16. ', recon.indexOf('15. **Light theme only**')) );
    expect(q15.length).toBeGreaterThan(200);
    for (const text of ['Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif', '#FAFAFA', 'rgba(0,0,0,0.87)', 'rgba(0,0,0,0.54)', '#E0E0E0', '#1565C0', 'radius 8 px']) {
      expect(q15, text).toContain(text);
    }
  });

  it('no token is missing and every other token has a non-empty value in both themes', () => {
    expect(Object.keys(LIGHT_TOKENS).sort()).toStrictEqual([...TOKEN_NAMES].sort());
    expect(Object.keys(DARK_TOKENS).sort()).toStrictEqual([...TOKEN_NAMES].sort());
    for (const n of TOKEN_NAMES) {
      expect(LIGHT_TOKENS[n].length, n).toBeGreaterThan(0);
      expect(DARK_TOKENS[n].length, n).toBeGreaterThan(0);
    }
  });

  it('a color token uses only Q15 values, R46 status colors, system colors, var(--osx-*), color-mix(in srgb) and percentages', () => {
    const allowed = [
      /#(FAFAFA|FFFFFF|E0E0E0|1565C0)/gi, // Q15 hexes
      /rgba\(0,0,0,0\.(87|54)\)/g, // Q15 text colors
      /(CanvasText|Canvas|GrayText|AccentColorText|AccentColor)/g, // CSS system colors
      /var\(--osx-[a-z-]+\)/g,
      /color-mix\(in srgb,/g,
      /\d+%/g,
    ];
    // README R46: only the four status tokens may hold a status hex in the light theme; R57 lets dark reuse the warn pair.
    const r46 = /#(2E7D32|EF6C00|C62828|000000)/gi;
    const statusTokens: readonly string[] = ['--osx-good', '--osx-warn-bg', '--osx-warn-fg', '--osx-bad'];
    const colorTokens = TOKEN_NAMES.filter((n) => n !== '--osx-font' && n !== '--osx-radius');
    expect(colorTokens.length).toBe(12);
    for (const [theme, set] of [['light', LIGHT_TOKENS], ['dark', DARK_TOKENS]] as const) {
      for (const name of colorTokens) {
        let rest = set[name];
        for (const re of allowed) rest = rest.replace(re, ' ');
        // README R57: dark reuses the light warn pair. Good and bad have no dark hex.
        const darkWarn = name === '--osx-warn-bg' || name === '--osx-warn-fg';
        if ((theme === 'light' && statusTokens.includes(name)) || (theme === 'dark' && darkWarn)) rest = rest.replace(r46, ' ');
        expect(rest.replace(/[\s,()]/g, ''), `${theme} ${name} = ${set[name]} holds a value that is neither Q15, R46 nor a system color`).toBe('');
      }
    }
  });

  it('dashboard.css carries exactly the token blocks theme.ts generates for :root', () => {
    const css = readFileSync(path.join(extensionRoot, 'src', 'dashboard', 'dashboard.css'), 'utf8');
    expect(css).toContain(tokenCss(':root'));
  });

  it('print token CSS forces every light token for the default and dark theme selectors', () => {
    const printCss = printTokenCss(':root');
    expect(printCss).toContain(':root, :root[data-osx-theme="dark"]');
    for (const name of TOKEN_NAMES) expect(printCss).toContain(`${name}: ${LIGHT_TOKENS[name]} !important;`);
    const css = readFileSync(path.join(extensionRoot, 'src', 'dashboard', 'dashboard.css'), 'utf8');
    expect(css).toContain(printCss);
  });

  it('the shadow stylesheet carries the token blocks for .osx-root, both themes', () => {
    expect(SHADOW_CSS).toContain(tokenCss('.osx-root'));
    expect(SHADOW_CSS).toContain('.osx-root[data-osx-theme="dark"]');
  });

  it('dashboard.html starts in the light theme', () => {
    expect(readFileSync(path.join(extensionRoot, 'static', 'dashboard.html'), 'utf8')).toMatch(/<html[^>]*data-osx-theme="light"/);
  });
});

describe('(f) no rem and no @font-face in anything that carries styles', () => {
  let built: BuiltEntry[] = [];
  beforeAll(async () => {
    built = await buildAll();
  }, 60_000);

  // A number followed by `rem`, as in `1.5rem`. Plain words such as "remove" do not match.
  const REM = /[0-9.]\s*rem\b/i;
  const FONT_FACE = /@font-face/i;

  it('scans the source CSS, the static files, and the built overlay and dashboard output', () => {
    const scanned: { name: string; text: string }[] = [];
    // Source CSS and static files, read from disk.
    for (const dir of [path.join(extensionRoot, 'src'), path.join(extensionRoot, 'static')]) {
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.(css|html)$/.test(e.name)) scanned.push({ name: path.relative(repoRoot, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') });
        }
      };
      walk(dir);
    }
    // The built output, in memory (the same options as the CLI). The overlay JS holds its CSS as a string.
    for (const b of built) {
      if (b.entry.name !== 'sim-overlay' && b.entry.name !== 'dashboard') continue;
      for (const f of b.files) if (/\.(js|css)$/.test(f.name)) scanned.push({ name: `build:${b.entry.name}/${f.name}`, text: f.text });
    }
    const names = scanned.map((s) => s.name);
    expect(names).toContain('apps/extension/src/dashboard/dashboard.css');
    expect(names).toContain('apps/extension/static/dashboard.html');
    expect(names).toContain('apps/extension/static/light.css');
    expect(names).toContain('build:sim-overlay/sim-overlay.js');
    expect(names.some((n) => n.startsWith('build:dashboard/') && n.endsWith('.css'))).toBe(true);
    // The overlay bundle really carries the stylesheet, so the scan is not vacuous.
    expect(scanned.find((s) => s.name === 'build:sim-overlay/sim-overlay.js')?.text).toContain('.osx-root');
    for (const s of scanned) {
      expect(s.text, `${s.name} uses rem`).not.toMatch(REM);
      expect(s.text, `${s.name} declares @font-face`).not.toMatch(FONT_FACE);
    }
  });

  it('the content-script bundles define no custom element', () => {
    for (const name of ['sim-overlay', 'sim-bridge']) {
      const js = built.find((b) => b.entry.name === name)?.files.find((f) => f.name === `${name}.js`)?.text ?? '';
      expect(js.length, name).toBeGreaterThan(100);
      expect(js, name).not.toMatch(/customElements/);
    }
  });
});
