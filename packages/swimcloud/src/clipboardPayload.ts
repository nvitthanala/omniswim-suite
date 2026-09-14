/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reads the JSON payload the browser extension
 * (`extensions/swimcloud-companion/content.js`) produces — Track A's
 * transport for a single-page capture (`plans/2026-09-06/03-architecture.md`
 * §5, resolved 2026-09-07: clipboard over a localhost listener or a watched
 * file).
 *
 * ## Two versions, one reader
 *
 * `omniswimSwimCloudCapture: 1` is the original single-page clipboard
 * payload — still the transport for the Manager swimmer-profile flow and
 * Matrix's "From clipboard" fallback.
 *
 * `omniswimSwimCloudCapture: 2` is new (`plans/2026-09-08/03-extension-crawler.md`),
 * for one page of a multi-page crawl posted to the local capture-store HTTP
 * route rather than read from the clipboard. It carries a `subject` (which
 * meet or team this page belongs to) and an `httpStatus`, and reuses this
 * same reader rather than forking a second one — the `unsupported-version`
 * rejection this module already had exists for exactly this kind of
 * addition.
 *
 * The payload shape is duplicated, intentionally, in `content.js`'s
 * `buildPayload()` — a Manifest V3 content script here is an unbundled
 * classic script with no import of this module available to it, so "shared
 * code" isn't an option for that half; a shared, versioned shape is. If the
 * two ever drift, this reader rejects the mismatch loudly
 * (`unsupported-version` / `wrong-shape`) rather than guessing.
 */

import type { SwimCloudParseContext } from './parser';
// From ./entities, NOT ./captureStore — captureStore.ts composes ./cache.ts,
// which does `await import('node:fs/promises')` internally. This module is
// imported by browser UI packages (`@omniswim/swimcloud/clipboardPayload`,
// per OpsModule.tsx's and RosterImportWizard.tsx's own "subpaths only, never
// the package root" rule, docs/INVARIANTS.md #7) and must never pull that
// Node-only code into their type-check graph, even as a type-only import —
// TypeScript still fully checks a file it reads for one re-exported type.
import type { SwimCloudCaptureSubject } from './entities';

/** The exact shape `content.js`'s `buildPayload()` produces for a single-page clipboard capture. */
export interface SwimCloudClipboardPayload {
  readonly omniswimSwimCloudCapture: 1;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly track: 'browser-extension';
  readonly html: string;
}

/**
 * One page of a multi-page crawl, posted to the local capture-store route.
 * See `plans/2026-09-08/03-extension-crawler.md`'s "Route contract".
 */
export interface SwimCloudClipboardPayloadV2 {
  readonly omniswimSwimCloudCapture: 2;
  readonly subject: SwimCloudCaptureSubject;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly track: 'browser-extension';
  /** Absent for a successful fetch; present for a recorded non-200 outcome. */
  readonly httpStatus?: number;
  readonly html: string;
}

export type SwimCloudClipboardRejectionReason =
  /** The clipboard text was empty or whitespace-only. */
  | 'empty'
  /** `JSON.parse` failed — this wasn't JSON at all. */
  | 'not-json'
  /** Parsed as JSON, but not an object, or missing/mistyped a required field. */
  | 'wrong-shape'
  /** `omniswimSwimCloudCapture` was present but not `1` or `2` — a version this reader doesn't know. */
  | 'unsupported-version';

export interface SwimCloudClipboardAccepted {
  readonly ok: true;
  readonly payload: SwimCloudClipboardPayload | SwimCloudClipboardPayloadV2;
  /** Ready to hand straight to `parseTeamMeetSwimsHtml`/`parseMeetTeamsHtml`/etc. alongside `payload.html`. */
  readonly context: SwimCloudParseContext;
}

export interface SwimCloudClipboardRejected {
  readonly ok: false;
  readonly reason: SwimCloudClipboardRejectionReason;
  readonly message: string;
}

export type SwimCloudClipboardReadResult = SwimCloudClipboardAccepted | SwimCloudClipboardRejected;

const EXPECTED_TRACK = 'browser-extension' as const;
const SUPPORTED_VERSIONS = [1, 2] as const;

function isSupportedVersion(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2;
}

/** Loose but real validation of a v2 `subject` — never guesses a shape it wasn't given. */
function readSubject(value: unknown): SwimCloudCaptureSubject | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'meet' && typeof record.meetId === 'string' && record.meetId.length > 0) {
    return { kind: 'meet', meetId: record.meetId };
  }
  if (record.kind === 'team' && typeof record.teamId === 'string' && record.teamId.length > 0) {
    return {
      kind: 'team',
      teamId: record.teamId,
      ...(typeof record.season === 'string' ? { season: record.season } : {}),
    };
  }
  return undefined;
}

/**
 * Read and validate a captured payload — clipboard text (v1) or a posted
 * page body (v2). Never throws — every failure mode is a
 * `{ ok: false, reason, message }` a caller can show a coach verbatim,
 * rather than an exception to catch.
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

  if (!isSupportedVersion(record.omniswimSwimCloudCapture)) {
    return {
      ok: false,
      reason: 'unsupported-version',
      message: `Expected omniswimSwimCloudCapture: one of ${SUPPORTED_VERSIONS.join(' or ')}, got ${JSON.stringify(record.omniswimSwimCloudCapture)}. The browser extension and this app are out of sync — update one or the other.`,
    };
  }
  const version = record.omniswimSwimCloudCapture;

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

  if (version === 1) {
    const payload: SwimCloudClipboardPayload = {
      omniswimSwimCloudCapture: 1,
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

  const subject = readSubject(record.subject);
  if (subject === undefined) {
    return {
      ok: false,
      reason: 'wrong-shape',
      message: 'Missing or invalid "subject" field — a v2 payload must carry { kind: "meet", meetId } or { kind: "team", teamId }.',
    };
  }
  const httpStatus = typeof record.httpStatus === 'number' ? record.httpStatus : undefined;

  const payload: SwimCloudClipboardPayloadV2 = {
    omniswimSwimCloudCapture: 2,
    subject,
    sourceUrl: record.sourceUrl as string,
    retrievedAt: record.retrievedAt as string,
    track: EXPECTED_TRACK,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    html: record.html as string,
  };
  return {
    ok: true,
    payload,
    context: { sourceUrl: payload.sourceUrl, retrievedAt: payload.retrievedAt, track: payload.track },
  };
}
