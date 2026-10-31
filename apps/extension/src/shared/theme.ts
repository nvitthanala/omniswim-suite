/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Design tokens and theme control (D3 section 4). Pure: no DOM at import time, so the
 * content-script bundle and the dashboard bundle can both use it.
 *
 * Provenance rule: a LIGHT value comes from recon Q15
 * (plans/2026-10-25/02-SIMULATOR-RECON.md, "Look", item 15), except the status colors. SwimCloud has no
 * dark theme and Q15 records no good, warn, bad or accent-fg value. The status colors come from the
 * user's decision README R46 (plans/2026-10-25/README.md): Material 800 shades, good #2E7D32, warn
 * #EF6C00, bad #C62828. Good and bad may be text. Warn is a FILL ONLY (a badge or chip background with
 * the dark foreground token beside it): orange is 3.1:1 on white, so it is never text, a border or a
 * thin icon. tests/extensionStatusColors.test.ts measures the contrast and scans the CSS for misuse.
 * Dark mode reuses the light warn pair (README R57, user decision). Everything else, including dark
 * good and bad, uses CSS system colors (Canvas, CanvasText, GrayText) or color-mix() from a recorded
 * value. No dark good or bad value has been recorded, so none is invented here.
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
  // R46. Good and bad are text colors. Warn is a fill: use `--osx-warn-bg` as a background only, with
  // `--osx-warn-fg` as the text on it. There is no plain `--osx-warn`, so nothing reads as warn text.
  '--osx-good',
  '--osx-warn-bg',
  '--osx-warn-fg',
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

/** README R46 (user decision). The warn pair is a fill and the foreground that sits on it. */
const R46_GOOD = '#2E7D32';
const R46_WARN_FILL = '#EF6C00';
const R46_WARN_ON_FILL = '#000000';
const R46_BAD = '#C62828';

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
  // R46: Material 800 shades. Good 5.1:1 and bad 5.6:1 on white, so both may be text.
  '--osx-good': R46_GOOD,
  // R46: warn is a FILL ONLY. 3.1:1 on white as text, so never `color`, a border or a thin icon.
  '--osx-warn-bg': R46_WARN_FILL,
  // R46: the dark text on the warn fill, 6.8:1.
  '--osx-warn-fg': R46_WARN_ON_FILL,
  '--osx-bad': R46_BAD,
  // Q15: font Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif. No font files ship (the font-face at-rule does not load in a shadow root): reuse the family name.
  '--osx-font': 'Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif',
  // Q15: cards radius 8 px.
  '--osx-radius': '8px',
  // Derived with color-mix() from the accent and the surface.
  '--osx-accent-soft': 'color-mix(in srgb, var(--osx-accent) 12%, var(--osx-surface))',
};

/**
 * Dark theme. SwimCloud has none (Q15), so nothing here claims to be SwimCloud's.
 *
 * Good and bad stay neutral: the 800 shades fail 4.5:1 on a dark Canvas (about 3.7:1 for good,
 * 3.3:1 for bad on #121212). Warn uses the light pair (README R57, user decision): the fill and its
 * black text measure 6.8:1 whatever the page background is.
 */
export const DARK_TOKENS: TokenSet = {
  '--osx-bg': 'Canvas',
  '--osx-surface': 'color-mix(in srgb, Canvas 92%, CanvasText)',
  '--osx-fg': 'CanvasText',
  '--osx-fg-muted': 'GrayText',
  '--osx-border': 'color-mix(in srgb, Canvas 80%, CanvasText)',
  // The recorded Q15 accent, lightened with color-mix() so it reads on a dark surface.
  '--osx-accent': `color-mix(in srgb, ${Q15_ACCENT} 65%, CanvasText)`,
  '--osx-accent-fg': 'Canvas',
  '--osx-good': 'CanvasText',
  '--osx-warn-bg': LIGHT_TOKENS['--osx-warn-bg'],
  '--osx-warn-fg': LIGHT_TOKENS['--osx-warn-fg'],
  '--osx-bad': 'CanvasText',
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

/** Light token overrides for print, with enough priority to beat theme selectors and inline accents. */
export function printTokenCss(scope = ':root'): string {
  const tokens = TOKEN_NAMES.map((name) => `  ${name}: ${LIGHT_TOKENS[name]} !important;`).join('\n');
  return `@media print {\n${scope}, ${scope}[${THEME_ATTRIBUTE}="dark"] {\n${tokens}\n}\n}\n`;
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

/** The dark theme lightens its accent: 65% of the accent, 35% of `CanvasText` (white in a dark scheme). The same share as `DARK_TOKENS`. */
const DARK_ACCENT_SHARE = 0.65;

/** The accent as the dark theme shows it, as `#rrggbb`, for the contrast pick of the text on it. */
function lightenedForDark(hex: string): string {
  const channel = (i: number): string => Math.round(parseInt(hex.slice(i, i + 2), 16) * DARK_ACCENT_SHARE + 255 * (1 - DARK_ACCENT_SHARE)).toString(16).padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * Apply a user accent to an element that carries the tokens. Accepts only `#rrggbb`. Returns false
 * and changes nothing for anything else (`red`, `#fff`, `#12345g`, `url(x)`), so no free-form
 * string reaches a style property. `--osx-accent-soft` already derives from the accent with
 * color-mix(), so it follows. `--osx-accent-fg` is black or white by contrast.
 *
 * `theme` is the resolved theme of `el` (default `'light'`). The dark theme lightens its accent so it reads on a dark surface, and an
 * inline accent would override that, so in dark the same lightening is applied to the user's accent and the text colour is picked for
 * the lightened colour. A theme switch needs `applyAccent` again: `createAccentSync` does that.
 */
export function applyAccent(el: HTMLElement, hex: string, theme: ResolvedTheme = 'light'): boolean {
  if (!isHexColor(hex)) return false;
  const dark = theme === 'dark';
  el.style.setProperty('--osx-accent', dark ? `color-mix(in srgb, ${hex} ${DARK_ACCENT_SHARE * 100}%, CanvasText)` : hex);
  el.style.setProperty('--osx-accent-fg', luminance(dark ? lightenedForDark(hex) : hex) > 0.4 ? 'black' : 'white');
  return true;
}

/** Remove the override. The theme's own accent applies again. */
export function clearAccent(el: HTMLElement): void {
  el.style.removeProperty('--osx-accent');
  el.style.removeProperty('--osx-accent-fg');
}

/**
 * Keep a user accent on `el` in step with the element's own theme attribute. `set(hex)` applies it (or clears it for `undefined` or a
 * value that is not `#rrggbb`), and a later change of `data-osx-theme` on `el` (a switch, or system mode following the OS) applies it again for the new theme.
 */
export interface AccentSync {
  set(hex: string | undefined): void;
  dispose(): void;
}

export function createAccentSync(el: HTMLElement): AccentSync {
  let current: string | undefined;
  const apply = (): void => {
    if (current === undefined) {
      clearAccent(el);
      return;
    }
    applyAccent(el, current, el.getAttribute(THEME_ATTRIBUTE) === 'dark' ? 'dark' : 'light');
  };
  const Observer = typeof MutationObserver === 'function' ? MutationObserver : undefined;
  const observer = Observer ? new Observer(apply) : undefined;
  observer?.observe(el, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
  return {
    set(hex) {
      current = isHexColor(hex) ? hex : undefined;
      apply();
    },
    dispose() {
      observer?.disconnect();
    },
  };
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
