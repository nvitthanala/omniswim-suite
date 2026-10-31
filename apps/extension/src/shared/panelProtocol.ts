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
import { isHexColor } from './theme';
import type { ThemePreference } from './theme';
import type { SimSnapshot } from './bridgeSchema';
import type { PresetRef } from '../storage/schema';
import type { RulePreset } from '@omniswim/engine';
import type { SessionPreset } from '@omniswim/engine';

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
  readonly rulePresetRef?: PresetRef;
  readonly rulePreset?: RulePreset;
  readonly rulePresetChoices?: readonly { readonly ref: PresetRef; readonly label: string }[];
  readonly scoringTeamSize?: number;
  readonly warnings: readonly string[];
  readonly cutTags?: readonly { readonly teamId: string; readonly teamName: string; readonly swimmerId: string; readonly swimmerName: string;
    readonly eventKey: string; readonly real: string; readonly estimated: string; readonly estimatedIsEstimate: boolean; readonly estimatedProvenance?: string }[];
  readonly suggestions?: readonly {
    readonly teamId: string; readonly gender: string;
    readonly result: { readonly kind: 'suggested'; readonly swimmerIds: readonly string[]; readonly points: number;
      readonly spots: { readonly numerator: number; readonly denominator: number }; readonly method: 'all_entered' | 'ilp' }
      | { readonly kind: 'absent'; readonly reason: 'pins_over_size' | 'solver_not_optimal' }
      | { readonly kind: 'error'; readonly code: string; readonly subject: string | null };
  }[];
  readonly planner?: {
    readonly perSwimmer: readonly { readonly swimmerId: string; readonly sessions: readonly { readonly session: { readonly day: number; readonly slot: string }; readonly races: number; readonly eventKeys: readonly string[] }[] }[];
    readonly violations: readonly string[];
  };
  readonly sessionSchedule?: { readonly ref?: PresetRef; readonly preset?: SessionPreset; readonly error?: string; readonly note?: string };
  readonly error?: string;
}

/**
 * Iframe to overlay (D6 section 5): the theme the coach chose in settings. The dashboard reads `settings.theme` and `settings.accent` and
 * follows the change bus; the overlay applies them to its panel frame and to the page panel, so one choice themes all three. `accent`
 * is `#rrggbb` or absent. The overlay only reads it and sets attributes and style properties, as with every port message.
 */
export interface ThemeStateMessage {
  readonly kind: 'theme-state';
  readonly preference: ThemePreference;
  readonly accent?: string;
}

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function isThemeState(m: unknown): m is ThemeStateMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as { kind?: unknown; preference?: unknown; accent?: unknown };
  return v.kind === 'theme-state' && THEME_PREFERENCES.includes(v.preference as ThemePreference) && (v.accent === undefined || isHexColor(v.accent));
}

/**
 * Iframe to overlay (D6 section 1): the docked panel's size. `compact` is 360 by 240 px; `expanded` is larger. The overlay sets one
 * attribute on the frame and a rule in the shadow stylesheet does the rest, so the page never sees a size from the iframe.
 */
export type PanelSize = 'compact' | 'expanded';
export interface PanelSizeMessage {
  readonly kind: 'panel-size';
  readonly size: PanelSize;
}

export function isPanelSize(m: unknown): m is PanelSizeMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as { kind?: unknown; size?: unknown };
  return v.kind === 'panel-size' && (v.size === 'compact' || v.size === 'expanded');
}

/**
 * Iframe to overlay (D5 amendment 7 item 3): where an AutoBuilder run stands. The page panel shows it as one line. It carries no result:
 * the result and Accept live in the docked dashboard. The overlay only reads it and writes text, as it does with every port message.
 */
export type AutoBuildStatus = 'running' | 'done' | 'cancelled' | 'failed';
export const AUTO_BUILD_STATUSES: readonly AutoBuildStatus[] = ['running', 'done', 'cancelled', 'failed'];
export interface AutoBuildStatusMessage {
  readonly kind: 'auto-build-status';
  readonly status: AutoBuildStatus;
  readonly elapsedMs: number;
  readonly limitMs: number;
}

export function isAutoBuildStatus(m: unknown): m is AutoBuildStatusMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as Partial<Record<keyof AutoBuildStatusMessage, unknown>>;
  return v.kind === 'auto-build-status' && AUTO_BUILD_STATUSES.includes(v.status as AutoBuildStatus) && typeof v.elapsedMs === 'number' && Number.isFinite(v.elapsedMs) && typeof v.limitMs === 'number' && Number.isFinite(v.limitMs);
}

export interface ScorerTagActionMessage {
  readonly kind: 'scorer-tag-action';
  readonly action: 'choose-team' | 'choose-rule-preset' | 'set-role' | 'clear-role';
  readonly teamId?: string;
  readonly swimmerId?: string;
  readonly role?: 'scorer' | 'non-scorer' | 'exhibition';
  readonly rulePresetRef?: PresetRef;
}

export interface SessionPresetEditMessage { readonly kind: 'session-preset-edit'; readonly preset: unknown }
export type PanelUiActionMessage = ScorerTagActionMessage | SessionPresetEditMessage;

export function isScorerTagState(m: unknown): m is ScorerTagStateMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as ScorerTagStateMessage;
  return v.kind === 'scorer-tag-state' && typeof v.meetKey === 'string' && Array.isArray(v.teams) && Array.isArray(v.swimmers) && Array.isArray(v.tags) && Array.isArray(v.warnings);
}

export function isScorerTagAction(m: unknown): m is ScorerTagActionMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as ScorerTagActionMessage;
  return v.kind === 'scorer-tag-action' && ['choose-team', 'choose-rule-preset', 'set-role', 'clear-role'].includes(v.action) &&
    (v.action === 'choose-rule-preset' ? !!v.rulePresetRef : typeof v.teamId === 'string' && (v.action === 'choose-team' || (typeof v.swimmerId === 'string' && (v.action === 'clear-role' || ['scorer', 'non-scorer', 'exhibition'].includes(String(v.role))))));
}

export function isSessionPresetEdit(m: unknown): m is SessionPresetEditMessage {
  if (!m || typeof m !== 'object') return false;
  const value = m as { kind?: unknown; preset?: unknown };
  return value.kind === 'session-preset-edit' && typeof value.preset === 'object' && value.preset !== null;
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
