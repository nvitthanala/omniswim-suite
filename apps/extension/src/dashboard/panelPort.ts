/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The docked iframe's end of the overlay port (D3 section 3). `runtime.onConnect` fires in every
 * extension page, so the tab dashboard and every other docked iframe also hear each connect. This
 * side accepts one name only: `osx-panel:<its own nonce>`, where the nonce is the URL fragment it
 * was loaded with. Register it at module top level, before the overlay's connect can arrive.
 */
import { isPanelPing, isPanelSnapshot, isScorerTagAction, isSessionPresetEdit, NONCE_PATTERN, panelPortName } from '../shared/panelProtocol';
import type { PanelPong } from '../shared/panelProtocol';
import type { SimSnapshot } from '../shared/bridgeSchema';

export interface PanelStats {
  /** Ports with our name. */
  accepted: number;
  /** Ports with any other name. They are left alone. */
  rejected: number;
  /** Pings answered. */
  pings: number;
  snapshots: number;
}

/** A disconnected Chrome port may throw before its onDisconnect callback reaches the page. */
export function postPanelMessageSafely(port: { postMessage(message: unknown): void } | null, message: unknown, onDisconnected: () => void = () => undefined): void {
  if (!port) return;
  try { port.postMessage(message); } catch { onDisconnected(); }
}

/** The slice of `chrome.runtime` this file uses. */
export interface PanelListenerRuntime {
  readonly onConnect: {
    addListener(
      cb: (port: {
        name: string;
        postMessage(message: unknown): void;
        onMessage: { addListener(cb: (message: unknown) => void): void };
        /** The overlay closed the port, or its page went away. Optional: a test port may not have it. */
        onDisconnect?: { addListener(cb: () => void): void };
      }) => void,
    ): void;
  };
}

/** The nonce in `#<nonce>`, or `null` when the fragment is not one. */
export function readNonce(hash: string): string | null {
  const nonce = hash.startsWith('#') ? hash.slice(1) : hash;
  return NONCE_PATTERN.test(nonce) ? nonce : null;
}

export function listenForPanelPort(runtime: PanelListenerRuntime, nonce: string, onSnapshot: (snapshot: SimSnapshot) => void = () => undefined, onTagAction: (action: import('../shared/panelProtocol').ScorerTagActionMessage) => void = () => undefined, onPort: (port: { postMessage(message: unknown): void }) => void = () => undefined, onSessionPresetEdit: (preset: unknown) => void = () => undefined, onPortClosed: (port: { postMessage(message: unknown): void }) => void = () => undefined): PanelStats {
  const stats: PanelStats = { accepted: 0, rejected: 0, pings: 0, snapshots: 0 };
  const ours = panelPortName(nonce);
  runtime.onConnect.addListener((port) => {
    if (port.name !== ours) {
      stats.rejected += 1;
      return;
    }
    stats.accepted += 1;
    onPort(port);
    port.onDisconnect?.addListener(() => onPortClosed(port));
    port.onMessage.addListener((message) => {
      if (!isPanelPing(message)) return;
      stats.pings += 1;
      const pong: PanelPong = { kind: 'pong', n: message.n, nonce };
      postPanelMessageSafely(port, pong, () => onPortClosed(port));
    });
    port.onMessage.addListener((message) => { if (isScorerTagAction(message)) onTagAction(message); });
    port.onMessage.addListener((message) => { if (isSessionPresetEdit(message)) onSessionPresetEdit(message.preset); });
    port.onMessage.addListener((message) => {
      if (!isPanelSnapshot(message)) return;
      stats.snapshots += 1;
      onSnapshot(message.snapshot);
    });
  });
  return stats;
}
