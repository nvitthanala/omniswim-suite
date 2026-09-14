/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `packages/swimcloud/src/clipboardPayload.ts`, the app-side reader
 * for what `extensions/swimcloud-companion/content.js` writes to the
 * clipboard.
 *
 * `content.js` cannot be imported here (it's a Manifest V3 content script, no
 * bundler, no Node environment for `document`/`navigator`), so this suite
 * validates the *shape contract* between the two: every payload shape below
 * is copy-pasted from what `buildPayload()` in that file actually produces,
 * not reconstructed from memory. If the extension's payload shape ever
 * changes, update both `content.js` and the fixtures here together — see the
 * extension's README, "Payload shape".
 */
import { describe, expect, it } from 'vitest';
import { readSwimCloudClipboardPayload } from '@omniswim/swimcloud';

/** Exactly what content.js's buildPayload() produces, as JSON text. */
function realisticPayloadText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    omniswimSwimCloudCapture: 1,
    sourceUrl: 'https://www.swimcloud.com/team/633/',
    retrievedAt: '2026-09-07T12:34:56.000Z',
    track: 'browser-extension',
    html: '<!doctype html><html><body>fixture</body></html>',
    ...overrides,
  });
}

describe('readSwimCloudClipboardPayload — the happy path', () => {
  it('accepts a well-formed payload and builds a ready-to-use parse context', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText());
    if (!result.ok) throw new Error(`expected ok, got rejected: ${result.reason} — ${result.message}`);

    expect(result.payload.sourceUrl).toBe('https://www.swimcloud.com/team/633/');
    expect(result.payload.html).toContain('fixture');
    expect(result.context).toEqual({
      sourceUrl: 'https://www.swimcloud.com/team/633/',
      retrievedAt: '2026-09-07T12:34:56.000Z',
      track: 'browser-extension',
    });
  });

  it('tolerates leading/trailing whitespace around the clipboard text (a paste often carries it)', () => {
    const result = readSwimCloudClipboardPayload(`\n  ${realisticPayloadText()}  \n`);
    expect(result.ok).toBe(true);
  });
});

describe('readSwimCloudClipboardPayload — rejects loudly, never silently guesses', () => {
  it('rejects empty clipboard content', () => {
    const result = readSwimCloudClipboardPayload('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('rejects whitespace-only clipboard content the same way as truly empty', () => {
    const result = readSwimCloudClipboardPayload('   \n\t  ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('rejects non-JSON text (e.g. someone copied a URL, not the extension output)', () => {
    const result = readSwimCloudClipboardPayload('https://www.swimcloud.com/team/633/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-json');
  });

  it('rejects valid JSON that is not an object (an array, a bare string, a number)', () => {
    for (const text of ['[1,2,3]', '"just a string"', '42', 'null']) {
      const result = readSwimCloudClipboardPayload(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('wrong-shape');
    }
  });

  it('rejects a payload missing the version marker entirely', () => {
    const { omniswimSwimCloudCapture: _drop, ...rest } = JSON.parse(realisticPayloadText());
    const result = readSwimCloudClipboardPayload(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported-version');
  });

  it('rejects a payload from a future, incompatible extension version rather than guessing at its shape', () => {
    // Was 2 before 2026-09-08 — version 2 is now real (see the v2 describe
    // block below), so the "not a version this reader knows" case has moved
    // to 3. Kept as a separate assertion below that a v1-*shaped* payload
    // merely claiming version 2 is rejected as wrong-shape, not silently
    // accepted as if it were really v2.
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ omniswimSwimCloudCapture: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-version');
      expect(result.message).toContain('3');
    }
  });

  it('rejects a v1-shaped payload that merely claims to be version 2 (missing the required v2 "subject" field)', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ omniswimSwimCloudCapture: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });

  it('rejects a payload missing a required field', () => {
    for (const field of ['sourceUrl', 'retrievedAt', 'track', 'html']) {
      const full = JSON.parse(realisticPayloadText());
      delete full[field];
      const result = readSwimCloudClipboardPayload(JSON.stringify(full));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('wrong-shape');
    }
  });

  it('rejects a payload whose fields are the wrong type', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ sourceUrl: 12345 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });

  it('rejects a payload with the wrong track value (this reader is Track A only)', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ track: 'playwright' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });

  it('rejects a payload whose captured html is empty — a real capture is never nothing', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText({ html: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });
});

/**
 * v2 — added 2026-09-08 for the capture-store crawl
 * (`plans/2026-09-08/03-extension-crawler.md`'s "Route contract"). Reuses
 * this same reader rather than forking a second one; the shared
 * `unsupported-version` rejection is exactly why.
 */
function v2PayloadText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    omniswimSwimCloudCapture: 2,
    subject: { kind: 'meet', meetId: '356467' },
    sourceUrl: 'https://www.swimcloud.com/results/356467/team/58/swims/',
    retrievedAt: '2026-09-08T12:34:56.000Z',
    track: 'browser-extension',
    httpStatus: 200,
    html: '<!doctype html><html><body>fixture</body></html>',
    ...overrides,
  });
}

