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

import { parseSeasonChoices, simSnapshotSchema } from './bridgeSchema';
import { isHexColor } from './theme';
import type { ThemePreference } from './theme';
import type { ParsedSeasonChoices, SeasonChoice, SimSnapshot } from './bridgeSchema';
import { FETCH_FEATURES } from './fetchProtocol';
import type { FetchFeature, FetchTarget } from './fetchProtocol';
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

// ---- Extra SwimCloud requests (D7 section 3) -----------------------------------------------------------------------------------------
// The docked panel asks; the overlay fetches in its own world and sends back each raw 200 body. The panel parses it again and writes
// (decisions Q, W, C). Nothing here starts from a page, a snapshot or a bridge message: a run starts only on `fetch-run` from the port.

export type FetchStopReason = 'challenge' | 'forbidden' | 'rate-limited' | 'server-error' | 'unexpected-status' | 'network' | 'redirected'
  | 'cancelled' | 'lock-held' | 'lock-unavailable' | 'busy'
  /** Added to D7's list: the run held a target whose path `fetchPathFor` would not round-trip. No request was sent. */
  | 'refused'
  /** Added by the architect's ruling of 2026-11-05: the overlay's own code failed mid-run. A bug in the extension, not in SwimCloud's answer. `status` is 0. */
  | 'internal';

/** Panel to overlay: start one run. The panel sends it only from a click handler and only when `fetchPosture === 'on-click'`. */
export interface FetchRunMessage {
  readonly kind: 'fetch-run';
  readonly runId: string;
  readonly feature: FetchFeature;
  readonly targets: readonly FetchTarget[];
}
/** Panel to overlay: stop the run with this id. */
export interface FetchCancelMessage {
  readonly kind: 'fetch-cancel';
  readonly runId: string;
}
/** Overlay to panel: request `index` is about to start after `waitMs`. `why` is `start` (first), `pacing` or `rate-limited`. */
export interface FetchProgressMessage {
  readonly kind: 'fetch-progress';
  readonly runId: string;
  readonly index: number;
  readonly waitMs: number;
  readonly why: 'start' | 'pacing' | 'rate-limited';
}
/** Overlay to panel: one `200` the overlay classified as the page it asked for. `body` is the raw text. `fetchedAt` is ISO 8601. */
export interface FetchItemMessage {
  readonly kind: 'fetch-item';
  readonly runId: string;
  readonly index: number;
  readonly path: string;
  readonly finalPath: string;
  readonly contentType: string;
  readonly body: string;
  readonly fetchedAt: string;
}
export interface FetchStopped {
  readonly reason: FetchStopReason;
  /** The target that was being fetched. */
  readonly index: number;
  /** The HTTP status, or 0 when none applies (network, lock, busy, refused, cancelled). */
  readonly status: number;
  readonly detail: string;
}
/** Overlay to panel: exactly one per `fetch-run`. `stopped` is null when every target was delivered. */
export interface FetchEndMessage {
  readonly kind: 'fetch-end';
  readonly runId: string;
  readonly delivered: number;
  readonly stopped: FetchStopped | null;
}

export function isFetchRun(m: unknown): m is FetchRunMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as Partial<Record<keyof FetchRunMessage, unknown>>;
  return v.kind === 'fetch-run' && typeof v.runId === 'string' && v.runId.length > 0 && FETCH_FEATURES.includes(v.feature as FetchFeature) && Array.isArray(v.targets);
}

export function isFetchCancel(m: unknown): m is FetchCancelMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as Partial<Record<keyof FetchCancelMessage, unknown>>;
  return v.kind === 'fetch-cancel' && typeof v.runId === 'string';
}

// ---- Overlay to panel: run progress, parsed strictly (F1.1a) --------------------------------------------------------------------------
// The overlay is a content script in the host page's origin. The panel treats every message from it as untrusted data: each guard checks every
// field and returns a copy, never the object it was given. A message that fails a guard is dropped by the caller.

