/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The docked iframe's end of the overlay port (D3 section 3). `runtime.onConnect` fires in every
 * extension page, so the tab dashboard and every other docked iframe also hear each connect. This
 * side accepts one name only: `osx-panel:<its own nonce>`, where the nonce is the URL fragment it
 * was loaded with. Register it at module top level, before the overlay's connect can arrive.
 */
import { isPanelPing, NONCE_PATTERN, panelPortName } from '../shared/panelProtocol';
import type { PanelPong } from '../shared/panelProtocol';

export interface PanelStats {
  /** Ports with our name. */
  accepted: number;
  /** Ports with any other name. They are left alone. */
  rejected: number;
  /** Pings answered. */
  pings: number;
}

/** The slice of `chrome.runtime` this file uses. */
export interface PanelListenerRuntime {
  readonly onConnect: {
    addListener(
      cb: (port: {
        name: string;
        postMessage(message: unknown): void;
        onMessage: { addListener(cb: (message: unknown) => void): void };
      }) => void,
    ): void;
  };
}

/** The nonce in `#<nonce>`, or `null` when the fragment is not one. */
export function readNonce(hash: string): string | null {
  const nonce = hash.startsWith('#') ? hash.slice(1) : hash;
  return NONCE_PATTERN.test(nonce) ? nonce : null;
}

export function listenForPanelPort(runtime: PanelListenerRuntime, nonce: string): PanelStats {
  const stats: PanelStats = { accepted: 0, rejected: 0, pings: 0 };
  const ours = panelPortName(nonce);
  runtime.onConnect.addListener((port) => {
    if (port.name !== ours) {
      stats.rejected += 1;
      return;
    }
    stats.accepted += 1;
    port.onMessage.addListener((message) => {
      if (!isPanelPing(message)) return;
      stats.pings += 1;
      const pong: PanelPong = { kind: 'pong', n: message.n, nonce };
      port.postMessage(pong);
    });
  });
  return stats;
}
