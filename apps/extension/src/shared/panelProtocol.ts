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

export interface ScorerTagStateMessage {
  readonly kind: 'scorer-tag-state';
  readonly meetKey: string;
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly swimmers: readonly { readonly id: string; readonly teamId: string; readonly name: string; readonly gender: string }[];
  readonly tags: readonly { readonly teamId: string; readonly swimmerId: string; readonly role: 'scorer' | 'non-scorer' | 'exhibition' }[];
  readonly ownTeamId?: string;
  readonly scoringTeamSize?: number;
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface ScorerTagActionMessage {
  readonly kind: 'scorer-tag-action';
  readonly action: 'choose-team' | 'set-role' | 'clear-role';
  readonly teamId: string;
  readonly swimmerId?: string;
  readonly role?: 'scorer' | 'non-scorer' | 'exhibition';
}

export function isScorerTagState(m: unknown): m is ScorerTagStateMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as ScorerTagStateMessage;
  return v.kind === 'scorer-tag-state' && typeof v.meetKey === 'string' && Array.isArray(v.teams) && Array.isArray(v.swimmers) && Array.isArray(v.tags) && Array.isArray(v.warnings);
}

export function isScorerTagAction(m: unknown): m is ScorerTagActionMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as ScorerTagActionMessage;
  return v.kind === 'scorer-tag-action' && ['choose-team', 'set-role', 'clear-role'].includes(v.action) && typeof v.teamId === 'string' && (v.action === 'choose-team' || (typeof v.swimmerId === 'string' && (v.action === 'clear-role' || ['scorer', 'non-scorer', 'exhibition'].includes(String(v.role)))));
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
