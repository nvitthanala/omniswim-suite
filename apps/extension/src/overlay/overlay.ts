/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * sim-overlay, ISOLATED world, document_idle.
 *
 * Bridge trust rule (D3 2.7): the page can forge any `postMessage`, so this
 * script validates the shape of every bridge message and drops the malformed
 * ones. It starts no storage write and no SwimCloud request from a bridge
 * message. It touches no IndexedDB here: in this world that would be
 * SwimCloud's own database (D3 0.2, enforced by tests/extensionBundleBoundaries).
 *
 * It logs a valid SimSnapshot to the console and hands it to `onSnapshot`,
 * which forwards it to the docked panel (D3 15).
 */
import { parseBridgeMessage } from '../shared/bridgeSchema';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { bindTheme } from '../shared/theme';
import type { ThemeController, ThemeOptions, ThemePreference } from '../shared/theme';
import { ROOT_CLASS, SHADOW_CSS } from './shadowStyle';
import { BRIDGE_SOURCE, BRIDGE_VERSION, OVERLAY_SOURCE } from '../shared/protocol';

export const LOG_PREFIX = '[OmniSwim]';

export type OverlayLog = Pick<Console, 'log' | 'warn' | 'error' | 'debug'>;

/** Keys typed into OmniSwim UI must not reach SwimCloud's handlers (D3 section 4, trap 5). */
export const STOPPED_KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;

export interface ShadowHostOptions {
  /** Defaults to `'light'`. `'system'` follows `prefers-color-scheme`. */
  readonly theme?: ThemePreference;
  /** Defaults to the global `matchMedia`. A test passes a stub. */
  readonly matchMedia?: ThemeOptions['matchMedia'];
}

const themeControllers = new WeakMap<HTMLElement, ThemeController>();

/** The theme controller of a host that `mountShadowHost` made. */
export function themeOf(host: HTMLElement): ThemeController | undefined {
  return themeControllers.get(host);
}

/**
 * Mount the shadow host (D3 section 4). Layout goes on the host as inline
 * style because page rules beat `:host`. Idempotent: a second call returns the
 * host that already exists.
 *
 * Inside the shadow root: one `<style>` (reset and tokens, ./shadowStyle.ts) and the `.osx-root`
 * wrapper. The wrapper stops key events so SwimCloud's handlers never see them. Nothing here
 * portals to `document.body` and nothing defines a custom element.
 */
export function mountShadowHost(doc: Document, opts: ShadowHostOptions = {}): HTMLElement {
  const existing = doc.querySelector<HTMLElement>('[data-osx-host]');
  if (existing) return existing;
  const host = doc.createElement('div');
  host.setAttribute('data-osx-host', '');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.setAttribute('data-osx-style', '');
  style.textContent = SHADOW_CSS;
  const wrapper = doc.createElement('div');
  wrapper.className = ROOT_CLASS;
  for (const type of STOPPED_KEY_EVENTS) wrapper.addEventListener(type, (e) => e.stopPropagation());
  root.append(style, wrapper);
  const options: ThemeOptions = { preference: opts.theme ?? 'light', ...(opts.matchMedia ? { matchMedia: opts.matchMedia } : {}) };
  themeControllers.set(host, bindTheme(wrapper, options));
  (doc.body ?? doc.documentElement).append(host);
  return host;
}

/** Listen for bridge messages. Returns a function that stops listening. */
export function startOverlay(win: Window & typeof globalThis, log: OverlayLog = console, onSnapshot: (snapshot: SimSnapshot) => void = () => undefined): () => void {
  const host = mountShadowHost(win.document);

  const onMessage = (e: MessageEvent): void => {
    // Not ours: another frame, another origin, or a page that talks to itself.
    if (e.source !== win || e.origin !== win.location.origin) return;
    const data = e.data as { source?: unknown } | null;
    if (!data || typeof data !== 'object' || data.source !== BRIDGE_SOURCE) return;

    const parsed = parseBridgeMessage(data);
    if (!parsed.ok) {
      log.warn(`${LOG_PREFIX} dropped a malformed bridge message (${parsed.reason})`);
      return;
    }
    const m = parsed.message;
    switch (m.kind) {
      case 'snapshot':
        host.dataset.osxState = 'ready';
        // The console line stays: the user's live load check reads it (D3 15, P1 `userCheck` in the state file).
        log.log(`${LOG_PREFIX} SimSnapshot`, m.snapshot);
        onSnapshot(m.snapshot);
        break;
      case 'response':
        log.debug(`${LOG_PREFIX} team response`, m.url);
        break;
      case 'error':
        host.dataset.osxState = 'error';
        log.error(`${LOG_PREFIX} bridge error: ${m.code}: ${m.detail}`);
        break;
    }
  };

  win.addEventListener('message', onMessage);
  // The bridge posted its first snapshot before this script loaded. Ask for the latest.
  win.postMessage({ source: OVERLAY_SOURCE, v: BRIDGE_VERSION, kind: 'ready' }, win.location.origin);
  return () => win.removeEventListener('message', onMessage);
}