describe('readSwimCloudClipboardPayload — v2 (a posted crawl page)', () => {
  it('accepts a well-formed v2 payload with a meet subject', () => {
    const result = readSwimCloudClipboardPayload(v2PayloadText());
    if (!result.ok) throw new Error(`expected ok, got rejected: ${result.reason} — ${result.message}`);
    expect(result.payload.omniswimSwimCloudCapture).toBe(2);
    if (result.payload.omniswimSwimCloudCapture !== 2) return;
    expect(result.payload.subject).toStrictEqual({ kind: 'meet', meetId: '356467' });
    expect(result.payload.httpStatus).toBe(200);
  });

  it('accepts a team subject, with and without a season', () => {
    const withSeason = readSwimCloudClipboardPayload(
      v2PayloadText({ subject: { kind: 'team', teamId: '58', season: '2026-2027' } }),
    );
    if (!withSeason.ok) throw new Error('expected ok');
    if (withSeason.payload.omniswimSwimCloudCapture !== 2) throw new Error('expected v2');
    expect(withSeason.payload.subject).toStrictEqual({ kind: 'team', teamId: '58', season: '2026-2027' });

    const withoutSeason = readSwimCloudClipboardPayload(
      v2PayloadText({ subject: { kind: 'team', teamId: '58' } }),
    );
    if (!withoutSeason.ok) throw new Error('expected ok');
    if (withoutSeason.payload.omniswimSwimCloudCapture !== 2) throw new Error('expected v2');
    expect(withoutSeason.payload.subject).toStrictEqual({ kind: 'team', teamId: '58' });
  });

  it('accepts a v2 payload with no httpStatus (a successful fetch need not carry one)', () => {
    const overrides = v2PayloadText();
    const parsed = JSON.parse(overrides) as Record<string, unknown>;
    delete parsed.httpStatus;
    const result = readSwimCloudClipboardPayload(JSON.stringify(parsed));
    if (!result.ok) throw new Error('expected ok');
    if (result.payload.omniswimSwimCloudCapture !== 2) throw new Error('expected v2');
    expect(result.payload.httpStatus).toBeUndefined();
  });

  it('rejects a v2 payload with a missing subject', () => {
    const parsed = JSON.parse(v2PayloadText()) as Record<string, unknown>;
    delete parsed.subject;
    const result = readSwimCloudClipboardPayload(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });

  it('rejects a v2 payload with an invalid subject.kind rather than guessing which one was meant', () => {
    const result = readSwimCloudClipboardPayload(v2PayloadText({ subject: { kind: 'swimmer', swimmerId: '1' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-shape');
  });

  it('rejects an unknown version (not 1, not 2)', () => {
    const result = readSwimCloudClipboardPayload(v2PayloadText({ omniswimSwimCloudCapture: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported-version');
  });

  it('still accepts a v1 payload unchanged — v2 is additive, not a replacement', () => {
    const result = readSwimCloudClipboardPayload(realisticPayloadText());
    if (!result.ok) throw new Error('expected ok');
    expect(result.payload.omniswimSwimCloudCapture).toBe(1);
  });
});
