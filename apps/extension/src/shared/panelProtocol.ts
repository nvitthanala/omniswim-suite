/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The overlay <-> docked iframe port (D3 section 3). This file imports nothing.
 *
 * The overlay makes a random nonce and loads `dashboard.html?host=docked#<nonce>`. It then calls
 * `chrome.runtime.connect({name: 'osx-panel:<nonce>'})`. The iframe accepts only its own name.
 * The service worker ignores the `osx-panel:` prefix. The two sides never use `window.postMessage`:
 * the host page shares the content script's origin and could forge a "save lineup" message.
 */

import { simSnapshotSchema } from './bridgeSchema';
import type { SimSnapshot } from './bridgeSchema';

export const PANEL_PORT_PREFIX = 'osx-panel:';

/** 16 random bytes as lower-case hex. Anything else is not a nonce. */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export function panelPortName(nonce: string): string {
  return PANEL_PORT_PREFIX + nonce;
}

export function isPanelPortName(name: string): boolean {
  return name.startsWith(PANEL_PORT_PREFIX);
}

/** Overlay to iframe. */
export interface PanelPing {
  readonly kind: 'ping';
  readonly n: number;
}

/** Iframe to overlay. `nonce` echoes the iframe's own nonce. */
export interface PanelPong {
  readonly kind: 'pong';
  readonly n: number;
  readonly nonce: string;
}

/** Validated page snapshot forwarded to the docked extension page. */
export interface PanelSnapshot {
  readonly kind: 'simulator-snapshot';
  readonly snapshot: SimSnapshot;
}

export function isPanelSnapshot(m: unknown): m is PanelSnapshot {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as { kind?: unknown; snapshot?: unknown };
  return r.kind === 'simulator-snapshot' && simSnapshotSchema.safeParse(r.snapshot).success;
}

export function isPanelPing(m: unknown): m is PanelPing {
  const r = m as { kind?: unknown; n?: unknown } | null;
  return typeof r === 'object' && r !== null && r.kind === 'ping' && typeof r.n === 'number';
}

export function isPanelPong(m: unknown): m is PanelPong {
  const r = m as { kind?: unknown; n?: unknown; nonce?: unknown } | null;
  return typeof r === 'object' && r !== null && r.kind === 'pong' && typeof r.n === 'number' && typeof r.nonce === 'string';
}