export const FETCH_STOP_REASONS: readonly FetchStopReason[] = ['challenge', 'forbidden', 'rate-limited', 'server-error', 'unexpected-status', 'network',
  'redirected', 'cancelled', 'lock-held', 'lock-unavailable', 'busy', 'refused', 'internal'];

const isRunId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const isIsoInstant = (v: unknown): v is string => typeof v === 'string' && ISO_INSTANT.test(v) && !Number.isNaN(Date.parse(v));

export function parseFetchProgress(m: unknown): FetchProgressMessage | null {
  if (!m || typeof m !== 'object') return null;
  const v = m as Record<string, unknown>;
  if (v.kind !== 'fetch-progress' || !isRunId(v.runId) || !isCount(v.index) || !isCount(v.waitMs)) return null;
  if (v.why !== 'start' && v.why !== 'pacing' && v.why !== 'rate-limited') return null;
  return { kind: 'fetch-progress', runId: v.runId, index: v.index, waitMs: v.waitMs, why: v.why };
}

export function parseFetchItem(m: unknown): FetchItemMessage | null {
  if (!m || typeof m !== 'object') return null;
  const v = m as Record<string, unknown>;
  if (v.kind !== 'fetch-item' || !isRunId(v.runId) || !isCount(v.index)) return null;
  if (typeof v.path !== 'string' || typeof v.finalPath !== 'string' || typeof v.contentType !== 'string' || typeof v.body !== 'string') return null;
  if (!isIsoInstant(v.fetchedAt)) return null;
  return { kind: 'fetch-item', runId: v.runId, index: v.index, path: v.path, finalPath: v.finalPath, contentType: v.contentType, body: v.body, fetchedAt: v.fetchedAt };
}

export function parseFetchEnd(m: unknown): FetchEndMessage | null {
  if (!m || typeof m !== 'object') return null;
  const v = m as Record<string, unknown>;
  if (v.kind !== 'fetch-end' || !isRunId(v.runId) || !isCount(v.delivered)) return null;
  if (v.stopped === null) return { kind: 'fetch-end', runId: v.runId, delivered: v.delivered, stopped: null };
  if (!v.stopped || typeof v.stopped !== 'object') return null;
  const s = v.stopped as Record<string, unknown>;
  if (!FETCH_STOP_REASONS.includes(s.reason as FetchStopReason) || !isCount(s.index) || !isCount(s.status) || typeof s.detail !== 'string') return null;
  return { kind: 'fetch-end', runId: v.runId, delivered: v.delivered, stopped: { reason: s.reason as FetchStopReason, index: s.index, status: s.status, detail: s.detail } };
}

export type FetchOverlayMessage = FetchProgressMessage | FetchItemMessage | FetchEndMessage;

/** The overlay's run message, or `null` for anything that is not exactly one. */
export function parseFetchOverlayMessage(m: unknown): FetchOverlayMessage | null {
  const kind = m && typeof m === 'object' ? (m as { kind?: unknown }).kind : undefined;
  if (kind === 'fetch-progress') return parseFetchProgress(m);
  if (kind === 'fetch-item') return parseFetchItem(m);
  if (kind === 'fetch-end') return parseFetchEnd(m);
  return null;
}

// ---- Overlay to panel: the page's season list --------------------------------------------------------------------------------------------

/**
 * The checked season list from the page's own `GET /api/seasonchoices/` (D7 section 3). The overlay checks it once with `parseSeasonChoices`
 * and the panel checks it again, so a forged port message cannot add a season. The overlay keeps the latest list and sends it again after
 * every reconnect, as it does the snapshot.
 */
export interface SeasonsStateMessage {
  readonly kind: 'seasons-state';
  readonly seasons: readonly SeasonChoice[];
}

/** The checked list, or `null`. Re-runs `parseSeasonChoices`; the returned rows are copies. */
export function parseSeasonsState(m: unknown): ParsedSeasonChoices & { ok: true } | null {
  if (!m || typeof m !== 'object') return null;
  const v = m as { kind?: unknown; seasons?: unknown };
  if (v.kind !== 'seasons-state') return null;
  const parsed = parseSeasonChoices(v.seasons);
  return parsed.ok ? parsed : null;
}
