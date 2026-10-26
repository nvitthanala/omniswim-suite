/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Design tokens and theme control (D3 section 4). Pure: no DOM at import time, so the
 * content-script bundle and the dashboard bundle can both use it.
 *
 * Provenance rule: a LIGHT value comes only from recon Q15
 * (plans/2026-10-25/02-SIMULATOR-RECON.md, "Look", item 15). SwimCloud has no dark theme and Q15
 * records no good, warn, bad or accent-fg value. Those, and all of dark mode, use CSS system colors
 * (Canvas, CanvasText, GrayText) or color-mix() from a recorded value. No SwimCloud palette value is
 * invented here.
 *
 * Units: px and em only. `rem` follows the host page's `html` font-size (D3 section 4, trap 4).
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_ATTRIBUTE = 'data-osx-theme';

export const TOKEN_NAMES = [
  '--osx-bg',
  '--osx-surface',
  '--osx-fg',
  '--osx-fg-muted',
  '--osx-border',
  '--osx-accent',
  '--osx-accent-fg',
  '--osx-good',
  '--osx-warn',
  '--osx-bad',
  '--osx-font',
  '--osx-radius',
  // Derived, not a Q15 value: a tint of the accent over the surface.
  '--osx-accent-soft',
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type TokenSet = Readonly<Record<TokenName, string>>;

/** Q15: "primary and links `#1565C0`". The one recorded accent. Dark mode derives from it. */
const Q15_ACCENT = '#1565C0';

/**
 * Light theme. Every value marked Q15 is copied from recon Q15; the rest are system colors or
 * derived, and the comment says which.
 */
export const LIGHT_TOKENS: TokenSet = {
  // Q15: body background #FAFAFA.
  '--osx-bg': '#FAFAFA',
  // Q15: cards white.
  '--osx-surface': '#FFFFFF',
  // Q15: text rgba(0,0,0,0.87).
  '--osx-fg': 'rgba(0,0,0,0.87)',
  // Q15: table header text rgba(0,0,0,0.54).
  '--osx-fg-muted': 'rgba(0,0,0,0.54)',
  // Q15: row borders #E0E0E0.
  '--osx-border': '#E0E0E0',
  // Q15: primary and links #1565C0.
  '--osx-accent': Q15_ACCENT,
  // Not in Q15. System color: the page background under `color-scheme: light`, so white on the accent.
  '--osx-accent-fg': 'Canvas',
  // Not in Q15, and no system color means good, warn or bad. Neutral until the user decides a
  // semantic palette: these three read as plain text, so no code may rely on them to tell states apart.
  '--osx-good': 'CanvasText',
  '--osx-warn': 'CanvasText',
  '--osx-bad': 'CanvasText',
  // Q15: font Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif. No font files ship (the font-face at-rule does not load in a shadow root): reuse the family name.
  '--osx-font': 'Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif',
  // Q15: cards radius 8 px.
  '--osx-radius': '8px',
  // Derived with color-mix() from the accent and the surface.
  '--osx-accent-soft': 'color-mix(in srgb, var(--osx-accent) 12%, var(--osx-surface))',
};

/** Dark theme. SwimCloud has none (Q15), so nothing here claims to be SwimCloud's. */
export const DARK_TOKENS: TokenSet = {
  '--osx-bg': 'Canvas',
  '--osx-surface': 'color-mix(in srgb, Canvas 92%, CanvasText)',
  '--osx-fg': 'CanvasText',
  '--osx-fg-muted': 'GrayText',
  '--osx-border': 'color-mix(in srgb, Canvas 80%, CanvasText)',
  // The recorded Q15 accent, lightened with color-mix() so it reads on a dark surface.
  '--osx-accent': `color-mix(in srgb, ${Q15_ACCENT} 65%, CanvasText)`,
  '--osx-accent-fg': 'Canvas',
  '--osx-good': LIGHT_TOKENS['--osx-good'],
  '--osx-warn': LIGHT_TOKENS['--osx-warn'],
  '--osx-bad': LIGHT_TOKENS['--osx-bad'],
  '--osx-font': LIGHT_TOKENS['--osx-font'],
  '--osx-radius': LIGHT_TOKENS['--osx-radius'],
  '--osx-accent-soft': LIGHT_TOKENS['--osx-accent-soft'],
};

function declarations(tokens: TokenSet, scheme: ResolvedTheme): string {
  const lines = TOKEN_NAMES.map((name) => `  ${name}: ${tokens[name]};`);
  return `  color-scheme: ${scheme};\n${lines.join('\n')}`;
}

/**
 * The token CSS for one scope. `scope` is `.osx-root` in the shadow root and `:root` on the
 * dashboard page. Light is the default: it applies with no attribute, and `data-osx-theme="dark"`
 * overrides it.
 */
export function tokenCss(scope: string): string {
  return (
    `${scope} {\n${declarations(LIGHT_TOKENS, 'light')}\n}\n` +
    `${scope}[${THEME_ATTRIBUTE}="dark"] {\n${declarations(DARK_TOKENS, 'dark')}\n}\n`
  );
}

// ---- accent override -------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** WCAG relative luminance of a validated `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * Apply a user accent to an element that carries the tokens. Accepts only `#rrggbb`. Returns false
 * and changes nothing for anything else (`red`, `#fff`, `#12345g`, `url(x)`), so no free-form
 * string reaches a style property. `--osx-accent-soft` already derives from the accent with
 * color-mix(), so it follows. `--osx-accent-fg` is black or white by contrast.
 */
export function applyAccent(el: HTMLElement, hex: string): boolean {
  if (!isHexColor(hex)) return false;
  el.style.setProperty('--osx-accent', hex);
  el.style.setProperty('--osx-accent-fg', luminance(hex) > 0.4 ? 'black' : 'white');
  return true;
}

/** Remove the override. The theme's own accent applies again. */
export function clearAccent(el: HTMLElement): void {
  el.style.removeProperty('--osx-accent');
  el.style.removeProperty('--osx-accent-fg');
}

// ---- preference and system mode --------------------------------------------------------------

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The slice of `MediaQueryList` this file uses. */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeOptions {
  /** Defaults to `'light'`. */
  readonly preference?: ThemePreference;
  /** Defaults to the global `matchMedia`. Pass a stub in a test. */
  readonly matchMedia?: (query: string) => MediaQueryLike;
  /** Called once at bind time and after each change of the resolved theme. */
  readonly onChange?: (resolved: ResolvedTheme) => void;
}

export interface ThemeController {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
  /** Stops listening to the media query. */
  dispose(): void;
}

/**
 * Set `data-osx-theme` on `el` from a preference and keep it current. `system` follows
 * `prefers-color-scheme` and its change events. Without a `matchMedia`, `system` resolves to light.
 */
export function bindTheme(el: Element, opts: ThemeOptions = {}): ThemeController {
  const matchMediaFn = opts.matchMedia ?? (typeof matchMedia === 'function' ? (q: string) => matchMedia(q) : undefined);
  let preference: ThemePreference = opts.preference ?? 'light';
  let resolved: ResolvedTheme = 'light';
  let started = false;
  let mql: MediaQueryLike | undefined;

  const resolve = (): ResolvedTheme => (preference === 'system' ? (mql?.matches ? 'dark' : 'light') : preference);
  const apply = (): void => {
    const next = resolve();
    el.setAttribute(THEME_ATTRIBUTE, next);
    if (started && next === resolved) return;
    started = true;
    resolved = next;
    opts.onChange?.(next);
  };
  const onMediaChange = (): void => apply();
  const listen = (): void => {
    if (preference === 'system' && matchMediaFn && !mql) {
      mql = matchMediaFn(DARK_QUERY);
      mql.addEventListener('change', onMediaChange);
    } else if (preference !== 'system' && mql) {
      mql.removeEventListener('change', onMediaChange);
      mql = undefined;
    }
  };

  listen();
  apply();
  return {
    get preference() {
      return preference;
    },
    get resolved() {
      return resolved;
    },
    setPreference(next) {
      preference = next;
      listen();
      apply();
    },
    dispose() {
      mql?.removeEventListener('change', onMediaChange);
      mql = undefined;
    },
  };
}
