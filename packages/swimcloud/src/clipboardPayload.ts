/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reads the JSON payload the browser extension
 * (`extensions/swimcloud-companion/content.js`) writes to the clipboard —
 * Track A's chosen transport
 * (`plans/2026-09-06/03-architecture.md` §5, resolved 2026-09-07: clipboard
 * over a localhost listener or a watched file, because it needs no new
 * infrastructure, no port, and works even when the desktop app isn't
 * running).
 *
 * The payload shape is duplicated, intentionally, in exactly one other place:
 * `content.js`'s `buildPayload()`. A Manifest V3 content script here is an
 * unbundled classic script with no import of this module available to it, so
 * "shared code" isn't an option — a shared, versioned shape
 * (`omniswimSwimCloudCapture: 1`) is. If the two ever drift, this reader
 * rejects the mismatch loudly (`unsupported-version` /
 * `wrong-shape`) rather than guessing.
 */

import type { SwimCloudParseContext } from './parser';

/** The exact shape `content.js`'s `buildPayload()` produces. Keep the two in sync. */
export interface SwimCloudClipboardPayload {
  readonly omniswimSwimCloudCapture: 1;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly track: 'browser-extension';
  readonly html: string;
}

export type SwimCloudClipboardRejectionReason =
  /** The clipboard text was empty or whitespace-only. */
  | 'empty'
  /** `JSON.parse` failed — this wasn't JSON at all. */
  | 'not-json'
  /** Parsed as JSON, but not an object, or missing/mistyped a required field. */
  | 'wrong-shape'
  /** `omniswimSwimCloudCapture` was present but not `1` — a version this reader doesn't know. */
  | 'unsupported-version';

export interface SwimCloudClipboardAccepted {
  readonly ok: true;
  readonly payload: SwimCloudClipboardPayload;
  /** Ready to hand straight to `parseTeamRosterHtml`/`parseMeetResultsHtml` alongside `payload.html`. */
  readonly context: SwimCloudParseContext;
}

export interface SwimCloudClipboardRejected {
  readonly ok: false;
  readonly reason: SwimCloudClipboardRejectionReason;
  readonly message: string;
}

export type SwimCloudClipboardReadResult = SwimCloudClipboardAccepted | SwimCloudClipboardRejected;

const EXPECTED_TRACK = 'browser-extension' as const;
const SUPPORTED_VERSION = 1;

/**
 * Read and validate a clipboard-text capture. Never throws — every failure
 * mode is a `{ ok: false, reason, message }` a caller can show to a coach
 * verbatim, rather than an exception to catch.
 *
 * Deliberately does **not** attempt to classify `sourceUrl` or parse `html`
 * itself — that's `urlClassifier.ts` and `parser.ts`'s job respectively, kept
 * separate so this module's only responsibility is "is this the shape the
 * extension actually produces."
 */
export function readSwimCloudClipboardPayload(text: string): SwimCloudClipboardReadResult {
  if (text.trim().length === 0) {
    return { ok: false, reason: 'empty', message: 'Clipboard is empty. Click "Copy for Omniswim" on a SwimCloud page first.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: 'not-json',
      message: 'Clipboard contents are not JSON. Did you copy something other than the SwimCloud Companion output?',
    };
  }

  // typeof [] === 'object' in JS, so Array.isArray needs its own check —
  // otherwise an array's missing omniswimSwimCloudCapture property would fall
  // through to 'unsupported-version' below instead of being rejected here as
  // the wrong shape entirely.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'wrong-shape', message: 'Clipboard JSON is not an object.' };
  }

  const record = parsed as Record<string, unknown>;

  if (record.omniswimSwimCloudCapture !== SUPPORTED_VERSION) {
    return {
      ok: false,
      reason: 'unsupported-version',
      message: `Expected omniswimSwimCloudCapture: ${SUPPORTED_VERSION}, got ${JSON.stringify(record.omniswimSwimCloudCapture)}. The browser extension and this app are out of sync — update one or the other.`,
    };
  }

  const missing = (['sourceUrl', 'retrievedAt', 'track', 'html'] as const).filter(
    (key) => typeof record[key] !== 'string',
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'wrong-shape',
      message: `Missing or non-string field(s): ${missing.join(', ')}.`,
    };
  }

  if (record.track !== EXPECTED_TRACK) {
    return {
      ok: false,
      reason: 'wrong-shape',
      message: `Expected track: ${JSON.stringify(EXPECTED_TRACK)}, got ${JSON.stringify(record.track)}.`,
    };
  }

  if ((record.html as string).trim().length === 0) {
    return { ok: false, reason: 'wrong-shape', message: 'Captured html is empty.' };
  }

  const payload: SwimCloudClipboardPayload = {
    omniswimSwimCloudCapture: SUPPORTED_VERSION,
    sourceUrl: record.sourceUrl as string,
    retrievedAt: record.retrievedAt as string,
    track: EXPECTED_TRACK,
    html: record.html as string,
  };

  return {
    ok: true,
    payload,
    context: { sourceUrl: payload.sourceUrl, retrievedAt: payload.retrievedAt, track: payload.track },
  };
}
