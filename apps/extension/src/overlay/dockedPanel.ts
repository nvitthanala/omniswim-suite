/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The docked panel (D3 section 3, option D): an extension-page iframe inside the overlay's shadow
 * host, plus the port that links the two.
 *
 * The iframe is `chrome-extension://<id>/dashboard.html?host=docked#<nonce>`. It runs as the
 * extension, so it has the extension's IndexedDB and may start the optimizer worker. This script
 * runs as www.swimcloud.com and does neither.
 *
 * Trust rule (D3 2.7): a message on the port only sets a state attribute on the shadow host. It
 * starts no storage write and no SwimCloud request.
 *
 * Connect timing: `runtime.connect` fails with "Receiving end does not exist" until the iframe has
 * registered its `onConnect` listener. So the overlay connects on the iframe's `load` event and
 * retries a few times if the port closes before the first reply.
 */
import { THEME_ATTRIBUTE } from '../shared/theme';
import { isPanelPong, panelPortName } from '../shared/panelProtocol';
import type { PanelPing } from '../shared/panelProtocol';

/** The slice of a `chrome.runtime.Port` this file uses. A test passes a fake. */
export interface PanelPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(cb: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(cb: () => void): void };
}

/** The slice of `chrome.runtime` this file uses. */
export interface PanelRuntime {
  getURL(path: string): string;
  connect(info: { name: string }): PanelPort;
  /** Reading it clears Chrome's "unchecked runtime.lastError" warning. */
  readonly lastError?: { message?: string } | undefined;
}

export type PanelState = 'mounted' | 'connected' | 'unreachable';

export interface DockedPanelOptions {
  /** Defaults to the global `crypto`. */
  readonly crypto?: Pick<Crypto, 'getRandomValues'>;
  /** Defaults to 6. */
  readonly maxAttempts?: number;
  /** Defaults to 250. */
  readonly retryDelayMs?: number;
}

export interface DockedPanel {
  readonly iframe: HTMLIFrameElement;
  readonly nonce: string;
  /** The URL the iframe loads, `#<nonce>` included. */
  readonly url: string;
}

/** 32 lower-case hex characters from `crypto.getRandomValues`. */
export function makeNonce(source: Pick<Crypto, 'getRandomValues'> = crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function mountDockedPanel(host: HTMLElement, runtime: PanelRuntime, opts: DockedPanelOptions = {}): DockedPanel {
  const root = host.shadowRoot?.querySelector('.osx-root');
  if (!root) throw new Error('the shadow host has no .osx-root');
  const nonce = makeNonce(opts.crypto);
  const maxAttempts = opts.maxAttempts ?? 6;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  const url = `${runtime.getURL('dashboard.html?host=docked')}#${nonce}`;

  const iframe = host.ownerDocument.createElement('iframe');
  iframe.setAttribute('data-osx-panel-frame', '');
  iframe.title = 'OmniSwim';
  // Trap 8 (D3 section 4): an explicit background and a color-scheme that matches the theme, so
  // the page's scheme cannot paint an opaque backdrop. Position and size live in the shadow
  // stylesheet (./shadowStyle.ts), where a media query moves the panel clear of SwimCloud's
  // narrow-layout "Options" button. An inline value would beat that rule.
  iframe.style.cssText = 'border: 1px solid var(--osx-border); background: var(--osx-bg);';
  const syncScheme = (): void => {
    iframe.style.colorScheme = root.getAttribute(THEME_ATTRIBUTE) === 'dark' ? 'dark' : 'light';
  };
  syncScheme();
  // The theme can change later (system mode). Keep the iframe's scheme in step.
  const Observer = host.ownerDocument.defaultView?.MutationObserver;
  if (Observer) new Observer(syncScheme).observe(root, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
  host.dataset.osxPanel = 'mounted' satisfies PanelState;

  let attempt = 0;
  let pings = 0;
  const connect = (): void => {
    attempt += 1;
    let answered = false;
    const port = runtime.connect({ name: panelPortName(nonce) });
    port.onMessage.addListener((message) => {
      // Only our own iframe holds our nonce, so only it can answer with it.
      if (!isPanelPong(message) || message.nonce !== nonce) return;
      answered = true;
      host.dataset.osxPanel = 'connected' satisfies PanelState;
      host.dataset.osxPanelVia = 'direct';
      host.dataset.osxPanelAttempts = String(attempt);
      host.dataset.osxPanelPongs = String(Number(host.dataset.osxPanelPongs ?? '0') + 1);
    });
    port.onDisconnect.addListener(() => {
      void runtime.lastError;
      if (answered) return;
      if (attempt < maxAttempts) setTimeout(connect, retryDelayMs);
      else host.dataset.osxPanel = 'unreachable' satisfies PanelState;
    });
    pings += 1;
    const ping: PanelPing = { kind: 'ping', n: pings };
    port.postMessage(ping);
  };

  iframe.addEventListener('load', connect, { once: true });
  iframe.src = url;
  root.append(iframe);
  return { iframe, nonce, url };
}
